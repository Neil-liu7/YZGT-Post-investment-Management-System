import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
// @ts-expect-error The plain JavaScript selector runs before loading native modules.
import { projectRoot, useProjectRuntime } from './runtime.mjs';
import { notificationLedgerSummary, publicNotificationConfiguration, resolveNotificationVerification, type VerificationChannel } from './live-notification-config';
import { assertUnknownRecoveryLedger, reconcileExpiredNotificationLease, recoveryBusinessTables, recoveryTableCount, smtpRecoveryPreflight, unknownRecoveryArguments, unknownRecoverySummary, UnknownRecoveryError, type RecoveryLedger } from './unknown-notification-recovery';
import { createVerificationFinalizer, redactSecrets, verificationReportStatus, type VerificationFinalState } from './verification-support';

const args = unknownRecoveryArguments(process.argv.slice(2));
if (args.issues.length || process.env.NODE_ENV === 'test') {
  console.error(JSON.stringify({ status: 'not_run', issues: process.env.NODE_ENV === 'test' ? [{ code: 'TEST_OUTBOUND_BLOCKED', message: '自动测试环境禁止真实人工恢复。' }] : args.issues }));
  process.exitCode = 1;
} else {
  await useProjectRuntime(import.meta.url, ['--import', 'tsx']);
  try { await recover(args.channel!, args.reason, args.expectedAttempts); }
  catch (error) {
    console.error(JSON.stringify({ status: 'not_run', error_code: error instanceof UnknownRecoveryError ? error.code : 'RECOVERY_FAILED', error: error instanceof UnknownRecoveryError ? error.message : '人工恢复未能启动，本次未发送。' }));
    process.exitCode = 1;
  }
}

async function recover(channel: VerificationChannel, reason: string, expectedAttempts: 1 | 2) {
  // No configuration, database, or server module is loaded until all explicit opt-ins pass.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: join(projectRoot, '.env') });
  if (process.env.NODE_ENV === 'test') throw new UnknownRecoveryError('TEST_OUTBOUND_BLOCKED', '自动测试环境禁止真实人工恢复。');
  const selected = resolveNotificationVerification(channel, process.env);
  if (!selected.configured || !selected.targetHash) throw new UnknownRecoveryError('NOTIFICATION_NOT_CONFIGURED', '通知配置未就绪，不能人工恢复。');
  const { default: Database } = await import('better-sqlite3');
  const auditDirectory = join(projectRoot, 'var', 'live-notifications', channel, selected.targetHash), auditFile = join(auditDirectory, 'app.sqlite');
  if (!existsSync(auditFile)) throw new UnknownRecoveryError('RECOVERY_AUDIT_MISSING', '原目标联调台账不存在，不能创建新批次代替恢复。');
  const lockPath = join(auditDirectory, 'verification.lock'), token = randomUUID();
  try { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new UnknownRecoveryError('VERIFICATION_LOCKED', '该目标已有联调锁，本次不会人工恢复。'); }

  const started = Date.now(), reportPath = join(projectRoot, 'docs', `真实提醒联调-${channel}-人工恢复-${started}-${token}.json`);
  const report: Record<string, any> = {
    status: 'not_run', operation: 'resend_unknown_once', scope: 'fixed_synthetic_channel_test', user_database_used: false, channel, manual_reason: reason, configuration: publicNotificationConfiguration(selected),
    audit_directory: relative(projectRoot, auditDirectory), expected_attempts: expectedAttempts, new_transmission_attempts: 0, receipt_status: 'not_confirmed', queue_calls: 0,
    smtp_preflight: { status: channel === 'email' ? 'not_run' : 'not_applicable', scope: 'smtp_connection_and_authentication_only', message_sent: false },
    runtime: { source: 'TypeScript source via tsx', node: process.versions.node, llm_mode: 'mock', allow_external_model: false, outbound_mode: 'live', scheduler_enabled: false, server_started: false },
  };
  let store: import('../apps/server/src/store').Store | undefined;
  let preflightPromise: Promise<unknown> | undefined, queuePromise: Promise<unknown> | undefined, before: RecoveryLedger | undefined;
  let reconciliation: Promise<Awaited<ReturnType<typeof reconcileExpiredNotificationLease>>> | undefined;
  let reportCreated = false, recoveryRequested = false;
  let progress: ReturnType<typeof setInterval> | undefined;

  function readLedger(): RecoveryLedger {
    const db = new Database(auditFile, { readonly: true, fileMustExist: true });
    try {
      if ((db.pragma('quick_check') as any[])[0]?.quick_check !== 'ok') throw new Error('Invalid audit');
      const rows = (table: string) => (db.prepare(`SELECT data FROM ${table} ORDER BY created_at,id`).all() as { data: string }[]).map(row => JSON.parse(row.data));
      const count = (table: string) => recoveryTableCount(db, table);
      return { notifications: rows('notifications'), attempts: rows('attempts'), reminders: count('reminders'), projects: count('projects'), tasks: count('tasks'), business_rows: recoveryBusinessTables.reduce((total, table) => total + count(table), 0) };
    } catch { throw new UnknownRecoveryError('RECOVERY_AUDIT_INVALID', '原联调台账无法完整核对，本次停止。'); }
    finally { db.close(); }
  }
  function saveReport(state: VerificationFinalState) {
    if (before) {
      try {
        const current = readLedger();
        if (recoveryRequested) {
          const summary = unknownRecoverySummary(before, current, channel);
          report.after = summary; report.new_transmission_attempts = summary.new_transmission_attempts; report.receipt_status = summary.receipt_status;
        } else {
          report.after = { status: 'not_attempted', ledger_unchanged: isDeepStrictEqual(before, current), lease_state_reconciled: Boolean(report.lease_reconciliation), batch_count: current.notifications.length, attempt_count: current.attempts.length, new_transmission_attempts: 0 };
        }
      } catch { report.audit_read_after_stop = 'failed'; if (!state.cancelled && !state.cleanupFailed) report.status = 'audit_mismatch'; }
    }
    report.recorded_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
    report.send_authorization_consumed = report.new_transmission_attempts > 0;
    report.status = verificationReportStatus(report.status, state);
    report.receipt_note = '既往尝试送达仍未知；本次传输接受仅代表服务器或机器人接口接受，实际收件仍须人工确认。';
    const content = JSON.stringify(redactSecrets(report, selected.secrets), null, 2) + '\n';
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(reportPath, content, { flag: reportCreated ? 'w' : 'wx', mode: 0o600 }); reportCreated = true;
    console.log(content);
  }
  const finalizer = createVerificationFinalizer({
    cleanup: async () => {
      // Let the sole in-flight transport finish and persist its result before closing its Store.
      try { await reconciliation; } catch { /* A lease-only check never sends or creates a new transmission. */ }
      try { await preflightPromise; } catch { /* The preflight never sends MAIL; main flow records its stable failure. */ }
      try { await queuePromise; } catch { /* Main flow records the failure; no second queue is started. */ }
      if (progress) clearInterval(progress);
      store?.close();
      if (existsSync(lockPath)) {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (owner.token === token && owner.pid === process.pid) unlinkSync(lockPath);
      }
    },
    save: saveReport,
    onCancel: signal => { report.status = 'cancelled'; report.error_code = 'VERIFICATION_CANCELLED'; report.cancellation_signal = signal; report.cancel_note = recoveryRequested ? '人工恢复已请求，取消不证明未送达；等待当前唯一发送写回，保留台账且不再重试。' : '已取消，本次不会请求人工恢复。'; },
    onCleanupError: () => { report.cleanup = 'failed'; report.error_code = 'CLEANUP_FAILED'; process.exitCode = 1; },
  });
  try {
    before = readLedger();
    reconciliation = reconcileExpiredNotificationLease(auditFile, selected, readLedger, new Date(), () => finalizer.cancelled);
    const reconciled = await reconciliation;
    if (reconciled) {
      report.lease_reconciliation = reconciled;
      report.status = 'result_unknown'; report.reason = 'EXPIRED_LEASE_RECONCILED_REVIEW_REQUIRED';
      report.before = notificationLedgerSummary(before, channel);
      report.before_snapshot_sha256 = createHash('sha256').update(JSON.stringify(before)).digest('hex');
      report.review_note = '本次只归并过期租约，未进行SMTP预检、未入队、未消耗发送授权。请先核查接收端，确认后再显式调用人工恢复。';
      process.exitCode = 1;
      return;
    }
    assertUnknownRecoveryLedger(before, selected, expectedAttempts);
    const baseline = notificationLedgerSummary(before, channel), baselineChecks: Record<string, boolean> = { ...baseline.checks };
    delete baselineChecks.exactly_one_attempt;
    report.before = { ...baseline, expected_attempts: expectedAttempts, checks: { ...baselineChecks, expected_unknown_attempts: before.attempts.length === expectedAttempts } };
    report.before_snapshot_sha256 = createHash('sha256').update(JSON.stringify(before)).digest('hex');
    const originalReport = join(projectRoot, 'docs', `真实提醒联调-${channel}.json`);
    report.initial_report = { path: relative(projectRoot, originalReport), sha256: existsSync(originalReport) ? createHash('sha256').update(readFileSync(originalReport)).digest('hex') : null };
    report.status = 'prepared'; saveReport({ cancelled: false, cleanupFailed: false });
    if (channel === 'email') {
      const [{ default: nodemailer }, { smtpTransportOptions }] = await Promise.all([import('nodemailer'), import('../packages/integrations/src/outbound')]);
      if (finalizer.cancelled) throw new UnknownRecoveryError('VERIFICATION_CANCELLED', '人工恢复已取消。');
      report.smtp_preflight.status = 'running';
      preflightPromise = smtpRecoveryPreflight(() => nodemailer.createTransport(smtpTransportOptions(selected.privateEnvironment)));
      try { await preflightPromise; report.smtp_preflight.status = 'passed'; }
      catch (error) { report.smtp_preflight.status = 'failed'; throw error; }
    }
    const [{ Store }, { NotificationService }] = await Promise.all([import('../apps/server/src/store'), import('../apps/server/src/notifications')]);
    if (finalizer.cancelled) throw new UnknownRecoveryError('VERIFICATION_CANCELLED', '人工恢复已取消。');
    store = new Store(auditFile);
    const service = new NotificationService(store, { ...selected.privateEnvironment, LLM_MODE: 'mock', ALLOW_EXTERNAL_MODEL: 'false', OUTBOUND_MODE: 'live', SCHEDULER_ENABLED: 'false' });
    store.transaction(() => {
      const current = readLedger(); assertUnknownRecoveryLedger(current, selected, expectedAttempts);
      if (!isDeepStrictEqual(before, current)) throw new UnknownRecoveryError('RECOVERY_AUDIT_CHANGED', '预检后台账已变化，本次停止。');
      service.resolveUnknown(before!.notifications[0].id, { action: 'resend', reason });
    });
    recoveryRequested = true; report.queue_calls = 1;
    progress = setInterval(() => console.log(`单次人工恢复已等待${Math.floor((Date.now() - started) / 1000)}秒；不会启动第二次队列或自动重试。`), 10000); progress.unref();
    queuePromise = service.processQueue(1); await queuePromise;
    const summary = unknownRecoverySummary(before, readLedger(), channel);
    if (!finalizer.cancelled) report.status = summary.status;
    if (summary.status !== 'transport_accepted') process.exitCode = 1;
  } catch (error) {
    if (!finalizer.cancelled) {
      report.status = 'failed'; report.error_code = error instanceof UnknownRecoveryError ? error.code : 'RECOVERY_FAILED';
      report.error = error instanceof UnknownRecoveryError ? error.message : '本次人工恢复未完成，请核对保留台账；不会自动重试。'; process.exitCode = 1;
    }
  } finally { await finalizer.finish(); }
}
