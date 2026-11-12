/** Sanitize JSON-compatible verification reports before writing them. */
export function redactSecrets(value: unknown, secrets: string[]): any {
  const tokens = secrets.filter(Boolean).sort((first, second) => second.length - first.length);
  const redact = (text: string) => tokens.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const visit = (entry: unknown): any => {
    if (typeof entry === 'string') return redact(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, field]) => [redact(key), visit(field)]));
    return entry;
  };
  return visit(value);
}

type VerificationSignal = 'SIGINT' | 'SIGTERM';
export type VerificationFinalState = { cancelled: boolean; cleanupFailed: boolean };
export function verificationReportStatus(status: string, state: VerificationFinalState): string {
  return state.cleanupFailed ? 'cleanup_failed' : state.cancelled ? 'cancelled' : status;
}
type FinalizerOptions = {
  cleanup: () => Promise<void>; save: (state: VerificationFinalState) => void;
  onCancel: (signal: VerificationSignal) => void; onCleanupError: (error: unknown) => void;
};

/** Share one cleanup/save operation between normal completion and user cancellation. */
export function createVerificationFinalizer(options: FinalizerOptions) {
  let cancelled = false;
  let cleanupFailed = false;
  let finalizing: Promise<void> | undefined;
  const finish = () => {
    finalizing ??= (async () => {
      try {
        try { await options.cleanup(); }
        catch (error) { cleanupFailed = true; options.onCleanupError(error); }
        options.save({ cancelled, cleanupFailed });
      } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
    })();
    return finalizing;
  };
  const cancel = (signal: VerificationSignal) => {
    if (cancelled) return;
    cancelled = true;
    options.onCancel(signal);
    void finish().then(() => process.exit(cleanupFailed ? 1 : signal === 'SIGINT' ? 130 : 143), () => process.exit(1));
  };
  const interrupt = () => cancel('SIGINT');
  const terminate = () => cancel('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  return { finish, get cancelled() { return cancelled; } };
}
