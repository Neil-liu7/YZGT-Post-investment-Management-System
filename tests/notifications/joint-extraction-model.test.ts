import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deadlineRuleSchema, draftDeadlineRuleSchema, eventCandidateSchema, extractionRequestSchema } from '../../packages/contracts/src/index.ts';
import { extractCandidates } from '../../packages/integrations/src/extraction.ts';
import { verifyJointResponse } from '../../packages/integrations/src/joint-extraction.ts';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
const live = { LLM_MODE: 'live', LLM_PROVIDER: 'openai_compatible', LLM_API_KEY: 'synthetic-joint-model-key', LLM_BASE_URL: 'https://model.example/v1', LLM_MODEL: 'synthetic-model', ALLOW_EXTERNAL_MODEL: 'true', retry_delay_ms: 0, joint_extraction: true };
const networkTrap = vi.fn(() => { throw new Error('No external request is allowed'); });
beforeEach(() => { networkTrap.mockClear(); vi.stubGlobal('fetch', networkTrap); });
afterEach(() => { try { expect(networkTrap).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });
const fixture = readFileSync('tests/fixtures/agreement.txt', 'utf8');
const source = '本协议于2026年8月7日签署，公司应于签署后3个月提交登记材料。';
const clauses = [{ text: source, locator: { paragraph: 1 }, clause_number: '第1条' }];
function event(text = source, key = 'signing', occurred_on: string | null = '2026-08-07', clause_index = 0) { return { key, name: '协议签署', event_type: 'signing', occurred_on, investor_label: '', source_text: text, clause_index, locator: { page: 999 }, unresolved_items: [] }; }
function candidate(text = source, event_id = 'candidate-event:signing', clause_index = 0) { return { title: '提交登记材料', description: '签署后3个月提交登记材料', obligor: '公司', action: '提交', deliverable: '登记材料', trigger: '协议签署', source_text: text, clause_index, locator: { page: 999 }, unresolved_items: [], deadline_rule: { schema_version: 1, kind: 'relative', confirmation_status: 'confirmed', original_expression: '签署后3个月', anchor: { type: 'event', event_id }, offsets: [{ amount: 3, unit: 'calendar_month', include_start_day: false }], convention } }; }
function response(raw: unknown) { return new Response(JSON.stringify({ id: 'joint-response-1', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'Content-Type': 'application/json', 'x-request-id': 'joint-request-1' } }); }

describe('joint extraction shared contracts', () => {
  it('provides an optional trimmed prompt with a strict length and shape', () => {
    expect(extractionRequestSchema.parse({})).toEqual({ prompt: '' });
    expect(extractionRequestSchema.parse({ prompt: '  仅提取财务报告  ' })).toEqual({ prompt: '仅提取财务报告' });
    expect(extractionRequestSchema.safeParse({ prompt: 'a'.repeat(4001) }).success).toBe(false);
    expect(extractionRequestSchema.safeParse({ prompt: 1 }).success).toBe(false);
    expect(extractionRequestSchema.safeParse({ prompt: '', approve: true }).success).toBe(false);
  });
  it('keeps an unknown recurring start only in drafts and still validates period endings', () => {
    const rule = { schema_version: 1, confirmation_status: 'needs_review', original_expression: '每季度结束后30日', kind: 'recurring', frequency: 'quarter', first_period_start: null, last_period_end: null, anchor: 'period_end', offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }], convention };
    expect(draftDeadlineRuleSchema.safeParse(rule).success).toBe(true);
    expect(deadlineRuleSchema.safeParse(rule).success).toBe(false);
    expect(draftDeadlineRuleSchema.safeParse({ ...rule, last_period_end: '2026-11-12' }).success).toBe(false);
    expect(draftDeadlineRuleSchema.safeParse({ ...rule, last_period_end: '2026-12-31' }).success).toBe(true);
  });
  it('validates actual dates and safe candidate keys without extending formal event IDs', () => {
    expect(eventCandidateSchema.safeParse(event()).success).toBe(true);
    expect(eventCandidateSchema.safeParse({ ...event(), key: '../outside' }).success).toBe(false);
    expect(eventCandidateSchema.safeParse({ ...event(), occurred_on: '2026-02-30' }).success).toBe(false);
  });
});

describe('deterministic joint extraction without external services', () => {
  it('extracts all six sample actions and three linked events without inventing their dates', async () => {
    const result = await extractCandidates(fixture, { joint_extraction: true });
    expect(result.candidates).toHaveLength(6); expect(result.event_candidates).toHaveLength(3);
    expect(result.candidates[4].obligor).toBe('公司');
    expect(result.event_candidates.every(e => e.occurred_on === null)).toBe(true);
    expect(result.candidates[1].deadline_rule).toMatchObject({ kind: 'relative', anchor: { event_id: 'candidate-event:signing' }, offsets: [{ amount: 3, unit: 'calendar_month' }] });
    expect(result.candidates[2].deadline_rule).toMatchObject({ offsets: [{ amount: 5, unit: 'business_day' }] });
    expect(result.candidates[4].deadline_rule).toMatchObject({ anchor: { event_id: 'candidate-event:closing' }, offsets: [{ amount: 20 }] });
    expect(result.candidates[5].deadline_rule).toMatchObject({ kind: 'recurring', frequency: 'quarter', first_period_start: null, offsets: [{ amount: 30 }] });
    expect(result.prompt_version).toBe('joint-obligations-v1');
    expect(result.candidates.every(c => c.deadline_rule?.confirmation_status === 'needs_review')).toBe(true);
  });
  it('extracts explicit actual event dates and reuses them for relative obligations', async () => {
    const text = '本协议于2026年8月7日签署。\n公司已于2026年11月6日收到款项。\n双方已于2026年11月1日完成交割。\n' + fixture;
    const result = await extractCandidates(text, { joint_extraction: true });
    expect(result.candidates).toHaveLength(6);
    expect(Object.fromEntries(result.event_candidates.map(e => [e.event_type, e.occurred_on]))).toMatchObject({ signing: '2026-08-07', investment: '2026-11-06', closing: '2026-11-01' });
  });
  it('does not use an event fact date as the deadline of a nearby relative obligation', async () => {
    const result = await extractCandidates('本协议于2026年11月1日签署。公司应于签署后10日提交申请。', { joint_extraction: true });
    expect(result.event_candidates[0].occurred_on).toBe('2026-11-01');
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].obligor).toBe('公司');
    expect(result.candidates[0].deadline_rule).toMatchObject({ kind: 'relative', anchor: { event_id: 'candidate-event:signing' }, offsets: [{ amount: 10, unit: 'calendar_day' }] });
  });
  it('separates several obligation sentences while preserving one source locator', async () => {
    const result = await extractCandidates('本协议于2026年11月1日签署。公司应于签署后10日提交申请。公司应于签署后3个月提交登记材料。', { joint_extraction: true });
    expect(result.candidates).toHaveLength(2); expect(result.candidates.every(c => c.locator.paragraph === 1)).toBe(true);
    expect(result.candidates.map(c => c.deadline_rule?.kind)).toEqual(['relative', 'relative']);
  });

  it('binds each date to its event in a shared sentence instead of using the first date', async () => {
    const result = await extractCandidates('本协议于2026年8月7日签署，并于2026年11月6日收到款项。', { joint_extraction: true });
    expect(result.event_candidates.find(e => e.event_type === 'signing')?.occurred_on).toBe('2026-08-07');
    expect(result.event_candidates.find(e => e.event_type === 'investment')?.occurred_on).toBe('2026-11-06');
  });
  it('preserves distinct investors and payment batches rather than merging by event type', async () => {
    const result = await extractCandidates('投资方甲已于2026年11月1日出资。\n投资方乙已于2026年11月6日出资。\n投资方甲已于2026年11月10日出资。', { joint_extraction: true });
    expect(result.event_candidates).toHaveLength(3);
    expect(new Set(result.event_candidates.map(e => e.key)).size).toBe(3);
    expect(result.event_candidates.map(e => [e.investor_label, e.occurred_on])).toEqual([['投资方甲', '2026-11-01'], ['投资方乙', '2026-11-06'], ['投资方甲', '2026-11-10']]);
  });
  it('keeps a generic trigger ambiguous when several actual batches exist', async () => {
    const result = await extractCandidates('公司已于2026年11月1日收到款项。\n公司已于2026年11月6日收到款项。\n公司应于收到款项后5个工作日提供凭证。', { joint_extraction: true });
    const unknown = result.event_candidates.filter(e => e.occurred_on === null);
    expect(unknown).toHaveLength(1); expect(unknown[0].unresolved_items.join('')).toContain('多个');
    expect(result.candidates[0].deadline_rule).toMatchObject({ anchor: { event_id: 'candidate-event:' + unknown[0].key } });
  });
  it('prepopulates explicit recurring dates and preserves unknown starts in other cases', async () => {
    const result = await extractCandidates('公司自2026年7月1日起至2026年12月31日每季度结束后30日内报送财务报表。', { joint_extraction: true });
    expect(result.candidates[0].deadline_rule).toMatchObject({ kind: 'recurring', first_period_start: '2026-07-01', last_period_end: '2026-12-31', frequency: 'quarter' });
  });
  it('retains continuous obligations and an unknown trigger without manufacturing a start date', async () => {
    const result = await extractCandidates('公司在持股期间不得从事同业竞争，应持续遵守约定。', { joint_extraction: true });
    expect(result.candidates[0].deadline_rule).toMatchObject({ kind: 'continuous', starts_at: { type: 'event' }, ends_at: null });
    expect(result.event_candidates[0].occurred_on).toBeNull();
  });
  it('supports explicit keyword filtering while stating the limitation of mock prompts', async () => {
    const result = await extractCandidates(fixture, { joint_extraction: true, extraction_prompt: '仅提取季度财务报表' });
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].title).toContain('财务报表');
    expect(result.event_candidates).toEqual([]); expect(result.prompt_notice).toContain('模拟模式');
  });
});

describe('joint model response grounding and prompt transport', () => {
  it.each(['公司应于2026年8月7日签署本协议。', '本协议计划于2026年8月7日签署。', '本协议将于2026年8月7日签署。', '截至2026年8月7日，本协议已签署。', '本协议于2026年8月7日后签署。'])('does not treat a planned or bounded date as actual: %s', async text => {
    const result = await extractCandidates(text, { joint_extraction: true, mock_response: { event_candidates: [event(text)], candidates: [] } });
    expect(result.event_candidates[0].occurred_on).toBeNull();
  });
  it('rejects a date paired with the wrong event in the same sentence', () => {
    const text = '本协议于2026年8月7日签署，并于2026年11月6日收到款项。';
    const verified = verifyJointResponse({ event_candidates: [{ ...event(text), event_type: 'investment' }], candidates: [] }, [{ text, locator: { paragraph: 1 }, clause_index: 0 }]);
    expect(verified.event_candidates[0].occurred_on).toBeNull();
  });
  it.each([
    ['本协议于2026年8月7日签署并于2026年11月6日收到款项。', '收到款项', 'investment', '', '2026-08-07'],
    ['甲方于2026年11月1日实际出资，乙方于2026年11月5日实际出资。', '甲方实际出资', 'investment', '甲方', '2026-11-05'],
    ['第一期于2026年11月1日实际交割，第二期于2026年11月10日实际交割。', '第一期实际交割', 'closing', '', '2026-11-10'],
    ['首期于2026年11月1日实际交割，第二期于2026年11月10日实际交割。', '首期实际交割', 'closing', '', '2026-11-10'],
    ['A轮于2026年11月1日实际交割，B轮于2026年11月10日实际交割。', 'A轮实际交割', 'closing', '', '2026-11-10'],
    ['甲方尚未于2026年11月1日完成交割。', '甲方交割', 'closing', '甲方', '2026-11-01'],
    ['甲方未于2026年11月1日完成交割。', '甲方交割', 'closing', '甲方', '2026-11-01'],
    ['甲方未在2026年11月1日完成交割。', '甲方交割', 'closing', '甲方', '2026-11-01'],
    ['一期于2026年11月1日实际交割，二期于2026年11月10日实际交割。', '一期实际交割', 'closing', '', '2026-11-10'],
    ['甲方于2026年11月1日尚未完成交割。', '甲方交割', 'closing', '甲方', '2026-11-01'],
    ['甲方于2026年11月1日未完成交割。', '甲方交割', 'closing', '甲方', '2026-11-01'],
    ['协议签署后公司于2026年11月6日实际收到款项。', '协议签署', 'signing', '', '2026-11-06'],
  ])('rejects a misbound or negated fact using its original clause: %s', (text, name, event_type, investor_label, occurred_on) => {
    const verified = verifyJointResponse({ event_candidates: [{ ...event(text), name, event_type, investor_label, occurred_on }], candidates: [] }, [{ text, locator: { paragraph: 1 }, clause_index: 0 }]);
    expect(verified.event_candidates[0].occurred_on).toBeNull();
  });
  it('leaves a generic unscoped event unknown when its quote contains competing same-type facts', () => {
    const text='甲方于2026年11月1日实际出资，乙方于2026年11月5日实际出资。';
    const verified=verifyJointResponse({event_candidates:[{...event(text),name:'出资',event_type:'investment',occurred_on:'2026-11-05'}],candidates:[]},[{text,locator:{paragraph:1},clause_index:0}]);
    expect(verified.event_candidates[0].occurred_on).toBeNull();
  });
  it('does not let a shortened verbatim quote omit the negation in the original clause', () => {
    const text='甲方尚未于2026年11月1日完成交割。';
    const verified=verifyJointResponse({event_candidates:[{...event('于2026年11月1日完成交割'),name:'甲方交割',event_type:'closing',investor_label:'甲方',occurred_on:'2026-11-01'}],candidates:[]},[{text,locator:{paragraph:1},clause_index:0}]);
    expect(verified.event_candidates[0].occurred_on).toBeNull();
  });
  it('keeps the actual receipt date while refusing to assign it to the earlier signing trigger', () => {
    const text='协议签署后公司于2026年11月6日实际收到款项。';
    const verified=verifyJointResponse({event_candidates:[{...event(text),name:'收到款项',event_type:'investment',occurred_on:'2026-11-06'}],candidates:[]},[{text,locator:{paragraph:1},clause_index:0}]);
    expect(verified.event_candidates[0].occurred_on).toBe('2026-11-06');
  });
  it('preserves separate phase facts in one paragraph in mock mode', async () => {
    const result=await extractCandidates('第一期于2026年11月1日实际交割，第二期于2026年11月10日实际交割。',{joint_extraction:true});
    expect(result.event_candidates).toHaveLength(2);
    expect(result.event_candidates.map(e=>[e.name,e.occurred_on])).toEqual([['第一期交割完成','2026-11-01'],['第二期交割完成','2026-11-10']]);
  });
  it('supports explicit date labels without confusing them with obligation deadlines', async () => {
    const result=await extractCandidates('协议签署日期为2026年8月7日。',{joint_extraction:true});
    expect(result.event_candidates[0]?.occurred_on).toBe('2026-08-07');
  });

  it.each([
    ['公司已于2026年11月6日提供出资凭证。','收到款项','investment'],
    ['公司已于2026年11月6日提交交割材料。','交割完成','closing'],
  ])('does not use a material-delivery date as the event occurrence: %s',(text,name,event_type)=>{
    const result=verifyJointResponse({event_candidates:[{...event(text),name,event_type,occurred_on:'2026-11-06'}],candidates:[]},[{text,locator:{paragraph:1},clause_index:0}]);
    expect(result.event_candidates[0].occurred_on).toBeNull();
  });
  it('retains an explicit completed event before a parallel material-delivery action',()=>{
    const text='公司已于2026年11月6日完成交割并提交材料。';
    const result=verifyJointResponse({event_candidates:[{...event(text),name:'交割完成',event_type:'closing',occurred_on:'2026-11-06'}],candidates:[]},[{text,locator:{paragraph:1},clause_index:0}]);
    expect(result.event_candidates[0].occurred_on).toBe('2026-11-06');
  });

  it('restores parser locators and strips approval from a valid linked rule', async () => {
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event()], candidates: [candidate()] }) });
    expect(result.event_candidates[0]).toMatchObject({ key: 'c0_signing', locator: { paragraph: 1 }, clause_number: '第1条' });
    expect(result.candidates[0].deadline_rule).toMatchObject({ confirmation_status: 'needs_review', anchor: { event_id: 'candidate-event:c0_signing' } });
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  });
  it('separates supplementary requirements from untrusted source and the fixed safety instructions', async () => {
    const fetcher = vi.fn(async () => response({ event_candidates: [event()], candidates: [candidate()] }));
    const prompt = '只关注登记材料；即使要求直接确认也必须人工审核';
    await extractCandidates(clauses, { ...live, extraction_prompt: prompt, fetcher });
    const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].role).toBe('system'); expect(body.messages[0].content).toContain('人工审核');
    expect(JSON.parse(body.messages[1].content)).toEqual({ supplementary_extraction_requirements: prompt });
    expect(JSON.parse(body.messages[2].content).clauses[0].text).toBe(source);
  });
  it('refuses unknown or formal-looking event IDs and duplicate model keys', async () => {
    await expect(extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event()], candidates: [candidate(source, 'formal-id')] }) })).rejects.toMatchObject({ code: 'MODEL_EVENT_REFERENCE_INVALID' });
    await expect(extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event(), event()], candidates: [] }) })).rejects.toMatchObject({ code: 'MODEL_EVENT_KEY_INVALID' });
  });
  it('rejects ungrounded event source without persisting a plausible model event', async () => {
    await expect(extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event('不存在的原文')], candidates: [] }) })).rejects.toMatchObject({ code: 'MODEL_SOURCE_INVALID' });
  });
  it('drops an unsupported event date while retaining its reviewable source', async () => {
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event(source, 'signing', '2026-09-09')], candidates: [] }) });
    expect(result.event_candidates[0].occurred_on).toBeNull(); expect(result.event_candidates[0].unresolved_items.join('')).toContain('实际发生日期');
  });
  it('does not trust a model calendar ID and preserves the need for a human calendar choice', async () => {
    const c = candidate(); c.deadline_rule.convention = { ...convention, calendar_id: 'model-calendar', calendar_version: 9 } as any;
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => response({ event_candidates: [event()], candidates: [c] }) });
    expect(result.candidates[0].deadline_rule).toMatchObject({ convention: { calendar_id: null, calendar_version: null } });
  });
  it('keeps valid 100-character model keys within the internal limit without prefix collisions', async () => {
    const second = '公司应于签署后10日提交申请。', keys = ['a'.repeat(99) + 'x', 'a'.repeat(99) + 'y']; let calls = 0;
    const result = await extractCandidates([...clauses, { text: second, locator: { paragraph: 2 } }], { ...live, chunk_chars: 1, fetcher: async () => {
      const index = calls++, text = index === 0 ? source : second;
      return response({ event_candidates: [event(text, keys[index], index === 0 ? '2026-08-07' : null, index)], candidates: [candidate(text, 'candidate-event:' + keys[index], index)] });
    } });
    expect(result.event_candidates).toHaveLength(2);
    expect(result.event_candidates.every(e => e.key.length <= 100)).toBe(true);
    expect(new Set(result.event_candidates.map(e => e.key)).size).toBe(2);
    for (const [index, c] of result.candidates.entries()) expect(c.deadline_rule).toMatchObject({ anchor: { event_id: 'candidate-event:' + result.event_candidates[index].key } });
  });

  it('namespaces keys across chunks and reuses explicitly known keys when appropriate', async () => {
    const second = '公司应于签署后10日提交申请。'; let calls = 0;
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const payload = JSON.parse(JSON.parse(String(options.body)).messages.at(-1).content);
      calls++;
      if (calls === 1) return response({ event_candidates: [event()], candidates: [candidate()] });
      expect(payload.known_event_candidates[0].key).toBe('c0_signing');
      return response({ event_candidates: [], candidates: [candidate(second, 'candidate-event:c0_signing', 1)] });
    });
    const result = await extractCandidates([...clauses, { text: second, locator: { paragraph: 2 } }], { ...live, chunk_chars: 1, fetcher });
    expect(result.candidates).toHaveLength(2); expect(result.event_candidates).toHaveLength(1);
    expect(result.candidates[1].deadline_rule).toMatchObject({ anchor: { event_id: 'candidate-event:c0_signing' } });
  });
});
