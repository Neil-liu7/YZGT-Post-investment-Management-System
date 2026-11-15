import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../../scripts/supervisor-core.mjs';

class FakeChild extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 1000);
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: string[] = [];
  constructor(private readonly closeOnKill = false) { super(); }
  kill(signal = 'SIGTERM') {
    this.kills.push(signal);
    if (this.closeOnKill) queueMicrotask(() => { this.exitCode = signal === 'SIGTERM' ? 0 : null; this.signalCode = signal === 'SIGTERM' ? null : signal; this.emit('close', this.exitCode, this.signalCode); });
    return true;
  }
}

type Timer = { callback: () => void; delay: number; cancelled: boolean };
function timerHarness() {
  const timers: Timer[] = [];
  return {
    timers,
    setTimeout(callback: () => void, delay: number) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer: Timer) { timer.cancelled = true; },
    run(delay: number) { const timer = timers.find(candidate => !candidate.cancelled && candidate.delay === delay); if (!timer) throw new Error(`timer ${delay} not found`); timer.cancelled = true; timer.callback(); },
  };
}

describe('runtime supervisor', () => {
  const supervisors: Supervisor[] = [];
  afterEach(async () => { for (const supervisor of supervisors.splice(0)) await supervisor.stop(); });

  it('restarts crashed children with backoff and stops after the cap', () => {
    const timers = timerHarness(); const children: FakeChild[] = []; const alerts: any[] = [];
    const supervisor = new Supervisor({
      spawnProcess: () => { const child = new FakeChild(); children.push(child); return child; },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, restartDelayMs: 10, maxRestartDelayMs: 100, maxRestarts: 2,
      healthIntervalMs: 1000, onAlert: (event: any) => alerts.push(event), logger: { warn() {}, error() {}, log() {} },
    }); supervisors.push(supervisor);
    supervisor.launch(); supervisor.handleChildExit(children[0], 7, null);
    expect(alerts.map(event => event.type)).toContain('restart_scheduled');
    timers.run(10); expect(children).toHaveLength(2);
    supervisor.handleChildExit(children[1], 7, null); timers.run(20); expect(children).toHaveLength(3);
    supervisor.handleChildExit(children[2], 7, null);
    expect(supervisor.state).toBe('failed'); expect(alerts.map(event => event.type)).toContain('restart_exhausted');
  });

  it('alerts and terminates a child after consecutive health failures', async () => {
    const timers = timerHarness(); const child = new FakeChild(); const alerts: any[] = [];
    const supervisor = new Supervisor({
      spawnProcess: () => child, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, healthFailureThreshold: 2,
      healthCheck: async () => false, onAlert: (event: any) => alerts.push(event), logger: { warn() {}, error() {}, log() {} },
    }); supervisors.push(supervisor);
    supervisor.launch(); await supervisor.probeHealth(child); await supervisor.probeHealth(child);
    expect(child.kills).toContain('SIGTERM'); expect(alerts.some(event => event.type === 'health_failed')).toBe(true);
  });

  it('does not restart after an explicit stop', async () => {
    const timers = timerHarness(); const children: FakeChild[] = []; const alerts: any[] = [];
    const supervisor = new Supervisor({
      spawnProcess: () => { const child = new FakeChild(true); children.push(child); return child; },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, onAlert: (event: any) => alerts.push(event), logger: { warn() {}, error() {}, log() {} },
    }); supervisors.push(supervisor);
    const result = supervisor.run(); await supervisor.stop('shutdown'); expect(await result).toMatchObject({ code: 0, reason: 'stopped' });
    expect(children).toHaveLength(1); expect(alerts.some(event => event.type === 'restart_scheduled')).toBe(false);
  });
});
