import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationTestBody, resolveNotificationVerification, type VerificationChannel } from '../../scripts/live-notification-config';
import { assertUnknownRecoveryLedger, smtpRecoveryPreflight, unknownRecoveryArguments, unknownRecoverySummary, type RecoveryLedger } from '../../scripts/unknown-notification-recovery';

const email = { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'synthetic-user', SMTP_PASS: 'synthetic-password', SMTP_FROM: 'sender@example.invalid', MAIL_TO: 'recipient@example.invalid' };
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-recovery-hook';
const reason = '经人工核查连接恢复，另行批准一次合成测试重发。';
const args = ['--live', '--resend-unknown', '--channel=email', `--reason=${reason}`];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const config = (channel: VerificationChannel = 'email') => resolveNotificationVerification(channel, channel === 'email' ? email : { FEISHU_WEBHOOK_URL: webhook });

function original(channel: VerificationChannel = 'email'): RecoveryLedger {
  return {
    notifications: [{
      id: 'synthetic-recovery-batch', channel, mode: 'live', purpose: 'test', project_id: null,
      status: 'unknown', attempts: 1, recipients: channel === 'email' ? ['recipient@example.invalid'] : [],
      recipient_key: channel === 'email' ? `email:${digest('recipient@example.invalid')}` : `feishu:${digest(JSON.stringify(webhook))}`,
      content: { subject: '投后管理渠道测试', body: notificationTestBody, items: [] }, reminder_ids: [],
    }],
    attempts: [{
      id: 'synthetic-original-attempt', notification_id: 'synthetic-recovery-batch', attempt_number: 1,
      status: 'unknown', mode: 'live', started_at: '2026-11-12T05:17:57.000Z', finished_at: '2026-11-12T05:17:58.000Z',
      error_code: 'TRANSPORT_UNKNOWN', external_id: null, audit_detail: { original: 'preserve exactly' },
    }],
    reminders: 0, projects: 0, tasks: 0, business_rows: 0,
  };
}

function recovered(before: RecoveryLedger, status = 'succeeded', attemptStatus = status): RecoveryLedger {
  const result = structuredClone(before);
  const next = before.attempts.length + 1;
  result.notifications[0].status = status; result.notifications[0].attempts = next;
  result.attempts.push({
    id: `synthetic-recovery-attempt-${next}`, notification_id: 'synthetic-recovery-batch', attempt_number: next,
    status: attemptStatus, mode: 'live', started_at: '2026-11-12T06:45:00.000Z', finished_at: '2026-11-12T06:45:01.000Z',
    external_id: 'synthetic-private-id@address.invalid', error: 'synthetic-private-error', response: { secret: 'synthetic-response-secret' },
  });
  return result;
}

let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchTrap = vi.fn(() => { throw new Error('Real network forbidden'); }); vi.stubGlobal('fetch', fetchTrap); });
afterEach(() => { expect(fetchTrap).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

function expectRejected(ledger: RecoveryLedger, code = 'RECOVERY_INELIGIBLE', channel: VerificationChannel = 'email') {
  expect(() => assertUnknownRecoveryLedger(ledger, config(channel))).toThrow(expect.objectContaining({ code }));
}

describe('explicit single unknown-notification recovery arguments', () => {
  it.each(['email', 'feishu'])('requires all explicit confirmations for %s', channel => {
    expect(unknownRecoveryArguments(['--live', '--resend-unknown', `--channel=${channel}`, `--reason=  ${reason}  `])).toEqual({ live: true, resendUnknown: true, channel, reason, expectedAttempts: 1, issues: [] });
  });

  it.each(['--live', '--resend-unknown', '--channel=email'])('rejects recovery without %s', missing => {
    const result = unknownRecoveryArguments(args.filter(argument => argument !== missing));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'RECOVERY_CONFIRMATION_REQUIRED' }));
  });

  it('keeps the default non-live and requires an audited reason', () => {
    const result = unknownRecoveryArguments([]);
    expect(result.live).toBe(false); expect(result.resendUnknown).toBe(false);
    expect(result.expectedAttempts).toBe(1);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['RECOVERY_CONFIRMATION_REQUIRED', 'RECOVERY_REASON_REQUIRED']));
    expect(unknownRecoveryArguments(args.filter(argument => !argument.startsWith('--reason='))).issues).toContainEqual(expect.objectContaining({ code: 'RECOVERY_REASON_REQUIRED' }));
  });

  it.each(['--live', '--resend-unknown', '--channel=feishu', '--reason=another', '--channel=other', '--message=changed', '--to=outside@example.invalid', '--force', '--live=true'])('rejects duplicate or unsupported argument %s', extra => {
    const result = unknownRecoveryArguments([...args, extra]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it.each(['', '   ', 'x'.repeat(2001), 'audit\nline', 'audit\rline', 'audit\tline', 'audit\u0000line', 'audit\u007fline'])('rejects an empty, oversized or control-bearing reason %#', value => {
    expect(unknownRecoveryArguments([...args.slice(0, 3), `--reason=${value}`]).issues).toContainEqual(expect.objectContaining({ code: 'RECOVERY_REASON_REQUIRED' }));
  });

  it('allows the upper reason boundary and the separate reason value form', () => {
    expect(unknownRecoveryArguments([...args.slice(0, 3), `--reason=${'x'.repeat(2000)}`]).issues).toEqual([]);
    expect(unknownRecoveryArguments([...args.slice(0, 3), '--reason', reason])).toMatchObject({ reason, issues: [] });
  });
});

describe('explicit two-unknown baseline arguments', () => {
  it('requires the literal second-baseline flag while retaining every existing confirmation', () => {
    expect(unknownRecoveryArguments([...args, '--expected-attempts=2'])).toMatchObject({ expectedAttempts: 2, issues: [] });
    expect(unknownRecoveryArguments(['--expected-attempts=2']).issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['RECOVERY_CONFIRMATION_REQUIRED', 'RECOVERY_REASON_REQUIRED']));
  });

  it.each(['0', '1', '3', '-1', '02', '2.0', '+2', '2e0', 'Infinity', ''])('rejects unsupported explicit baseline %s', value => {
    expect(unknownRecoveryArguments([...args, `--expected-attempts=${value}`]).issues).toContainEqual(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('rejects duplicate and noncanonical count flags', () => {
    for (const extra of [['--expected-attempts=2', '--expected-attempts=2'], ['--expected-attempts', '2'], ['--expected-attempts=2 ', '--force']]) {
      expect(unknownRecoveryArguments([...args, ...extra]).issues).toContainEqual(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });
});

describe('connection-only SMTP recovery preflight', () => {
  it('verifies once and closes once when authentication succeeds', async () => {
    const verify = vi.fn(async () => true), close = vi.fn();
    const factory = vi.fn(() => ({ verify, close }));
    await expect(smtpRecoveryPreflight(factory)).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('closes once and hides private verification error details behind a stable failure', async () => {
    const secret = 'synthetic-preflight-password';
    const verify = vi.fn(async () => { throw Object.assign(new Error(secret), { response: secret, code: 'SYNTHETIC_PRIVATE_CODE' }); }), close = vi.fn();
    const error = await smtpRecoveryPreflight(() => ({ verify, close })).catch(error => error);
    expect(error).toMatchObject({ code: 'SMTP_PREFLIGHT_FAILED' });
    expect(String(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(secret);
    expect(verify).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('maps a factory failure before a transport exists without exposing its details', async () => {
    const secret = 'synthetic-private-factory-configuration';
    const factory = vi.fn(() => { throw new Error(secret); });
    const error = await smtpRecoveryPreflight(factory).catch(error => error);
    expect(error).toMatchObject({ code: 'SMTP_PREFLIGHT_FAILED' });
    expect(String(error)).not.toContain(secret); expect(factory).toHaveBeenCalledOnce();
  });

  it('keeps the connection open until a deferred verification has resolved', async () => {
    let finish!: () => void;
    const verify = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), close = vi.fn();
    const pending = smtpRecoveryPreflight(() => ({ verify, close }));
    expect(verify).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    finish(); await pending;
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for a deferred failure before closing and reports the same stable error', async () => {
    let fail!: (reason: Error) => void;
    const verify = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; })), close = vi.fn();
    const pending = smtpRecoveryPreflight(() => ({ verify, close })).catch(error => error);
    expect(close).not.toHaveBeenCalled();
    fail(new Error('synthetic-deferred-private-detail'));
    const error = await pending;
    expect(error).toMatchObject({ code: 'SMTP_PREFLIGHT_FAILED' });
    expect(String(error)).not.toContain('synthetic-deferred-private-detail'); expect(close).toHaveBeenCalledOnce();
  });

  it('also masks a cleanup failure after a successful verification', async () => {
    const secret = 'synthetic-private-close-detail';
    const verify = vi.fn(async () => true), close = vi.fn(() => { throw new Error(secret); });
    const error = await smtpRecoveryPreflight(() => ({ verify, close })).catch(error => error);
    expect(error).toMatchObject({ code: 'SMTP_PREFLIGHT_FAILED' });
    expect(String(error)).not.toContain(secret); expect(close).toHaveBeenCalledOnce();
  });
});

describe('explicit two-unknown ledger and one additional result', () => {
  it.each(['email', 'feishu'] as const)('accepts the same two frozen %s unknown attempts only with an explicit baseline of two', channel => {
    const ledger = recovered(original(channel), 'unknown'), snapshot = structuredClone(ledger);
    expect(() => assertUnknownRecoveryLedger(ledger, config(channel))).toThrow(expect.objectContaining({ code: 'RECOVERY_INELIGIBLE' }));
    expect(() => assertUnknownRecoveryLedger(ledger, config(channel), 2)).not.toThrow();
    expect(ledger).toEqual(snapshot);
    const after = recovered(ledger), result = unknownRecoverySummary(ledger, after, channel);
    expect(result).toMatchObject({ status: 'transport_accepted', receipt_status: 'receipt_pending', batch_count: 1, attempt_count: 3, new_transmission_attempts: 1 });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(after.attempts.slice(0, 2)).toEqual(snapshot.attempts);
    const publicReport = JSON.stringify(result);
    for (const privateValue of ['recipient@example.invalid', webhook, email.SMTP_PASS, 'synthetic-private-id@address.invalid', 'synthetic-private-error', 'synthetic-response-secret']) expect(publicReport).not.toContain(privateValue);
  });

  it('cannot use a baseline of two before it exists or after a third attempt exists', () => {
    expect(() => assertUnknownRecoveryLedger(original(), config(), 2)).toThrow(expect.objectContaining({ code: 'RECOVERY_INELIGIBLE' }));
    const thirdUnknown = recovered(recovered(original(), 'unknown'), 'unknown');
    expect(() => assertUnknownRecoveryLedger(thirdUnknown, config(), 2)).toThrow(expect.objectContaining({ code: 'RECOVERY_INELIGIBLE' }));
    expect(() => assertUnknownRecoveryLedger(thirdUnknown, config())).toThrow(expect.objectContaining({ code: 'RECOVERY_INELIGIBLE' }));
  });

  it.each([
    ['batch counter behind history', (ledger: RecoveryLedger) => { ledger.notifications[0].attempts = 1; }],
    ['batch counter ahead of history', (ledger: RecoveryLedger) => { ledger.notifications[0].attempts = 3; }],
    ['duplicate record id', (ledger: RecoveryLedger) => { ledger.attempts[1].id = ledger.attempts[0].id; }],
    ['missing record id', (ledger: RecoveryLedger) => { delete ledger.attempts[1].id; }],
    ['empty record id', (ledger: RecoveryLedger) => { ledger.attempts[1].id = ''; }],
    ['duplicate attempt number', (ledger: RecoveryLedger) => { ledger.attempts[1].attempt_number = 1; }],
    ['gap in attempt numbers', (ledger: RecoveryLedger) => { ledger.attempts[1].attempt_number = 3; }],
    ['reordered history', (ledger: RecoveryLedger) => { ledger.attempts.reverse(); }],
    ['first attempt from another batch', (ledger: RecoveryLedger) => { ledger.attempts[0].notification_id = 'other'; }],
    ['second attempt from another batch', (ledger: RecoveryLedger) => { ledger.attempts[1].notification_id = 'other'; }],
    ['first attempt has known success', (ledger: RecoveryLedger) => { ledger.attempts[0].status = 'succeeded'; }],
    ['second attempt has known failure', (ledger: RecoveryLedger) => { ledger.attempts[1].status = 'failed'; }],
    ['first attempt is mock', (ledger: RecoveryLedger) => { ledger.attempts[0].mode = 'mock'; }],
    ['second attempt is mock', (ledger: RecoveryLedger) => { ledger.attempts[1].mode = 'mock'; }],
    ['fixed test changed', (ledger: RecoveryLedger) => { ledger.notifications[0].content.subject = 'changed'; }],
    ['target changed', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients = ['other@example.invalid']; }],
    ['business data present', (ledger: RecoveryLedger) => { ledger.business_rows = 1; }],
  ] as const)('rejects a two-attempt baseline with %s', (_name, change) => {
    const ledger = recovered(original(), 'unknown'); change(ledger);
    expect(() => assertUnknownRecoveryLedger(ledger, config(), 2)).toThrow();
  });

  it.each([
    ['first record field', (ledger: RecoveryLedger) => { ledger.attempts[0].finished_at = null; }],
    ['first record nested audit', (ledger: RecoveryLedger) => { ledger.attempts[0].audit_detail.original = 'rewritten'; }],
    ['second record identity', (ledger: RecoveryLedger) => { ledger.attempts[1].id = 'replacement'; }],
    ['second record field', (ledger: RecoveryLedger) => { ledger.attempts[1].error = 'rewritten'; }],
    ['second record nested audit', (ledger: RecoveryLedger) => { ledger.attempts[1].response.secret = 'rewritten'; }],
  ] as const)('never accepts a successful third attempt after changing the %s', (_name, change) => {
    const before = recovered(original(), 'unknown'), after = recovered(before); change(after);
    const result = unknownRecoverySummary(before, after, 'email');
    expect(result.status).toBe('audit_mismatch'); expect(result.checks.original_unknown_preserved).toBe(false);
  });

  it.each([
    ['unknown', 'unknown', 'result_unknown'], ['failed', 'failed', 'failed_needs_review'], ['retry_wait', 'failed', 'failed_needs_review'],
  ])('preserves uncertainty for a third batch %s / attempt %s as %s', (batchState, attemptState, expected) => {
    const before = recovered(original(), 'unknown'), result = unknownRecoverySummary(before, recovered(before, batchState, attemptState), 'email');
    expect(result).toMatchObject({ status: expected, receipt_status: 'not_confirmed', attempt_count: 3, new_transmission_attempts: 1 });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it.each([
    ['third attempt not succeeded', (ledger: RecoveryLedger) => { ledger.attempts[2].status = 'unknown'; }],
    ['third attempt is mock', (ledger: RecoveryLedger) => { ledger.attempts[2].mode = 'mock'; }],
    ['third attempt has wrong number', (ledger: RecoveryLedger) => { ledger.attempts[2].attempt_number = 4; }],
    ['third attempt reuses an old id', (ledger: RecoveryLedger) => { ledger.attempts[2].id = ledger.attempts[1].id; }],
    ['fourth attempt added', (ledger: RecoveryLedger) => { ledger.attempts.push({ ...ledger.attempts[2], id: 'fourth', attempt_number: 4 }); }],
  ] as const)('rejects a successful third result if %s', (_name, change) => {
    const before = recovered(original(), 'unknown'), after = recovered(before); change(after);
    expect(unknownRecoverySummary(before, after, 'email').status).toBe('audit_mismatch');
  });
});

describe('eligible frozen synthetic unknown ledger', () => {
  it.each(['email', 'feishu'] as const)('accepts only an untouched first unknown %s attempt without mutation', channel => {
    const ledger = original(channel), snapshot = structuredClone(ledger);
    expect(() => assertUnknownRecoveryLedger(ledger, config(channel))).not.toThrow();
    expect(ledger).toEqual(snapshot);
  });

  it('blocks missing channel configuration before considering an otherwise eligible ledger', () => {
    expect(() => assertUnknownRecoveryLedger(original(), resolveNotificationVerification('email', {}))).toThrow(expect.objectContaining({ code: 'NOTIFICATION_NOT_CONFIGURED' }));
  });

  it.each([
    ['missing batch', (ledger: RecoveryLedger) => { ledger.notifications = []; }],
    ['extra batch', (ledger: RecoveryLedger) => { ledger.notifications.push(structuredClone(ledger.notifications[0])); }],
    ['missing attempt', (ledger: RecoveryLedger) => { ledger.attempts = []; }],
    ['extra attempt', (ledger: RecoveryLedger) => { ledger.attempts.push(structuredClone(ledger.attempts[0])); }],
    ['unsafe batch id', (ledger: RecoveryLedger) => { ledger.notifications[0].id = '../outside'; }],
    ['succeeded batch', (ledger: RecoveryLedger) => { ledger.notifications[0].status = 'succeeded'; }],
    ['queued batch', (ledger: RecoveryLedger) => { ledger.notifications[0].status = 'queued'; }],
    ['failed batch', (ledger: RecoveryLedger) => { ledger.notifications[0].status = 'failed'; }],
    ['already has second attempt', (ledger: RecoveryLedger) => { ledger.notifications[0].attempts = 2; }],
    ['wrong channel', (ledger: RecoveryLedger) => { ledger.notifications[0].channel = 'feishu'; }],
    ['mock batch', (ledger: RecoveryLedger) => { ledger.notifications[0].mode = 'mock'; }],
    ['business purpose', (ledger: RecoveryLedger) => { ledger.notifications[0].purpose = 'manual'; }],
    ['business project', (ledger: RecoveryLedger) => { ledger.notifications[0].project_id = 'synthetic-project'; }],
    ['changed subject', (ledger: RecoveryLedger) => { ledger.notifications[0].content.subject = 'changed synthetic subject'; }],
    ['changed body', (ledger: RecoveryLedger) => { ledger.notifications[0].content.body = 'changed synthetic body'; }],
    ['content member', (ledger: RecoveryLedger) => { ledger.notifications[0].content.items = [{ id: 'synthetic-task' }]; }],
    ['reminder member', (ledger: RecoveryLedger) => { ledger.notifications[0].reminder_ids = ['synthetic-reminder']; }],
    ['different attempt batch', (ledger: RecoveryLedger) => { ledger.attempts[0].notification_id = 'different-batch'; }],
    ['attempt already numbered 2', (ledger: RecoveryLedger) => { ledger.attempts[0].attempt_number = 2; }],
    ['first attempt succeeded', (ledger: RecoveryLedger) => { ledger.attempts[0].status = 'succeeded'; }],
    ['mock attempt', (ledger: RecoveryLedger) => { ledger.attempts[0].mode = 'mock'; }],
  ] as const)('rejects %s before any transmission', (_name, change) => {
    const ledger = original(); change(ledger); expectRejected(ledger);
  });

  it.each(['projects', 'tasks', 'reminders', 'business_rows'] as const)('rejects business data in %s', field => {
    const ledger = original(); ledger[field] = 1; expectRejected(ledger);
  });

  it.each([
    ['drifted recipient key', (ledger: RecoveryLedger) => { ledger.notifications[0].recipient_key = 'email:other'; }],
    ['replaced recipient', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients = ['other@example.invalid']; }],
    ['additional recipient', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients.push('other@example.invalid'); }],
    ['empty recipients', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients = []; }],
    ['malformed recipient', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients = ['recipient@example.invalid\r\nBcc:other@example.invalid']; }],
  ] as const)('rejects email target changes: %s', (_name, change) => {
    const ledger = original(); change(ledger); expectRejected(ledger, 'RECOVERY_TARGET_CHANGED');
  });

  it('checks the currently configured target rather than trusting a matching frozen recipient/key pair', () => {
    const changed = resolveNotificationVerification('email', { ...email, MAIL_TO: 'changed@example.invalid' });
    expect(() => assertUnknownRecoveryLedger(original(), changed)).toThrow(expect.objectContaining({ code: 'RECOVERY_TARGET_CHANGED' }));
    const changedHook = resolveNotificationVerification('feishu', { FEISHU_WEBHOOK_URL: webhook + '-changed' });
    expect(() => assertUnknownRecoveryLedger(original('feishu'), changedHook)).toThrow(expect.objectContaining({ code: 'RECOVERY_TARGET_CHANGED' }));
  });

  it('allows normalized casing and duplicates that retain the same email delivery target', () => {
    const ledger = original(); ledger.notifications[0].recipients = ['RECIPIENT@example.invalid', 'recipient@example.invalid'];
    expect(() => assertUnknownRecoveryLedger(ledger, config())).not.toThrow();
  });

  it('rejects email recipients attached to a Feishu batch', () => {
    const ledger = original('feishu'); ledger.notifications[0].recipients = ['recipient@example.invalid'];
    expectRejected(ledger, 'RECOVERY_INELIGIBLE', 'feishu');
  });

  it.each(['succeeded', 'unknown', 'failed', 'retry_wait'])('never permits another recovery after a second %s attempt exists', state => {
    const ledger = recovered(original(), state, state === 'retry_wait' ? 'failed' : state);
    expectRejected(ledger);
  });
});

describe('single recovery result retains immutable audit and delivery uncertainty', () => {
  it.each(['email', 'feishu'] as const)('accepts only one new successful %s attempt and leaves receipt pending', channel => {
    const before = original(channel), after = recovered(before), snapshot = structuredClone(before);
    const result = unknownRecoverySummary(before, after, channel);
    expect(result).toMatchObject({ status: 'transport_accepted', receipt_status: 'receipt_pending', batch_count: 1, attempt_count: 2, new_transmission_attempts: 1, runtime_provenance: { mode: 'live', purpose: 'test', content_items: 0, reminder_count: 0 } });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(before).toEqual(snapshot); expect(after.attempts[0]).toEqual(before.attempts[0]);
    const report = JSON.stringify(result);
    for (const privateValue of ['recipient@example.invalid', webhook, email.SMTP_PASS, 'synthetic-private-id@address.invalid', 'synthetic-private-error', 'synthetic-response-secret', notificationTestBody]) expect(report).not.toContain(privateValue);
    expect(result.attempts[1].external_id_hash).toBe(digest('synthetic-private-id@address.invalid'));
    expect(report).not.toContain('live_passed');
  });

  it.each([
    ['unknown', 'unknown', 'result_unknown'], ['sending', 'sending', 'result_unknown'],
    ['failed', 'failed', 'failed_needs_review'], ['retry_wait', 'failed', 'failed_needs_review'],
  ])('keeps batch %s / attempt %s as %s', (batchStatus, attemptStatus, expected) => {
    const before = original(), result = unknownRecoverySummary(before, recovered(before, batchStatus, attemptStatus), 'email');
    expect(result.status).toBe(expected); expect(result.receipt_status).toBe('not_confirmed');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it.each(['unknown', 'failed', 'sending', 'mock_completed'])('never accepts a succeeded batch whose second attempt is %s', state => {
    const before = original(), result = unknownRecoverySummary(before, recovered(before, 'succeeded', state), 'email');
    expect(result.status).toBe('audit_mismatch'); expect(result.checks.result_recorded).toBe(false);
  });

  it.each([
    ['status', (attempt: any) => { attempt.status = 'succeeded'; }],
    ['mode', (attempt: any) => { attempt.mode = 'mock'; }],
    ['id', (attempt: any) => { attempt.id = 'replaced-original'; }],
    ['start timestamp', (attempt: any) => { attempt.started_at = '2026-11-12T05:17:59.000Z'; }],
    ['finish timestamp', (attempt: any) => { attempt.finished_at = null; }],
    ['failure audit', (attempt: any) => { attempt.error_code = 'REWRITTEN'; }],
    ['nested audit', (attempt: any) => { attempt.audit_detail.original = 'changed'; }],
    ['additional field', (attempt: any) => { attempt.unapproved = true; }],
  ] as const)('rejects any original attempt mutation: %s', (_name, change) => {
    const before = original(), after = recovered(before); change(after.attempts[0]);
    const result = unknownRecoverySummary(before, after, 'email');
    expect(result.status).toBe('audit_mismatch'); expect(result.checks.original_unknown_preserved).toBe(false);
  });

  it.each([
    ['different batch', (ledger: RecoveryLedger) => { ledger.notifications[0].id = 'replacement'; }],
    ['additional batch', (ledger: RecoveryLedger) => { ledger.notifications.push(structuredClone(ledger.notifications[0])); }],
    ['missing original attempt', (ledger: RecoveryLedger) => { ledger.attempts.shift(); }],
    ['third attempt', (ledger: RecoveryLedger) => { ledger.attempts.push({ ...ledger.attempts[1], id: 'third', attempt_number: 3 }); }],
    ['wrong second number', (ledger: RecoveryLedger) => { ledger.attempts[1].attempt_number = 3; }],
    ['mock second attempt', (ledger: RecoveryLedger) => { ledger.attempts[1].mode = 'mock'; }],
    ['wrong second batch', (ledger: RecoveryLedger) => { ledger.attempts[1].notification_id = 'replacement'; }],
    ['wrong batch count', (ledger: RecoveryLedger) => { ledger.notifications[0].attempts = 3; }],
    ['changed subject', (ledger: RecoveryLedger) => { ledger.notifications[0].content.subject = 'replacement'; }],
    ['changed body', (ledger: RecoveryLedger) => { ledger.notifications[0].content.body = 'replacement'; }],
    ['business content', (ledger: RecoveryLedger) => { ledger.notifications[0].content.items = [{ id: 'task' }]; }],
    ['reminder reference', (ledger: RecoveryLedger) => { ledger.notifications[0].reminder_ids = ['reminder']; }],
    ['changed target key', (ledger: RecoveryLedger) => { ledger.notifications[0].recipient_key = 'email:replacement'; }],
    ['changed recipients', (ledger: RecoveryLedger) => { ledger.notifications[0].recipients = ['other@example.invalid']; }],
    ['business table row', (ledger: RecoveryLedger) => { ledger.business_rows = 1; }],
  ] as const)('reports audit_mismatch after %s', (_name, change) => {
    const before = original(), after = recovered(before); change(after);
    expect(unknownRecoverySummary(before, after, 'email').status).toBe('audit_mismatch');
  });
});
