import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../../apps/server/src/store';
import { Business } from '../../apps/server/src/business';
import { backup, restore, LegacyImporter } from '../../apps/server/src/maintenance';
import { recoveryBusinessTables, recoveryTableCount } from '../../scripts/unknown-notification-recovery';

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) if (store.db.open) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-joint-maintenance-')); roots.push(root);
  const store = new Store(join(root, 'app.sqlite')); stores.push(store);
  const p = store.create('projects', { name: '合成联合提取维护项目' });
  const storage = join(root, 'storage'); mkdirSync(storage);
  const text = '公司应于协议签署后3个月提交登记材料。';
  writeFileSync(join(storage, 'synthetic.txt'), text);
  const document = store.create('documents', { project_id: p.id, state: 'parsed', original_name: 'synthetic.txt', storage_name: 'synthetic.txt', sha256: createHash('sha256').update(text).digest('hex'), text, file_version: 1 });
  const run = store.create('extractions', { project_id: p.id, document_id: document.id, state: 'succeeded', joint_extraction: true, prompt: '重点提取登记材料', prompt_version: 'joint-obligations-v1' });
  return { root, store, p, storage, document, run };
}

describe('event candidates in read-only notification ledger checks', () => {
  it('counts a historical schema 4 ledger without silently migrating it', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(4); CREATE TABLE projects(id TEXT); INSERT INTO projects VALUES(\'synthetic\')');
      expect(recoveryTableCount(db, 'event_drafts')).toBe(0);
      expect(recoveryTableCount(db, 'projects')).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='event_drafts'").get()).toBeUndefined();
      expect(db.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: 4 });
    } finally { db.close(); }
  });

  it('refuses a damaged current schema instead of treating missing candidates as empty', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(5)');
      expect(() => recoveryTableCount(db, 'event_drafts')).toThrow('missing');
    } finally { db.close(); }
  });

  it('includes event candidates in the zero-business-data send guard', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(5); CREATE TABLE event_drafts(id TEXT); INSERT INTO event_drafts VALUES(\'synthetic-event\')');
      expect(recoveryBusinessTables).toContain('event_drafts');
      expect(recoveryTableCount(db, 'event_drafts')).toBe(1);
    } finally { db.close(); }
  });

  it('does not treat an empty migration history as a valid historical ledger', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY)');
      expect(() => recoveryTableCount(db, 'event_drafts')).toThrow('missing');
    } finally { db.close(); }
  });
});

describe('joint candidate migration and backup compatibility', () => {
  it('upgrades a schema 4 database without changing existing business JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-joint-upgrade-')); roots.push(root);
    const file = join(root, 'old.sqlite'), old = new Database(file);
    old.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const name of readdirSync('database/migrations').filter(name => /^00[1-4]_/.test(name)).sort()) {
      old.exec(readFileSync(join('database/migrations', name), 'utf8'));
      old.prepare('INSERT INTO migrations VALUES(?,?)').run(Number(name.split('_')[0]), '2026-11-12T00:00:00.000Z');
    }
    const row = { id: 'existing-project', name: '已有合成项目', owner_label: '保留人工负责人', version: 1 };
    const before = JSON.stringify(row);
    old.prepare('INSERT INTO projects(id,version,data,created_at,updated_at) VALUES(?,?,?,?,?)').run(row.id, 1, before, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z'); old.close();
    const upgraded = new Store(file); stores.push(upgraded);
    expect(upgraded.db.prepare('SELECT data FROM projects WHERE id=?').get(row.id)).toEqual({ data: before });
    expect(upgraded.all('event_drafts')).toEqual([]);
    expect(upgraded.db.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: 5 });
    upgraded.close();
    const reopened = new Store(file); stores.push(reopened);
    expect(reopened.db.prepare('SELECT count(*) AS count FROM migrations WHERE version=5').get()).toEqual({ count: 1 });
  });

  it('restores event candidates, incomplete rules, custom prompt and original file without creating live records', async () => {
    const f = fixture();
    const event = f.store.create('event_drafts', { project_id: f.p.id, document_id: f.document.id, document_version_id: f.document.id, extraction_id: f.run.id, candidate_key: 'signing', name: '协议签署', event_type: 'signing', occurred_on: null, source_text: f.document.text, review_state: 'draft' });
    const draft = f.store.create('drafts', { project_id: f.p.id, document_id: f.document.id, extraction_id: f.run.id, title: '待确认季度报送', rule: { kind: 'recurring', first_period_start: null }, review_state: 'draft' });
    const result = await backup(f.store, f.storage, join(f.root, 'backup')); expect(result.sealed).toBe(true);
    const destination = join(f.root, 'restored'); expect(restore(result.directory, destination).verified).toBe(true);
    const recovered = new Store(join(destination, 'app.sqlite')); stores.push(recovered);
    expect(recovered.require('event_drafts', event.id)).toEqual(event);
    expect(recovered.require('drafts', draft.id)).toEqual(draft);
    expect(recovered.require('extractions', f.run.id).prompt).toBe('重点提取登记材料');
    expect(readFileSync(join(destination, 'storage', 'synthetic.txt'), 'utf8')).toBe(f.document.text);
    for (const table of ['events', 'obligations', 'tasks']) expect(recovered.all(table)).toHaveLength(0);
  });

  it('lists event candidates as new dependencies that block legacy rollback', () => {
    const f = fixture(), importer = new LegacyImporter(f.store, new Business(f.store));
    const preview = importer.preview('synthetic-joint-import', { projects: [{ id: 'old', name: '合成迁移项目', tasks: [] }] });
    const imported = importer.confirm(preview.id);
    const mapping = f.store.all('legacy_mappings', { import_id: imported.id, entity_type: 'project' })[0];
    const document = f.store.create('documents', { project_id: mapping.new_id, state: 'parsed', text: '合成签署条款' });
    const run = f.store.create('extractions', { project_id: mapping.new_id, document_id: document.id, state: 'succeeded' });
    const event = f.store.create('event_drafts', { project_id: mapping.new_id, document_id: document.id, extraction_id: run.id, candidate_key: 'signing', name: '签署', occurred_on: null });
    const plan = importer.rollbackPreview(imported.id, '演示撤回边界');
    expect(plan.can_rollback).toBe(false);
    expect(plan.blocked_records.some((row: any) => row.table === 'event_drafts' && row.id === event.id)).toBe(true);
  });
});
