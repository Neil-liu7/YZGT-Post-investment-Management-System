import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const versions = dirname(dirname(dirname(process.execPath)));
const installed = existsSync(versions) ? readdirSync(versions).filter(name => /^v\d+\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => join(versions, name, 'bin', 'node')) : [];
const alternate = installed.find(file => existsSync(file) && realpathSync(file) !== realpathSync(process.execPath));
const nvmDirectory = dirname(dirname(versions));
const roots: string[] = [], children = new Set<ChildProcess>(), leaves = new Set<number>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed; }
  children.clear();
  for (const pid of leaves) { try { process.kill(pid, 'SIGKILL'); } catch { /* Fixture already exited. */ } } leaves.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(mode: 'cancel' | 'service' | 'fail') {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-runtime-exit-')); roots.push(root);
  const file = join(root, 'fixture.mjs'), helper = new URL('../../scripts/runtime.mjs', import.meta.url).href;
  writeFileSync(file, `import {useProjectRuntime} from ${JSON.stringify(helper)};\nawait useProjectRuntime(import.meta.url);\nif(process.argv[2]==='fail')process.exit(7);\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.exit(process.argv[2]==='service'?0:signal==='SIGINT'?130:143));\nconsole.log(JSON.stringify({ready:true,pid:process.pid,node:process.versions.node}));\nsetInterval(()=>{},1000);\n`);
  const child = spawn(alternate!, [file, mode], { env: { PATH: process.env.PATH ?? '', NVM_DIR: nvmDirectory }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let stderr = ''; child.stderr!.on('data', value => { stderr += value; });
  const ready = mode === 'fail' ? null : await new Promise<{ pid: number; node: string }>((resolve, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(new Error(`Runtime fixture not ready: ${stderr}`)), 5000);
    child.stdout!.on('data', value => { text += value; const line = text.split('\n').find(value => value.startsWith('{')); if (!line) return; try { const record = JSON.parse(line); clearTimeout(timeout); leaves.add(record.pid); resolve(record); } catch { /* Wait for a full line. */ } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return { child, closed, ready };
}

describe('project Node wrapper exit status', () => {
  // Exercise a real executable switch when a second local Node exists; never install a runtime or load .env for this fixture.
  it.skipIf(!alternate).each(['SIGINT', 'SIGTERM'] as const)('preserves child cancellation %s after automatic Node selection', async signal => {
    const f = await fixture('cancel');
    expect(f.ready!.node).toBe('22.22.2');
    f.child.kill(signal);
    expect(await f.closed).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
    expect(() => process.kill(f.ready!.pid, 0)).toThrow(); leaves.delete(f.ready!.pid);
  });
  it.skipIf(!alternate)('keeps a normally stopped service successful', async () => {
    const f = await fixture('service'); f.child.kill('SIGTERM');
    expect(await f.closed).toEqual({ code: 0, signal: null }); leaves.delete(f.ready!.pid);
  });
  it.skipIf(!alternate)('preserves a child command failure', async () => {
    const f = await fixture('fail'); expect(await f.closed).toEqual({ code: 7, signal: null });
  });
});
