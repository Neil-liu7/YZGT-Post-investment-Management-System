import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, allPages, checkUploadSize, continuousPeriod, pagePath, uploadLimit, uploadLimitLabel } from '../../apps/web/src/api';

afterEach(() => { vi.unstubAllGlobals(); });
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
function form(text: string, name = 'synthetic.txt', version = '1') {
  const body = new FormData(); body.append('file', new File([text], name)); body.append('version', version); return body;
}

describe('multipart command identity survives response loss', () => {
  it('reuses the same key for identical bytes/fields after failure, then starts a new operation after success', async () => {
    const keys: string[] = [];
    const fetcher = vi.fn(async (_path: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
      if (keys.length === 1) throw new TypeError('Synthetic lost response');
      return ok({ id: 'same-upload' });
    }); vi.stubGlobal('fetch', fetcher);
    const path = '/synthetic-upload-lost-response';
    await expect(api(path, { method: 'POST', body: form('same bytes') })).rejects.toThrow('Synthetic lost response');
    await expect(api(path, { method: 'POST', body: form('same bytes') })).resolves.toEqual({ id: 'same-upload' });
    await api(path, { method: 'POST', body: form('same bytes') });
    expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(keys[2]).not.toBe(keys[1]);
  });
  it('separates routes, changed bytes, filenames and version parameters', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: unknown, init?: RequestInit) => { keys.push(new Headers(init?.headers).get('Idempotency-Key')!); throw new TypeError('Synthetic response loss'); }));
    for (const [path, body] of [
      ['/synthetic-identity-a', form('A')], ['/synthetic-identity-b', form('A')],
      ['/synthetic-identity-a', form('B')], ['/synthetic-identity-a', form('A', 'other.txt')],
      ['/synthetic-identity-a', form('A', 'synthetic.txt', '2')],
    ] as const) await expect(api(path, { method: 'POST', body })).rejects.toThrow();
    expect(new Set(keys).size).toBe(5);
  });
  it('preserves an upload key when a successful HTTP response has no valid save result', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
      return keys.length === 1 ? new Response('not-json', { status: 200 }) : ok({ id: 'stored-before-response-loss' });
    }));
    await expect(api('/synthetic-invalid-response', { method: 'POST', body: form('C') })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await api('/synthetic-invalid-response', { method: 'POST', body: form('C') });
    expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  });
  it('honors an explicitly supplied command key', async () => {
    const fetcher = vi.fn(async (_path: unknown, init?: RequestInit) => { expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('synthetic-explicit-key'); return ok(null); });
    vi.stubGlobal('fetch', fetcher);
    await api('/synthetic-explicit', { method: 'POST', body: form('D'), headers: { 'Idempotency-Key': 'synthetic-explicit-key' } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('complete paginated selector data', () => {
  it('keeps query filters and retrieves every option beyond the first 100', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      const url = new URL(path, 'http://local.invalid'); urls.push(url);
      const page = Number(url.searchParams.get('page'));
      return ok({ items: Array.from({ length: page < 4 ? 100 : 1 }, (_, i) => ({ id: String((page - 1) * 100 + i), version: 1 })), page, page_size: 100, total: 301 });
    }));
    const result = await allPages('/synthetic-options?q=季度&archived=false');
    expect(result.items).toHaveLength(301); expect((result.items[300] as any).id).toBe('300');
    expect(urls.map(url => url.searchParams.get('page'))).toEqual(['1', '2', '3', '4']);
    expect(urls.every(url => url.searchParams.get('q') === '季度' && url.searchParams.get('archived') === 'false' && url.searchParams.get('page_size') === '100')).toBe(true);
    expect(pagePath('/synthetic-options?sort=due_on', 2, 20)).toBe('/synthetic-options?sort=due_on&page=2&page_size=20');
  });
  it('rejects a missing later page rather than returning a truncated option set', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      const page = Number(new URL(path, 'http://local.invalid').searchParams.get('page'));
      return ok({ items: page === 1 ? [{ id: 'one' }] : [], total: 2, page, page_size: 100 });
    }));
    await expect(allPages('/synthetic-missing-page')).rejects.toMatchObject({ code: 'INVALID_PAGE' });
  });
  it.each(['changed_total', 'duplicated_item'])('rejects inconsistent pages: %s', reason => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      const page = Number(new URL(path, 'http://local.invalid').searchParams.get('page'));
      return ok({ items: [{ id: reason === 'duplicated_item' || page === 1 ? 'one' : 'two' }], total: reason === 'changed_total' && page > 1 ? 3 : 2, page, page_size: 100 });
    }));
    return expect(allPages('/synthetic-changing-page')).rejects.toMatchObject({ code: 'LIST_CHANGED' });
  });
  it('propagates a later page HTTP failure without resolving partial records', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++requests === 1 ? ok({ items: [{ id: 'one' }], total: 2, page: 1, page_size: 100 }) : new Response(JSON.stringify({ error: { code: 'SYNTHETIC_FAILURE', message: 'Synthetic second page failed' } }), { status: 503 })));
    await expect(allPages('/synthetic-page-error')).rejects.toMatchObject({ code: 'SYNTHETIC_FAILURE' });
  });
});

describe('upload and continuous-period presentation', () => {
  it('uses the public configured upload limit, accepting its boundary and rejecting larger files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ max_upload_bytes: 30 * 1024 * 1024 })));
    const maximum = await uploadLimit(); expect(maximum).toBe(30 * 1024 * 1024);
    expect(uploadLimitLabel(maximum)).toBe('30 MB');
    expect(() => checkUploadSize({ name: 'synthetic.txt', size: maximum }, maximum)).not.toThrow();
    expect(() => checkUploadSize({ name: 'synthetic.txt', size: maximum + 1 }, maximum)).toThrow('30 MB');
  });
  it.each([0, -1, null, '20MB'])('rejects an invalid server limit instead of assuming 20MB: %s', maximum => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ max_upload_bytes: maximum })));
    return expect(uploadLimit()).rejects.toMatchObject({ code: 'INVALID_UPLOAD_LIMIT' });
  });
  it('renders computed relative continuous boundaries instead of an unknown deadline', () => {
    expect(continuousPeriod({ starts_at: { type: 'event' }, ends_at: { type: 'relative' } }, { interval: { start_on: '2026-01-15', end_on: '2036-01-15' } })).toBe('2026-01-15 至 2036-01-15');
  });
  it('distinguishes an unresolved relative end from an intentionally open end', () => {
    expect(continuousPeriod({ starts_at: { type: 'date', date: '2026-01-15' }, ends_at: { type: 'relative' } }, {})).toBe('2026-01-15 至 结束日期待确定');
    expect(continuousPeriod({ starts_at: { type: 'date', date: '2026-01-15' }, ends_at: null }, {})).toBe('2026-01-15 至 无固定终止日');
  });
});
