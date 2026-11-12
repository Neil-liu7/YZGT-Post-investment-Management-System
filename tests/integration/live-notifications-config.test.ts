import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mayStartNotificationVerification, newNotificationTransmissionAttempts, notificationLedgerSummary, notificationTestBody, notificationVerificationArguments, publicNotificationConfiguration, resolveNotificationVerification, type NotificationLedger } from '../../scripts/live-notification-config';

const email = { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'synthetic-account', SMTP_PASS: 'synthetic"\\password', SMTP_FROM: 'sender@example.invalid', MAIL_TO: 'recipient@example.invalid' };
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-hook-token';
let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchTrap = vi.fn(() => { throw new Error('No network is allowed'); }); vi.stubGlobal('fetch', fetchTrap); });
afterEach(() => { expect(fetchTrap).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const empty = (): NotificationLedger => ({ notifications: [], attempts: [], reminders: 0, projects: 0, tasks: 0 });

describe('live notification CLI arguments and configuration', () => {
  it('defaults to configuration-only with no channel or live operation', () => {
    expect(notificationVerificationArguments([])).toEqual({ live: false, channel: undefined, issues: [] });
  });
  it('requires an explicit single channel before any real operation', () => {
    expect(notificationVerificationArguments(['--live']).issues[0].code).toBe('CHANNEL_REQUIRED');
    expect(notificationVerificationArguments(['--live', '--channel=email'])).toEqual({ live: true, channel: 'email', issues: [] });
    expect(notificationVerificationArguments(['--live', '--channel=feishu']).issues).toEqual([]);
    for (const args of [['--channel=email', '--channel=feishu'], ['--live', '--live', '--channel=email'], ['--file=anything'], ['--message=anything'], ['--channel=other']]) expect(notificationVerificationArguments(args).issues.length).toBeGreaterThan(0);
  });
  it('rejects missing email configuration without exposing inputs in public diagnostics', () => {
    const config = resolveNotificationVerification('email', {});
    expect(config.configured).toBe(false);
    expect(config.targetHash).toBe('');
    expect(config.issues.length).toBeGreaterThan(0);
    expect(config.idempotencyKey).toBe('');
  });
  it.each([
    { SMTP_HOST: 'https://smtp.example.invalid' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' },
    { SMTP_PORT: '465.5' }, { SMTP_SECURE: 'yes' }, { SMTP_SECURE: 'false' },
    { SMTP_USER: '' }, { SMTP_PASS: '' }, { SMTP_FROM: 'invalid' }, { MAIL_TO: '' },
    { MAIL_TO: 'recipient@example.invalid\r\nBcc:outside@example.invalid' },
  ])('blocks an incomplete or unsafe SMTP setup: %j', override => {
    expect(resolveNotificationVerification('email', { ...email, ...override }).configured).toBe(false);
  });
  it('keeps literal authentication secrets and prevents cross-channel credentials in the child environment', () => {
    const password = ' synthetic password ';
    const config = resolveNotificationVerification('email', { ...email, SMTP_PASS: password, FEISHU_WEBHOOK_URL: webhook });
    expect(config.configured).toBe(true);
    expect(config.privateEnvironment.SMTP_PASS).toBe(password);
    expect(config.privateEnvironment.FEISHU_WEBHOOK_URL).toBe('');
    expect(JSON.stringify(publicNotificationConfiguration(config))).not.toContain(password);
  });
  it('uses one persistent key for recipient casing, ordering and duplicates', () => {
    const first = resolveNotificationVerification('email', { ...email, MAIL_TO: 'B@example.invalid, a@example.invalid, A@example.invalid' });
    const second = resolveNotificationVerification('email', { ...email, MAIL_TO: 'a@example.invalid; b@example.invalid' });
    expect(first.configured).toBe(true);
    expect(first.targetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.targetHash).toBe(second.targetHash);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).not.toContain('example.invalid');
    expect(first.idempotencyKey).not.toBe(resolveNotificationVerification('email', { ...email, MAIL_TO: 'other@example.invalid' }).idempotencyKey);
    const safe = JSON.stringify(publicNotificationConfiguration(first));
    expect(safe).not.toContain('a@example.invalid'); expect(safe).not.toContain('B@example.invalid'); expect(safe).not.toContain(email.SMTP_PASS);
  });
  it('accepts only the configured standard Feishu HTTPS hook and exposes only a digest', () => {
    const config = resolveNotificationVerification('feishu', { FEISHU_WEBHOOK_URL: webhook, ...email });
    expect(config.configured).toBe(true);
    expect(config.privateEnvironment.SMTP_PASS).toBe('');
    expect(config.privateEnvironment.MAIL_TO).toBe('');
    const safe = JSON.stringify(publicNotificationConfiguration(config));
    expect(safe).not.toContain(webhook); expect(safe).not.toContain('synthetic-hook-token');
    expect(config.targetHash).not.toBe(resolveNotificationVerification('feishu', { FEISHU_WEBHOOK_URL: webhook + '-other' }).targetHash);
    for (const target of ['', webhook.replace('https:', 'http:'), webhook + '?secret=x', webhook + '#x', 'https://user:password@open.feishu.cn/open-apis/bot/v2/hook/x', 'https://outside.example.invalid/hook/x']) expect(resolveNotificationVerification('feishu', { FEISHU_WEBHOOK_URL: target }).configured).toBe(false);
  });
});

describe('persistent notification audit prevents repeat sends', () => {
  it('does not attribute an existing attempt to a lock contender with an unknown baseline', () => {
    const existing = { ...empty(), attempts: [{ notification_id: 'other-invocation' }] };
    expect(newNotificationTransmissionAttempts(existing, undefined)).toBe(0);
    expect(newNotificationTransmissionAttempts(existing, empty())).toBe(1);
    expect(newNotificationTransmissionAttempts(existing, existing)).toBe(0);
  });
  it('allows a fresh empty ledger only', () => { expect(mayStartNotificationVerification(empty())).toBe(true); });
  it.each(['succeeded', 'unknown', 'queued', 'sending', 'retry_wait', 'failed', 'obsolete', 'mock_completed'])('never starts another service for an existing %s batch', status => {
    expect(mayStartNotificationVerification({ ...empty(), notifications: [{ id: 'existing', status }] })).toBe(false);
  });
  it('reports transport acceptance as receipt pending, never as complete live delivery', () => {
    const ledger = empty();
    ledger.notifications = [{ id: 'synthetic-batch', channel: 'email', mode: 'live', purpose: 'test', project_id: null, status: 'succeeded', content: { body: notificationTestBody, items: [] }, reminder_ids: [] }];
    ledger.attempts = [{ notification_id: 'synthetic-batch', attempt_number: 1, mode: 'live', status: 'succeeded', started_at: '2026-11-12T00:00:00Z', external_id: 'private@address.invalid' }];
    const result = notificationLedgerSummary(ledger, 'email');
    expect(result).toMatchObject({ status: 'transport_accepted', receipt_status: 'receipt_pending', batch_count: 1, attempt_count: 1 });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private@address.invalid');
    expect(JSON.stringify(result)).not.toContain('live_passed');
    ledger.notifications[0].status = 'unknown'; expect(notificationLedgerSummary(ledger, 'email').status).toBe('result_unknown');
  });
  it('rejects business content, multiple attempts and other data as successful verification', () => {
    const ledger = empty();
    ledger.notifications = [{ id: 'batch', channel: 'email', mode: 'live', purpose: 'manual', project_id: 'project', status: 'succeeded', content: { body: 'real project data', items: [{ id: 'task' }] }, reminder_ids: ['reminder'] }];
    ledger.attempts = [{ notification_id: 'batch', mode: 'live' }, { notification_id: 'batch', mode: 'live' }]; ledger.projects = 1; ledger.tasks = 1; ledger.reminders = 1;
    const result = notificationLedgerSummary(ledger, 'email');
    expect(result.status).not.toBe('transport_accepted');
    expect(result.checks).toMatchObject({ exactly_one_attempt: false, test_message_only: false, no_automatic_reminders: false, no_business_data: false });
  });
});
