import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerificationFinalizer, redactSecrets, verificationReportStatus } from '../../scripts/verification-support';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const leaves = new Set<number>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(done => child.once('close', () => done())); child.kill('SIGKILL'); await closed;
  }
  children.clear();
  for (const pid of leaves) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped by the fixture. */ } }
  leaves.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verification report redaction', () => {
  it.each(['synthetic"quoted-secret', 'synthetic\\escaped-secret'])('redacts literal credentials before JSON escaping: %s', secret => {
    const report = { model: `prefix-${secret}-suffix`, nested: [{ secret }], ordinary: 'safe', tokens: 7 };
    const safe = redactSecrets(report, [secret]);
    const restored = JSON.parse(JSON.stringify(safe));
    expect(restored.model).toBe('prefix-[REDACTED]-suffix');
    expect(restored.nested[0].secret).toBe('[REDACTED]');
    expect(restored).toMatchObject({ ordinary: 'safe', tokens: 7 });
    expect(report.nested[0].secret).toBe(secret);
  });
  it('redacts credential-bearing keys and repeated nested strings without mutating the report', () => {
    const secret = 'synthetic"\\secret';
    const report = { [secret]: [secret, `${secret}:${secret}`], flag: false };
    expect(redactSecrets(report, ['', secret])).toEqual({ '[REDACTED]': ['[REDACTED]', '[REDACTED]:[REDACTED]'], flag: false });
    expect(report[secret][0]).toBe(secret);
  });
});

describe('verification cancellation cleanup', () => {
  it.each(['transport_accepted', 'live_passed'])('preserves cancellation when %s arrives during asynchronous cleanup', async lateStatus => {
    let release: () => void = () => {};
    const cleanup = new Promise<void>(done => { release = done; });
    const report = { status: 'running' }; let saved: string | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const lifecycle = createVerificationFinalizer({
      cleanup: () => cleanup,
      save: state => { saved = verificationReportStatus(report.status, state); },
      onCancel: () => { report.status = 'cancelled'; },
      onCleanupError: () => { report.status = 'cleanup_failed'; },
    });
    try {
      process.emit('SIGINT'); report.status = lateStatus; release();
      await lifecycle.finish();
      expect(lifecycle.cancelled).toBe(true); expect(saved).toBe('cancelled');
    } finally { exit.mockRestore(); }
  });

  it('keeps cleanup failure terminal when a successful result arrives while cleanup is pending', async () => {
    const report = { status: 'running' }; let saved: string | undefined;
    const lifecycle = createVerificationFinalizer({
      cleanup: async () => { await Promise.resolve(); report.status = 'live_passed'; throw new Error('Synthetic cleanup failure'); },
      save: state => { saved = verificationReportStatus(report.status, state); },
      onCancel: () => { report.status = 'cancelled'; },
      onCleanupError: () => {},
    });
    await lifecycle.finish();
    expect(saved).toBe('cleanup_failed');
  });

  it('joins concurrent finalization requests into one cleanup and save', async () => {
    let cleanups = 0, saves = 0;
    const lifecycle = createVerificationFinalizer({ cleanup: async () => { cleanups++; await Promise.resolve(); }, save: () => { saves++; }, onCancel: () => { throw new Error('Unexpected cancellation'); }, onCleanupError: error => { throw error; } });
    await Promise.all([lifecycle.finish(), lifecycle.finish()]);
    expect({ cleanups, saves, cancelled: lifecycle.cancelled }).toEqual({ cleanups: 1, saves: 1, cancelled: false });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('handles %s without orphaning its child or temporary data', async signal => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-verification-signal-')); roots.push(root);
    const helper = new URL('../../scripts/verification-support.ts', import.meta.url).href;
    const program = `
      import {spawn} from 'node:child_process';
      import {mkdirSync,existsSync,writeFileSync,rmSync} from 'node:fs';
      import {join} from 'node:path';
      import {createVerificationFinalizer} from ${JSON.stringify(helper)};
      const root=process.argv[1], temporary=join(root,'isolated');mkdirSync(temporary);
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{}});
      const report={status:'running',cleanups:0,saves:0};
      const lifecycle=createVerificationFinalizer({
        cleanup:async()=>{report.cleanups++;await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('fixture child did not stop'));},3000);child.once('close',()=>{clearTimeout(timer);done();});child.kill('SIGTERM');});rmSync(temporary,{recursive:true});},
        save:()=>{report.saves++;report.temporary_exists=existsSync(temporary);writeFileSync(join(root,'report.json'),JSON.stringify(report));},
        onCancel:signal=>{report.status='cancelled';report.signal=signal;},
        onCleanupError:()=>{report.status='failed';}
      });
      console.log(JSON.stringify({ready:true,pid:child.pid}));
      await new Promise(()=>{});
      await lifecycle.finish();
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, root], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stderr = ''; child.stderr!.on('data', value => { stderr += String(value); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => { child.once('error', reject); child.once('close', (code, value) => done({ code, signal: value })); });
    const pid = await new Promise<number>((done, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error(`Signal fixture was not ready: ${stderr}`)), 5000);
      child.stdout!.on('data', value => { output += String(value); if (!output.includes('\n')) return; try { const result = JSON.parse(output.trim()); clearTimeout(timeout); done(result.pid); } catch { /* Wait for the complete readiness message. */ } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    leaves.add(pid);
    child.kill(signal); child.kill(signal);
    expect(await closed).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
    expect(existsSync(join(root, 'isolated'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))).toMatchObject({ status: 'cancelled', signal, cleanups: 1, saves: 1, temporary_exists: false });
    expect(() => process.kill(pid, 0)).toThrow(); leaves.delete(pid);
  });
});
