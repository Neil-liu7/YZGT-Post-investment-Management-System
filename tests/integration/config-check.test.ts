import { afterEach, describe, expect, it } from 'vitest';
import { inspectConfiguration } from '../../scripts/config-check';

const base = {
  LLM_MODE: 'mock', OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: 'false', MAX_UPLOAD_BYTES: '20971520', PORT: '8765',
  FEISHU_KEYWORD: '投后提醒',
};
const liveChannels = {
  ...base, OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: 'true',
  LLM_MODE: 'live', LLM_PROVIDER: 'openai_compatible', LLM_API_KEY: 'synthetic-key', LLM_MODEL: 'synthetic-model', LLM_BASE_URL: 'https://models.example/v1', ALLOW_EXTERNAL_MODEL: 'true',
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'user@example.com', SMTP_PASS: 'synthetic-password', SMTP_FROM: 'user@example.com', MAIL_TO: 'recipient@example.com',
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-hook',
};

afterEach(() => { delete process.env.DATABASE_FILE; });

describe('local configuration self-check', () => {
  it('accepts a mock-only first install without credentials or network access', () => {
    const result = inspectConfiguration(base, { checkPaths: false });
    expect(result.status).toBe('ready');
    expect(result.modes).toEqual({ llm: 'mock', outbound: 'mock', scheduler: false });
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });

  it('accepts complete live model and both channel configuration without connecting', () => {
    const result = inspectConfiguration(liveChannels, { checkPaths: false });
    expect(result.status).toBe('ready');
    expect(result.notifications.every(channel => channel.configured)).toBe(true);
    expect(result.model.ready).toBe(true);
    expect(result.notifications[0]).not.toHaveProperty('target');
  });

  it('allows one configured live notification channel and warns for the other', () => {
    const result = inspectConfiguration({ ...liveChannels, FEISHU_WEBHOOK_URL: '' }, { checkPaths: false });
    expect(result.status).toBe('ready');
    expect(result.notifications).toEqual([
      { channel: 'email', configured: true },
      { channel: 'feishu', configured: false },
    ]);
    expect(result.checks).toContainEqual({ code: 'FEISHU_LIVE_NOT_READY', state: 'warn', message: '真实飞书配置未就绪。' });
  });

  it('reports missing model authorization and channels as configuration gaps', () => {
    const result = inspectConfiguration({ ...base, LLM_MODE: 'live', OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: 'true' }, { checkPaths: false });
    expect(result.status).toBe('needs_configuration');
    expect(result.checks.map(check => check.code)).toEqual(expect.arrayContaining(['MODEL_LIVE_NOT_READY', 'EMAIL_LIVE_NOT_READY', 'FEISHU_LIVE_NOT_READY', 'NO_LIVE_CHANNEL']));
  });

  it('rejects automatic reminders when outbound mode remains mock', () => {
    const result = inspectConfiguration({ ...base, SCHEDULER_ENABLED: 'true' }, { checkPaths: false });
    expect(result.status).toBe('needs_configuration');
    expect(result.checks.some(check => check.code === 'SCHEDULER_REQUIRES_LIVE')).toBe(true);
  });

  it('rejects invalid upload limits, port and unsafe model URL before any connection', () => {
    const result = inspectConfiguration({ ...liveChannels, MAX_UPLOAD_BYTES: '0', PORT: '70000', LLM_BASE_URL: 'http://models.example/v1' }, { checkPaths: false });
    expect(result.status).toBe('invalid');
    expect(result.checks.map(check => check.code)).toEqual(expect.arrayContaining(['UPLOAD_LIMIT_INVALID', 'MODEL_LIVE_NOT_READY']));
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
  });

  it('warns rather than failing when checking an already running service port', () => {
    const result = inspectConfiguration(base, { checkPaths: false, portInUse: true });
    expect(result.checks).toContainEqual({ code: 'PORT_IN_USE', state: 'warn', message: '端口 8765 已被当前服务占用；如果是检查运行中的服务，可忽略。' });
  });

  it('does not hide invalid modes or runtime checks behind the summary', () => {
    const result = inspectConfiguration({ ...base, LLM_MODE: 'unsupported', OUTBOUND_MODE: 'unsupported', SCHEDULER_ENABLED: 'maybe' }, { checkPaths: false });
    expect(result.status).toBe('invalid');
    expect(result.checks.map(check => check.code)).toEqual(expect.arrayContaining(['LLM_MODE_VALID', 'OUTBOUND_MODE_VALID', 'SCHEDULER_VALUE_VALID']));
    expect(result.checks.every(check => !JSON.stringify(check).includes('synthetic'))).toBe(true);
  });

  it('requires an explicit HTTPS URL for external runtime alerts', () => {
    const result = inspectConfiguration({ ...base, SUPERVISOR_ALERT_WEBHOOK_URL: 'http://alerts.example.test/hook' }, { checkPaths: false });
    expect(result.status).toBe('invalid');
    expect(result.checks.map(check => check.code)).toContain('SUPERVISOR_ALERT_URL_VALID');
  });

  it('validates OCR mode and timeout without probing external engines', () => {
    const configured = inspectConfiguration({ ...base, OCR_MODE: 'tesseract', OCR_LANG: 'chi_sim+eng', OCR_TIMEOUT_MS: '120000' }, { checkPaths: false });
    expect(configured.status).toBe('ready');
    expect(configured.checks).toEqual(expect.arrayContaining([
      { code: 'OCR_MODE_VALID', state: 'ok', message: 'OCR模式配置有效。' },
      { code: 'OCR_TIMEOUT_VALID', state: 'ok', message: 'OCR超时时间有效。' },
    ]));

    const invalid = inspectConfiguration({ ...base, OCR_MODE: 'cloud', OCR_TIMEOUT_MS: '900' }, { checkPaths: false });
    expect(invalid.status).toBe('invalid');
    expect(invalid.checks.map(check => check.code)).toEqual(expect.arrayContaining(['OCR_MODE_VALID', 'OCR_TIMEOUT_VALID']));
  });
});
