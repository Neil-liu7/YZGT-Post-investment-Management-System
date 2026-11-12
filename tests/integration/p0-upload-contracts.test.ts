import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';

const resources: { root: string; runtime: ReturnType<typeof createApp> }[] = [];
function setup(max_upload_bytes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-p0-uploads-'));
  const runtime = createApp({ database_file: join(root, 'app.sqlite'), storage_dir: join(root, 'storage'), clock: () => new Date('2026-11-12T02:00:00Z'), max_upload_bytes });
  resources.push({ root, runtime });
  const project = runtime.store.create('projects', { name: '合成上传项目', company: '合成公司', archived: false });
  return { ...runtime, root, project };
}
afterEach(() => { for (const { root, runtime } of resources.splice(0)) { runtime.store.close(); rmSync(root, { recursive: true, force: true }); } });
const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
const bytes = Buffer.from('这是一份合成原件。');

describe('P0 multipart operation identity', () => {
  it('replays the original upload and still permits a new intentional version', async () => {
    const r = setup();
    const upload = (key: string, content = bytes) => request(r.app).post(`/api/v1/projects/${r.project.id}/documents`).set('Idempotency-Key', key).attach('file', content, 'synthetic.txt');
    const [first, duplicate] = await Promise.all([upload('upload-once'), upload('upload-once')]);
    expect(first.status).toBe(201); expect(duplicate.status).toBe(201);
    expect(first.body.data.id).toBe(duplicate.body.data.id);
    expect(r.store.all('documents')).toHaveLength(1);
    expect(readdirSync(join(r.root, 'storage'))).toHaveLength(1);
    expect((await upload('upload-once', Buffer.from('不同内容'))).status).toBe(409);
    const next = await upload('new-intentional-upload');
    expect(next.status).toBe(201); expect(next.body.data.id).not.toBe(first.body.data.id); expect(next.body.data.file_version).toBe(2);
  });

  it('replays a supplement before checking its old version or creating another original', async () => {
    const r = setup();
    const document = r.store.create('documents', { project_id: r.project.id, original_name: '历史.txt', state: 'needs_file', storage_name: null, file_version: 1 });
    const upload = (content = bytes) => request(r.app).post(`/api/v1/documents/${document.id}/supplement`).set('Idempotency-Key', 'supplement-once').field('version', String(document.version)).attach('file', content, 'synthetic.txt');
    const [first, concurrent] = await Promise.all([upload(), upload()]);
    expect(concurrent.status).toBe(200); expect(concurrent.body.data.id).toBe(first.body.data.id);
    const again = await upload();
    expect(first.status).toBe(200); expect(again.status).toBe(200); expect(again.body.data.id).toBe(document.id);
    expect(again.body.data.version).toBe(first.body.data.version);
    expect(r.store.all('documents')).toHaveLength(1); expect(readdirSync(join(r.root, 'storage'))).toHaveLength(1);
    expect(r.store.all('audit_logs').filter(row => row.action === 'supplement')).toHaveLength(1);
    expect((await upload(Buffer.from('different'))).status).toBe(409);
  });

  it('replays evidence uploads without duplicating attachments or audit entries', async () => {
    const r = setup();
    const task = r.store.create('tasks', { project_id: r.project.id, title: '合成事项', status: 'pending' });
    const upload = (note = '合成凭证') => request(r.app).post(`/api/v1/tasks/${task.id}/evidence`).set('Idempotency-Key', 'evidence-once').field('note', note).attach('file', bytes, 'synthetic.txt');
    const first = await upload(), again = await upload();
    expect(first.status).toBe(201); expect(again.status).toBe(201); expect(again.body.data.id).toBe(first.body.data.id);
    expect(r.store.all('evidence')).toHaveLength(1); expect(r.store.all('documents')).toHaveLength(1);
    expect(r.store.all('audit_logs').filter(row => row.action === 'evidence')).toHaveLength(1);
    expect(readdirSync(join(r.root, 'storage'))).toHaveLength(1);
    expect((await upload('不同备注')).status).toBe(409);
  });

  it('binds upload keys to the target route as well as the file', async () => {
    const r = setup(); const second = r.store.create('projects', { name: '另一个项目' });
    const upload = (id: string) => request(r.app).post(`/api/v1/projects/${id}/documents`).set('Idempotency-Key', 'shared-key').attach('file', bytes, 'synthetic.txt');
    expect((await upload(r.project.id)).status).toBe(201);
    expect((await upload(second.id)).status).toBe(409);
    expect(r.store.all('documents')).toHaveLength(1);
  });

  it.each(['original', 'supplement', 'evidence'] as const)('advertises and enforces the same configured byte limit for %s', async kind => {
    const r = setup(8);
    const record = kind === 'supplement' ? r.store.create('documents', { project_id: r.project.id, original_name: '历史.txt', state: 'needs_file', storage_name: null, file_version: 1 }) : kind === 'evidence' ? r.store.create('tasks', { project_id: r.project.id, title: '合成事项', status: 'pending' }) : null;
    const path = kind === 'original' ? `/api/v1/projects/${r.project.id}/documents` : kind === 'supplement' ? `/api/v1/documents/${record!.id}/supplement` : `/api/v1/tasks/${record!.id}/evidence`;
    const upload = (content: string) => { const call = request(r.app).post(path); if (kind === 'supplement') call.field('version', String(record!.version)); return call.attach('file', Buffer.from(content), 'synthetic.txt'); };
    expect((await request(r.app).get('/api/v1/settings')).body.data.max_upload_bytes).toBe(8);
    const rejected = await upload('123456789');
    expect(rejected.status).toBe(413); expect(r.store.all('documents')).toHaveLength(kind === 'supplement' ? 1 : 0);
    expect(readdirSync(join(r.root, 'storage'))).toHaveLength(0); expect(r.store.all('evidence')).toHaveLength(0);
    const accepted = await upload('12345678');
    expect(accepted.status).toBe(kind === 'supplement' ? 200 : 201);
    const document = kind === 'evidence' ? r.store.require('documents', accepted.body.data.document_id) : accepted.body.data;
    expect(document.size).toBe(8); expect(readdirSync(join(r.root, 'storage'))).toHaveLength(1);
  });
});

describe('P0 continuous interval read model', () => {
  it('returns calculated relative boundaries to obligation list and detail without writes', async () => {
    const r = setup();
    const event = r.store.create('events', { project_id: r.project.id, name: '合成出资', occurred_on: '2026-01-15' });
    const obligation = r.business.createObligation(r.project.id, { title: '持续承诺', source_type: 'manual', source_description: '合成协议', rule: {
      schema_version: 1, kind: 'continuous', confirmation_status: 'confirmed', original_expression: '出资日起十年内', review_mode: 'manual',
      starts_at: { type: 'event', event_id: event.id }, ends_at: { type: 'relative', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 10, unit: 'calendar_year', include_start_day: false }], convention },
    } });
    const auditBefore = r.store.all('audit_logs').length;
    const list = (await request(r.app).get(`/api/v1/projects/${r.project.id}/obligations`)).body.data.items;
    const detail = (await request(r.app).get(`/api/v1/obligations/${obligation.id}`)).body.data;
    for (const row of [list[0], detail]) expect(row.calculation).toMatchObject({ state: 'calculated', computed_due_on: null, interval: { start_on: '2026-01-15', end_on: '2036-01-15' } });
    expect(r.store.require('obligations', obligation.id).version).toBe(1);
    expect(r.store.all('audit_logs')).toHaveLength(auditBefore);
  });
});
