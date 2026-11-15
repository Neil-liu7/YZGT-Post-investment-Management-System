import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../../scripts/supervisor-core.mjs';

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 10000) + 1;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed: string[] = [];

  kill(signal = 'SIGTERM') {
    this.killed.push(signal);
    if (this.exitCode === null) {
      this.exitCode = signal === 'SIGKILL' ? 137 : 0;
      queueMicrotask(() => this.emit('close', this.exitCode, signal));
    }
    return true;
  }
}

async function eventually(predicate: () => boolean, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('runtime supervisor', () => {
  it('restarts an unexpected child and stops without another restart', async () => {
    const children: FakeChild[] = [];
    const alerts: Array<{ type: string }> = [];
    const supervisor = new Supervisor({
      spawnProcess: () => { const child = new FakeChild(); children.push(child); return child; },
      healthCheck: async () => true,
      healthIntervalMs: 5,
      restartDelayMs: 1,
      maxRestarts: 3,
      onAlert: event => alerts.push(event),
    });
    const running = supervisor.run();
    await eventually(() => children.length === 1);
    children[0].emit('close', 1, null);
    await eventually(() => children.length === 2);
    expect(alerts.some(event => event.type === 'restart_scheduled')).toBe(true);
    await supervisor.stop();
    await running;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(children).toHaveLength(2);
    expect(supervisor.state).toBe('stopping');
  });

  it('turns repeated health failures into an alert and a restart', async () => {
    const children: FakeChild[] = [];
    const alerts: Array<{ type: string }> = [];
    const supervisor = new Supervisor({
      spawnProcess: () => { const child = new FakeChild(); children.push(child); return child; },
      healthCheck: async () => false,
      healthIntervalMs: 5,
      healthFailureThreshold: 2,
      restartDelayMs: 1,
      maxRestarts: 1,
      stopGraceMs: 1,
      onAlert: event => alerts.push(event),
    });
    const running = supervisor.run();
    await eventually(() => children.length >= 2);
    expect(alerts.some(event => event.type === 'health_failed')).toBe(true);
    await supervisor.stop();
    await running;
  });

  it('finishes with restart_exhausted after the rolling restart limit', async () => {
    const children: FakeChild[] = [];
    const alerts: Array<{ type: string }> = [];
    const supervisor = new Supervisor({
      spawnProcess: () => { const child = new FakeChild(); children.push(child); return child; },
      healthCheck: async () => true,
      restartDelayMs: 1,
      maxRestarts: 1,
      onAlert: event => alerts.push(event),
    });
    const resultPromise = supervisor.run();
    await eventually(() => children.length === 1);
    children[0].emit('close', 1, null);
    await eventually(() => children.length === 2);
    children[1].emit('close', 1, null);
    const result = await resultPromise;
    expect(result.reason).toBe('restart_exhausted');
    expect(alerts.some(event => event.type === 'restart_exhausted')).toBe(true);
    expect(supervisor.state).toBe('failed');
  });

  it('force-kills a child that ignores the graceful stop signal', async () => {
    const child = new FakeChild();
    child.kill = function kill(signal = 'SIGTERM') {
      this.killed.push(signal);
      if (signal === 'SIGKILL') {
        this.exitCode = 137;
        queueMicrotask(() => this.emit('close', 137, signal));
      }
      return true;
    };
    const supervisor = new Supervisor({
      spawnProcess: () => child,
      healthCheck: async () => true,
      stopGraceMs: 5,
    });
    const resultPromise = supervisor.run();
    await eventually(() => supervisor.child === child);
    await supervisor.stop();
    const result = await resultPromise;
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.reason).toBe('stopped');
  });
});
