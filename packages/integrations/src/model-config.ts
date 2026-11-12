export type ModelProvider = 'glm' | 'openai_compatible';
export type ModelIssue = { code: string; message: string };
export type ModelConfig = {
  provider: ModelProvider; apiKey: string; model: string; baseUrl: string; endpoint: string;
  jsonMode: boolean; timeoutMs: number; maxTokens?: number; reasoningEffort?: string; temperature?: number;
  allowExternalData: boolean; configured: boolean; ready: boolean; issues: ModelIssue[];
};

const optional = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? undefined : value;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const number = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;

/** Resolve server-only settings without requiring credentials during mock startup. */
export function resolveModelConfig(record: Record<string, any> = process.env): ModelConfig {
  const read = (key: string) => record[key.toLowerCase()] ?? record[key];
  const issues: ModelIssue[] = [];
  const invalid = (message: string) => issues.push({ code: 'MODEL_CONFIG_INVALID', message });
  const providerValue = text(read('LLM_PROVIDER')) || 'glm';
  // Unknown providers must never inherit the legacy GLM secret.
  const provider: ModelProvider = providerValue === 'glm' ? 'glm' : 'openai_compatible';
  if (!['glm', 'openai_compatible'].includes(providerValue)) invalid('模型服务类型无效。');
  const apiKey = text(read('LLM_API_KEY')) || (provider === 'glm' ? text(read('GLM_API_KEY')) : '');
  const model = text(read('LLM_MODEL')) || (provider === 'glm' ? text(read('GLM_MODEL')) : '');
  const baseUrl = text(read('LLM_BASE_URL')) || (provider === 'glm' ? text(read('GLM_BASE_URL')) || 'https://open.bigmodel.cn/api/paas/v4' : '');
  if (!apiKey) issues.push({ code: 'MODEL_NOT_CONFIGURED', message: '模型密钥未配置。' });
  else if (Array.from(apiKey).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) >= 127)) invalid('模型密钥格式无效，请检查空白或控制字符。');
  if (!model) issues.push({ code: 'MODEL_NOT_CONFIGURED', message: '模型名称未配置。' });
  else if (model.length > 500 || Array.from(model).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid('模型名称格式无效。');
  if (apiKey && model.includes(apiKey)) invalid('模型名称配置无效，请核对模型标识。');
  let endpoint = '';
  if (!baseUrl) issues.push({ code: 'MODEL_NOT_CONFIGURED', message: '模型服务地址未配置。' });
  else {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || baseUrl.includes('?') || baseUrl.includes('#')) throw new Error('invalid');
      const path = url.pathname.replace(/\/+$/, '');
      endpoint = `${url.origin}${path.endsWith('/chat/completions') ? path : `${path}/chat/completions`}`;
    } catch { invalid('模型服务地址须为有效HTTPS地址，不能包含用户信息、查询参数或片段。'); }
  }
  const jsonValue = optional(read('LLM_JSON_MODE'));
  let jsonMode = true;
  if (jsonValue !== undefined) {
    if (jsonValue === true || jsonValue === 'true') jsonMode = true;
    else if (jsonValue === false || jsonValue === 'false') jsonMode = false;
    else invalid('模型JSON模式只能设置为true或false。');
  }
  const timeoutValue = optional(read('LLM_TIMEOUT_MS')) ?? optional(read('TIMEOUT_MS'));
  const timeoutMs = timeoutValue === undefined ? 120000 : number(timeoutValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) invalid('模型超时须为1至600000毫秒的整数。');
  const maxValue = optional(read('LLM_MAX_TOKENS'));
  const maxTokens = maxValue === undefined ? undefined : number(maxValue);
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) invalid('模型输出上限须为正整数。');
  const temperatureValue = optional(read('LLM_TEMPERATURE'));
  const temperature = temperatureValue === undefined ? undefined : number(temperatureValue);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) invalid('模型温度须在0至2之间。');
  const reasoningValue = optional(read('LLM_REASONING_EFFORT'));
  const reasoningEffort = reasoningValue === undefined ? undefined : text(reasoningValue).toLowerCase();
  if (reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) invalid('模型推理强度设置无效。');
  const permission = record.allow_external_data ?? read('ALLOW_EXTERNAL_MODEL') ?? read('ALLOW_EXTERNAL_DATA');
  const allowExternalData = permission === true || permission === 'true';
  const configured = issues.length === 0;
  if (!allowExternalData) issues.push({ code: 'MODEL_DATA_NOT_AUTHORIZED', message: '尚未允许向外部模型发送协议数据。' });
  return { provider, apiKey, model, baseUrl, endpoint, jsonMode, timeoutMs, maxTokens, reasoningEffort, temperature, allowExternalData, configured, ready: configured && allowExternalData, issues };
}

/** Safe for status APIs: no key, complete endpoint, headers, or URL path is returned. */
export function getModelStatus(record: Record<string, any> = process.env) {
  const config = resolveModelConfig(record);
  let host = '';
  if (config.endpoint) host = new URL(config.endpoint).host;
  const hideSecret = (value: string) => config.apiKey && value.includes(config.apiKey) ? '已配置' : value;
  return { provider: config.provider, model: hideSecret(config.model), host: hideSecret(host), configured: config.configured, ready: config.ready, issues: config.issues };
}
