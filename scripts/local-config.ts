import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { resolveModelConfig } from '../packages/integrations/src/model-config';
import { resolveNotificationVerification, type VerificationChannel } from './live-notification-config';

export const secretKeys = new Set(['LLM_API_KEY', 'GLM_API_KEY', 'SMTP_PASS', 'FEISHU_WEBHOOK_URL']);
export const supportedKeys = [
  'APP_MODE', 'HOST', 'PORT', 'APP_TIMEZONE', 'DATABASE_FILE', 'STORAGE_DIR', 'BACKUP_DIR', 'MAX_UPLOAD_BYTES',
  'LLM_MODE', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_JSON_MODE', 'LLM_TIMEOUT_MS',
  'LLM_MAX_TOKENS', 'LLM_REASONING_EFFORT', 'LLM_TEMPERATURE', 'GLM_API_KEY', 'GLM_MODEL', 'GLM_BASE_URL',
  'ALLOW_EXTERNAL_MODEL', 'OUTBOUND_MODE', 'SCHEDULER_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
  'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_TO', 'FEISHU_WEBHOOK_URL', 'FEISHU_KEYWORD', 'FEISHU_SCHEDULE_TIMES',
  'OCR_MODE', 'OCR_MOCK_TEXT', 'OCR_TESSERACT_PATH', 'OCR_PDFTOPPM_PATH', 'OCR_LANG', 'OCR_TIMEOUT_MS',
  'BACKUP_SCHEDULE_ENABLED', 'BACKUP_INTERVAL_HOURS', 'BACKUP_RETENTION', 'SUPERVISOR_LOG_DIR',
  'SUPERVISOR_LOG_MAX_BYTES', 'SUPERVISOR_LOG_RETENTION', 'SUPERVISOR_ALERT_FILE',
  'SUPERVISOR_ALERT_WEBHOOK_URL', 'SUPERVISOR_ALERT_COOLDOWN_MINUTES',
] as const;
export type LocalEnv = Record<string, string>;

export function parseEnv(text: string): LocalEnv {
  const values: LocalEnv = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function quoteEnvValue(value: string): string {
  return value === '' || /[\s#='"\\]/.test(value) ? JSON.stringify(value) : value;
}

/** Update known keys while retaining comments and unknown deployment settings. */
export function renderEnv(template: string, values: LocalEnv): string {
  const seen = new Set<string>();
  const lines = template.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]); return `${match[1]}=${quoteEnvValue(values[match[1]])}`;
  });
  for (const key of supportedKeys) if (key in values && !seen.has(key)) lines.push(`${key}=${quoteEnvValue(values[key])}`);
  return `${lines.filter((line, index, all) => index !== all.length - 1 || line !== '').join('\n')}\n`;
}

export function atomicWriteEnv(file: string, content: string): void {
  const target = resolve(file); mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 }); chmodSync(temp, 0o600);
  try { renameSync(temp, target); }
  catch (error) {
    // Windows cannot atomically replace an existing file with renameSync.
    // Remove the old target only for that platform-specific fallback.
    if (process.platform !== 'win32') throw error;
    rmSync(target, { force: true }); renameSync(temp, target);
  }
  chmodSync(target, 0o600);
}

export function backupEnv(file: string, backupRoot = resolve('var', 'config-backups')): string | null {
  if (!existsSync(file)) return null;
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const target = resolve(backupRoot, `.env.${Date.now()}-${process.pid}-${randomUUID()}.bak`); copyFileSync(file, target); chmodSync(target, 0o600); return target;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function publicSecret(value: string | undefined): { configured: boolean } {
  return { configured: Boolean(value?.trim()) };
}

export type CheckResult = { ok: boolean; code: string; message: string; detail?: unknown };

export function checkConfiguration(values: LocalEnv, options: { checkNode?: boolean } = {}): { ok: boolean; checks: CheckResult[]; public: Record<string, unknown> } {
  const checks: CheckResult[] = [];
  const add = (ok: boolean, code: string, message: string, detail?: unknown) => checks.push({ ok, code, message, ...(detail === undefined ? {} : { detail }) });
  const port = Number(values.PORT || '8765');
  add(Number.isInteger(port) && port >= 1 && port <= 65535, 'PORT_VALID', '端口配置有效。', { port });
  const maxBytes = Number(values.MAX_UPLOAD_BYTES || '20971520');
  add(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'UPLOAD_LIMIT_VALID', '上传上限有效。');
  const llmMode = values.LLM_MODE || 'mock';
  add(llmMode === 'mock' || llmMode === 'live', 'LLM_MODE_VALID', '模型模式有效。', { mode: llmMode });
  const model = resolveModelConfig(values);
  if (llmMode === 'mock') add(true, 'MODEL_READY_MOCK', '模拟模型无需密钥。');
  else add(model.ready, model.ready ? 'MODEL_READY' : 'MODEL_NOT_READY', model.ready ? '真实模型配置有效。' : '真实模型配置未就绪。', { issues: model.issues.map(issue => issue.code) });
  const outbound = values.OUTBOUND_MODE || 'mock';
  add(outbound === 'mock' || outbound === 'live', 'OUTBOUND_MODE_VALID', '通知模式有效。', { mode: outbound });
  const liveChannelReady: boolean[] = [];
  for (const channel of ['email', 'feishu'] as VerificationChannel[]) {
    const result = resolveNotificationVerification(channel, values);
    const code = channel === 'email' ? 'SMTP_READY' : 'FEISHU_READY';
    if (outbound === 'mock') add(true, `${code}_MOCK`, `${channel === 'email' ? '邮件' : '飞书'}模拟模式无需真实凭据。`, { configured: result.configured });
    else {
      liveChannelReady.push(result.configured);
      add(result.configured, result.configured ? code : `${code}_NOT_READY`, result.configured ? `${channel === 'email' ? '邮件' : '飞书'}配置有效。` : `${channel === 'email' ? '邮件' : '飞书'}配置未就绪。`, { issues: result.issues.map(issue => issue.code) });
    }
  }
  const scheduler = bool(values.SCHEDULER_ENABLED);
  add(scheduler !== undefined || values.SCHEDULER_ENABLED === undefined, 'SCHEDULER_VALUE_VALID', '自动提醒开关配置有效。', { enabled: scheduler ?? false });
  if (scheduler && outbound !== 'live') add(false, 'SCHEDULER_REQUIRES_LIVE', '开启自动提醒前必须使用真实通知模式。');
  const scheduleTimes = String(values.FEISHU_SCHEDULE_TIMES || '09:00,12:00,18:00').split(/[,，;；\s]+/).filter(Boolean);
  add(scheduleTimes.length > 0 && scheduleTimes.every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)), 'FEISHU_SCHEDULE_TIMES_VALID', '飞书提醒时间有效。', { times: scheduleTimes });
  const ocrMode = values.OCR_MODE || 'disabled';
  add(['disabled', 'mock', 'tesseract'].includes(ocrMode), 'OCR_MODE_VALID', 'OCR模式配置有效。', { mode: ocrMode });
  const ocrTimeout = Number(values.OCR_TIMEOUT_MS || '120000');
  add(Number.isSafeInteger(ocrTimeout) && ocrTimeout >= 1000 && ocrTimeout <= 900000, 'OCR_TIMEOUT_VALID', 'OCR超时时间有效。', { milliseconds: ocrTimeout });
  const backupEnabled = bool(values.BACKUP_SCHEDULE_ENABLED);
  add(backupEnabled !== undefined || values.BACKUP_SCHEDULE_ENABLED === undefined, 'BACKUP_SCHEDULE_VALUE_VALID', '定时备份开关配置有效。', { enabled: backupEnabled ?? false });
  const backupInterval = Number(values.BACKUP_INTERVAL_HOURS || '24');
  add(Number.isFinite(backupInterval) && backupInterval >= 0.01, 'BACKUP_INTERVAL_VALID', '备份间隔有效。', { hours: backupInterval });
  const backupRetention = Number(values.BACKUP_RETENTION || '7');
  add(Number.isSafeInteger(backupRetention) && backupRetention >= 1, 'BACKUP_RETENTION_VALID', '备份保留数量有效。', { count: backupRetention });
  const logMaxBytes = Number(values.SUPERVISOR_LOG_MAX_BYTES || '10485760');
  add(Number.isSafeInteger(logMaxBytes) && logMaxBytes >= 1024, 'SUPERVISOR_LOG_SIZE_VALID', '日志轮换大小有效。', { bytes: logMaxBytes });
  const logRetention = Number(values.SUPERVISOR_LOG_RETENTION || '5');
  add(Number.isSafeInteger(logRetention) && logRetention >= 1, 'SUPERVISOR_LOG_RETENTION_VALID', '日志保留数量有效。', { count: logRetention });
  const alertWebhook = values.SUPERVISOR_ALERT_WEBHOOK_URL?.trim();
  if (alertWebhook) add(/^https:\/\//.test(alertWebhook), 'SUPERVISOR_ALERT_URL_VALID', '运行告警Webhook地址有效。');
  if (outbound === 'live' && !liveChannelReady.some(Boolean)) add(false, 'NO_LIVE_CHANNEL', '至少需要配置一个真实通知渠道。');
  const database = resolve(values.DATABASE_FILE || 'var/app.sqlite');
  const storage = resolve(values.STORAGE_DIR || 'storage');
  const backup = resolve(values.BACKUP_DIR || 'backups');
  for (const [name, path] of [['DATABASE_FILE', database], ['STORAGE_DIR', storage], ['BACKUP_DIR', backup]] as const) {
    try { mkdirSync(name === 'DATABASE_FILE' ? dirname(path) : path, { recursive: true }); add(true, `${name}_PATH_VALID`, `${name}路径可用。`); }
    catch { add(false, `${name}_PATH_INVALID`, `${name}路径不可写。`); }
  }
  if (options.checkNode) {
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    add(major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))), 'NODE_VERSION_VALID', 'Node.js版本满足要求。', { node: process.versions.node });
  }
  const publicConfig = {
    node: process.versions.node, llm_mode: llmMode, llm_provider: model.provider, llm_model: model.model || null,
    outbound_mode: outbound, scheduler_enabled: scheduler ?? false, port, max_upload_bytes: maxBytes,
    secrets: { llm_api_key: publicSecret(values.LLM_API_KEY || (model.provider === 'glm' ? values.GLM_API_KEY : '')), smtp_pass: publicSecret(values.SMTP_PASS), feishu_webhook: publicSecret(values.FEISHU_WEBHOOK_URL) },
  };
  const blocking = checks.filter(check => !check.ok && !['MODEL_NOT_READY', 'SMTP_READY_NOT_READY', 'FEISHU_READY_NOT_READY'].includes(check.code));
  return { ok: blocking.length === 0 && (llmMode !== 'live' || model.ready) && (outbound !== 'live' || liveChannelReady.some(Boolean)), checks, public: publicConfig };
}
