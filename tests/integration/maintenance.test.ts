import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../../apps/server/src/store';
import { Business } from '../../apps/server/src/business';
import { LegacyImporter, backup, restore } from '../../apps/server/src/maintenance';
import { createApp } from '../../apps/server/src/app';
import { config } from '../../apps/server/src/config';
import type { DeadlineRule } from '../../packages/contracts/src/index';

const roots: string[] = [];
const stores: Store[] = [];
const originalMode = config.llm_mode;
const clock = () => new Date('2026-11-11T02:00:00Z');
const sha256 = (value: Buffer|string) => createHash('sha256').update(value).digest('hex');
const fixed: DeadlineRule = { schema_version: 1, kind: 'fixed', date: '2026-11-18', confirmation_status: 'confirmed', original_expression: '合成测试固定日期', convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } };
function rootDirectory() { const root = mkdtempSync(join(tmpdir(), 'yzgt-maintenance-')); roots.push(root); return root; }
function setup() {
  const root = rootDirectory(); const storage = join(root, 'storage'); mkdirSync(storage);
  const store = new Store(join(root, 'app.sqlite'), clock); stores.push(store);
  const business = new Business(store); return { root, storage, store, business, importer: new LegacyImporter(store, business) };
}
function apiSetup() {
  const root = rootDirectory(); config.llm_mode = 'mock';
  const result = createApp({ database_file: join(root, 'app.sqlite'), storage_dir: join(root, 'storage'), clock });
  stores.push(result.store); return { root, ...result };
}
function project(store: Store, name = '合成项目') { return store.create('projects', { name, company: '合成公司', archived: false, deleted_at: null, task_order_version: 1 }); }
function obligation(business: Business, project_id: string, rule: DeadlineRule = fixed) { return business.createObligation(project_id, { title: '合成履约事项', source_type: 'manual', source_description: '合成测试人工录入', rule }); }
afterEach(() => {
  config.llm_mode = originalMode;
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing cleanup outside the test temp directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('maintenance migration reconciliation A28 A29', () => {
  const legacy = () => ({ projects: [{ id: 'legacy-p1', name: '历史合成项目', uploadedFiles: ['原件已缺失.pdf'], tasks: [{ id: 'legacy-t1', title: '历史完成事项', status: 'done', dueDate: '2026-11-01' }, { id: 'legacy-t2', title: '历史无期限事项', status: 'pending' }] }] });
  it('repeated namespace import preserves current edits, states and missing originals without duplicate entities', () => {
    const { store, importer } = setup();
    const first = importer.preview('合成来源', legacy()); importer.confirm(first.id);
    const task = store.all('tasks')[0]; store.update('tasks', task.id, task.version, { title: '新系统人工修改' });
    const repeated = importer.preview('合成来源', legacy()); const result = importer.confirm(repeated.id);
    expect(result.reconciliation).toMatchObject({ mapped_projects: 1, mapped_tasks: 2, expected_projects: 1, expected_tasks: 2 });
    expect(store.all('projects')).toHaveLength(1); expect(store.all('tasks')).toHaveLength(2);
    expect(store.require('tasks', task.id).title).toBe('新系统人工修改');
    expect(store.require('tasks', task.id)).toMatchObject({ status: 'done', completed_on: null, effective_due_on: null, deadline_state: 'needs_review' });
    expect(store.all('documents')[0]).toMatchObject({ state: 'needs_file', storage_name: null, sha256: null });
    expect(store.all('tasks').every(t => t.effective_due_on === null)).toBe(true);
  });
  it('changed legacy content yields a blocking conflict and preserves current records', () => {
    const { store, importer } = setup(); importer.confirm(importer.preview('合成来源', legacy()).id);
    const changed = legacy(); changed.projects[0].tasks[0].title = '旧文件后来修改';
    const plan = importer.preview('合成来源', changed);
    expect(plan.issues.some((issue: any) => issue.blocking)).toBe(true);
    expect(() => importer.confirm(plan.id)).toThrow();
    expect(store.all('projects')).toHaveLength(1); expect(store.all('tasks')).toHaveLength(2);
    expect(store.all('tasks')[0].title).toBe('历史完成事项');
  });
  it.each([
    { projects: [{ name: '无 ID', tasks: [] }] },
    { projects: [{ id: 'same', tasks: [] }, { id: 'same', tasks: [] }] },
    { projects: [{ id: 'p', tasks: [{ title: '无 ID' }] }] },
    { projects: [{ id: 'p', tasks: [{ id: 'same' }, { id: 'same' }] }] },
  ])('blocks missing or duplicate legacy IDs before creating business rows: %j', source => {
    const { store, importer } = setup(); const plan = importer.preview('无效来源', source);
    expect(plan.issues.some((issue: any) => issue.blocking)).toBe(true);
    expect(() => importer.confirm(plan.id)).toThrow();
    expect(store.all('projects')).toHaveLength(0); expect(store.all('tasks')).toHaveLength(0);
  });
});

describe('maintenance backup restore integrity A30 A35', () => {
  function attachment(store: Store, storage: string) {
    const p = project(store); const bytes = Buffer.from('合成协议原件，不包含真实业务数据', 'utf8');
    writeFileSync(join(storage, 'original.txt'), bytes);
    const doc = store.create('documents', { project_id: p.id, original_name: '合成 原文.txt', storage_name: 'original.txt', sha256: sha256(bytes), state: 'parsed', text: bytes.toString('utf8'), file_version: 1 });
    store.create('clauses', { project_id: p.id, document_id: doc.id, text: '合成条款原文', locator: { paragraph: 1 } });
    return { p, doc, bytes };
  }
  it('restores original files, source text, tasks and notification dedup records into a fresh directory', async () => {
    const { store, business, root, storage } = setup(); const { p, doc, bytes } = attachment(store, storage);
    const task = obligation(business, p.id).tasks[0];
    const notification = store.create('notifications', { project_id: p.id, status: 'succeeded', mode: 'mock', content: '合成模拟提醒', members: [task.id] });
    store.create('reminders', { task_id: task.id, business_key: `${task.id}:1:1:feishu:synthetic:T7`, notification_id: notification.id, schedule_revision: 1, status: 'succeeded' });
    await backup(store, storage, join(root, 'backup'));
    const target = join(root, 'restored'); expect(restore(join(root, 'backup'), target).verified).toBe(true);
    const restored = new Store(join(target, 'app.sqlite'), clock); stores.push(restored);
    expect(restored.require('projects', p.id).name).toBe('合成项目');
    expect(restored.require('documents', doc.id).text).toBe(bytes.toString('utf8'));
    expect(restored.all('clauses', { document_id: doc.id })[0].text).toBe('合成条款原文');
    expect(restored.require('tasks', task.id).effective_due_on).toBe('2026-11-18');
    expect(restored.require('notifications', notification.id).status).toBe('succeeded');
    expect(restored.all('reminders', { task_id: task.id })).toHaveLength(1);
    expect(readFileSync(join(target, 'storage', 'original.txt'))).toEqual(bytes);
    expect(() => restore(join(root, 'backup'), target)).toThrow();
  });
  it('rejects changed backup bytes before creating a restore destination', async () => {
    const { store, root, storage } = setup(); attachment(store, storage);
    await backup(store, storage, join(root, 'backup'));
    writeFileSync(join(root, 'backup', 'storage', 'original.txt'), '被篡改的备份附件');
    const target = join(root, 'rejected');
    expect(() => restore(join(root, 'backup'), target)).toThrow(/摘要|校验/);
    expect(existsSync(target)).toBe(false);
  });
  it('does not seal an attachment whose bytes differ from the authoritative document digest', async () => {
    const { store, root, storage } = setup(); attachment(store, storage);
    writeFileSync(join(storage, 'original.txt'), '磁盘损坏后的内容');
    await expect(backup(store, storage, join(root, 'rejected-backup'))).rejects.toThrow(/摘要|校验|损坏/);
    expect(existsSync(join(root, 'rejected-backup', 'manifest.json'))).toBe(false);
  });
  it('rejects a sealed manifest with no database rather than reporting an empty database as restored', () => {
    const root = rootDirectory(); const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ format_version: 1, sealed: true, files: [] }));
    const target = join(root, 'must-not-create');
    expect(() => restore(source, target)).toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it('rejects paths that escape the selected backup directory', () => {
    const root = rootDirectory(); const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(root, 'outside.txt'), 'outside');
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ format_version: 1, sealed: true, files: [{ path: '../outside.txt', sha256: sha256('outside') }] }));
    expect(() => restore(source, join(root, 'rejected'))).toThrow(/路径/);
  });
  it('refuses a corrupt database and leaves its original bytes intact', () => {
    const root = rootDirectory(); const file = join(root, 'corrupt.sqlite'); const bytes = Buffer.from('synthetic-corrupt-database'); writeFileSync(file, bytes);
    const moduleUrl = pathToFileURL(resolve('apps/server/src/store.ts')).href;
    const script = `import {Store} from ${JSON.stringify(moduleUrl)}; try { new Store(${JSON.stringify(file)}); process.exitCode=2; } catch { process.exitCode=0; }`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
    expect(child.status, child.stderr).toBe(0); expect(readFileSync(file)).toEqual(bytes);
  });
});

describe('persistence change plan membership and reference validation', () => {
  it('validates actual event dates inside the business service before storing a preview', () => {
    const { store, business } = setup(); const p = project(store); const event = store.create('events', { project_id: p.id, name: '签署', occurred_on: '2026-08-07' });
    expect(() => business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { occurred_on: '2026-02-30' }, reason: '无效日期' })).toThrow();
    expect(store.all('change_plans')).toHaveLength(0); expect(store.require('events', event.id).occurred_on).toBe('2026-08-07');
  });
  it('allows the full event editor payload while validating document ownership and recording changes', () => {
    const { store, business } = setup(); const p = project(store); const document = store.create('documents', { project_id: p.id, state: 'parsed', original_name: 'synthetic.txt' });
    const event = store.create('events', { project_id: p.id, name: '旧名称', occurred_on: null, event_type: 'other' });
    const plan = business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { name: '本协议签署', event_type: 'signing', occurred_on: '2026-11-11', investor_label: '合成投资方', document_id: document.id, evidence: '合成签署证明', status: 'confirmed' }, reason: '核对协议原件' });
    expect(store.require('events', event.id).occurred_on).toBeNull(); business.commit(plan.id);
    expect(store.require('events', event.id)).toMatchObject({ name: '本协议签署', event_type: 'signing', occurred_on: '2026-11-11', investor_label: '合成投资方', document_id: document.id, evidence: '合成签署证明', status: 'confirmed' });
  });
  it('rejects foreign event documents and invalid event field types before creating a plan', () => {
    const { store, business } = setup(); const p1 = project(store, '项目一'); const p2 = project(store, '项目二');
    const foreign = store.create('documents', { project_id: p2.id, state: 'parsed', original_name: 'foreign.txt' });
    const event = store.create('events', { project_id: p1.id, name: '签署', occurred_on: null });
    expect(() => business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { document_id: foreign.id }, reason: '非法跨项目' })).toThrow();
    expect(() => business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { investor_label: 42 }, reason: '类型错误' })).toThrow();
    expect(() => business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { status: 'fabricated' }, reason: '状态错误' })).toThrow();
    expect(store.all('change_plans')).toHaveLength(0);
  });
  it('the database rejects malformed nonempty effective dates even outside HTTP validation', () => {
    const { store, business } = setup(); const p = project(store); const task = obligation(business, p.id).tasks[0];
    expect(() => store.update('tasks', task.id, task.version, { effective_due_on: '2026-99-01' })).toThrow();
    expect(store.require('tasks', task.id).effective_due_on).toBe('2026-11-18');
  });
  it('rejects a stale event plan when a new dependent task was created after its preview', () => {
    const { store, business } = setup(); const p = project(store); const event = store.create('events', { project_id: p.id, name: '签署', occurred_on: '2026-08-07' });
    const plan = business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { occurred_on: '2026-08-17' }, reason: '合成日期修正' });
    const rule: DeadlineRule = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '签署后三个月', convention: fixed.convention, kind: 'relative', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 3, unit: 'calendar_month', include_start_day: false }] };
    const task = obligation(business, p.id, rule).tasks[0]; expect(task.effective_due_on).toBe('2026-11-07');
    expect(() => business.commit(plan.id)).toThrow();
    expect(store.require('events', event.id).occurred_on).toBe('2026-08-07');
    expect(store.require('tasks', task.id).effective_due_on).toBe('2026-11-07');
  });
  it('change plans cannot move an event into another project through arbitrary changes', () => {
    const { store, business } = setup(); const p1 = project(store, '项目一'); const p2 = project(store, '项目二');
    const event = store.create('events', { project_id: p1.id, name: '签署', occurred_on: '2026-08-07' });
    expect(() => business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { project_id: p2.id, occurred_on: '2026-08-17' }, reason: '非法跨项目变更' })).toThrow();
    expect(store.require('events', event.id).project_id).toBe(p1.id);
  });
});

describe('API uploads and extraction persistence A01 A02 A07 A32', () => {
  it('retains same-name distinct files and honors upload retry idempotency', async () => {
    const { app, store, root } = apiSetup(); const p = project(store);
    const first = await request(app).post(`/api/v1/projects/${p.id}/documents`).set('Idempotency-Key', 'same-upload').attach('file', Buffer.from('第1条 公司应于2029年12月31日前完成实缴。'), '合成协议.txt');
    expect(first.status).toBe(201); expect(first.body.data.state).toBe('parsed');
    const repeated = await request(app).post(`/api/v1/projects/${p.id}/documents`).set('Idempotency-Key', 'same-upload').attach('file', Buffer.from('第1条 公司应于2029年12月31日前完成实缴。'), '合成协议.txt');
    expect(repeated.status).toBe(201); expect(repeated.body.data.id).toBe(first.body.data.id);
    const changed = await request(app).post(`/api/v1/projects/${p.id}/documents`).set('Idempotency-Key', 'another-upload').attach('file', Buffer.from('第1条 公司应于2030年12月31日前完成实缴。'), '合成协议.txt');
    expect(changed.status).toBe(201); expect(changed.body.data.id).not.toBe(first.body.data.id);
    expect(changed.body.data.file_version).toBe(2); expect(store.all('documents')).toHaveLength(2);
    expect(readdirSync(join(root, 'storage'))).toHaveLength(2);
  });
  it('batch confirmation validates every draft atomically and repeated confirmation creates one obligation', async () => {
    const { app, store } = apiSetup(); const p = project(store);
    const doc = store.create('documents', { project_id: p.id, state: 'parsed', original_name: 'synthetic.txt', file_version: 1, text: '合成原文' });
    const run = store.create('extractions', { project_id: p.id, document_id: doc.id, state: 'succeeded' });
    const draft = (title: string) => store.create('drafts', { extraction_id: run.id, project_id: p.id, document_id: doc.id, document_version_id: doc.id, title, source_text: '合成原文', rule: fixed, review_state: 'draft' });
    const valid = draft('有效候选'); const invalid = draft('');
    const failed = await request(app).post(`/api/v1/extractions/${run.id}/confirm`).send({ draft_ids: [valid.id, invalid.id] });
    expect(failed.status).toBe(422); expect(store.all('obligations')).toHaveLength(0); expect(store.require('drafts', valid.id).review_state).toBe('draft');
    const good = await request(app).post(`/api/v1/extractions/${run.id}/confirm`).set('Idempotency-Key', 'confirm-once').send({ draft_ids: [valid.id] });
    expect(good.status).toBe(200); expect(good.body.data.created).toHaveLength(1);
    const repeat = await request(app).post(`/api/v1/extractions/${run.id}/confirm`).send({ draft_ids: [valid.id] });
    expect(repeat.status).toBe(200); expect(repeat.body.data.skipped).toHaveLength(1); expect(store.all('obligations')).toHaveLength(1); expect(store.all('tasks')).toHaveLength(1);
  });
  it('persists an edited candidate clause number rather than silently discarding the saved field', async () => {
    const { app, store } = apiSetup(); const p = project(store); const draft = store.create('drafts', { project_id: p.id, title: '合成候选', source_text: '第5.2条合成原文', clause_number: '5.2', rule: fixed, review_state: 'draft' });
    const response = await request(app).patch(`/api/v1/draft-obligations/${draft.id}`).send({ version: draft.version, clause_number: '5.3', review_state: 'needs_review' });
    expect(response.status).toBe(200); expect(response.body.data.clause_number).toBe('5.3'); expect(store.require('drafts', draft.id).clause_number).toBe('5.3');
  });
  it('repeated extraction command reuses one asynchronous run and does not create formal obligations', async () => {
    const { app, store } = apiSetup(); const p = project(store);
    const uploaded = await request(app).post(`/api/v1/projects/${p.id}/documents`).attach('file', Buffer.from('第1条 公司应于2029年12月31日前完成实缴。'), 'synthetic.txt');
    expect(uploaded.status).toBe(201); const documentId = uploaded.body.data.id;
    const first = await request(app).post(`/api/v1/documents/${documentId}/extractions`).set('Idempotency-Key', 'extract-once').send({});
    const repeated = await request(app).post(`/api/v1/documents/${documentId}/extractions`).set('Idempotency-Key', 'extract-once').send({});
    expect(first.status).toBe(202); expect(repeated.body.data.id).toBe(first.body.data.id);
    for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(store.require('extractions', first.body.data.id).state); attempt++) await new Promise(done => setTimeout(done, 20));
    expect(store.require('extractions', first.body.data.id).state).toBe('succeeded');
    expect(store.all('extractions')).toHaveLength(1); expect(store.all('drafts').length).toBeGreaterThan(0); expect(store.all('obligations')).toHaveLength(0);
    // Allow the retry request's no-op callback to observe the completed run before closing this isolated store.
    await new Promise(done => setTimeout(done, 20));
  });
  it('reparsing an unchanged document version does not duplicate its clauses', async () => {
    const { app, store } = apiSetup(); const p = project(store);
    const uploaded = await request(app).post(`/api/v1/projects/${p.id}/documents`).attach('file', Buffer.from('第1条 公司应于2029年12月31日前完成实缴。\n第2条 每季度结束后三十日内报送。'), 'synthetic.txt');
    expect(uploaded.status).toBe(201); const documentId = uploaded.body.data.id; const count = store.all('clauses', { document_id: documentId }).length;
    const parsed = await request(app).post(`/api/v1/documents/${documentId}/reparse`).send({ version: uploaded.body.data.version });
    expect(parsed.status).toBe(200); expect(store.all('clauses', { document_id: documentId })).toHaveLength(count);
  });
  it('refuses AI provenance pointing to a document version in another project', async () => {
    const { app, store } = apiSetup(); const p1 = project(store, '项目一'); const p2 = project(store, '项目二');
    const foreign = store.create('documents', { project_id: p2.id, original_name: 'foreign.txt', state: 'parsed', file_version: 1, text: '其他项目合成原文' });
    const response = await request(app).post(`/api/v1/projects/${p1.id}/obligations`).send({ title: '非法来源', source_type: 'ai', document_version_id: foreign.id, source_text: '其他项目合成原文', rule: fixed });
    expect(response.status).toBe(422); expect(store.all('obligations')).toHaveLength(0); expect(store.all('tasks')).toHaveLength(0);
  });
  it('refuses fabricated document version identifiers for an AI obligation', async () => {
    const { app, store } = apiSetup(); const p = project(store);
    const response = await request(app).post(`/api/v1/projects/${p.id}/obligations`).send({ title: '虚构来源', source_type: 'ai', document_version_id: 'missing-version', source_text: '无真实文件的原文', rule: fixed });
    expect([404, 422]).toContain(response.status); expect(store.all('obligations')).toHaveLength(0);
  });
  it('blocks foreign origins and private static paths without exposing credentials', async () => {
    const { app } = apiSetup();
    const denied = await request(app).post('/api/v1/projects').set('Origin', 'https://example.invalid').send({ name: '不应创建' }); expect(denied.status).toBe(403);
    for (const path of ['/.env', '/var/app.sqlite', '/storage/original.txt', '/apps/server/src/config.ts']) expect((await request(app).get(path)).status).toBe(404);
    const response = await request(app).get('/api/v1/settings'); expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toMatch(/SMTP_PASS|GLM_API_KEY|FEISHU_WEBHOOK_URL/);
  });
});
