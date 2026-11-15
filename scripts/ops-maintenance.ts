import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from '../apps/server/src/store';
import { backup } from '../apps/server/src/maintenance';

export type OpsAlert = {
  type: 'backup_failed' | 'backup_succeeded' | 'log_rotation_failed' | 'supervisor_health_failed' | 'supervisor_restart_failed';
  message: string;
  occurred_at: string;
  details?: Record<string, unknown>;
};

export type OpsConfig = {
  backupScheduleEnabled: boolean;
  backupIntervalMs: number;
  backupRetention: number;
  logDir: string;
  logMaxBytes: number;
  logRetention: number;
  alertFile: string;
  alertWebhookUrl: string;
  alertCooldownMs: number;
};

export type AlertSink = (event: OpsAlert) => void | Promise<void>;

const positiveInt = (value: string | undefined, fallback: number, minimum = 1) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

const positiveNumber = (value: string | undefined, fallback: number, minimum = 0.01) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean) => value === undefined || value === '' ? fallback : value === 'true';

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/(LLM_API_KEY|GLM_API_KEY|SMTP_PASS|FEISHU_WEBHOOK_URL)=([^\s,;]+)/gi, '$1=<redacted>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /key|pass|webhook|secret|token/i.test(key) ? '<redacted>' : redact(item)]));
  return value;
}

export function readOpsConfig(env: Record<string, string | undefined> = process.env): OpsConfig {
  const logDir = resolve(env.SUPERVISOR_LOG_DIR || join('var', 'supervisor'));
  return {
    backupScheduleEnabled: bool(env.BACKUP_SCHEDULE_ENABLED, false),
    backupIntervalMs: positiveNumber(env.BACKUP_INTERVAL_HOURS, 24) * 60 * 60 * 1000,
    backupRetention: positiveInt(env.BACKUP_RETENTION, 7),
    logDir,
    logMaxBytes: positiveInt(env.SUPERVISOR_LOG_MAX_BYTES, 10 * 1024 * 1024),
    logRetention: positiveInt(env.SUPERVISOR_LOG_RETENTION, 5),
    alertFile: resolve(env.SUPERVISOR_ALERT_FILE || join(logDir, 'alerts.jsonl')),
    alertWebhookUrl: env.SUPERVISOR_ALERT_WEBHOOK_URL?.trim() || '',
    alertCooldownMs: positiveNumber(env.SUPERVISOR_ALERT_COOLDOWN_MINUTES, 15) * 60 * 1000,
  };
}

function safeChild(parent: string, child: string): string {
  const root = resolve(parent);
  const candidate = resolve(root, child);
  if (!candidate.startsWith(root + sep)) throw new Error('路径必须位于运行目录内。');
  return candidate;
}

/** Rotate one append-only log before it grows beyond the configured limit. */
export function rotateLogFile(file: string, maxBytes: number, retention: number): { rotated: boolean; files: string[] } {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) { writeFileSync(target, '', { mode: 0o640 }); return { rotated: false, files: [] }; }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size <= maxBytes) return { rotated: false, files: [] };
  const keep = Math.max(1, Math.floor(retention));
  for (let index = keep; index >= 1; index -= 1) {
    const oldPath = `${target}.${index}`;
    const nextPath = `${target}.${index + 1}`;
    if (!existsSync(oldPath)) continue;
    if (index === keep) rmSync(oldPath, { force: true });
    else renameSync(oldPath, nextPath);
  }
  const rotated = `${target}.1`;
  renameSync(target, rotated);
  writeFileSync(target, '', { mode: 0o640 });
  return { rotated: true, files: [rotated] };
}

function backupDirectories(root: string, sealedOnly = false): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map(entry => safeChild(root, entry.name))
    .filter(directory => !sealedOnly || existsSync(join(directory, 'manifest.json')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function rotateBackups(backupDir: string, retention: number): { kept: string[]; removed: string[] } {
  const root = resolve(backupDir); mkdirSync(root, { recursive: true, mode: 0o700 });
  const all = backupDirectories(root); const keep = Math.max(1, Math.floor(retention));
  const removed = all.slice(keep);
  for (const directory of removed) rmSync(directory, { recursive: true, force: true });
  return { kept: all.slice(0, keep), removed };
}

function latestBackupAt(backupDir: string): number | null {
  const latest = backupDirectories(backupDir, true)[0];
  if (!latest) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(latest, 'manifest.json'), 'utf8')) as { created_at?: string };
    const created = manifest.created_at ? Date.parse(manifest.created_at) : NaN;
    return Number.isFinite(created) ? created : statSync(latest).mtimeMs;
  } catch { return statSync(latest).mtimeMs; }
}

export function backupDue(backupDir: string, intervalMs: number, now = Date.now()): boolean {
  const latest = latestBackupAt(backupDir);
  return latest === null || now - latest >= intervalMs;
}

function appendAlert(file: string, event: OpsAlert): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o640 });
}

/** Alerting is file based by default. A webhook is opt-in and never used in tests. */
export function createAlertSink(config: OpsConfig, options: { fetcher?: typeof fetch; allowWebhook?: boolean } = {}): AlertSink {
  const lastSent = new Map<string, number>();
  return async event => {
    const safeEvent = redact(event) as OpsAlert;
    const key = `${safeEvent.type}:${safeEvent.message}`;
    const now = Date.parse(safeEvent.occurred_at);
    if (lastSent.has(key) && now - (lastSent.get(key) ?? 0) < config.alertCooldownMs) return;
    lastSent.set(key, now);
    try { appendAlert(config.alertFile, safeEvent); } catch (error) { console.error(`[ops] 告警落盘失败：${error instanceof Error ? error.message : String(error)}`); }
    if (!options.allowWebhook || !config.alertWebhookUrl || process.env.NODE_ENV === 'test') return;
    if (!/^https:\/\//.test(config.alertWebhookUrl)) return;
    try {
      await (options.fetcher ?? fetch)(config.alertWebhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(10000), body: JSON.stringify({ title: '投后管理运行告警', type: safeEvent.type, message: safeEvent.message, occurred_at: safeEvent.occurred_at }),
      });
    } catch { /* the local alert record remains authoritative */ }
  };
}

export type MaintenanceCycleOptions = {
  store: Store;
  storageDir: string;
  backupDir: string;
  config: OpsConfig;
  now?: Date;
  forceBackup?: boolean;
  alertSink?: AlertSink;
  logFiles?: string[];
};

export async function runMaintenanceCycle(options: MaintenanceCycleOptions) {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const alerts: OpsAlert[] = [];
  const emit = async (event: OpsAlert) => { const safe = redact(event) as OpsAlert; alerts.push(safe); await options.alertSink?.(safe); };
  const rotated: string[] = [];
  for (const logFile of options.logFiles ?? []) {
    try {
      const result = rotateLogFile(logFile, options.config.logMaxBytes, options.config.logRetention);
      if (result.rotated) rotated.push(...result.files);
    } catch (error) {
      await emit({ type: 'log_rotation_failed', message: '日志轮换失败，请检查运行目录权限。', occurred_at: nowIso, details: { file: logFile, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  let backupResult: { directory: string; files: number; sealed: boolean } | null = null;
  const due = options.forceBackup || (options.config.backupScheduleEnabled && backupDue(options.backupDir, options.config.backupIntervalMs, now.getTime()));
  if (due) {
    const destination = join(resolve(options.backupDir), `backup-${now.getTime()}-${randomUUID()}`);
    try {
      backupResult = await backup(options.store, options.storageDir, destination);
      rotateBackups(options.backupDir, options.config.backupRetention);
      await emit({ type: 'backup_succeeded', message: '定时备份已完成。', occurred_at: nowIso, details: { directory: backupResult.directory, files: backupResult.files } });
    } catch (error) {
      try { rotateBackups(options.backupDir, options.config.backupRetention); } catch { /* retain the original failure and alert below */ }
      await emit({ type: 'backup_failed', message: '定时备份失败，已保留失败现场供核查。', occurred_at: nowIso, details: { directory: destination, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return { due, backup: backupResult, rotated, alerts };
}
