export type Entity = Record<string, any> & { id: string; version: number };
export type Page<T = Entity> = { items: T[]; page: number; page_size: number; total: number };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const pendingCommands = new Map<string, string>();
async function commandIdentity(path: string, options: RequestInit): Promise<string | null> {
  if (!options.method || options.method === 'GET') return null;
  if (typeof options.body === 'string') return `${options.method}:${path}:${options.body}`;
  if (!(options.body instanceof FormData)) return null;
  const fields = [];
  for (const [name, value] of options.body.entries()) {
    if (typeof value === 'string') fields.push([name, value]);
    else {
      const digest = await crypto.subtle.digest('SHA-256', await value.arrayBuffer());
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      fields.push([name, { name: value.name, size: value.size, sha256: hash }]);
    }
  }
  return `${options.method}:${path}:${JSON.stringify(fields)}`;
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const command = headers.has('Idempotency-Key') ? null : await commandIdentity(path, options);
  if (command && !headers.has('Idempotency-Key')) {
    const key = pendingCommands.get(command) ?? crypto.randomUUID();
    pendingCommands.set(command, key);
    headers.set('Idempotency-Key', key);
  }
  const response = await fetch(`/api/v1${path}`, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? `请求失败 (${response.status})`, body?.error?.details);
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器未返回保存结果，请保留当前内容后重试。');
  if (command) pendingCommands.delete(command);
  return body.data as T;
}
export function pagePath(path: string, page: number, size: number): string {
  const url = new URL(path, 'http://local.invalid');
  url.searchParams.set('page', String(page)); url.searchParams.set('page_size', String(size));
  return url.pathname + url.search;
}
/** Selectors need every option; refuse incomplete/changing results instead of silently truncating. */
export async function allPages<T = Entity>(path: string): Promise<Page<T>> {
  const result: T[] = []; const ids = new Set<string>(); let total: number | undefined;
  for (let page = 1; ; page++) {
    const response = await api<Page<T>>(pagePath(path, page, 100));
    if (!Array.isArray(response.items) || !Number.isInteger(response.total) || response.total < 0 || response.page !== page) throw new ApiError(502, 'INVALID_PAGE', '列表分页响应不完整，请重新读取。');
    if (total !== undefined && total !== response.total) throw new ApiError(409, 'LIST_CHANGED', '列表在读取期间发生变化，请重新读取完整选项。');
    total = response.total;
    for (const item of response.items) {
      const id = (item as any)?.id;
      if (typeof id !== 'string' || ids.has(id)) throw new ApiError(409, 'LIST_CHANGED', '列表在读取期间发生变化，请重新读取完整选项。');
      ids.add(id); result.push(item);
    }
    if (result.length === total) return { items: result, page: 1, page_size: result.length, total };
    if (!response.items.length || result.length > total) throw new ApiError(502, 'INVALID_PAGE', '列表分页响应不完整，请重新读取。');
  }
}
export async function uploadLimit(path = '/settings'): Promise<number> {
  const settings = await api<{ max_upload_bytes: number }>(path);
  if (!Number.isSafeInteger(settings.max_upload_bytes) || settings.max_upload_bytes <= 0) throw new ApiError(502, 'INVALID_UPLOAD_LIMIT', '上传上限尚未确认，请重新读取服务配置。');
  return settings.max_upload_bytes;
}
export function uploadLimitLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB` : bytes >= 1024 ? `${Number((bytes / 1024).toFixed(2))} KB` : `${bytes} B`;
}
export function checkUploadSize(file: { size: number; name: string }, maximum: number): void {
  if (file.size > maximum) throw new Error(`${file.name} 超过单文件上限 ${uploadLimitLabel(maximum)}，请拆分或压缩后上传。`);
}
export function continuousPeriod(rule: any, calculation: any): string {
  const interval = calculation?.interval;
  const start = interval?.start_on ?? (rule?.starts_at?.type === 'date' ? rule.starts_at.date : null);
  const end = interval?.end_on ?? (rule?.ends_at?.type === 'date' ? rule.ends_at.date : null);
  return `${start || '起始日期待确定'} 至 ${end || (rule?.ends_at == null ? '无固定终止日' : '结束日期待确定')}`;
}
export const post = <T = any>(path: string, data: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const message = (e: unknown) => e instanceof Error ? e.message : '请求失败，请重试';
export const items = (v: any): Entity[] => Array.isArray(v) ? v : v?.items ?? [];
export const dateTime = (v: string | null | undefined) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(v)) : '—';
