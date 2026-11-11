import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseDocument, extractCandidates, candidateSchema, normalizeRecipients, sendOutbound } from '../../packages/integrations/src/index.ts';

describe('document parsing and guarded extraction', () => {
  it('retains paragraph locations and splits two deadlines without inventing an anchor', async () => {
    const parsed = await parseDocument(Buffer.from('第1条 公司应于2029年12月31日前完成实缴。\n第2条 公司应于签署后3个月提交登记材料，并于收到款项后5个工作日提供凭证。\n第3条 每季度结束后30日内报送财务报表。'), '协议.txt');
    const result = await extractCandidates(parsed.clauses);
    expect(parsed.clauses[1]?.locator).toEqual({ paragraph: 2 });
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.filter(c => c.clause_index === 1)).toHaveLength(2);
    expect(result.candidates[0]?.deadline_rule).toMatchObject({ kind: 'fixed', date: '2029-12-31', confirmation_status: 'needs_review' });
    expect(result.candidates[1]?.unresolved_items.length).toBeGreaterThan(0);
    expect(result.candidates.every(c => candidateSchema.safeParse(c).success)).toBe(true);
  });
  it.each(['docx', 'pdf'])('extracts real synthetic %s fixture', async format => {
    const parsed = await parseDocument(await readFile(new URL(`../fixtures/agreement.${format}`, import.meta.url)), `合成.${format}`);
    expect(parsed.text).toContain('2029');
    expect(parsed.clauses.length).toBeGreaterThan(3);
    expect(parsed.clauses[0]?.locator[format === 'pdf' ? 'page' : 'paragraph']).toBe(1);
  });
  it('rejects unsupported, corrupt, encrypted and image-only files distinctly', async () => {
    await expect(parseDocument(Buffer.from('x'), 'old.doc')).rejects.toThrow(/DOCX/);
    await expect(parseDocument(Buffer.from('not a pdf'), 'bad.pdf')).rejects.toThrow(/损坏|不匹配/);
    await expect(parseDocument(await readFile(new URL('../fixtures/encrypted.pdf', import.meta.url)), 'encrypted.pdf')).rejects.toThrow(/加密/);
    await expect(parseDocument(await readFile(new URL('../fixtures/scanned.pdf', import.meta.url)), 'scan.pdf')).rejects.toThrow(/扫描|OCR/);
    await expect(parseDocument(Buffer.from([0xc0, 0xaf]), 'bad.txt')).rejects.toThrow(/UTF-8/);
  });
  it('uses one validated schema for invalid model output and partial mock batches', async () => {
    await expect(extractCandidates('应报送资料', { mock_response: { candidates: [{ title: 'incomplete' }] } })).rejects.toThrow(/结构/);
    const result = await extractCandidates('应报送资料', { mock_partial: true });
    expect(result.state).toBe('partial');
    expect(result.errors).toHaveLength(1);
    await expect(extractCandidates('资料', { mock_timeout: true })).rejects.toThrow(/超时/);
  });
  it('keeps successful GLM chunks reviewable when another chunk times out, using an isolated transport', async () => {
    const first = '公司应提交资料。';
    const result = await extractCandidates([{ text: first, locator: { paragraph: 1 } }, { text: '公司应报送另一个文件。', locator: { paragraph: 2 } }], {
      LLM_MODE: 'live', ALLOW_EXTERNAL_MODEL: 'true', GLM_API_KEY: 'synthetic-not-a-key', GLM_MODEL: 'synthetic', chunk_chars: 10, retry_delay_ms: 0,
      fetcher: async (_url: string, options: any) => {
        const prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
        if (prompt[0].clause_index === 1) throw new DOMException('synthetic timeout', 'TimeoutError');
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ candidates: [{ title: '提交资料', description: '提交资料', obligor: '公司', action: '提交', deliverable: '资料', trigger: '', deadline_rule: null, unresolved_items: ['待核对期限'], source_text: first, locator: {}, clause_index: 0 }] }) } }] }) };
      },
    });
    expect(result.state).toBe('partial'); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.locator).toEqual({ paragraph: 1 }); expect(result.errors).toHaveLength(1);
  });
});

describe('outbound guard and recipients', () => {
  it('normalizes recipients for dedup and rejects injected headers', () => {
    expect(normalizeRecipients('A@Example.com, a@example.com; b@example.com')).toEqual(['A@Example.com', 'b@example.com']);
    expect(() => normalizeRecipients('a@example.com\r\nBcc:x@example.com')).toThrow(/收件/);
  });
  it('never uses a live transport in the default mode', async () => {
    const result = await sendOutbound({ channel: 'feishu', mode: 'mock', content: { subject: '合成', body: '合成测试' }, recipient_key: 'mock:feishu' }, {});
    expect(result.status).toBe('mock_completed');
    const denied = await sendOutbound({ channel: 'feishu', mode: 'live', content: { subject: '合成', body: '测试' }, recipient_key: 'x' }, {});
    expect(denied).toMatchObject({ status: 'failed', retryable: false });
  });
  it('A33 blocks real model and channel transports under the automated test environment', async () => {
    const trap = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('隔离传输禁止网络连接'));
    try {
      await expect(extractCandidates('应报送资料', { LLM_MODE: 'live', ALLOW_EXTERNAL_MODEL: 'true', GLM_API_KEY: 'synthetic', GLM_MODEL: 'synthetic' })).rejects.toThrow(/自动测试/);
      const denied = await sendOutbound({ channel: 'feishu', mode: 'live', content: { subject: '合成', body: '测试' }, recipient_key: 'x' }, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic' });
      expect(denied).toMatchObject({ status: 'failed', retryable: false }); expect(denied.error).toContain('自动测试');
    } finally { trap.mockRestore(); }
  });
  it.each([new TypeError('fetch failed synthetic secret'), Object.assign(new Error('reset synthetic secret'), { code: 'ECONNRESET' }), Object.assign(new Error('aborted'), { code: 'ECONNABORTED' })])('classifies an uncertain Feishu network interruption as unknown without exposing transport details', async error => {
    const result = await sendOutbound({ channel: 'feishu', mode: 'live', content: { subject: '合成', body: '测试' }, recipient_key: 'synthetic' }, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic', fetcher: async () => { throw error; } });
    expect(result.status).toBe('unknown'); expect(result.error).not.toContain('synthetic secret');
  });
});
