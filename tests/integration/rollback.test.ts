import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../apps/server/src/store';
import { Business } from '../../apps/server/src/business';
import { LegacyImporter } from '../../apps/server/src/maintenance';

const resources: Array<{root: string; store: Store}> = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-rollback-')); let now = new Date('2026-11-11T02:00:00Z');
  const store = new Store(join(root, 'app.sqlite'), () => now); resources.push({ root, store });
  const importer = new LegacyImporter(store, new Business(store));
  return { store, importer, advance: () => { now = new Date(now.getTime() + 16 * 60 * 1000); } };
}
const source = () => ({ projects: [{ id: 'p1', name: '待撤回合成项目', agreementSignDate: '2026-08-07', actualInvestDate: '2026-10-20', uploadedFiles: ['缺失原件.pdf'], tasks: [{ id: 't1', title: '历史事项', status: 'done', dueDate: '2026-11-01' }], agreements: [{ clauses: [{ number: '5.2', text: '合成历史原文' }] }] }] });
function imported(importer: LegacyImporter, namespace = 'rollback-source') { return importer.confirm(importer.preview(namespace, source()).id); }
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    if (store.db.open) store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing cleanup outside test temp directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy import safe rollback with retained history', () => {
  it('records final created-row versions and snapshots at successful confirmation', () => {
    const { store, importer } = setup(); const batch = imported(importer);
    expect(batch.created_records).toEqual(expect.any(Array));
    expect(batch.created_records.map((record: any) => record.table)).toEqual(expect.arrayContaining(['projects', 'events', 'documents', 'clauses', 'obligations', 'tasks', 'legacy_mappings']));
    for (const record of batch.created_records) {
      const current = store.require(record.table, record.id);
      expect(record.version).toBe(current.version); expect(record.snapshot).toEqual(current);
    }
  });
  it('previews the affected range without archiving or changing imported rows', () => {
    const { store, importer } = setup(); const batch = imported(importer); const task = store.all('tasks')[0];
    const plan = importer.rollbackPreview(batch.id, '误选合成数据，撤回本批次');
    expect(plan).toMatchObject({ state: 'preview', can_rollback: true, import_id: batch.id });
    expect(plan.plan_id).toBeTruthy(); expect(plan.affected_records.length).toBeGreaterThan(0); expect(plan.blocked_records).toEqual([]);
    expect(store.require('imports', batch.id).state).toBe('committed'); expect(store.require('tasks', task.id).deleted_at).toBeNull();
  });
  it('soft deletes imported entities, retains source snapshots and marks mappings without deleting history', () => {
    const { store, importer } = setup(); const batch = imported(importer); const counts = Object.fromEntries(['projects', 'events', 'documents', 'clauses', 'obligations', 'tasks', 'legacy_mappings'].map(table => [table, store.all(table).length]));
    const auditCount = store.all('audit_logs').length; const plan = importer.rollbackPreview(batch.id, '撤回误导入批次'); const result = importer.rollback(batch.id, plan.plan_id);
    expect(result.state).toBe('rolled_back'); expect(result.rollback_reason).toBe('撤回误导入批次');
    for (const [table, count] of Object.entries(counts)) expect(store.all(table)).toHaveLength(count);
    for (const record of batch.created_records) {
      const current = store.require(record.table, record.id);
      if (record.table === 'legacy_mappings') expect(current.state).toBe('rolled_back');
      else expect(current).toMatchObject({ archived: true, deleted_at: '2026-11-11T02:00:00.000Z' });
    }
    expect(store.all('tasks')[0].status).toBe('done'); expect(store.all('clauses')[0].text).toBe('合成历史原文');
    expect(store.all('audit_logs').length).toBeGreaterThan(auditCount);
    const repeated = importer.rollback(batch.id, plan.plan_id); expect(repeated.version).toBe(result.version);
  });
  it('blocks rollback if a created task was edited after import and preserves all imported rows', () => {
    const { store, importer } = setup(); const batch = imported(importer); const task = store.all('tasks')[0]; store.update('tasks', task.id, task.version, { title: '后续人工修改' });
    const plan = importer.rollbackPreview(batch.id, '请求撤回'); expect(plan.can_rollback).toBe(false);
    expect(plan.blocked_records).toContainEqual(expect.objectContaining({ table: 'tasks', id: task.id }));
    expect(() => importer.rollback(batch.id, plan.plan_id)).toThrow();
    expect(store.all('projects')[0].archived).toBe(false); expect(store.require('tasks', task.id).title).toBe('后续人工修改');
  });
  it('revalidates row versions at commit and makes no partial changes when a row changed after preview', () => {
    const { store, importer } = setup(); const batch = imported(importer); const plan = importer.rollbackPreview(batch.id, '请求撤回'); const document = store.all('documents')[0]; store.update('documents', document.id, document.version, { original_name: '人工修正文件名.pdf' });
    expect(() => importer.rollback(batch.id, plan.plan_id)).toThrow(); expect(store.all('projects')[0].archived).toBe(false); expect(store.require('imports', batch.id).state).toBe('committed');
  });
  it('blocks a project rollback when a new document was added after the import', () => {
    const { store, importer } = setup(); const batch = imported(importer); const p = store.all('projects')[0]; const doc = store.create('documents', { project_id: p.id, original_name: '后续业务.txt', state: 'needs_file' });
    const plan = importer.rollbackPreview(batch.id, '请求撤回'); expect(plan.can_rollback).toBe(false);
    expect(plan.blocked_records).toContainEqual(expect.objectContaining({ table: 'documents', id: doc.id }));
    expect(() => importer.rollback(batch.id, plan.plan_id)).toThrow(); expect(store.require('projects', p.id).archived).toBe(false);
  });
  it('requires a reason and rejects expired rollback previews', () => {
    const { store, importer, advance } = setup(); const batch = imported(importer);
    expect(() => importer.rollbackPreview(batch.id, '')).toThrow();
    const plan = importer.rollbackPreview(batch.id, '撤回原因'); advance(); expect(() => importer.rollback(batch.id, plan.plan_id)).toThrow(); expect(store.require('imports', batch.id).state).toBe('committed');
  });
  it('does not undo entities from the original batch when rolling back an idempotent repeat import', () => {
    const { store, importer } = setup(); const original = imported(importer); const repeated = imported(importer);
    expect(repeated.created_records).toEqual([]); const plan = importer.rollbackPreview(repeated.id, '撤回重复批次记录'); importer.rollback(repeated.id, plan.plan_id);
    expect(store.all('projects')[0].archived).toBe(false); expect(store.require('imports', original.id).state).toBe('committed');
  });
  it('prevents automatically reimporting a namespace whose mapped entities were rolled back', () => {
    const { store, importer } = setup(); const batch = imported(importer); const plan = importer.rollbackPreview(batch.id, '误导入'); importer.rollback(batch.id, plan.plan_id);
    const repeated = importer.preview('rollback-source', source()); expect(repeated.issues.some((issue: any) => issue.blocking)).toBe(true);
    expect(() => importer.confirm(repeated.id)).toThrow(); expect(store.all('projects')).toHaveLength(1);
    expect(() => importer.confirm(batch.id)).toThrow();
  });
  it('revalidates namespace rollback state when confirming an import preview created before the rollback', () => {
    const { importer } = setup(); const batch = imported(importer); const stale = importer.preview('rollback-source', source());
    const plan = importer.rollbackPreview(batch.id, '撤回旧批次'); importer.rollback(batch.id, plan.plan_id);
    expect(() => importer.confirm(stale.id)).toThrow();
  });
  it('keeps unknown legacy deadlines as unreviewed dependencies on an explicit unknown event without a fabricated date', () => {
    const { store, importer } = setup(); const input = { projects: [{ id: 'unknown-p', name: '未知历史期限', tasks: [{ id: 'unknown-t', title: '未知起点事项', days: 45, status: 'pending' }] }] };
    imported(importer, 'other-source'); const batch = importer.confirm(importer.preview('unknown-source', input).id);
    const taskRecord = batch.created_records.find((record: any) => record.table === 'tasks'); const task = store.require('tasks', taskRecord.id); const rule = store.require('obligations', task.obligation_id).rule;
    expect(task).toMatchObject({ effective_due_on: null, computed_due_on: null, historical_estimated_due_on: null, deadline_state: 'needs_review' });
    expect(rule).toMatchObject({ kind: 'relative', confirmation_status: 'needs_review', offsets: [{ amount: 0, unit: 'calendar_day', include_start_day: false }] });
    expect(rule.date).toBeUndefined(); expect(rule.original_expression).toContain('45');
    expect(store.require('events', rule.anchor.event_id)).toMatchObject({ name: '原起算事件待核实', occurred_on: null, status: 'needs_review' });
    expect(task.legacy_original.days).toBe(45);
  });
});
