import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { Store } from '../../apps/server/src/store';
import { Business } from '../../apps/server/src/business';
import { NotificationService } from '../../apps/server/src/notifications';
import { classifySmtpError, type OutboundResult } from '../../packages/integrations/src/outbound';

const stores: Store[] = [];
let networkCalls = 0, smtpCalls = 0;
beforeEach(() => {
  networkCalls = 0; smtpCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { networkCalls++; throw new Error('Real network forbidden'); });
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => { smtpCalls++; throw new Error('Real SMTP forbidden'); });
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  expect(networkCalls).toBe(0); expect(smtpCalls).toBe(0);
  vi.restoreAllMocks();
});

function setup(outcomes: OutboundResult[] = [{ status: 'failed', retryable: true }, { status: 'mock_completed' }]) {
  let now = new Date('2026-11-09T01:00:00Z');
  const store = new Store(':memory:', () => now); stores.push(store);
  store.create('settings', { id: 'default', feishu_enabled: false, mail_enabled: true, lead_days: 30, send_empty: true, policy_revision: 1 });
  const project = store.create('projects', { name: '合成周报项目', archived: false, deleted_at: null });
  const remaining = [...outcomes];
  const adapter = vi.fn(async () => remaining.shift() ?? { status: 'mock_completed' as const });
  const config = { OUTBOUND_MODE: 'mock', MAIL_TO: 'synthetic@example.invalid', adapter };
  const service = new NotificationService(store, config, () => now);
  const task = (title = 'A', extra: Record<string, any> = {}) => store.create('tasks', {
    project_id: project.id, title, status: 'pending', deadline_state: 'calculated', effective_due_on: '2026-11-12', activated_on: '2026-11-01', schedule_revision: 1, ...extra,
  });
  const policy = (changes: Record<string, any>) => { const old = store.require('settings', 'default'); return store.update('settings', old.id, old.version, { ...changes, policy_revision: old.policy_revision + 1 }); };
  return { store, service, config, task, policy, adapter, setTime: (value: string) => { now = new Date(value); } };
}

describe('P0 weekly digest retry preservation', () => {
  it('keeps the same sealed nonempty batch and attempt budget after unrelated settings changes', async () => {
    const s = setup([{ status: 'failed', retryable: true }, { status: 'failed', retryable: true }, { status: 'mock_completed' }]);
    const a = s.task(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    const frozenBody = first.content.body;
    await s.service.processQueue();
    s.policy({ lead_days: 7 }); s.task('封口后新增');
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'retry_wait', attempts: 2 });
    s.policy({ feishu_enabled: true });
    s.setTime('2026-11-09T01:06:00Z'); await s.service.processQueue();
    s.service.scan({ recovery: true, channels: ['email'] }); await s.service.processQueue();
    expect(s.store.all('notifications')).toHaveLength(1);
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'mock_completed', attempts: 3 });
    expect(s.store.require('notifications', first.id).content.body).toBe(frozenBody);
    expect(s.store.all('digest_runs')).toHaveLength(1);
    expect(s.store.all('digest_runs')[0].task_ids).toEqual([a.id]);
    expect(s.store.all('attempts')).toHaveLength(3); expect(s.adapter).toHaveBeenCalledTimes(3);
  });

  it('preserves a retrying empty report when send_empty remains enabled', async () => {
    const s = setup(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue(); s.policy({ lead_days: 1 });
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'mock_completed', attempts: 2 });
    expect(s.store.all('digest_runs')).toHaveLength(1); expect(s.store.all('reminders')).toHaveLength(0);
  });

  it('stops an unsent empty report when empty reports are disabled without reopening the digest', async () => {
    const s = setup(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue(); s.policy({ send_empty: false });
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'obsolete', attempts: 1 });
    s.policy({ send_empty: true }); s.task('封口后新增');
    s.service.scan({ recovery: true, channels: ['email'] }); await s.service.processQueue();
    expect(s.store.all('digest_runs')).toHaveLength(1); expect(s.adapter).toHaveBeenCalledTimes(1);
  });

  it.each(['mock_completed', 'unknown'] as const)('does not resend a %s digest after policy changes', async status => {
    const s = setup([{ status }]); s.task();
    const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0]; await s.service.processQueue();
    const originalAttempts = structuredClone(s.store.all('attempts'));
    s.policy({ lead_days: 7 }); s.service.scan({ recovery: true, channels: ['email'] }); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status, attempts: 1 });
    expect(s.store.all('attempts')).toEqual(originalAttempts); expect(s.adapter).toHaveBeenCalledTimes(1);
    expect(s.store.all('digest_runs')).toHaveLength(1);
  });

  it('rebuilds only still-eligible frozen members after a task completes or is rescheduled', async () => {
    const s = setup(); const a = s.task('完成项'), b = s.task('改期项'), c = s.task('仍需报送');
    const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0]; await s.service.processQueue();
    s.store.update('tasks', a.id, a.version, { status: 'done' });
    s.store.update('tasks', b.id, b.version, { effective_due_on: '2027-01-01', schedule_revision: 2 });
    s.policy({ lead_days: 7 }); s.task('封口后新增');
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'obsolete', attempts: 1 });
    const sent = s.store.all('notifications').find(batch => batch.status === 'mock_completed');
    expect(sent.content.items.map((item: any) => item.task_id)).toEqual([c.id]);
    expect(s.store.all('digest_runs')[0].task_ids).toEqual([a.id, b.id, c.id]);
    expect(s.store.all('digest_runs')).toHaveLength(1);
  });

  it('does not revive a cancelled reminder or cancel one rebound to another batch', async () => {
    const s = setup([{ status: 'mock_completed' }]); s.task('取消项'); s.task('被重绑定项');
    const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    const [cancelled, rebound] = s.store.all('reminders');
    s.store.update('reminders', cancelled.id, cancelled.version, { status: 'cancelled' });
    const other = s.store.create('notifications', { channel: 'email', purpose: 'manual', mode: 'mock', status: 'failed', content: { subject: '合成', body: '合成', items: [] }, reminder_ids: [], attempts: 0 });
    s.store.update('reminders', rebound.id, rebound.version, { notification_id: other.id, status: 'queued' });
    await s.service.processQueue();
    expect(s.store.require('notifications', first.id).status).toBe('obsolete');
    expect(s.store.require('reminders', cancelled.id).status).toBe('cancelled');
    expect(s.store.require('reminders', rebound.id)).toMatchObject({ notification_id: other.id, status: 'queued' });
    expect(s.adapter).not.toHaveBeenCalled();
  });

  it('pauses and resumes the same unconsumed weekly batch within the same week', async () => {
    const s = setup(); const a = s.task(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue(); s.policy({ mail_enabled: false });
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    expect(s.adapter).toHaveBeenCalledTimes(1);
    s.task('暂停后新增'); s.policy({ mail_enabled: true });
    s.service.scan({ recovery: true, channels: ['email'] }); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'mock_completed', attempts: 2 });
    expect(s.store.all('digest_runs')).toHaveLength(1);
    expect(s.store.all('digest_runs')[0].task_ids).toEqual([a.id]);
    expect(s.store.all('notifications')).toHaveLength(1);
  });

  it('discards an old-week paused report and scans only the current week after re-enabling', async () => {
    const s = setup(); s.task(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue(); s.policy({ mail_enabled: false });
    s.setTime('2026-11-16T01:00:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'obsolete', attempts: 1 });
    expect(s.store.all('attempts')).toHaveLength(1);
    s.policy({ mail_enabled: true }); const current = s.service.scan({ recovery: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue();
    expect(current.id).not.toBe(first.id);
    expect(s.store.require('notifications', current.id).status).toBe('mock_completed');
    expect(s.store.all('digest_runs').map(digest => digest.iso_week)).toEqual(['2026-W46', '2026-W47']);
    expect(s.adapter).toHaveBeenCalledTimes(2);
  });

  it('does not silently retarget a pending email after the configured recipient changes', async () => {
    const s = setup(); s.task(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0]; await s.service.processQueue();
    s.setTime('2026-11-09T01:01:00Z');
    const changed = new NotificationService(s.store, { ...s.config, MAIL_TO: 'different@example.invalid' }, () => new Date('2026-11-09T01:01:00Z'));
    await changed.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'obsolete', attempts: 1 });
    expect(s.adapter).toHaveBeenCalledTimes(1);
  });

  it.each(['2026-11-09T01:00:00Z', '2026-11-16T01:00:00Z'])('processes an explicitly authorized resend at %s while automatic switches remain off', async resumedAt => {
    const s = setup([{ status: 'unknown' }]); s.task();
    const firstWorker = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: true }, () => new Date('2026-11-09T01:00:00Z'));
    const first = firstWorker.scan({ recovery: true, channels: ['email'] }).notifications[0]; await firstWorker.processQueue();
    expect(s.store.require('notifications', first.id).status).toBe('unknown');
    s.policy({ mail_enabled: false });
    firstWorker.resolveUnknown(first.id, { action: 'resend', reason: '合成明确人工核查决定' });
    const unrelated = s.store.create('notifications', { purpose: 'automatic', mode: 'live', channel: 'email', status: 'queued', attempts: 0, content: { subject: '合成', body: '合成', items: [] }, reminder_ids: [] });
    const adapter = vi.fn(async () => ({ status: 'succeeded' as const }));
    const resumed = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: false, adapter }, () => new Date(resumedAt));
    await resumed.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(s.store.require('notifications', unrelated.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('rejects a live resend when live transport is disabled without changing the unknown history', async () => {
    const s = setup([{ status: 'unknown' }]); s.task();
    const enabled = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: true }, () => new Date('2026-11-09T01:00:00Z'));
    const first = enabled.scan({ recovery: true, channels: ['email'] }).notifications[0]; await enabled.processQueue();
    const attempts = structuredClone(s.store.all('attempts'));
    const adapter = vi.fn(async () => ({ status: 'succeeded' as const }));
    const disabled = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'mock', adapter }, () => new Date('2026-11-09T01:00:00Z'));
    expect(() => disabled.resolveUnknown(first.id, { action: 'resend', reason: '合成重新发送决定' })).toThrow(expect.objectContaining({ code: 'OUTBOUND_DISABLED' }));
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(s.store.all('attempts')).toEqual(attempts); expect(adapter).not.toHaveBeenCalled();
    disabled.resolveUnknown(first.id, { action: 'mark_succeeded', reason: '合成独立核查已经收件' });
    expect(s.store.require('notifications', first.id).status).toBe('succeeded');
    expect(s.store.all('attempts')).toEqual(attempts);
  });

  it('does not claim queued live batches or burn attempts while the outbound hard switch is off', async () => {
    const s = setup(); s.task();
    const enabled = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: true }, () => new Date('2026-11-09T01:00:00Z'));
    const manual = enabled.sendSnapshot({ snapshot_id: enabled.preview({ channel: 'email', purpose: 'test' }).id });
    s.store.update('notifications', manual.id, manual.version, { manual_resend_authorized: true });
    const automatic = enabled.scan({ recovery: true, channels: ['email'] }).notifications[0];
    const adapter = vi.fn(async () => ({ status: 'succeeded' as const }));
    const disabled = new NotificationService(s.store, { ...s.config, OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: true, adapter }, () => new Date('2026-11-09T01:00:00Z'));
    await disabled.processQueue();
    expect(s.store.require('notifications', manual.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(s.store.require('notifications', automatic.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(s.store.all('attempts')).toHaveLength(0); expect(adapter).not.toHaveBeenCalled();
  });
});

describe('P0 explicit SMTP reply severities', () => {
  it.each([
    ['EENVELOPE', 450, 'RCPT TO'], ['EMESSAGE', 451, 'DATA'], ['EMESSAGE', 452, 'DATA'], ['EAUTH', 454, 'AUTH PLAIN'],
  ])('retries explicit temporary %s/%s rejection without disclosing transport details', (code, responseCode, command) => {
    const result = classifySmtpError({ code, responseCode, command, message: 'synthetic-secret' });
    expect(result).toMatchObject({ status: 'failed', retryable: true, error_code: 'SMTP_TEMPORARY_REJECTION' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it.each([['EENVELOPE', 550], ['EMESSAGE', 554], ['EAUTH', 535]])('stops permanent %s/%s rejection', (code, responseCode) => {
    expect(classifySmtpError({ code, responseCode })).toMatchObject({ status: 'failed', retryable: false });
  });
  it('keeps socket loss unknown despite an untrusted response code and preserves TLS configuration failures', () => {
    expect(classifySmtpError({ code: 'ESOCKET', command: 'CONN', responseCode: 451 })).toMatchObject({ status: 'unknown' });
    expect(classifySmtpError({ code: 'ETLS', responseCode: 451 })).toMatchObject({ status: 'failed', retryable: false });
  });
  it('feeds explicit temporary replies into the persisted one/five-minute backoff without changing batches', async () => {
    const s = setup([classifySmtpError({ code: 'EENVELOPE', responseCode: 450 }), classifySmtpError({ code: 'EMESSAGE', responseCode: 451 }), { status: 'mock_completed' }]);
    s.task(); const first = s.service.scan({ force: true, channels: ['email'] }).notifications[0];
    await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'retry_wait', attempts: 1, last_error_code: 'SMTP_TEMPORARY_REJECTION' });
    s.setTime('2026-11-09T01:00:59Z'); await s.service.processQueue(); expect(s.adapter).toHaveBeenCalledTimes(1);
    s.setTime('2026-11-09T01:01:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'retry_wait', attempts: 2 });
    s.setTime('2026-11-09T01:05:59Z'); await s.service.processQueue(); expect(s.adapter).toHaveBeenCalledTimes(2);
    s.setTime('2026-11-09T01:06:00Z'); await s.service.processQueue();
    expect(s.store.require('notifications', first.id)).toMatchObject({ status: 'mock_completed', attempts: 3 });
    expect(s.store.all('notifications')).toHaveLength(1); expect(s.adapter).toHaveBeenCalledTimes(3);
  });
});

describe('P0 leap-day recurring generation', () => {
  const rule = {
    schema_version: 1, kind: 'recurring', frequency: 'quarter', first_period_start: '2028-01-01', last_period_end: null, anchor: 'period_end',
    offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }],
    convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null },
    confirmation_status: 'confirmed', original_expression: '季度结束后30天',
  };
  it('creates and regenerates quarters idempotently using the injected Shanghai leap-day clock', () => {
    const store = new Store(':memory:', () => new Date('2028-02-29T01:35:00Z')); stores.push(store);
    const business = new Business(store), project = store.create('projects', { name: '闰日合成项目', archived: false });
    const obligation = business.createObligation(project.id, { title: '季度报送', source_type: 'manual', source_description: '合成季度规则', rule });
    expect(obligation.tasks.map((task: any) => task.occurrence_key)).toEqual(['2028-Q1', '2028-Q2', '2028-Q3', '2028-Q4', '2029-Q1']);
    expect(obligation.tasks.map((task: any) => task.effective_due_on)).toEqual(['2028-04-30', '2028-07-30', '2028-10-30', '2029-01-30', '2029-04-30']);
    business.generate(obligation); expect(store.all('tasks')).toHaveLength(5);
  });
  it('continues from recurring top-up to the due reminder scan on February 29', async () => {
    const store = new Store(':memory:', () => new Date('2028-02-29T01:35:00Z')); stores.push(store);
    const business = new Business(store), project = store.create('projects', { name: '闰日扫描项目', archived: false });
    store.create('settings', { id: 'default', mail_enabled: true, feishu_enabled: true, lead_days: 30, send_empty: true, policy_revision: 1 });
    business.createObligation(project.id, { title: '周期报送', source_type: 'manual', source_description: '合成季度规则', rule });
    business.createObligation(project.id, { title: '临期事项', source_type: 'manual', source_description: '合成日期', rule: { schema_version: 1, kind: 'fixed', date: '2028-03-02', convention: rule.convention, confirmation_status: 'confirmed', original_expression: '3月2日前' } });
    const adapter = vi.fn(async () => ({ status: 'mock_completed' as const }));
    const notifications = new NotificationService(store, { OUTBOUND_MODE: 'mock', MAIL_TO: 'synthetic@example.invalid', adapter }, store.clock);
    for (const obligation of store.all('obligations')) if (obligation.rule.kind === 'recurring') business.generate(obligation);
    await notifications.tick({ force_enabled: true, recovery: true });
    expect(store.all('scheduler_runs').map(run => run.status)).toEqual(['succeeded', 'succeeded']);
    expect(store.all('notifications')).toHaveLength(2);
    expect(store.all('notifications').every(batch => batch.status === 'mock_completed')).toBe(true);
  });
});
