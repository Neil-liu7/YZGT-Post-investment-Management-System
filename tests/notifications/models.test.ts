import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractCandidates, getModelStatus, resolveModelConfig } from '../../packages/integrations/src/index.ts';

const key = 'synthetic-key-never-sent-to-a-network';
const source = '第4条 公司应于2029年12月31日前提交合成资料。';
const clauses = [{ text: source, locator: { page: 2, paragraph: 3 }, clause_number: '第4条' }];
const live = {
  LLM_MODE: 'live', LLM_PROVIDER: 'openai_compatible', LLM_API_KEY: key,
  LLM_MODEL: 'deepseek-flash', LLM_BASE_URL: 'https://api.deepseek.com',
  ALLOW_EXTERNAL_MODEL: 'true', retry_delay_ms: 0,
};
const modelEnvironment = [
  'LLM_MODE', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_JSON_MODE', 'LLM_TIMEOUT_MS',
  'LLM_MAX_TOKENS', 'LLM_REASONING_EFFORT', 'LLM_TEMPERATURE', 'GLM_API_KEY', 'GLM_MODEL', 'GLM_BASE_URL',
  'ALLOW_EXTERNAL_MODEL', 'ALLOW_EXTERNAL_DATA',
];
let networkTrap: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const name of modelEnvironment) vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'test');
  networkTrap = vi.fn(async () => { throw new Error('测试禁止连接真实网络'); });
  vi.stubGlobal('fetch', networkTrap);
});
afterEach(() => {
  try { expect(networkTrap).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

function candidate(text = source, clauseIndex = 0) {
  return {
    title: '提交合成资料', description: '仅为合成模型返回', obligor: '合成公司', action: '提交', deliverable: '合成资料', trigger: '',
    deadline_rule: { schema_version: 1, confirmation_status: 'confirmed', original_expression: '2029年12月31日前', kind: 'fixed', date: '2029-12-31', convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } },
    unresolved_items: [], source_text: text, locator: { page: 999 }, clause_number: '模型伪造条款号', clause_index: clauseIndex,
  };
}

function envelope(message: Record<string, unknown>, finishReason = 'stop') {
  return { id: 'req-safe-123', model: 'untrusted-response-model', choices: [{ finish_reason: finishReason, message }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, secret: key } };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-safe-123' } });
}

function success(candidates: unknown[] = [candidate()]) {
  return response(envelope({ content: JSON.stringify({ candidates }) }));
}

async function expectFailure(config: Record<string, unknown>, code: string) {
  const error = await extractCandidates(clauses, config).then(() => null, failure => failure);
  expect(error).toMatchObject({ code });
  expect(`${error.message}${JSON.stringify(error.error_details ?? {})}`).not.toContain(key);
  expect(error.message).not.toContain('synthetic-private-transport');
  return error;
}

describe('model configuration without external requests', () => {
  it('retains legacy GLM configuration and the official GLM endpoint', () => {
    const config = resolveModelConfig({ GLM_API_KEY: key, GLM_MODEL: 'synthetic-glm', ALLOW_EXTERNAL_MODEL: 'true' });
    expect(config).toMatchObject({ provider: 'glm', apiKey: key, model: 'synthetic-glm', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', timeoutMs: 120000, jsonMode: true, configured: true, ready: true });
    expect(config.issues).toEqual([]);
  });

  it('prefers explicit generic lower-case aliases over upper-case and legacy values', () => {
    const config = resolveModelConfig({ llm_provider: 'openai_compatible', LLM_PROVIDER: 'glm', llm_api_key: key, LLM_API_KEY: 'synthetic-other', GLM_API_KEY: 'synthetic-legacy', llm_model: 'deepseek-flash', LLM_MODEL: 'other-model', llm_base_url: 'https://api.deepseek.com', ALLOW_EXTERNAL_MODEL: true });
    expect(config).toMatchObject({ provider: 'openai_compatible', apiKey: key, model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', ready: true });
  });

  it.each([
    ['https://models.example', 'https://models.example/chat/completions'],
    ['https://models.example/v1/', 'https://models.example/v1/chat/completions'],
    ['https://models.example/v1/chat/completions', 'https://models.example/v1/chat/completions'],
    ['https://models.example/v1/chat/completions/', 'https://models.example/v1/chat/completions'],
  ])('normalizes a compatible base or full endpoint once: %s', (baseUrl, endpoint) => {
    expect(resolveModelConfig({ ...live, LLM_BASE_URL: baseUrl }).endpoint).toBe(endpoint);
  });

  it('never borrows GLM credentials or an endpoint for another provider', () => {
    const config = resolveModelConfig({ LLM_PROVIDER: 'openai_compatible', LLM_MODEL: 'deepseek-flash', GLM_API_KEY: key, GLM_BASE_URL: 'https://legacy.example/v4', ALLOW_EXTERNAL_MODEL: 'true' });
    expect(config.configured).toBe(false);
    expect(config.ready).toBe(false);
    expect(config.apiKey).not.toBe(key);
    expect(config.endpoint).not.toContain('legacy.example');
    expect(config.issues.some(issue => issue.code === 'MODEL_NOT_CONFIGURED')).toBe(true);
  });

  it.each([
    'http://models.example/v1',
    'https://user:synthetic-private-transport@models.example/v1',
    'https://models.example/v1?api_key=synthetic-private-transport',
    'https://models.example/v1#synthetic-private-transport',
    'not a valid model URL',
    'https://models.example:invalid/v1',
  ])('rejects an unsafe or malformed model URL without echoing it: %s', baseUrl => {
    const config = resolveModelConfig({ ...live, LLM_BASE_URL: baseUrl });
    expect(config.ready).toBe(false);
    expect(config.issues.some(issue => issue.code === 'MODEL_CONFIG_INVALID')).toBe(true);
    const status = getModelStatus({ ...live, LLM_BASE_URL: baseUrl });
    expect(JSON.stringify(status)).not.toContain('synthetic-private-transport');
    expect(JSON.stringify(status)).not.toContain(key);
  });

  it.each([
    { LLM_PROVIDER: 'unknown-provider' }, { LLM_JSON_MODE: 'yes' },
    { LLM_TIMEOUT_MS: 0 }, { LLM_TIMEOUT_MS: -1 }, { LLM_TIMEOUT_MS: 1.5 }, { LLM_TIMEOUT_MS: 600001 },
    { LLM_MAX_TOKENS: 0 }, { LLM_MAX_TOKENS: '9007199254740992' },
    { LLM_TEMPERATURE: 'Infinity' }, { LLM_TEMPERATURE: 2.1 }, { LLM_REASONING_EFFORT: 'ultra' },
  ])('reports invalid optional configuration before any request: %j', invalid => {
    const config = resolveModelConfig({ ...live, ...invalid });
    expect(config.ready).toBe(false);
    expect(config.issues.some(issue => issue.code === 'MODEL_CONFIG_INVALID')).toBe(true);
  });

  it('parses optional numeric values and keeps unspecified generation knobs absent', () => {
    const defaults = resolveModelConfig(live);
    expect(defaults).toMatchObject({ timeoutMs: 120000, jsonMode: true });
    expect(defaults.temperature).toBeUndefined();
    expect(defaults.maxTokens).toBeUndefined();
    const explicit = resolveModelConfig({ ...live, LLM_JSON_MODE: 'false', LLM_TIMEOUT_MS: '2500', LLM_MAX_TOKENS: '128', LLM_REASONING_EFFORT: 'none', LLM_TEMPERATURE: '0' });
    expect(explicit).toMatchObject({ jsonMode: false, timeoutMs: 2500, maxTokens: 128, reasoningEffort: 'none', temperature: 0, ready: true });
  });

  it('exposes only public model status and distinguishes configuration from external-data authorization', () => {
    const status = getModelStatus({ ...live, LLM_BASE_URL: 'https://models.example/private-tenant/v1', ALLOW_EXTERNAL_MODEL: 'false' });
    expect(status).toMatchObject({ provider: 'openai_compatible', model: 'deepseek-flash', host: 'models.example', configured: true, ready: false });
    expect(status.issues.some(issue => issue.code === 'MODEL_DATA_NOT_AUTHORIZED')).toBe(true);
    expect(JSON.stringify(status)).not.toContain(key);
    expect(JSON.stringify(status)).not.toContain('private-tenant');
  });
});

describe('guarded Chat Completions extraction through in-memory transports', () => {
  it('keeps the default mock usable without a key even when live configuration is invalid', async () => {
    const result = await extractCandidates(clauses, { LLM_PROVIDER: 'invalid', LLM_BASE_URL: 'http://invalid.example' });
    expect(result.state).toBe('succeeded');
    expect(result.model).toBe('deterministic-mock-v1');
    expect(result.candidates).toHaveLength(1);
  });

  it('hard-blocks an un-injected live transport in automatic tests', async () => {
    await expectFailure(live, 'TEST_OUTBOUND_BLOCKED');
  });

  it('requires explicit permission before even an injected transport sees protocol text', async () => {
    const fetcher = vi.fn(async () => success());
    await expectFailure({ ...live, ALLOW_EXTERNAL_MODEL: 'false', fetcher }, 'MODEL_DATA_NOT_AUTHORIZED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ LLM_BASE_URL: 'http://models.example' }, { LLM_TIMEOUT_MS: 0 }])('blocks invalid live configuration before its injected transport: %j', async invalid => {
    const fetcher = vi.fn(async () => success());
    await expectFailure({ ...live, ...invalid, fetcher }, 'MODEL_CONFIG_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not transmit a legacy GLM key to a compatible provider with missing credentials', async () => {
    const fetcher = vi.fn(async () => success());
    await expectFailure({ ...live, LLM_API_KEY: '', GLM_API_KEY: key, fetcher }, 'MODEL_NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([key, `model-prefix-${key}-suffix`])('rejects a credential pasted into the model name before transport or audit exposure: %s', async model => {
    const config = { ...live, LLM_MODEL: model };
    const resolved = resolveModelConfig(config);
    expect(resolved).toMatchObject({ configured: false, ready: false });
    expect(resolved.issues.some(issue => issue.code === 'MODEL_CONFIG_INVALID')).toBe(true);
    expect(JSON.stringify(getModelStatus(config))).not.toContain(key);
    const fetcher = vi.fn(async () => response({ error: { message: key } }, 401));
    const error = await expectFailure({ ...config, fetcher }, 'MODEL_CONFIG_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(key);
    expect(JSON.stringify({ model: error.model, metadata: error.response_metadata, details: error.error_details })).not.toContain(key);
  });

  it('sends DeepSeek none reasoning and configured JSON mode while omitting an unspecified temperature', async () => {
    const fetcher = vi.fn(async () => success());
    const result = await extractCandidates(clauses, { ...live, LLM_REASONING_EFFORT: 'none', LLM_MAX_TOKENS: 1024, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${key}`);
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'none', max_tokens: 1024, response_format: { type: 'json_object' } });
    expect(body).not.toHaveProperty('temperature');
    expect(result).toMatchObject({ provider: 'openai_compatible', model: 'deepseek-flash', state: 'succeeded' });
    expect(result.request_ids).toContain('req-safe-123');
    expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    expect(result.usage).not.toHaveProperty('secret');
    expect(result.response_metadata).toEqual([expect.objectContaining({ chunk_index: 0, attempt: 1, model: 'deepseek-flash' })]);
  });

  it('omits JSON response_format when disabled and transmits an explicitly selected temperature', async () => {
    const fetcher = vi.fn(async () => success());
    await extractCandidates(clauses, { ...live, LLM_JSON_MODE: false, LLM_TEMPERATURE: 0.25, fetcher });
    const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.temperature).toBe(0.25);
  });

  it('drops response identifiers that contain a credential rather than copying them into audit metadata', async () => {
    const data = { ...envelope({ content: JSON.stringify({ candidates: [candidate()] }) }), id: `request-${key}` };
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'x-request-id': key } }) });
    expect(JSON.stringify({ ids: result.request_ids, metadata: result.response_metadata })).not.toContain(key);
    expect(result.model).toBe('deepseek-flash');
  });

  it('uses legacy GLM credentials with an explicitly selected GLM provider', async () => {
    const fetcher = vi.fn(async () => success());
    const result = await extractCandidates(clauses, { LLM_MODE: 'live', LLM_PROVIDER: 'glm', GLM_API_KEY: key, GLM_MODEL: 'synthetic-glm', ALLOW_EXTERNAL_MODEL: 'true', fetcher });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(JSON.parse(String(options.body)).model).toBe('synthetic-glm');
    expect(result).toMatchObject({ provider: 'glm', model: 'synthetic-glm' });
  });

  it('restores authoritative source location and forces valid model rules back to human review', async () => {
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => success() });
    expect(result.candidates[0]).toMatchObject({ locator: { page: 2, paragraph: 3 }, clause_number: '第4条', source_text: source, deadline_rule: { confirmation_status: 'needs_review' } });
  });

  it.each([
    { schema_version: 1, confirmation_status: 'confirmed', original_expression: '伪造起算条件', kind: 'relative', anchor: { type: 'event', event_id: 'invented-event-id' }, offsets: [{ amount: 5, unit: 'calendar_day', include_start_day: false }], convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } },
    { schema_version: 1, confirmation_status: 'confirmed', original_expression: '伪造固定日期', kind: 'fixed', date: '2030-01-01', convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } },
  ])('keeps unsupported dates or fabricated references unresolved instead of inventing business inputs', async deadlineRule => {
    const result = await extractCandidates(clauses, { ...live, fetcher: async () => success([{ ...candidate(), deadline_rule: deadlineRule }]) });
    expect(result.candidates[0].deadline_rule).toBeNull();
    expect(result.candidates[0].unresolved_items.length).toBeGreaterThan(0);
  });

  it.each([
    ['MODEL_SCHEMA_INVALID', { candidates: [{ title: '结构缺失', source_text: source }] }],
    ['MODEL_SOURCE_INVALID', { candidates: [{ ...candidate(), source_text: '原文不存在的义务' }] }],
    ['MODEL_SOURCE_INVALID', { candidates: [{ ...candidate(), clause_index: 99 }] }],
  ])('rejects invalid candidates rather than importing them: %s', async (code, output) => {
    const fetcher = vi.fn(async () => response(envelope({ content: JSON.stringify(output) })));
    await expectFailure({ ...live, fetcher }, String(code));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['MODEL_OUTPUT_TRUNCATED', { content: JSON.stringify({ candidates: [candidate()] }) }, 'length'],
    ['MODEL_REFUSED', { content: null, refusal: 'synthetic-private-transport' }, 'stop'],
    ['MODEL_REFUSED', { content: null }, 'content_filter'],
    ['MODEL_EMPTY_RESPONSE', { content: '   ' }, 'stop'],
    ['MODEL_EMPTY_RESPONSE', {}, 'stop'],
    ['MODEL_JSON_INVALID', { content: `{"secret":"${key}"` }, 'stop'],
  ])('keeps a permanent model response error bounded and redacted: %s', async (code, message, finishReason) => {
    const fetcher = vi.fn(async () => response(envelope(message as Record<string, unknown>, String(finishReason))));
    await expectFailure({ ...live, fetcher }, String(code));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('recovers from two transient HTTP %s responses on the third attempt', async status => {
    const fetcher = vi.fn(async () => fetcher.mock.calls.length < 3 ? response({ error: { message: key } }, status) : success());
    const result = await extractCandidates(clauses, { ...live, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.state).toBe('succeeded');
    expect(result.candidates).toHaveLength(1);
  });

  it.each([[429, 'MODEL_RATE_LIMITED'], [503, 'MODEL_UNAVAILABLE']])('limits persistent HTTP %s failures to three redacted attempts', async (status, code) => {
    const fetcher = vi.fn(async () => response({ error: { message: `${key} synthetic-private-transport` } }, Number(status)));
    await expectFailure({ ...live, fetcher }, String(code));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent authentication rejection or expose its response body', async () => {
    const fetcher = vi.fn(async () => response({ error: { message: `${key} synthetic-private-transport` } }, 401));
    await expectFailure({ ...live, fetcher }, 'MODEL_REJECTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'TypeError', error: () => new TypeError(`body terminated ${key}`), code: 'MODEL_NETWORK_ERROR' },
    { name: 'ECONNRESET', error: () => Object.assign(new Error(`body reset ${key}`), { code: 'ECONNRESET' }), code: 'MODEL_NETWORK_ERROR' },
    { name: 'AbortError', error: () => new DOMException(`body aborted ${key}`, 'AbortError'), code: 'MODEL_TIMEOUT' },
  ])('retries a 200 response whose body stream fails with $name at most three times', async ({ error: makeError, code }) => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(makeError()); } }), { headers: { 'Content-Type': 'application/json' } }));
    const error = await expectFailure({ ...live, fetcher }, code);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(error.response_metadata).toHaveLength(3);
    expect(error.response_metadata.every((attempt: { error_code: string }) => attempt.error_code === code)).toBe(true);
  });

  it('recovers when the first two 200 response bodies terminate before a complete JSON envelope arrives', async () => {
    const fetcher = vi.fn(async () => fetcher.mock.calls.length < 3
      ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('synthetic body terminated')); } }))
      : success());
    const result = await extractCandidates(clauses, { ...live, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.state).toBe('succeeded');
    expect(result.candidates).toHaveLength(1);
  });

  it('does not retry a genuine JSON SyntaxError in a fully received HTTP response body', async () => {
    const fetcher = vi.fn(async () => new Response(`{"secret":"${key}"`, { headers: { 'Content-Type': 'application/json' } }));
    await expectFailure({ ...live, fetcher }, 'MODEL_RESPONSE_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the configured abort timeout and never exceeds three attempts', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = options.signal!; signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expectFailure({ ...live, LLM_TIMEOUT_MS: 5, fetcher }, 'MODEL_TIMEOUT');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('preserves successful chunks, selected provider/model and safe failure details in partial runs', async () => {
    const first = '第1条 公司应提交合成资料。', second = '第2条 公司应报送合成报告。';
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const part = JSON.parse(JSON.parse(String(options.body)).messages[1].content);
      return part[0].clause_index === 0 ? success([candidate(first, 0)]) : response({ error: { message: `${key} synthetic-private-transport` } }, 503);
    });
    const result = await extractCandidates([{ text: first, locator: { paragraph: 1 } }, { text: second, locator: { paragraph: 2 } }], { ...live, chunk_chars: 10, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ provider: 'openai_compatible', model: 'deepseek-flash', state: 'partial' });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].locator).toEqual({ paragraph: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.error_details).toEqual([expect.objectContaining({ chunk_index: 1, code: 'MODEL_UNAVAILABLE' })]);
    expect(JSON.stringify(result.error_details)).not.toContain(key);
    expect(JSON.stringify(result.error_details)).not.toContain('synthetic-private-transport');
  });
});
