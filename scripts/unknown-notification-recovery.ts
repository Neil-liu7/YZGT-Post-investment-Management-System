import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { feishuRecipientKey, normalizeRecipients, recipientKey } from '../packages/integrations/src/outbound';
import { notificationTestBody, type NotificationLedger, type NotificationVerificationConfig, type VerificationChannel } from './live-notification-config';

export type RecoveryLedger = NotificationLedger & { business_rows: number };
export const recoveryBusinessTables = ['projects', 'documents', 'clauses', 'events', 'obligations', 'tasks', 'evidence', 'extractions', 'drafts', 'event_drafts', 'calendars', 'change_plans', 'legacy_mappings', 'imports'] as const;
/** Historical notification ledgers remain read-only; schema 4 predates event drafts. */
export function recoveryTableCount(db: Database.Database, table: string): number {
  if (table === 'event_drafts' && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_drafts'").get()) {
    const schema = db.prepare('SELECT max(version) AS version FROM migrations').get() as { version: number };
    if (Number.isInteger(schema.version) && schema.version >= 1 && schema.version < 5) return 0;
    throw new Error('Event candidate table missing from current schema');
  }
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}
export class UnknownRecoveryError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function requireRecovery(value: unknown, code = 'RECOVERY_INELIGIBLE', message = '台账不符合指定未知合成测试批次的单次人工恢复条件。'): asserts value {
  if (!value) throw new UnknownRecoveryError(code, message);
}

export function unknownRecoveryArguments(args: string[]) {
  let live = false, resendUnknown = false, reason = ''; let channel: VerificationChannel | undefined;
  let expectedAttempts: 1 | 2 = 1;
  const seen = new Set<string>(), issues: { code: string; message: string }[] = [];
  const invalid = () => issues.push({ code: 'INVALID_ARGUMENT', message: '人工恢复仅接受单个--live、--resend-unknown、--channel=email或feishu、--reason及可选--expected-attempts=2。' });
  for (let index = 0; index < args.length; index++) {
    const argument = args[index], name = argument.split('=')[0];
    if (seen.has(name)) { invalid(); continue; } seen.add(name);
    if (argument === '--live') live = true;
    else if (argument === '--resend-unknown') resendUnknown = true;
    else if (argument === '--channel=email' || argument === '--channel=feishu') channel = argument.slice(10) as VerificationChannel;
    else if (argument === '--expected-attempts=2') expectedAttempts = 2;
    else if (argument.startsWith('--reason=')) reason = argument.slice(9).trim();
    else if (argument === '--reason' && args[index + 1] && !args[index + 1].startsWith('--')) reason = args[++index].trim();
    else invalid();
  }
  if (!live || !resendUnknown || !channel) issues.push({ code: 'RECOVERY_CONFIRMATION_REQUIRED', message: '必须明确指定真实模式、单次人工恢复和唯一渠道；本次未发送。' });
  if (!reason || reason.length > 2000 || Array.from(reason).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) issues.push({ code: 'RECOVERY_REASON_REQUIRED', message: '人工恢复原因须为1至2000字，且不能包含控制字符。' });
  return { live, resendUnknown, channel, reason, expectedAttempts, issues };
}

/** Connection/authentication only; callers provide the transport and retain the send gate. */
export async function smtpRecoveryPreflight(createTransport: () => { verify(): Promise<unknown>; close(): void }) {
  let transport: ReturnType<typeof createTransport> | undefined;
  try {
    try { transport = createTransport(); await transport.verify(); }
    finally { transport?.close(); }
  }
  catch { throw new UnknownRecoveryError('SMTP_PREFLIGHT_FAILED', '当前SMTP连接或认证预检未通过，本次没有入队或追加发送尝试。'); }
}

const emptyBusiness = (ledger: RecoveryLedger) => ledger.projects === 0 && ledger.tasks === 0 && ledger.reminders === 0 && ledger.business_rows === 0;
const fixedTest = (batch: any, channel: VerificationChannel) => batch?.channel === channel && batch.mode === 'live' && batch.purpose === 'test' && batch.project_id === null
  && batch.content?.subject === '投后管理渠道测试' && batch.content.body === notificationTestBody
  && Array.isArray(batch.content.items) && batch.content.items.length === 0 && Array.isArray(batch.reminder_ids) && batch.reminder_ids.length === 0;

function assertRecoveryScope(ledger: RecoveryLedger, config: NotificationVerificationConfig, expectedAttempts: number): void {
  requireRecovery(Number.isInteger(expectedAttempts) && expectedAttempts >= 1 && expectedAttempts <= 3);
  requireRecovery(config.configured && config.targetHash, 'NOTIFICATION_NOT_CONFIGURED', '通知配置未就绪，不能人工恢复。');
  const batch = ledger.notifications[0];
  requireRecovery(ledger.notifications.length === 1 && ledger.attempts.length === expectedAttempts && emptyBusiness(ledger));
  requireRecovery(typeof batch?.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(batch.id) && batch.attempts === expectedAttempts && fixedTest(batch, config.channel));
  requireRecovery(new Set(ledger.attempts.map(attempt => attempt?.id)).size === expectedAttempts && ledger.attempts.every((attempt, index) =>
    typeof attempt?.id === 'string' && attempt.id.length > 0 && attempt.notification_id === batch.id && attempt.attempt_number === index + 1 && attempt.mode === 'live'));
  let expectedKey: string;
  try {
    if (config.channel === 'email') {
      expectedKey = `email:${recipientKey(normalizeRecipients(config.privateEnvironment.MAIL_TO))}`;
      requireRecovery(Array.isArray(batch.recipients) && batch.recipients.length > 0 && `email:${recipientKey(normalizeRecipients(batch.recipients))}` === expectedKey, 'RECOVERY_TARGET_CHANGED', '原批次接收目标与当前配置不一致，不能人工恢复。');
    } else {
      expectedKey = feishuRecipientKey(config.privateEnvironment.FEISHU_WEBHOOK_URL);
      requireRecovery(Array.isArray(batch.recipients) && batch.recipients.length === 0);
    }
  } catch (error) {
    if (error instanceof UnknownRecoveryError) throw error;
    throw new UnknownRecoveryError('RECOVERY_TARGET_CHANGED', '原批次接收目标无效，不能人工恢复。');
  }
  requireRecovery(batch.recipient_key === expectedKey, 'RECOVERY_TARGET_CHANGED', '原批次接收目标与当前配置不一致，不能人工恢复。');
}

export function assertUnknownRecoveryLedger(ledger: RecoveryLedger, config: NotificationVerificationConfig, expectedAttempts: 1 | 2 = 1): void {
  requireRecovery(expectedAttempts === 1 || expectedAttempts === 2);
  assertRecoveryScope(ledger, config, expectedAttempts);
  requireRecovery(ledger.notifications[0].status === 'unknown' && ledger.attempts.every(attempt => attempt.status === 'unknown'));
}

/** Caller must hold this target's verification lock. This operation never claims a send or consumes resend authorization. */
export async function reconcileExpiredNotificationLease(file: string, config: NotificationVerificationConfig, readLedger: () => RecoveryLedger, now = new Date(), cancelled = () => false) {
  const before = readLedger(), batch = before.notifications[0];
  if (batch?.status !== 'sending') return null;
  const deadline = typeof batch.lease_until === 'string' ? Date.parse(batch.lease_until) : NaN;
  requireRecovery(Number.isFinite(now.getTime()) && Number.isFinite(deadline) && new Date(deadline).toISOString() === batch.lease_until, 'RECOVERY_LEASE_INVALID', '发送租约格式无效，未修改原台账。');
  if (deadline > now.getTime()) return null;
  const count = before.attempts.length;
  assertRecoveryScope(before, config, count);
  requireRecovery(before.attempts.every((attempt, index) => attempt.status === (index === count - 1 ? 'sending' : 'unknown')));
  const active = () => requireRecovery(!cancelled(), 'VERIFICATION_CANCELLED', '租约核查已取消，未请求发送。');
  active();
  const [{ Store }, { NotificationService }] = await Promise.all([import('../apps/server/src/store'), import('../apps/server/src/notifications')]);
  active();
  const store = new Store(file, () => new Date(now));
  try {
    const current = readLedger();
    requireRecovery(isDeepStrictEqual(before, current), 'RECOVERY_AUDIT_CHANGED', '租约预检后台账发生变化，未请求发送。');
    active();
    const states = (ledger: RecoveryLedger) => ({ transport_state: ledger.notifications[0].status, latest_attempt_state: ledger.attempts.at(-1)?.status });
    const reason = '仅将已过期的合成测试发送租约归为结果未知；不代表未送达，未入队或重发，仍须接收端核查和显式人工决定。';
    store.audit('notifications', batch.id, 'expired_lease_reconciliation_started', states(before), null, reason);
    const service = new NotificationService(store, { OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: 'false', adapter: () => { throw new Error('Lease reconciliation must not send'); } }, () => new Date(now));
    await service.processQueue(0);
    const after = readLedger(), latest = count - 1;
    const without = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const checks = {
      scope_preserved: isDeepStrictEqual(without(batch, ['status', 'lease_until', 'next_attempt_at', 'last_error', 'last_error_code', 'external_id', 'completed_at', 'version', 'updated_at']), without(after.notifications[0], ['status', 'lease_until', 'next_attempt_at', 'last_error', 'last_error_code', 'external_id', 'completed_at', 'version', 'updated_at'])),
      no_new_attempts: after.notifications.length === 1 && after.attempts.length === count && after.notifications[0].attempts === count,
      prior_unknown_preserved: isDeepStrictEqual(before.attempts.slice(0, -1), after.attempts.slice(0, -1)),
      latest_attempt_reconciled: after.attempts[latest]?.status === 'unknown' && after.attempts[latest]?.finished_at === now.toISOString() && isDeepStrictEqual(without(before.attempts[latest], ['status', 'finished_at', 'version', 'updated_at']), without(after.attempts[latest], ['status', 'finished_at', 'version', 'updated_at'])),
      batch_reconciled: after.notifications[0].status === 'unknown' && after.notifications[0].lease_until === null,
      no_business_data: emptyBusiness(after),
    };
    requireRecovery(Object.values(checks).every(Boolean), 'RECOVERY_RECONCILIATION_MISMATCH', '租约归并结果不符合预期，请保留台账核查，未请求重发。');
    store.audit('notifications', batch.id, 'expired_lease_reconciled', states(before), states(after), reason);
    return { status: 'reconciled_to_unknown', new_transmission_attempts: 0, attempt_count: count, before: states(before), after: states(after), checks, recorded_at: now.toISOString(), note: reason };
  } finally { store.close(); }
}

export function unknownRecoverySummary(before: RecoveryLedger, after: RecoveryLedger, channel: VerificationChannel) {
  const batch = after.notifications[0], expectedAttempts = before.attempts.length;
  const added = after.attempts[expectedAttempts];
  const checks = {
    same_single_batch: before.notifications.length === 1 && after.notifications.length === 1 && before.notifications[0].id === batch?.id,
    exactly_one_new_attempt: [1, 2].includes(expectedAttempts) && before.notifications[0]?.attempts === expectedAttempts && after.attempts.length === expectedAttempts + 1 && batch?.attempts === expectedAttempts + 1,
    original_unknown_preserved: [1, 2].includes(expectedAttempts) && before.attempts.every((original, index) => original?.status === 'unknown' && original.mode === 'live' && original.attempt_number === index + 1 && original.notification_id === before.notifications[0]?.id && isDeepStrictEqual(original, after.attempts[index])),
    new_live_attempt: added?.mode === 'live' && added.notification_id === batch?.id && added.attempt_number === expectedAttempts + 1,
    unique_attempt_ids: after.attempts.every(attempt => typeof attempt?.id === 'string' && attempt.id.length > 0) && new Set(after.attempts.map(attempt => attempt?.id)).size === after.attempts.length,
    fixed_test_and_target: fixedTest(batch, channel) && batch?.recipient_key === before.notifications[0]?.recipient_key && isDeepStrictEqual(batch?.recipients, before.notifications[0]?.recipients),
    no_business_data: emptyBusiness(before) && emptyBusiness(after),
    result_recorded: batch?.status === 'succeeded' ? added?.status === 'succeeded' : batch?.status === 'retry_wait' ? added?.status === 'failed' : added?.status === batch?.status,
  };
  const valid = Object.values(checks).every(Boolean), state = batch?.status;
  const status = !valid ? 'audit_mismatch' : state === 'succeeded' ? 'transport_accepted' : ['unknown', 'sending'].includes(state) ? 'result_unknown' : ['failed', 'retry_wait'].includes(state) ? 'failed_needs_review' : 'audit_mismatch';
  const safe = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
  return {
    status, receipt_status: status === 'transport_accepted' ? 'receipt_pending' : 'not_confirmed', transport_state: safe(state), checks,
    expected_attempts: expectedAttempts, batch_count: after.notifications.length, attempt_count: after.attempts.length, new_transmission_attempts: Math.max(0, after.attempts.length - before.attempts.length),
    attempts: after.attempts.map(attempt => ({ attempt_number: attempt.attempt_number, status: safe(attempt.status), mode: safe(attempt.mode), started_at: attempt.started_at, finished_at: attempt.finished_at ?? null, external_id_hash: typeof attempt.external_id === 'string' ? createHash('sha256').update(attempt.external_id).digest('hex') : null })),
    runtime_provenance: { mode: safe(batch?.mode), purpose: safe(batch?.purpose), content_items: batch?.content?.items?.length ?? null, reminder_count: after.reminders },
  };
}
