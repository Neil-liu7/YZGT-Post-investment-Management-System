import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../apps/server/src/store.ts';
import { NotificationService } from '../../apps/server/src/notifications.ts';
const resources: { store: Store; dir: string }[] = [];
afterEach(() => { for (const { store, dir } of resources.splice(0)) { store.db.close(); rmSync(dir, { recursive: true, force: true }); } });
function setup(date = '2026-11-10T00:00:00Z', options: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'post-investment-notification-'));
  const store = new Store(join(dir, 'test.sqlite'));
  resources.push({ store, dir });
  let now = new Date(date);
  store.create('settings', { id: 'default', feishu_enabled: true, mail_enabled: false, lead_days: 30, send_empty: true, policy_revision: 1 });
  const project = store.create('projects', { name: '合成项目', company: '合成公司', archived: false });
  const service = new NotificationService(store, { OUTBOUND_MODE: 'mock', ...options }, () => now);
  const task = (title = 'A', extra: any = {}) => store.create('tasks', { project_id: project.id, title, status: 'pending', deadline_state: 'calculated', effective_due_on: '2026-11-17', activated_on: '2026-11-01', schedule_revision: 1, ...extra });
  return { store, service, project, task, setTime: (value: string) => { now = new Date(value); } };
}
describe('persistent notification occurrences and queue', () => {
  it('A20 sends each successive current stage once across one unchanged schedule', async () => {
    const s = setup(); s.task('阶段事项', { effective_due_on: '2026-12-10' });
    for (const date of ['2026-11-10T02:00:00Z', '2026-12-03T02:00:00Z', '2026-12-09T02:00:00Z', '2026-12-10T02:00:00Z', '2026-12-11T02:00:00Z']) {
      s.setTime(date); s.service.scan({ force: true }); await s.service.processQueue(); s.service.scan({ force: true });
    }
    expect(s.store.all('reminders').map(r => r.stage)).toEqual(['T30', 'T7', 'T1', 'DUE', 'OVERDUE']);
    expect(s.store.all('notifications')).toHaveLength(5);
  });
  it('A21 uses T3 T1 DUE after lead time is set to three days', () => {
    const s = setup(); s.task(); const p = s.store.get('settings', 'default'); s.store.update('settings', p.id, p.version, { lead_days: 3 });
    s.service.scan({ force: true }); expect(s.store.all('reminders')).toHaveLength(0);
    for (const date of ['2026-11-14T02:00:00Z', '2026-11-16T02:00:00Z', '2026-11-17T02:00:00Z']) { s.setTime(date); s.service.scan({ force: true }); }
    expect(s.store.all('reminders').map(r => r.stage)).toEqual(['T3', 'T1', 'DUE']);
  });
  it('A22 shares durable uniqueness and a sending lease between two instances', async () => {
    const s = setup(); s.task(); const second = new Store(s.store.file);
    try {
      const other = new NotificationService(second, { OUTBOUND_MODE: 'mock' }, () => new Date('2026-11-10T00:00:00Z'));
      s.service.scan({ force: true }); other.scan({ force: true });
      await Promise.all([s.service.processQueue(), other.processQueue()]);
      expect(s.store.all('reminders')).toHaveLength(1); expect(s.store.all('notifications')).toHaveLength(1); expect(s.store.all('attempts')).toHaveLength(1);
    } finally { second.close(); }
  });
  it('A23 recovers only the currently urgent stage after crossing previous thresholds', () => {
    const s = setup('2026-11-16T00:00:00Z'); s.task(); s.service.scan({ recovery: true });
    expect(s.store.all('reminders').map(r => r.stage)).toEqual(['T1']);
  });
  it('F12 independently records a new same-day task and does not consume manual preview stages', async () => {
    const s = setup(); s.task('A');
    s.service.scan({ force: true }); await s.service.processQueue();
    s.task('B'); s.service.scan({ force: true }); await s.service.processQueue();
    expect(s.store.all('reminders').filter(r => r.channel === 'feishu')).toHaveLength(2);
    expect(s.store.all('notifications').filter(n => n.channel === 'feishu')).toHaveLength(2);
    expect(s.store.all('notifications').every(n => n.status === 'mock_completed')).toBe(true);
    const preview = s.service.preview({ channel: 'feishu' });
    s.service.sendSnapshot({ snapshot_id: preview.id }); await s.service.processQueue();
    expect(s.store.all('reminders').filter(r => r.channel === 'feishu')).toHaveLength(2);
  });
  it('F13 preserves one batch across 1/5 minute backoffs and stops after three attempts', async () => {
    let tries = 0;
    const s = setup(undefined, { adapter: async () => ++tries < 3 ? { status: 'failed', retryable: true, error: '合成可重试失败' } : { status: 'mock_completed', external_id: 'synthetic' } });
    s.task(); s.service.scan({ force: true });
    await s.service.processQueue();
    s.setTime('2026-11-10T00:00:59Z'); await s.service.processQueue();
    expect(s.store.all('attempts')).toHaveLength(1);
    s.setTime('2026-11-10T00:01:00Z'); await s.service.processQueue();
    s.setTime('2026-11-10T00:05:59Z'); await s.service.processQueue();
    expect(s.store.all('attempts')).toHaveLength(2);
    s.setTime('2026-11-10T00:06:00Z'); await s.service.processQueue();
    expect(s.store.all('attempts')).toHaveLength(3);
    expect(s.store.all('notifications')).toHaveLength(1);
    expect(s.store.all('notifications')[0]?.status).toBe('mock_completed');
    expect(s.store.all('reminders')[0]?.status).toBe('mock_completed');
  });
  it('F14 never retries unknown delivery without an audited human decision', async () => {
    const s = setup(undefined, { adapter: async () => ({ status: 'unknown', error: '合成已提交后超时' }) });
    s.task(); s.service.scan({ force: true }); await s.service.processQueue();
    s.setTime('2026-11-11T00:00:00Z'); await s.service.processQueue();
    expect(s.store.all('attempts')).toHaveLength(1);
    const n = s.store.all('notifications')[0];
    expect(n.status).toBe('unknown');
    s.service.resolveUnknown(n.id, { action: 'mark_succeeded', reason: '合成核查确认送达' });
    expect(s.store.get('notifications', n.id).status).toBe('succeeded');
    expect(s.store.all('audit_logs').some(a => a.action === 'resolve_unknown')).toBe(true);
  });
  it('F17 seals one empty ISO week digest even after later tasks arrive', () => {
    const s = setup('2026-11-09T01:05:00Z');
    const settings = s.store.get('settings', 'default'); s.store.update('settings', settings.id, settings.version, { mail_enabled: true });
    s.service.scan({ force: true }); s.task(); s.service.scan({ force: true });
    expect(s.store.all('digest_runs')).toHaveLength(1);
    const mails = s.store.all('notifications').filter(n => n.channel === 'email');
    expect(mails).toHaveLength(1);
    expect(mails[0]?.content.body).toContain('无临期事项');
  });
  it('F18 recovery leaves formal daily slot free and formal scan includes a newly added task', async () => {
    const s = setup(); s.task('A');
    s.service.scan({ recovery: true }); await s.service.processQueue();
    s.setTime('2026-11-10T01:00:00Z'); s.task('B');
    s.setTime('2026-11-10T01:30:00Z'); await s.service.tick({ force_enabled: true });
    expect(s.store.all('reminders').filter(r => r.channel === 'feishu')).toHaveLength(2);
    const scans = s.store.all('scheduler_runs');
    expect(scans.some(r => r.kind === 'recovery')).toBe(true);
    expect(scans.some(r => r.slot === 'feishu:2026-11-10')).toBe(true);
  });
  it('rebuilds an unsent partial batch against latest state and cancels the completed member', async () => {
    const s = setup(); const a = s.task('A'); s.task('B'); s.service.scan({ force: true });
    s.store.update('tasks', a.id, a.version, { status: 'done' });
    await s.service.processQueue();
    const batches = s.store.all('notifications');
    expect(batches.filter(n => n.status === 'obsolete')).toHaveLength(1);
    const rebuilt = batches.find(n => n.status === 'mock_completed');
    expect(rebuilt?.content.body).toContain('B');
    expect(rebuilt?.content.items).toHaveLength(1);
  });
  it('rejects stale manual snapshots and keeps both immutable versions', () => {
    const s = setup(); const a = s.task(); const preview = s.service.preview({ channel: 'email' });
    s.store.update('tasks', a.id, a.version, { title: '已编辑标题' });
    expect(() => s.service.sendSnapshot({ snapshot_id: preview.id })).toThrow(/变化|重新/);
    const n = s.service.sendSnapshot({ snapshot_id: preview.id, allow_stale: true, body: '人工确认的旧稿' });
    expect(n.content.body).toBe('人工确认的旧稿');
    expect(s.store.get('snapshots', preview.id).content.body).toContain('A');
  });
  it('does not consume the Feishu daily slot at the 09:00 mail time', async () => {
    const s = setup('2026-11-09T01:00:00Z'); s.task();
    await s.service.tick({ force_enabled: true });
    expect(s.store.all('reminders')).toHaveLength(0);
    s.setTime('2026-11-09T01:30:00Z'); await s.service.tick({ force_enabled: true });
    expect(s.store.all('reminders')).toHaveLength(1);
  });
  it('keeps live automatic work paused when the scheduler global switch is disabled', async () => {
    const s = setup(undefined, { OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: false, FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic', adapter: async () => ({ status: 'succeeded' }) });
    s.task(); s.service.scan(); await s.service.tick();
    expect(s.store.all('attempts')).toHaveLength(0);
    expect(s.store.all('notifications')[0]?.status).toBe('queued');
  });
  it('converts an interrupted lease to unknown and never submits it again', async () => {
    const s = setup(); s.task(); s.service.scan({ force: true });
    const n = s.store.all('notifications')[0];
    s.store.update('notifications', n.id, n.version, { status: 'sending', attempts: 1, lease_until: '2026-11-09T23:59:59Z' });
    s.store.create('attempts', { notification_id: n.id, attempt_number: 1, status: 'sending' });
    await s.service.processQueue();
    expect(s.store.get('notifications', n.id).status).toBe('unknown');
    expect(s.store.all('attempts')).toHaveLength(1);
    expect(s.store.all('attempts')[0]?.status).toBe('unknown');
  });
  it('does not automatically retry a permanent failure or a fourth definite failure', async () => {
    const s = setup(undefined, { adapter: async () => ({ status: 'failed', retryable: true, error: '合成失败' }) });
    s.task(); s.service.scan({ force: true }); await s.service.processQueue();
    s.setTime('2026-11-10T00:01:00Z'); await s.service.processQueue();
    s.setTime('2026-11-10T00:06:00Z'); await s.service.processQueue();
    s.setTime('2026-11-10T01:00:00Z'); await s.service.processQueue();
    expect(s.store.all('attempts')).toHaveLength(3);
    expect(s.store.all('notifications')[0]?.status).toBe('failed');
  });
  it('uses ISO week year when sealing a digest across New Year', () => {
    const s = setup('2027-01-01T02:00:00Z');
    const p = s.store.get('settings', 'default'); s.store.update('settings', p.id, p.version, { mail_enabled: true });
    s.service.scan({ force: true });
    expect(s.store.all('digest_runs')[0]?.iso_week).toBe('2026-W53');
  });
  it('splits oversized project cards without omitting or duplicating a member', async () => {
    const s = setup(); for (let i = 0; i < 20; i++) s.task(`合成事项${i}${'长'.repeat(1000)}`);
    s.service.scan({ force: true }); await s.service.processQueue();
    const batches = s.store.all('notifications');
    expect(batches.length).toBeGreaterThan(1);
    const ids = batches.flatMap(n => n.content.items.map((i: any) => i.task_id));
    expect(ids).toHaveLength(20); expect(new Set(ids).size).toBe(20);
  });
  it('records a failed scan without consuming a formal slot when recipient configuration is invalid', () => {
    const s = setup(undefined, { MAIL_TO: 'not an address' });
    const p = s.store.get('settings', 'default'); s.store.update('settings', p.id, p.version, { mail_enabled: true });
    expect(() => s.service.scan()).toThrow(/收件/);
    expect(s.store.all('scheduler_runs')).toHaveLength(1);
    expect(s.store.all('scheduler_runs')[0]).toMatchObject({ status: 'failed', slot_key: null });
  });
  it('seals skipped empty digests and keeps project card content isolated', () => {
    const s = setup('2026-11-09T02:00:00Z');
    const p = s.store.get('settings', 'default'); s.store.update('settings', p.id, p.version, { mail_enabled: true, send_empty: false });
    s.service.scan({ force: true }); expect(s.store.all('digest_runs')[0]?.status).toBe('skipped_empty');
    s.task('项目甲事项'); const other = s.store.create('projects', { name: '另一个项目', archived: false });
    s.task('项目乙事项', { project_id: other.id }); s.service.scan({ force: true });
    const cards = s.store.all('notifications').filter(n => n.channel === 'feishu');
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(new Set(card.content.items.map((i: any) => i.project_id)).size).toBe(1);
    expect(s.store.all('digest_runs')).toHaveLength(1);
    expect(s.store.all('notifications').filter(n => n.channel === 'email')).toHaveLength(0);
  });
});
