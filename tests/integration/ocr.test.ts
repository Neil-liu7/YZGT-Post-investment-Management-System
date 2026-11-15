import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../packages/integrations/src/documents';
import { createMockOcrProvider, createTesseractOcrProvider } from '../../packages/integrations/src/ocr';

const scanned = () => readFile(new URL('../fixtures/scanned.pdf', import.meta.url));

describe('scanned document OCR support', () => {
  it('keeps scanner PDFs reviewable with page locators when an OCR provider succeeds', async () => {
    const parsed = await parseDocument(await scanned(), '扫描协议.pdf', {
      ocrProvider: async () => ({ pages: [{ page: 1, text: '第1条 公司应提交扫描材料。' }, { page: 2, text: '第2条 公司应持续报告。' }], parser: 'ocr-test-v1' }),
    });
    expect(parsed.parser).toBe('ocr-test-v1');
    expect(parsed.text).toContain('第1条');
    expect(parsed.clauses.map(clause => clause.locator)).toEqual([{ page: 1, paragraph: 1 }, { page: 2, paragraph: 1 }]);
  });

  it('leaves OCR disabled by default and reports a clear configuration error', async () => {
    await expect(parseDocument(await scanned(), '扫描协议.pdf')).rejects.toMatchObject({ code: 'SCANNED_DOCUMENT' });
  });

  it('supports deterministic mock OCR without network access', async () => {
    const parsed = await parseDocument(await scanned(), '扫描协议.pdf', { ocrMode: 'mock', env: { OCR_MOCK_TEXT: '第3条 合成 OCR 内容。' } });
    expect(parsed.parser).toBe('ocr-mock-v1');
    expect(parsed.clauses[0]).toMatchObject({ text: '第3条 合成 OCR 内容。', locator: { page: 1, paragraph: 1 } });
  });

  it('distinguishes missing local OCR commands from an empty recognition result', async () => {
    const provider = createTesseractOcrProvider({ OCR_PDFTOPPM_PATH: '/path/that/does/not/exist', OCR_TIMEOUT_MS: '1000' });
    await expect(parseDocument(await scanned(), '扫描协议.pdf', { ocrProvider: provider })).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
    await expect(parseDocument(await scanned(), '扫描协议.pdf', { ocrProvider: async () => ({ pages: [] }) })).rejects.toMatchObject({ code: 'OCR_EMPTY' });
  });

  it('requires mock text instead of inventing OCR content', async () => {
    await expect(createMockOcrProvider({}) (await scanned(), '扫描协议.pdf')).rejects.toMatchObject({ code: 'OCR_NOT_CONFIGURED' });
  });
});
