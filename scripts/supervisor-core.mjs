import { spawn as defaultSpawn } from 'node:child_process';

/**
 * Small process supervisor used by the local runtime entry point.
 *
 * The class is deliberately dependency-injected so tests can simulate process
 * exits and health failures without starting the real service. It never
 * retries after an explicit stop, and it caps restarts in a rolling window.
 */
export class Supervisor {
  constructor(options = {}) {
    this.command = options.command ?? process.execPath;
    this.args = options.args ?? ['scripts/start.mjs'];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.host = options.host ?? '127.0.0.1';
    this.port = Number(options.port ?? 8765);
    this.healthIntervalMs = Math.max(100, Number(options.healthIntervalMs ?? 5000));
    this.healthTimeoutMs = Math.max(100, Number(options.healthTimeoutMs ?? 1500));
    this.healthFailureThreshold = Math.max(1, Number(options.healthFailureThreshold ?? 3));
    this.restartDelayMs = Math.max(0, Number(options.restartDelayMs ?? 1000));
    this.maxRestartDelayMs = Math.max(this.restartDelayMs, Number(options.maxRestartDelayMs ?? 30000));
    this.maxRestarts = Math.max(0, Number(options.maxRestarts ?? 5));
    this.restartWindowMs = Math.max(1000, Number(options.restartWindowMs ?? 60000));
    this.stopGraceMs = Math.max(100, Number(options.stopGraceMs ?? 5000));
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.healthCheck = options.healthCheck ?? ((host, port, timeoutMs) => this.defaultHealthCheck(host, port, timeoutMs));
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? setTimeout;
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.logger = options.logger ?? console;
    this.onAlert = options.onAlert ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.state = 'idle';
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
    this.healthTimer = null;
    this.forceStopTimer = null;
    this.restartTimes = [];
    this.healthFailures = 0;
    this.terminationReason = null;
    this.resolveRun = null;
    this.runPromise = null;
  }

  async defaultHealthCheck(host, port, timeoutMs) {
    const controller = new globalThis.AbortController();
    const timer = this.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.data?.status === 'ok';
    } catch {
      return false;
    } finally {
      this.clearTimeout(timer);
    }
  }

  alert(type, detail = {}) {
    const event = { type, at: new Date(this.now()).toISOString(), ...detail };
    try { this.onAlert(event); } catch (error) { this.logger.error?.('[supervisor] 告警处理失败：', error); }
    const text = detail.message || type;
    if (type === 'restart_exhausted' || type === 'health_failed') this.logger.error?.(`[supervisor] ${text}`);
    else this.logger.warn?.(`[supervisor] ${text}`);
  }

  pruneRestartTimes() {
    const cutoff = this.now() - this.restartWindowMs;
    this.restartTimes = this.restartTimes.filter(timestamp => timestamp >= cutoff);
  }

  scheduleHealthCheck(child) {
    this.clearHealthTimer();
    this.healthTimer = this.setTimeout(() => { void this.probeHealth(child); }, this.healthIntervalMs);
  }

  clearHealthTimer() {
    if (this.healthTimer) this.clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  attachOutput(child) {
    const write = (level, chunk) => {
      const text = String(chunk ?? '').trimEnd();
      if (text) this.logger[level]?.(text);
    };
    child.stdout?.on?.('data', chunk => write('log', chunk));
    child.stderr?.on?.('data', chunk => write('error', chunk));
  }

  launch() {
    if (this.stopping) return;
    this.pruneRestartTimes();
    this.state = 'starting';
    let child;
    try {
      child = this.spawnProcess(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.handleChildExit(null, null, error);
      return;
    }
    this.child = child;
    this.terminationReason = null;
    this.healthFailures = 0;
    this.attachOutput(child);
    child.once?.('error', error => this.handleChildExit(child, null, error));
    child.once?.('close', (code, signal) => this.handleChildExit(child, code, signal));
    this.scheduleHealthCheck(child);
  }

  async probeHealth(child) {
    if (this.stopping || child !== this.child) return;
    let healthy = false;
    try { healthy = await this.healthCheck(this.host, this.port, this.healthTimeoutMs); }
    catch (error) { this.logger.warn?.(`[supervisor] 健康检查异常：${error instanceof Error ? error.message : String(error)}`); }
    if (this.stopping || child !== this.child) return;
    if (healthy) {
      const wasStarting = this.state === 'starting';
      this.state = 'running';
      this.healthFailures = 0;
      if (wasStarting) {
        try { this.onReady({ host: this.host, port: this.port, pid: child.pid }); } catch (error) { this.logger.error?.('[supervisor] ready 回调失败：', error); }
      }
    } else {
      this.healthFailures += 1;
      this.logger.warn?.(`[supervisor] 健康检查失败（${this.healthFailures}/${this.healthFailureThreshold}）。`);
      if (this.healthFailures >= this.healthFailureThreshold) {
        this.terminationReason = 'health_failed';
        this.alert('health_failed', { message: `服务健康检查连续失败${this.healthFailures}次。`, failures: this.healthFailures });
        this.terminateChild(child);
        return;
      }
    }
    this.scheduleHealthCheck(child);
  }

  terminateChild(child) {
    if (!child || typeof child.kill !== 'function') return;
    try { child.kill('SIGTERM'); } catch (error) { this.logger.warn?.('[supervisor] 发送停止信号失败：', error); }
    if (this.stopGraceMs > 0) {
      this.forceStopTimer = this.setTimeout(() => {
        if (this.child === child && child.exitCode == null) {
          try { child.kill('SIGKILL'); } catch { /* process may have exited */ }
        }
      }, this.stopGraceMs);
    }
  }

  handleChildExit(child, code, signalOrError) {
    if (child && child !== this.child) return;
    this.clearHealthTimer();
    if (this.forceStopTimer) this.clearTimeout(this.forceStopTimer);
    this.forceStopTimer = null;
    this.child = null;
    if (this.stopping) {
      this.finish({ code: 0, signal: null, reason: 'stopped' });
      return;
    }
    const reason = this.terminationReason || 'process_exit';
    this.terminationReason = null;
    const error = signalOrError instanceof Error ? signalOrError : null;
    const message = error ? `服务启动失败：${error.message}` : `服务进程退出（code=${code ?? 'null'}，signal=${signalOrError ?? 'none'}）。`;
    this.alert('process_exit', { message, code: code ?? null, signal: typeof signalOrError === 'string' ? signalOrError : null, reason });
    this.pruneRestartTimes();
    if (this.restartTimes.length >= this.maxRestarts) {
      this.alert('restart_exhausted', { message: `服务在${this.restartWindowMs}毫秒内重启次数达到上限。`, attempts: this.restartTimes.length });
      this.state = 'failed';
      this.finish({ code: 1, signal: null, reason: 'restart_exhausted' });
      return;
    }
    this.restartTimes.push(this.now());
    const attempt = this.restartTimes.length;
    const delay = Math.min(this.maxRestartDelayMs, this.restartDelayMs * (2 ** Math.max(0, attempt - 1)));
    this.state = 'restarting';
    this.alert('restart_scheduled', { message: `服务将在${delay}毫秒后第${attempt}次重启。`, attempt, delay, reason });
    this.restartTimer = this.setTimeout(() => { this.restartTimer = null; this.launch(); }, delay);
  }

  finish(result) {
    if (this.resolveRun) {
      const resolve = this.resolveRun;
      this.resolveRun = null;
      this.runPromise = null;
      resolve(result);
    }
  }

  run() {
    if (this.runPromise) return this.runPromise;
    this.stopping = false;
    this.state = 'starting';
    this.runPromise = new Promise(resolve => { this.resolveRun = resolve; this.launch(); });
    return this.runPromise;
  }

  async stop(reason = 'shutdown') {
    if (this.stopping) return;
    this.stopping = true;
    this.state = 'stopping';
    if (this.restartTimer) this.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearHealthTimer();
    if (this.forceStopTimer) this.clearTimeout(this.forceStopTimer);
    this.forceStopTimer = null;
    const child = this.child;
    if (!child) { this.finish({ code: 0, signal: null, reason }); return; }
    this.terminationReason = reason;
    this.terminateChild(child);
    if (!this.runPromise) this.finish({ code: 0, signal: null, reason });
  }
}
