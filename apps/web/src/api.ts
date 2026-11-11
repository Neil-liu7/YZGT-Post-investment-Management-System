export type Entity = Record<string, any> & { id: string; version: number };
export type Page<T = Entity> = { items: T[]; page: number; page_size: number; total: number };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const pendingCommands = new Map<string, string>();
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const command = options.method && options.method !== 'GET' && typeof options.body === 'string' ? `${options.method}:${path}:${options.body}` : null;
  if (command && !headers.has('Idempotency-Key')) {
    const key = pendingCommands.get(command) ?? crypto.randomUUID();
    pendingCommands.set(command, key);
    headers.set('Idempotency-Key', key);
  }
  const response = await fetch(`/api/v1${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? `请求失败 (${response.status})`, body.error?.details);
  if (command) pendingCommands.delete(command);
  return body.data as T;
}
export const post = <T = any>(path: string, data: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const message = (e: unknown) => e instanceof Error ? e.message : '请求失败，请重试';
export const items = (v: any): Entity[] => Array.isArray(v) ? v : v?.items ?? [];
export const dateTime = (v: string | null | undefined) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(v)) : '—';
