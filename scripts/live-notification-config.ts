import { createHash } from 'node:crypto';
import { normalizeRecipients } from '../packages/integrations/src/outbound';

export type VerificationChannel = 'email' | 'feishu';
type Issue = { code: string; message: string };
export type NotificationVerificationConfig = {
  channel: VerificationChannel; configured: boolean; issues: Issue[]; targetHash: string; maskedTargets: string[];
  idempotencyKey: string; privateEnvironment: Record<string, string>; secrets: string[];
};
export const notificationTestBody = '这是一条投后管理系统渠道测试消息。';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const control = (value: string) => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function notificationVerificationArguments(args: string[]) {
  let live = false; let channel: VerificationChannel | undefined;
  const issues: Issue[] = [];
  for (const argument of args) {
    if (argument === '--live' && !live) live = true;
    else if (!channel && (argument === '--channel=email' || argument === '--channel=feishu')) channel = argument.slice(10) as VerificationChannel;
    else issues.push({ code: 'INVALID_ARGUMENT', message: '仅支持单个--live及--channel=email或--channel=feishu，不能指定其他消息、目标或数据。' });
  }
  if (live && !channel) issues.push({ code: 'CHANNEL_REQUIRED', message: '真实验证必须明确指定一个通知渠道。' });
  return { live, channel, issues };
}

function maskedEmail(email: string) {
  const [local, domain] = email.split('@');
  const suffix = domain.includes('.') ? '.' + domain.split('.').at(-1) : '';
  return `${local[0]}***@${domain[0]}***${suffix}`;
}

/** Pure configuration validation; callers retain private fields on the server only. */
export function resolveNotificationVerification(channel: VerificationChannel, record: Record<string, any>): NotificationVerificationConfig {
  const read = (key: string) => text(record[key.toLowerCase()] ?? record[key]);
  const raw = (key: string) => { const value = record[key.toLowerCase()] ?? record[key]; return typeof value === 'string' ? value : ''; };
  const issues: Issue[] = [];
  const issue = (message: string) => issues.push({ code: 'NOTIFICATION_NOT_CONFIGURED', message });
  const privateEnvironment: Record<string, string> = { SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '', MAIL_TO: '', FEISHU_WEBHOOK_URL: '', FEISHU_KEYWORD: '' };
  const secrets: string[] = [];
  let targetHash = ''; let maskedTargets: string[] = [];
  if (channel === 'email') {
    const host = read('SMTP_HOST'), portText = read('SMTP_PORT') || '465', secureText = read('SMTP_SECURE') || 'true';
    const user = read('SMTP_USER'), pass = raw('SMTP_PASS'), from = read('SMTP_FROM'), to = read('MAIL_TO');
    if (!host || control(host) || /[\s/@?#]/.test(host)) issue('邮件服务器主机未配置或格式无效。');
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) issue('邮件服务器端口须为1至65535的整数。');
    if (!['true', 'false'].includes(secureText) || (port === 465 && secureText !== 'true')) issue('邮件传输安全模式无效，465端口须使用TLS。');
    if (!user || control(user)) issue('邮件认证账号未配置或格式无效。');
    if (!pass.trim() || control(pass)) issue('邮件认证凭据未配置或格式无效。');
    try { if (normalizeRecipients(from).length !== 1) issue('请配置唯一有效的发件邮箱。'); }
    catch { issue('发件邮箱格式无效。'); }
    let recipients: string[] = [];
    try { recipients = normalizeRecipients(to); if (!recipients.length) issue('测试收件邮箱未配置。'); }
    catch { issue('测试收件邮箱格式无效。'); }
    if (recipients.length) {
      targetHash = hash(JSON.stringify({ channel, recipients: recipients.map(address => address.toLowerCase()).sort() }));
      maskedTargets = recipients.map(maskedEmail);
    }
    Object.assign(privateEnvironment, { SMTP_HOST: host, SMTP_PORT: portText, SMTP_SECURE: secureText, SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: from, MAIL_TO: recipients.join(',') });
    secrets.push(user, pass, from, to, ...recipients);
  } else {
    const webhook = read('FEISHU_WEBHOOK_URL'), keyword = read('FEISHU_KEYWORD') || '投后提醒';
    if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(webhook)) issue('飞书群机器人地址未配置或格式无效。');
    else { targetHash = hash(JSON.stringify({ channel, webhook })); maskedTargets = ['已配置的飞书测试群']; }
    if (control(keyword) || keyword.length > 100) issue('飞书机器人关键字格式无效。');
    Object.assign(privateEnvironment, { FEISHU_WEBHOOK_URL: webhook, FEISHU_KEYWORD: keyword });
    secrets.push(webhook, webhook.split('/').at(-1) ?? '');
  }
  return { channel, configured: !issues.length, issues, targetHash, maskedTargets, idempotencyKey: targetHash ? `notification-test-v1:${channel}:${targetHash}` : '', privateEnvironment, secrets: secrets.filter(Boolean) };
}

export function publicNotificationConfiguration(config: NotificationVerificationConfig) {
  return { channel: config.channel, configured: config.configured, target_hash: config.targetHash || null, masked_targets: config.maskedTargets, issues: config.issues };
}

export type NotificationLedger = { notifications: any[]; attempts: any[]; reminders: number; projects: number; tasks: number };
export function newNotificationTransmissionAttempts(ledger: NotificationLedger, before?: NotificationLedger) {
  return before ? Math.max(0, ledger.attempts.length - before.attempts.length) : 0;
}
/** Any existing batch blocks a new service, including queued or interrupted sends. */
export function mayStartNotificationVerification(ledger: NotificationLedger) { return ledger.notifications.length === 0; }

export function notificationLedgerSummary(ledger: NotificationLedger, channel: VerificationChannel) {
  const batch = ledger.notifications[0];
  const attempts = ledger.attempts.filter(attempt => attempt.notification_id === batch?.id);
  const checks = {
    exactly_one_batch: ledger.notifications.length === 1,
    exactly_one_attempt: attempts.length === 1,
    accepted_attempt_recorded: batch?.status !== 'succeeded' || (attempts.length === 1 && attempts[0].status === 'succeeded'),
    live_mode: batch?.mode === 'live' && attempts.every(attempt => attempt.mode === 'live'),
    test_message_only: batch?.channel === channel && batch?.purpose === 'test' && batch?.project_id === null && batch?.content?.body === notificationTestBody && Array.isArray(batch?.content?.items) && batch.content.items.length === 0,
    no_automatic_reminders: ledger.reminders === 0 && Array.isArray(batch?.reminder_ids) && batch.reminder_ids.length === 0,
    no_business_data: ledger.projects === 0 && ledger.tasks === 0,
  };
  const state = typeof batch?.status === 'string' ? batch.status : 'not_created';
  const status = state === 'succeeded' && Object.values(checks).every(Boolean) ? 'transport_accepted'
    : ['unknown', 'sending'].includes(state) ? 'result_unknown'
    : ['failed', 'retry_wait'].includes(state) ? 'failed_needs_review'
    : state === 'not_created' ? 'not_run' : 'existing_requires_review';
  const safeState = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
  return {
    status, transport_state: safeState(state), receipt_status: state === 'succeeded' ? 'receipt_pending' : 'not_confirmed',
    batch_count: ledger.notifications.length, attempt_count: attempts.length, checks,
    attempts: attempts.map(attempt => ({ attempt_number: attempt.attempt_number, status: safeState(attempt.status), mode: safeState(attempt.mode), started_at: attempt.started_at, finished_at: attempt.finished_at ?? null, external_id_hash: typeof attempt.external_id === 'string' ? hash(attempt.external_id) : null })),
    runtime_provenance: { mode: safeState(batch?.mode), purpose: safeState(batch?.purpose), content_items: batch?.content?.items?.length ?? null, reminder_count: ledger.reminders },
  };
}
