import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../apps/server/src/store';
import { backupDue, createAlertSink, readOpsConfig, rotateBackups, rotateLogFile, runMaintenanceCycle } from '../../scripts/ops-maintenance';

function workspace() { return mkdtempSync(join(tmpdir(), 'yzgt-ops-')); }

describe('runtime maintenance safeguards', () => {
  it('rotates logs by size while retaining the configured number of generations', () => {
    const root = workspace(); const file = join(root, 'supervisor.log');
    writeFileSync(file, 'one'); expect(rotateLogFile(file, 2, 2).rotated).toBe(true);
    appendFileSync(file, 'two'); rotateLogFile(file, 2, 2);
    appendFileSync(file, 'three'); rotateLogFile(file, 2, 2);
    expect(readdirSync(root).filter(name => /^supervisor\.log\.\d+$/.test(name)).sort()).toEqual(['supervisor.log.1', 'supervisor.log.2']);
  });

  it('retains newest sealed backup directories and removes older ones', () => {
    const root = workspace();
    for (let index = 0; index < 4; index += 1) { const directory = join(root, `backup-${index}`); mkdirSync(directory); writeFileSync(join(directory, 'manifest.json'), '{}'); const time = new Date(2026, 0, index + 1); utimesSync(directory, time, time); }
    const result = rotateBackups(root, 2);
    expect(result.kept).toHaveLength(2); expect(result.removed).toHaveLength(2);
    expect(readdirSync(root).filter(name => name.startsWith('backup-'))).toHaveLength(2);
  });

  it('treats a missing backup or an expired interval as due', () => {
    const root = workspace(); expect(backupDue(root, 24 * 3600000, Date.now())).toBe(true);
    const directory = join(root, 'backup-1'); mkdirSync(directory); writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ created_at: new Date(1000).toISOString() }));
    expect(backupDue(root, 24 * 3600000, 1000 + 24 * 3600000 - 1)).toBe(false); expect(backupDue(root, 24 * 3600000, 1000 + 24 * 3600000)).toBe(true);
  });

  it('runs a forced sealed backup and emits a local alert record without a network call', async () => {
    const root = workspace(); const db = join(root, 'app.sqlite'); const storage = join(root, 'storage'); const backups = join(root, 'backups'); const logs = join(root, 'logs');
    mkdirSync(storage); const store = new Store(db); const config = { ...readOpsConfig({ BACKUP_SCHEDULE_ENABLED: 'true', BACKUP_INTERVAL_HOURS: '24', BACKUP_RETENTION: '2', SUPERVISOR_LOG_DIR: logs, SUPERVISOR_ALERT_FILE: join(logs, 'alerts.jsonl') }), backupScheduleEnabled: true };
    try {
      const result = await runMaintenanceCycle({ store, storageDir: storage, backupDir: backups, config, forceBackup: true, logFiles: [join(logs, 'supervisor.log')], alertSink: createAlertSink(config, { allowWebhook: false }) });
      expect(result.backup?.sealed).toBe(true); expect(result.alerts[0]?.type).toBe('backup_succeeded'); expect(statSync(join(result.backup!.directory, 'manifest.json')).isFile()).toBe(true);
    } finally { store.close(); }
  });

  it('keeps an incomplete backup and emits a failure alert when an attachment is missing', async () => {
    const root = workspace(); const db = join(root, 'app.sqlite'); const storage = join(root, 'storage'); const backups = join(root, 'backups'); const alerts = join(root, 'alerts.jsonl'); mkdirSync(storage);
    const store = new Store(db); const project = store.create('projects', { name: 'missing attachment', company: '', owner_label: '', notes: '', archived: false, deleted_at: null, task_order_version: 1 }); store.create('documents', { project_id: project.id, original_name: 'missing.txt', state: 'ready', storage_name: 'missing.txt', sha256: 'bad', file_version: 1 });
    const config = { ...readOpsConfig({ BACKUP_RETENTION: '2', SUPERVISOR_ALERT_FILE: alerts }), backupScheduleEnabled: true };
    try {
      const result = await runMaintenanceCycle({ store, storageDir: storage, backupDir: backups, config, forceBackup: true, alertSink: createAlertSink(config) });
      expect(result.backup).toBeNull(); expect(result.alerts[0]?.type).toBe('backup_failed'); expect(readdirSync(backups).some(name => name.startsWith('backup-'))).toBe(true); expect(JSON.parse(readFileSync(alerts, 'utf8').trim()).type).toBe('backup_failed');
    } finally { store.close(); }
  });

  it('coalesces repeated identical alerts during the cooldown window', async () => {
    const root = workspace(); const config = { ...readOpsConfig({ SUPERVISOR_ALERT_FILE: join(root, 'alerts.jsonl'), SUPERVISOR_ALERT_COOLDOWN_MINUTES: '15' }), alertCooldownMs: 900000 };
    const sink = createAlertSink(config); const event = { type: 'backup_failed' as const, message: 'same failure', occurred_at: new Date(1000).toISOString() };
    await sink(event); await sink({ ...event, occurred_at: new Date(2000).toISOString() });
    expect(readFileSync(config.alertFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
