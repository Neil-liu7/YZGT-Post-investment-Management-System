import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../apps/server/src/store';
import { NotificationService } from '../../apps/server/src/notifications';

const resources: { store: Store; root: string }[] = [];
afterEach(() => {
  for (const { store, root } of resources.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

describe('explicit notification queue claim limit', () => {
  it.each([1, undefined])('claims at most one with limit=1 and preserves the ordinary default: %s', limit => {
    return (async () => {
      const trap = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real transport forbidden'));
      const root = mkdtempSync(join(tmpdir(), 'yzgt-queue-limit-'));
      const clock = () => new Date('2026-11-12T06:00:00Z');
      const store = new Store(join(root, 'test.sqlite'), clock); resources.push({ store, root });
      const adapter = vi.fn(async () => ({ status: 'failed' as const, retryable: true, error: 'Synthetic definite failure' }));
      const service = new NotificationService(store, { OUTBOUND_MODE: 'mock', MAIL_TO: 'synthetic@example.invalid', adapter }, clock);
      const first = service.sendSnapshot({ snapshot_id: service.preview({ channel: 'email', purpose: 'test' }).id });
      const second = service.sendSnapshot({ snapshot_id: service.preview({ channel: 'email', purpose: 'test' }).id });
      await service.processQueue(limit);
      expect(store.require('notifications', first.id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
      expect(store.require('notifications', second.id)).toMatchObject(limit === 1 ? { status: 'queued', attempts: 0 } : { status: 'retry_wait', attempts: 1 });
      expect(adapter).toHaveBeenCalledTimes(limit === 1 ? 1 : 2);
      expect(store.all('attempts')).toHaveLength(limit === 1 ? 1 : 2);
      expect(trap).not.toHaveBeenCalled();
    })();
  });
});
