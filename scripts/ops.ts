import { join } from 'node:path';
import { config } from '../apps/server/src/config';
import { Store } from '../apps/server/src/store';
import { createAlertSink, readOpsConfig, rotateBackups, rotateLogFile, runMaintenanceCycle } from './ops-maintenance';

const action = process.argv[2] || 'status';
const ops = readOpsConfig(process.env);
const logFile = join(ops.logDir, 'supervisor.log');

try {
  if (action === 'status') {
    console.log(JSON.stringify({ status: 'ready', backup_schedule_enabled: ops.backupScheduleEnabled, backup_interval_hours: ops.backupIntervalMs / 3600000, backup_retention: ops.backupRetention, log_dir: ops.logDir, log_max_bytes: ops.logMaxBytes, log_retention: ops.logRetention, alert_file: ops.alertFile }, null, 2));
  } else if (action === 'rotate') {
    const log = rotateLogFile(logFile, ops.logMaxBytes, ops.logRetention);
    const backups = rotateBackups(config.backup_dir, ops.backupRetention);
    console.log(JSON.stringify({ status: 'passed', rotated: log.files, removed_backups: backups.removed }, null, 2));
  } else if (action === 'backup') {
    const store = new Store(config.database_file);
    try {
      const result = await runMaintenanceCycle({ store, storageDir: config.storage_dir, backupDir: config.backup_dir, config: ops, forceBackup: true, logFiles: [logFile], alertSink: createAlertSink(ops) });
      if (!result.backup) throw new Error('备份未执行。');
      console.log(JSON.stringify({ status: 'passed', backup: result.backup, alerts: result.alerts }, null, 2));
    } finally { store.close(); }
  } else throw new Error('用法：npm run ops:status | npm run ops:rotate | npm run ops:backup');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
