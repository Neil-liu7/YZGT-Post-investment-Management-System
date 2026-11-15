export type SupervisorAlert = {
  type: string;
  at: string;
  message?: string;
  [key: string]: unknown;
};

export type SupervisorResult = {
  code: number;
  signal: string | null;
  reason: string;
};

export type SupervisorOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  host?: string;
  port?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  healthFailureThreshold?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  stopGraceMs?: number;
  spawnProcess?: (...args: any[]) => any;
  healthCheck?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  setTimeout?: (...args: any[]) => any;
  clearTimeout?: (...args: any[]) => any;
  logger?: { log?: (value: unknown) => void; warn?: (value: unknown) => void; error?: (value: unknown) => void };
  onAlert?: (event: SupervisorAlert) => void;
  onReady?: (event: { host: string; port: number; pid?: number }) => void;
};

export class Supervisor {
  state: string;
  child: any;
  constructor(options?: SupervisorOptions);
  launch(): void;
  handleChildExit(child: any, code: number | null, signalOrError?: unknown): void;
  probeHealth(child: any): Promise<void>;
  run(): Promise<SupervisorResult>;
  stop(reason?: string): Promise<void>;
}
