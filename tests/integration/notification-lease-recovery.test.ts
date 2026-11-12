import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { Store } from '../../apps/server/src/store';
import { NotificationService } from '../../apps/server/src/notifications';
import { recipientKey } from '../../packages/integrations/src/outbound';
import { notificationTestBody, resolveNotificationVerification } from '../../scripts/live-notification-config';
import * as recovery from '../../scripts/unknown-notification-recovery';

const now = new Date('2026-11-12T06:02:00.000Z');
const config = resolveNotificationVerification('email', { SMTP_HOST: 'smtp.example.invalid', SMTP_USER: 'synthetic', SMTP_PASS: 'synthetic-password', SMTP_FROM: 'sender@example.invalid', MAIL_TO: 'recipient@example.invalid' });
const roots: string[] = [];
const stores = new Set<Store>();
const children = new Set<ChildProcess>();
let networkCalls = 0, smtpCalls = 0;

function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-lease-recovery-')); roots.push(root);
  const file = join(root, 'audit.sqlite');
  const store = new Store(file, () => now); stores.add(store);
  const batch = store.create('notifications', {
    id: 'synthetic-batch', channel: 'email', mode: 'live', purpose: 'test', project_id: null,
    status: 'sending', attempts: count, recipients: ['recipient@example.invalid'], recipient_key: `email:${recipientKey(['recipient@example.invalid'])}`,
    content: { subject: '投后管理渠道测试', body: notificationTestBody, items: [] }, reminder_ids: [],
    lease_until: '2026-11-12T06:01:00.000Z', next_attempt_at: null,
  });
  for (let index = 1; index <= count; index++) store.create('attempts', {
    id: `synthetic-attempt-${index}`, notification_id: batch.id, attempt_number: index, mode: 'live',
    status: index === count ? 'sending' : 'unknown', started_at: `2026-11-12T06:00:0${index}.000Z`,
    finished_at: index === count ? null : '2026-11-12T06:00:30.000Z', error_code: index === count ? null : 'DELIVERY_UNKNOWN', detail: { retain: index },
  });
  const read = (): recovery.RecoveryLedger => {
    const countRows = (table: string) => store.all(table).length;
    return { notifications: store.all('notifications'), attempts: store.all('attempts'), projects: countRows('projects'), tasks: countRows('tasks'), reminders: countRows('reminders'), business_rows: recovery.recoveryBusinessTables.reduce((sum, table) => sum + countRows(table), 0) };
  };
  return { file, store, read };
}

beforeEach(() => {
  networkCalls = 0; smtpCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { networkCalls++; throw new Error('Real network forbidden'); });
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => { smtpCalls++; throw new Error('SMTP forbidden'); });
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(done => child.once('close', () => done())); child.kill('SIGKILL'); await closed; } children.clear();
  expect(networkCalls).toBe(0); expect(smtpCalls).toBe(0);
  for (const store of stores) { try { store.close(); } catch { /* A persisted fixture was deliberately reopened. */ } } stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('expired synthetic notification lease reconciliation without sending', () => {
  it.each([1, 2, 3])('reopens persisted sending attempt %s as unknown without appending a transmission', async count => {
    const f = fixture(count), before = f.read();
    f.store.close(); stores.delete(f.store);
    const reopened = new Store(f.file, () => now); stores.add(reopened);
    const read = (): recovery.RecoveryLedger => ({ notifications: reopened.all('notifications'), attempts: reopened.all('attempts'), projects: 0, tasks: 0, reminders: 0, business_rows: 0 });
    const queue = vi.spyOn(NotificationService.prototype, 'processQueue');
    const result = await recovery.reconcileExpiredNotificationLease(f.file, config, read, now);
    expect(result).toMatchObject({ status: 'reconciled_to_unknown', new_transmission_attempts: 0, attempt_count: count, before: { transport_state: 'sending', latest_attempt_state: 'sending' }, after: { transport_state: 'unknown', latest_attempt_state: 'unknown' } });
    expect(Object.values(result!.checks).every(Boolean)).toBe(true);
    expect(queue).toHaveBeenCalledExactlyOnceWith(0);
    const after = read();
    expect(after.notifications[0]).toMatchObject({ id: before.notifications[0].id, status: 'unknown', attempts: count, lease_until: null });
    expect(after.attempts).toHaveLength(count);
    expect(after.attempts.slice(0, -1)).toEqual(before.attempts.slice(0, -1));
    expect(after.attempts.at(-1)).toMatchObject({ id: `synthetic-attempt-${count}`, status: 'unknown', finished_at: now.toISOString(), detail: { retain: count } });
    if (count < 3) expect(() => recovery.assertUnknownRecoveryLedger(after, config, count as 1 | 2)).not.toThrow();
    else for (const baseline of [1, 2] as const) expect(() => recovery.assertUnknownRecoveryLedger(after, config, baseline)).toThrow();
    const logs = reopened.all('audit_logs').length;
    expect(await recovery.reconcileExpiredNotificationLease(f.file, config, read, now)).toBeNull();
    expect(reopened.all('audit_logs')).toHaveLength(logs);
  });

  it('does not change an unexpired sending lease', async () => {
    const f = fixture(), batch = f.read().notifications[0];
    f.store.update('notifications', batch.id, batch.version, { lease_until: '2026-11-12T06:03:00.000Z' });
    const before = f.read();
    expect(await recovery.reconcileExpiredNotificationLease(f.file, config, f.read, now)).toBeNull();
    expect(f.read()).toEqual(before); expect(f.store.all('audit_logs')).toHaveLength(0);
  });

  it.each([
    ['wrong target', (f: ReturnType<typeof fixture>) => { const b = f.read().notifications[0]; f.store.update('notifications', b.id, b.version, { recipient_key: 'email:other' }); }],
    ['changed body', (f: ReturnType<typeof fixture>) => { const b = f.read().notifications[0]; f.store.update('notifications', b.id, b.version, { content: { ...b.content, body: 'different data' } }); }],
    ['business rows', (f: ReturnType<typeof fixture>) => { f.store.create('projects', { name: 'synthetic-business' }); }],
    ['invalid lease', (f: ReturnType<typeof fixture>) => { const b = f.read().notifications[0]; f.store.update('notifications', b.id, b.version, { lease_until: 'not-a-date' }); }],
    ['more than three attempts', (_f: ReturnType<typeof fixture>) => {}],
  ] as const)('refuses %s without reconciling or invoking a queue', async (name, change) => {
    const f = fixture(name === 'more than three attempts' ? 4 : 1); change(f); const before = f.read();
    const queue = vi.spyOn(NotificationService.prototype, 'processQueue');
    await expect(recovery.reconcileExpiredNotificationLease(f.file, config, f.read, now)).rejects.toMatchObject({ code: expect.stringMatching(/^RECOVERY_/) });
    expect(f.read()).toEqual(before); expect(queue).not.toHaveBeenCalled(); expect(f.store.all('audit_logs')).toHaveLength(0);
  });

  it('refuses reconciliation after cancellation without changing the ledger', async () => {
    const f = fixture(), before = f.read();
    await expect(recovery.reconcileExpiredNotificationLease(f.file, config, f.read, now, () => true)).rejects.toMatchObject({ code: 'VERIFICATION_CANCELLED' });
    expect(f.read()).toEqual(before); expect(f.store.all('audit_logs')).toHaveLength(0);
  });

  it.each(['verify-live-notifications.ts', 'resolve-unknown-notification.ts'])('%s reconciles an isolated persisted lease and stops before any send', async script => {
    const f = fixture(), b = f.read().notifications[0];
    f.store.update('notifications', b.id, b.version, { lease_until: new Date(Date.now() - 120000).toISOString() });
    f.store.close(); stores.delete(f.store);
    const root = mkdtempSync(join(tmpdir(), 'yzgt-lease-cli-')); roots.push(root);
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'docs'));
    for (const name of ['runtime.mjs', 'verification-support.ts', 'live-notification-config.ts', 'unknown-notification-recovery.ts', script]) copyFileSync(resolve('scripts', name), join(root, 'scripts', name));
    for (const name of ['apps', 'packages', 'database', 'node_modules']) symlinkSync(resolve(name), join(root, name), 'dir');
    writeFileSync(join(root, '.node-version'), '22.22.2\n'); writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, '.env'), 'SMTP_HOST=smtp.example.invalid\nSMTP_USER=synthetic\nSMTP_PASS=synthetic-password\nSMTP_FROM=sender@example.invalid\nMAIL_TO=recipient@example.invalid\nLLM_MODE=mock\nOUTBOUND_MODE=mock\nSCHEDULER_ENABLED=false\n');
    const directory = join(root, 'var', 'live-notifications', 'email', config.targetHash); mkdirSync(directory, { recursive: true });
    copyFileSync(f.file, join(directory, 'app.sqlite'));
    const guard = join(root, 'network-guard.mjs');
    writeFileSync(guard, `import nodemailer from 'nodemailer';import {writeFileSync} from 'node:fs';const forbidden=()=>{writeFileSync(${JSON.stringify(join(root, 'network-attempted'))},'blocked');throw new Error('Network forbidden');};nodemailer.createTransport=forbidden;globalThis.fetch=forbidden;`);
    const args = ['--import', 'tsx', '--import', guard, join(root, 'scripts', script), '--live', '--channel=email'];
    if (script === 'resolve-unknown-notification.ts') args.push('--resend-unknown', '--reason=synthetic receipt review');
    const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    let stdout = '', stderr = ''; child.stdout!.on('data', value => { stdout += value; }); child.stderr!.on('data', value => { stderr += value; });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Isolated lease CLI did not stop: ${stderr}`)); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    });
    expect(result).toEqual({ code: 1, signal: null });
    const reports = readdirSync(join(root, 'docs')).filter(name => name.endsWith('.json'));
    expect(reports).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(root, 'docs', reports[0]), 'utf8'));
    expect(report).toMatchObject({ status: 'result_unknown', new_transmission_attempts: 0, send_authorization_consumed: false, reason: 'EXPIRED_LEASE_RECONCILED_REVIEW_REQUIRED', lease_reconciliation: { status: 'reconciled_to_unknown', attempt_count: 1 } });
    if (script === 'resolve-unknown-notification.ts') expect(report).toMatchObject({ queue_calls: 0, smtp_preflight: { status: 'not_run' }, after: { status: 'not_attempted', lease_state_reconciled: true, new_transmission_attempts: 0 } });
    expect(existsSync(join(directory, 'verification.lock'))).toBe(false);
    expect(existsSync(join(root, 'network-attempted'))).toBe(false);
    expect(stdout).not.toContain('synthetic-password'); expect(stderr).not.toContain('synthetic-password');
    const persisted = new Store(join(directory, 'app.sqlite')); stores.add(persisted);
    expect(persisted.all('notifications')[0].status).toBe('unknown');
    expect(persisted.all('attempts')).toHaveLength(1); expect(persisted.all('attempts')[0].status).toBe('unknown');
  });
});
