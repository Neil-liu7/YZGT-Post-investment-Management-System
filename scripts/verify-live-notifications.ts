import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { config as loadEnv } from 'dotenv';
// @ts-expect-error The runtime selector is plain JavaScript so it can run before loading native modules.
import { projectRoot, useProjectRuntime } from './runtime.mjs';
import { createVerificationFinalizer, redactSecrets, verificationReportStatus, type VerificationFinalState } from './verification-support';
import { mayStartNotificationVerification, newNotificationTransmissionAttempts, notificationLedgerSummary, notificationVerificationArguments, publicNotificationConfiguration, resolveNotificationVerification, type NotificationLedger, type NotificationVerificationConfig } from './live-notification-config';
import { reconcileExpiredNotificationLease, recoveryBusinessTables, recoveryTableCount, type RecoveryLedger } from './unknown-notification-recovery';

await useProjectRuntime(import.meta.url, ['--import', 'tsx']);
loadEnv({ path: join(projectRoot, '.env') });
const args = notificationVerificationArguments(process.argv.slice(2));
const channels = args.channel ? [args.channel] : ['email', 'feishu'] as const;
const configurations = channels.map(channel => resolveNotificationVerification(channel, process.env));
const selected = configurations.find(config => config.channel === args.channel);
const reportPath = args.live && args.channel ? `docs/真实提醒联调-${args.channel}.json` : 'docs/提醒配置检查.json';
const started = Date.now();
const secrets = configurations.flatMap(config => config.secrets);
const report: Record<string, any> = {
  status: 'not_run', scope: 'fixed_synthetic_channel_test', requested_live: args.live, channel: args.channel ?? null,
  configuration: configurations.map(publicNotificationConfiguration), new_transmission_attempts: 0, reused_existing: false,
  receipt_status: 'not_confirmed', user_database_used: false,
  runtime: { llm_mode: 'mock', allow_external_model: false, outbound_mode: 'not_started', scheduler_enabled: false },
};
let child: ChildProcess | undefined;
let auditFile: string | undefined;
let auditDirectory: string | undefined;
let ownedLock: { path: string; token: string } | undefined;
let ledgerBefore: NotificationLedger | undefined;
let reconciliation: Promise<Awaited<ReturnType<typeof reconcileExpiredNotificationLease>>> | undefined;
let sendingRequested = false;
const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
const emptyLedger = (): RecoveryLedger => ({ notifications: [], attempts: [], reminders: 0, projects: 0, tasks: 0, business_rows: 0 });
class VerificationError extends Error { constructor(public code: string, message: string) { super(message); } }
function verify(value: unknown, code: string, message: string): asserts value { if (!value) throw new VerificationError(code, message); }
function safeCode(value: unknown) { return typeof value === 'string' && /^[A-Z_]{1,100}$/.test(value) ? value : 'LOCAL_API_FAILED'; }

function readLedger(): RecoveryLedger {
  if (!auditFile || !existsSync(auditFile)) return emptyLedger();
  let db: Database.Database | undefined;
  try {
    db = new Database(auditFile, { readonly: true, fileMustExist: true });
    verify((db.pragma('quick_check') as any[])[0]?.quick_check === 'ok', 'AUDIT_INVALID', '持久联调台账完整性检查未通过，停止发送。');
    const rows = (table: string) => (db!.prepare(`SELECT data FROM ${table} ORDER BY created_at,id`).all() as { data: string }[]).map(row => JSON.parse(row.data));
    const count = (table: string) => recoveryTableCount(db!, table);
    return { notifications: rows('notifications'), attempts: rows('attempts'), reminders: count('reminders'), projects: count('projects'), tasks: count('tasks'), business_rows: recoveryBusinessTables.reduce((total, table) => total + count(table), 0) };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('AUDIT_UNREADABLE', '无法只读核对持久联调台账，为避免重复发送，本次停止。');
  } finally { db?.close(); }
}

function recordLedger(ledger: NotificationLedger, config: NotificationVerificationConfig) {
  const summary = notificationLedgerSummary(ledger, config.channel);
  report.audit = summary;
  report.transport_state = summary.transport_state;
  report.receipt_status = summary.receipt_status;
  report.new_transmission_attempts = newNotificationTransmissionAttempts(ledger, ledgerBefore);
  return summary;
}

function saveReport(state: VerificationFinalState) {
  if (selected && auditFile && existsSync(auditFile)) {
    try { recordLedger(readLedger(), selected); }
    catch { report.audit_read_after_stop = 'failed'; }
  }
  report.recorded_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
  report.receipt_note = '传输接受仅表示SMTP服务器或机器人接口接受请求，不能证明收件人已看到；实际收件须人工确认。';
  report.status = verificationReportStatus(report.status, state);
  const content = JSON.stringify(redactSecrets(report, secrets), null, 2);
  writeFileSync(reportPath, content + '\n'); console.log(content);
}

async function stop() {
  try { await reconciliation; } catch { /* Main flow records a failed or cancelled lease check without sending. */ }
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const target = child;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { target.kill('SIGKILL'); reject(new VerificationError('CLEANUP_TIMEOUT', '隔离通知进程未能按时停止。')); }, 5000);
      target.once('close', () => { clearTimeout(timer); done(); }); target.kill('SIGTERM');
    });
  }
  if (ownedLock && existsSync(ownedLock.path)) {
    let owner: any;
    try { owner = JSON.parse(readFileSync(ownedLock.path, 'utf8')); } catch { /* Do not remove a lock whose owner cannot be verified. */ }
    if (owner?.token === ownedLock.token && owner?.pid === process.pid) unlinkSync(ownedLock.path);
  }
  // The isolated audit database is deliberately retained across invocations.
}

async function start(config: NotificationVerificationConfig) {
  const port = await new Promise<number>((done, reject) => {
    const probe = createServer(); probe.once('error', () => reject(new VerificationError('LOCAL_PORT_UNAVAILABLE', '无法分配本机隔离验证端口。')));
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); if (!address || typeof address === 'string') { probe.close(); reject(new VerificationError('LOCAL_PORT_UNAVAILABLE', '无法分配本机隔离验证端口。')); return; } probe.close(() => done(address.port)); });
  });
  verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次通知验证已取消。');
  const bypass = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SMTP_|FEISHU_|LLM_|GLM_|ALLOW_EXTERNAL|MAIL_TO$)/i.test(key)));
  const env = { ...inherited, ...config.privateEnvironment,
    NODE_ENV: 'production', LLM_MODE: 'mock', LLM_API_KEY: '', GLM_API_KEY: '', ALLOW_EXTERNAL_MODEL: 'false', ALLOW_EXTERNAL_DATA: 'false', OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: 'false',
    PORT: String(port), DATABASE_FILE: auditFile!, STORAGE_DIR: join(auditDirectory!, 'storage'), BACKUP_DIR: join(auditDirectory!, 'backups'), NO_PROXY: bypass, no_proxy: bypass,
  };
  child = spawn(process.execPath, ['scripts/start.mjs'], { env, windowsHide: true, stdio: 'ignore' });
  let failed = false; child.once('error', () => { failed = true; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次通知验证已取消。');
    verify(!failed && child.exitCode === null, 'LOCAL_START_FAILED', '隔离通知服务未能启动，请先检查构建与Node版本。');
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const health = (await response.json()).data;
        verify(health.llm_mode === 'mock' && health.outbound_mode === 'live', 'ISOLATION_FAILED', '隔离服务模式不符合通知验证约定。');
        report.runtime = { llm_mode: 'mock', allow_external_model: false, outbound_mode: 'live', scheduler_enabled: false, health_verified: true, node: process.versions.node };
        return base;
      }
    } catch (error) { if (error instanceof VerificationError) throw error; }
    await sleep(100);
  }
  throw new VerificationError('LOCAL_START_TIMEOUT', '隔离通知服务启动超时。');
}

async function api(base: string, path: string, body?: any, key?: string) {
  verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次通知验证已取消。');
  let response: Response;
  try { response = await fetch(base + '/api/v1' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch { throw new VerificationError('LOCAL_API_UNREACHABLE', '隔离本机通知接口连接失败或超时，保留台账并停止。'); }
  let result: any;
  try { result = await response.json(); } catch { throw new VerificationError('LOCAL_API_INVALID_RESPONSE', '隔离本机通知接口未返回有效响应。'); }
  if (!response.ok) throw new VerificationError(safeCode(result.error?.code), `隔离本机通知接口返回HTTP ${response.status}，请按稳定错误码核查。`);
  return result.data;
}

const finalizer = createVerificationFinalizer({
  cleanup: stop, save: saveReport,
  onCancel: signal => { report.status = 'cancelled'; report.error_code = 'VERIFICATION_CANCELLED'; report.cancellation_signal = signal; report.cancel_note = sendingRequested ? '发送已请求，取消不表示未送达；请核对保留台账，后续不会自动重发。' : '已取消本次通知验证。'; },
  onCleanupError: () => { if (!finalizer.cancelled) report.status = 'failed'; report.cleanup = 'failed'; report.error_code = 'CLEANUP_FAILED'; process.exitCode = 1; },
});

try {
  verify(!args.issues.length, args.issues[0]?.code ?? 'INVALID_ARGUMENT', args.issues[0]?.message ?? '通知验证参数无效。');
  if (!args.live) {
    report.reason = 'CONFIGURATION_CHECK_ONLY';
    console.log('仅检查本地通知配置格式；没有启动服务或发送消息。真实验证须明确指定--live及单个渠道。');
  } else {
    verify(process.env.NODE_ENV !== 'test', 'TEST_OUTBOUND_BLOCKED', '自动测试环境禁止进行真实通知验证。');
    verify(selected?.targetHash, 'TARGET_NOT_CONFIGURED', '尚未配置有效的测试目标，本次未发送。');
    auditDirectory = join(projectRoot, 'var', 'live-notifications', selected.channel, selected.targetHash);
    auditFile = join(auditDirectory, 'app.sqlite');
    report.audit_directory = relative(projectRoot, auditDirectory); report.target_hash = selected.targetHash; report.masked_targets = selected.maskedTargets;
    mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(auditDirectory, 'verification.lock'), token = randomUUID();
    try { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); ownedLock = { path: lockPath, token }; }
    catch { throw new VerificationError('VERIFICATION_LOCKED', '该目标已有联调锁，先核查现有进程及台账，本次不会重复发送。'); }
    ledgerBefore = readLedger();
    if (!mayStartNotificationVerification(ledgerBefore)) {
      report.reused_existing = true;
      reconciliation = reconcileExpiredNotificationLease(auditFile, selected, readLedger, new Date(), () => finalizer.cancelled);
      const reconciled = await reconciliation;
      if (reconciled) report.lease_reconciliation = reconciled;
      const summary = recordLedger(readLedger(), selected); if (!finalizer.cancelled) report.status = summary.status;
      report.reason = reconciled ? 'EXPIRED_LEASE_RECONCILED_REVIEW_REQUIRED' : 'EXISTING_AUDIT_NO_RESEND';
      if (reconciled) report.send_authorization_consumed = false;
      if (summary.status !== 'transport_accepted') process.exitCode = 1;
      console.log(reconciled ? '已仅将过期发送租约归为结果未知，本次没有发送或消耗发送授权；请先核查接收端，再明确选择人工处理。' : '发现该目标已有联调批次，本次只读回报，不启动发送服务、不重发。');
    } else {
      verify(selected.configured, 'NOTIFICATION_NOT_CONFIGURED', '通知配置未就绪，请按检查结果补齐；本次未发送。');
      verify(!ledgerBefore.projects && !ledgerBefore.tasks && !ledgerBefore.reminders && !ledgerBefore.attempts.length, 'AUDIT_NOT_EMPTY', '联调目录包含其他业务或尝试记录，为避免混用，本次停止。');
      verify(existsSync(join(projectRoot, 'dist/server.mjs')), 'BUILD_REQUIRED', '请先运行npm run build，通知联调使用隔离生产构建。');
      console.log('正在启动隔离通知服务，仅发送固定合成测试消息，不包含项目或协议数据。');
      const base = await start(selected);
      const settings = await api(base, '/settings');
      verify(settings.llm_mode === 'mock' && settings.outbound_mode === 'live' && settings.scheduler_enabled === false, 'ISOLATION_FAILED', '隔离服务的模型、通知或定时配置不符合约定。');
      report.runtime.settings_verified = true;
      sendingRequested = true;
      let batch = await api(base, '/notifications/test', { channel: selected.channel, mode: 'live' }, selected.idempotencyKey);
      verify(batch.purpose === 'test' && batch.mode === 'live' && batch.content?.items?.length === 0, 'TEST_MESSAGE_INVALID', '服务返回的通知不是预期的合成测试消息，立即停止并核查台账。');
      const began = Date.now(); let announced = 0;
      while (['queued', 'sending'].includes(batch.status)) {
        verify(Date.now() - began < 90000, 'DELIVERY_POLL_TIMEOUT', '通知结果尚未明确，已停止等待；保留台账，禁止自动重发。');
        await sleep(500); batch = await api(base, `/notifications/${batch.id}`);
        const elapsed = Math.floor((Date.now() - began) / 1000);
        if (elapsed >= announced + 10) { console.log(`通知已等待${elapsed}秒，当前状态：${['queued', 'sending'].includes(batch.status) ? batch.status : '结果待核查'}。`); announced = elapsed; }
      }
      const summary = recordLedger(readLedger(), selected); if (!finalizer.cancelled) report.status = summary.status;
      report.reason = summary.status === 'transport_accepted' ? 'RECEIPT_CONFIRMATION_REQUIRED' : 'STOPPED_WITHOUT_AUTOMATIC_RESEND';
      if (summary.status !== 'transport_accepted') process.exitCode = 1;
    }
  }
} catch (error) {
  if (!finalizer.cancelled) { report.status = 'failed'; report.error_code = error instanceof VerificationError ? error.code : 'LOCAL_VERIFICATION_FAILED'; report.error = error instanceof VerificationError ? error.message : '本机通知联调发生异常，请核查脱敏配置和持久台账。'; process.exitCode = 1; }
} finally { await finalizer.finish(); }
