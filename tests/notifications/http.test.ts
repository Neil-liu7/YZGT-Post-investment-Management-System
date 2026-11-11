import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app.ts';
const resources: { runtime: ReturnType<typeof createApp>; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'yzgt-notification-http-'));
  const runtime = createApp({ database_file: join(dir, 'test.sqlite'), storage_dir: join(dir, 'storage'), clock: () => new Date('2026-11-11T02:00:00Z') });
  resources.push({ runtime, dir });
  const project = runtime.store.create('projects', { name: '合成项目机密标题', company: '合成公司', archived: false });
  runtime.store.create('tasks', { project_id: project.id, title: '合成合同义务机密内容', status: 'pending', activated_on: '2026-11-01', effective_due_on: '2026-11-18', deadline_state: 'calculated', schedule_revision: 1 });
  return { ...runtime, project };
}
afterEach(() => { for (const { runtime, dir } of resources.splice(0)) { runtime.store.close(); rmSync(dir, { recursive: true, force: true }); } });
describe('notification HTTP contracts', () => {
  it('previews, queues with 202, reports mock completion, and enforces manual send idempotency', async () => {
    const s = setup();
    const preview = await request(s.app).post('/api/v1/reminders/preview').send({ channel: 'email', recipients: 'a@example.invalid; A@example.invalid' });
    expect(preview.status).toBe(200); expect(preview.body.request_id).toBeTruthy();
    expect(preview.body.data.content.body).toContain('合成合同义务机密内容');
    expect(s.store.all('notifications')).toHaveLength(0);
    const params = { snapshot_id: preview.body.data.id, body: '人工编辑的合成正文' };
    const sent = await request(s.app).post('/api/v1/reminders/send').set('Idempotency-Key', 'manual-a').send(params);
    expect(sent.status).toBe(202); expect(sent.body.data.status).toBe('queued');
    const again = await request(s.app).post('/api/v1/reminders/send').set('Idempotency-Key', 'manual-a').send(params);
    expect(again.body.data.id).toBe(sent.body.data.id);
    expect((await request(s.app).post('/api/v1/reminders/send').set('Idempotency-Key', 'manual-a').send({ ...params, body: '不同稿' })).status).toBe(409);
    await s.notifications.processQueue();
    const history = await request(s.app).get('/api/v1/notification-events');
    expect(history.body.data.items[0].status).toBe('mock_completed');
    expect(history.body.data.items[0].mode).toBe('mock');
    expect(s.store.all('reminders')).toHaveLength(0);
  });
  it('rejects stale previews with an envelope and allows explicit historical edited snapshot', async () => {
    const s = setup(); const preview = (await request(s.app).post('/api/v1/reminders/preview').send({})).body.data;
    const task = s.store.all('tasks')[0]; s.store.update('tasks', task.id, task.version, { owner_label: '更新负责人' });
    const stale = await request(s.app).post('/api/v1/reminders/send').send({ snapshot_id: preview.id });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('SNAPSHOT_STALE'); expect(stale.body.request_id).toBeTruthy();
    const permitted = await request(s.app).post('/api/v1/reminders/send').send({ snapshot_id: preview.id, allow_stale: true, body: '确认旧稿' });
    expect(permitted.status).toBe(202); expect(permitted.body.data.stale_snapshot_accepted).toBe(true);
  });
  it('uses a separate synthetic test message without project data or automatic occurrences', async () => {
    const s = setup(); const response = await request(s.app).post('/api/v1/notifications/test').send({ channel: 'feishu' });
    expect(response.status).toBe(202); expect(response.body.data.purpose).toBe('test');
    expect(response.body.data.content.body).not.toContain('合成合同义务机密内容');
    expect(response.body.data.content.items).toEqual([]);
    await s.notifications.processQueue(); expect(s.store.all('reminders')).toHaveLength(0);
  });
  it('forces explicit development scans to mock, and validates recipients without leaking configuration', async () => {
    const s = setup(); const policy = s.store.get('settings', 'default'); s.store.update('settings', policy.id, policy.version, { feishu_enabled: true });
    const scan = await request(s.app).post('/api/v1/scans').send({ mode: 'live', force: false });
    expect(scan.status).toBe(200); expect(scan.body.data.mode).toBe('mock');
    expect(s.store.all('notifications').every(n => n.mode === 'mock')).toBe(true);
    const invalid = await request(s.app).post('/api/v1/reminders/preview').send({ recipients: 'a@example.invalid\r\nBcc:evil@example.invalid' });
    expect(invalid.status).toBe(422); expect(invalid.body.error.code).toBe('INVALID_RECIPIENT');
    const settings = await request(s.app).get('/api/v1/settings');
    expect(JSON.stringify(settings.body)).not.toMatch(/WEBHOOK_URL|SMTP_PASS|GLM_API_KEY/);
  });
});
