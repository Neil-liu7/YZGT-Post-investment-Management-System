import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Supervisor } from './supervisor-core.mjs';

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const { config } = await import('../apps/server/src/config');
const { Store } = await import('../apps/server/src/store');
const { createAlertSink, readOpsConfig, rotateLogFile, runMaintenanceCycle } = await import('./ops-maintenance');

const ops = readOpsConfig(process.env);
const logFile = join(ops.logDir, 'supervisor.log');
mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
const secretValues = ['LLM_API_KEY', 'GLM_API_KEY', 'SMTP_PASS', 'FEISHU_WEBHOOK_URL']
  .map(key => process.env[key]).filter((value): value is string => Boolean(value));

function redactLogText(value: string): string {
  let result = value;
  for (const secret of secretValues) result = result.split(secret).join('<redacted>');
  return result.replace(/(LLM_API_KEY|GLM_API_KEY|SMTP_PASS|FEISHU_WEBHOOK_URL)=([^\s,;]+)/gi, '$1=<redacted>');
}

function writeLog(level: 'log' | 'warn' | 'error', value: unknown) {
  const text = value instanceof Error ? value.stack || value.message : String(value);
  const safeText = redactLogText(text);
  const line = `[${new Date().toISOString()}] [${level}] ${safeText}\n`;
  try {
    appendFileSync(logFile, line, { encoding: 'utf8', mode: 0o640 });
    rotateLogFile(logFile, ops.logMaxBytes, ops.logRetention);
  } catch (error) {
    console.error(`[supervisor] 日志写入失败：${error instanceof Error ? error.message : String(error)}`);
    console.error(safeText);
  }
}

const logger = {
  log: (value: unknown) => writeLog('log', value),
  warn: (value: unknown) => writeLog('warn', value),
  error: (value: unknown) => writeLog('error', value),
};
const alertSink = createAlertSink(ops, { allowWebhook: true });
let openedBrowser = false;

function openBrowser() {
  if (openedBrowser || process.env.SUPERVISOR_OPEN_BROWSER !== 'true') return;
  openedBrowser = true;
  const url = `http://${config.host}:${config.port}`;
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', url], { windowsHide: true })
    : spawn('open', [url], { stdio: 'ignore' });
  child.once('error', error => logger.warn(`无法自动打开浏览器，请手动访问 ${url}：${error.message}`));
}

async function maintenance(forceBackup = false) {
  const store = new Store(config.database_file);
  try {
    return await runMaintenanceCycle({
      store,
      storageDir: config.storage_dir,
      backupDir: config.backup_dir,
      config: ops,
      forceBackup,
      alertSink,
      logFiles: [logFile],
    });
  } finally {
    store.close();
  }
}

const supervisor = new Supervisor({
  command: process.execPath,
  args: ['scripts/start.mjs'],
  cwd: process.cwd(),
  env: process.env,
  host: config.host,
  port: config.port,
  logger,
  onReady: () => { openBrowser(); void maintenance().catch(error => logger.error(error)); },
  onAlert: event => {
    void alertSink({
      type: event.type === 'health_failed' ? 'supervisor_health_failed' : 'supervisor_restart_failed',
      message: event.message || event.type,
      occurred_at: event.at,
      details: event,
    });
  },
});

const maintenanceTimer = ops.backupScheduleEnabled
  ? setInterval(() => { void maintenance().catch(error => logger.error(error)); }, Math.min(ops.backupIntervalMs, 60 * 60 * 1000))
  : null;
maintenanceTimer?.unref?.();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  logger.log(`收到${signal}，正在停止服务守护。`);
  await supervisor.stop(signal);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(signal); });

const result = await supervisor.run();
if (maintenanceTimer) clearInterval(maintenanceTimer);
process.exitCode = result.code;
