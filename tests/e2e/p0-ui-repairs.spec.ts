import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
async function api(request: APIRequestContext, path: string, data?: unknown) {
  const response = data === undefined ? await request.get(`/api/v1${path}`) : await request.post(`/api/v1${path}`, { data });
  const body = await response.json(); expect(response.ok(), `${path}: ${JSON.stringify(body.error)}`).toBeTruthy(); return body.data;
}
const project = (request: APIRequestContext) => api(request, '/projects', { name: `P0合成回归-${Date.now()}`, company: '合成企业' });
async function paginated(page: Page, path: string, records: Record<string, unknown>[]) {
  await page.route(`**/api/v1${path}?*`, route => {
    const url = new URL(route.request().url()); const current = Number(url.searchParams.get('page') ?? 1); const size = Number(url.searchParams.get('page_size') ?? 20);
    return route.fulfill({ json: { data: { items: records.slice((current - 1) * size, current * size), page: current, page_size: size, total: records.length } } });
  });
}
async function next(page: Page, label: string, count: number) {
  const pager = page.getByRole('navigation', { name: label, exact: true });
  for (let index = 0; index < count; index++) {
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(pager).toContainText(`第 ${index + 2} /`);
  }
}

test('预览返回前锁定渠道，切换渠道清除旧邮件快照，再发送飞书模拟消息', async ({ page, request }) => {
  let release!: () => void, pending = false; const gate = new Promise<void>(resolve => { release = resolve; });
  let sent: any;
  await page.route('**/api/v1/notifications/preview', async route => {
    const data = route.request().postDataJSON();
    const response = await route.fetch({ postData: JSON.stringify({ ...data, ...(data.channel === 'email' ? { recipients: ['synthetic-old@example.invalid'] } : {}) }) });
    if (data.channel === 'email') { pending = true; await gate; }
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/notifications/send', async route => { const response = await route.fetch(); sent = (await response.json()).data; await route.fulfill({ response }); });
  await page.goto('/reminders');
  await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
  try { await expect.poll(() => pending).toBe(true); await expect(page.getByLabel('提醒渠道', { exact: true })).toBeDisabled(); }
  finally { release(); }
  await expect(page.getByLabel('收件人', { exact: true })).toHaveValue('synthetic-old@example.invalid');
  await page.getByLabel('提醒渠道', { exact: true }).selectOption('feishu');
  await expect(page.getByRole('button', { name: '确认模拟发送', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('发送正文', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
  await expect(page.getByLabel('收件人', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '确认模拟发送', exact: true }).click();
  await expect.poll(() => sent?.channel).toBe('feishu'); expect(sent.mode).toBe('mock');
  await expect.poll(async () => (await api(request, `/notifications/${sent.id}`)).status).toBe('mock_completed');
});

test('服务返回与当前渠道不一致的预览时拒绝确认发送', async ({ page }) => {
  let sends = 0;
  await page.route('**/api/v1/notifications/preview', route => route.fulfill({ json: { data: { id: 'wrong-channel', channel: 'email', mode: 'mock', recipients: ['hidden@example.invalid'], content: { body: '合成旧邮件' } } } }));
  await page.route('**/api/v1/notifications/send', route => { sends++; return route.fulfill({ json: { data: { id: 'unexpected' } } }); });
  await page.goto('/reminders'); await page.getByLabel('提醒渠道', { exact: true }).selectOption('feishu');
  await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('预览渠道与当前选择不一致');
  await expect(page.getByRole('button', { name: '确认模拟发送', exact: true })).toHaveCount(0); expect(sends).toBe(0);
});

test('发送和扫描记录可翻页找到首屏之外的未知批次及旧扫描', async ({ page }) => {
  await paginated(page, '/notifications', Array.from({ length: 51 }, (_, index) => ({ id: `synthetic-batch-${index}`, version: 1, channel: 'email', purpose: 'manual', mode: 'mock', status: index === 50 ? 'unknown' : 'mock_completed', attempts: 1, created_at: '2026-11-12T00:00:00Z' })));
  await paginated(page, '/scans', Array.from({ length: 21 }, (_, index) => ({ id: `synthetic-scan-${index}`, version: 1, trigger: 'manual', status: 'succeeded', created_at: '2026-11-12T00:00:00Z', summary: `合成扫描-${index}` })));
  await page.goto('/reminders'); await expect(page.getByRole('button', { name: '人工核查', exact: true })).toHaveCount(0);
  await next(page, '发送记录分页', 1); await page.getByRole('button', { name: '人工核查', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '核查结果未知的发送', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await next(page, '扫描记录分页', 1); await expect(page.getByRole('cell', { name: '合成扫描-20', exact: true })).toBeVisible();
});

test('超过100份文件、事件和义务均可从普通页面逐页到达', async ({ page, request }) => {
  const p = await project(request);
  const records = Array.from({ length: 121 }, (_, index) => ({ id: `synthetic-${index + 1}`, version: 1 }));
  await paginated(page, `/projects/${p.id}/documents`, records.map((item, index) => ({ ...item, original_name: `合成协议${index + 1}.txt`, state: 'parsed', file_version: 1 })));
  await paginated(page, `/projects/${p.id}/events`, records.map((item, index) => ({ ...item, name: `合成事件${index + 1}`, event_type: 'other', occurred_on: '2026-11-01' })));
  await paginated(page, `/projects/${p.id}/obligations`, records.map((item, index) => ({ ...item, title: `合成义务${index + 1}`, rule: { kind: 'fixed', date: '2029-12-31' }, source_type: 'manual' })));
  await page.goto(`/projects/${p.id}/documents`); await next(page, '文件列表分页', 6);
  await expect(page.getByRole('link', { name: '合成协议121.txt', exact: true })).toBeVisible();
  await page.goto(`/projects/${p.id}/events`); await next(page, '事件列表分页', 6);
  await expect(page.getByText('合成事件121', { exact: true })).toBeVisible();
  await page.goto(`/projects/${p.id}/obligations`); await next(page, '义务列表分页', 6);
  await expect(page.getByText('合成义务121', { exact: true })).toBeVisible();
});

test('规则事件、关联协议和工作日日历选项完整加载第101条之后的选项', async ({ page, request }) => {
  const p = await project(request); const records = Array.from({ length: 121 }, (_, index) => ({ id: `synthetic-${index + 1}`, version: 1 }));
  await paginated(page, `/projects/${p.id}/events`, records.map((item, index) => ({ ...item, name: `选项事件${index + 1}`, occurred_on: '2026-11-01', status: 'confirmed', event_type: 'other' })));
  await paginated(page, `/projects/${p.id}/documents`, records.map((item, index) => ({ ...item, original_name: `选项协议${index + 1}.txt`, state: 'parsed' })));
  await paginated(page, '/calendars', records.map((item, index) => ({ ...item, name: `选项日历${index + 1}`, confirmed: true, calendar_version: 1, region: '合成', start_on: '2026-01-01', end_on: '2030-12-31' })));
  await page.goto(`/projects/${p.id}/obligations`); await page.getByRole('button', { name: '创建义务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建义务', exact: true });
  await dialog.getByRole('combobox', { name: '时间类型', exact: true }).selectOption('relative');
  await dialog.getByRole('combobox', { name: /^起算事件/ }).selectOption('synthetic-121');
  await expect(dialog.getByRole('combobox', { name: /^起算事件/ })).toHaveValue('synthetic-121');
  await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption('synthetic-121@1');
  await expect(dialog.getByRole('combobox', { name: /^工作日日历/ })).toHaveValue('synthetic-121@1');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.goto(`/projects/${p.id}/events`); await page.getByRole('button', { name: '登记事件', exact: true }).click();
  await page.getByRole('combobox', { name: '关联协议（可选）', exact: true }).selectOption('synthetic-121');
  await expect(page.getByRole('combobox', { name: '关联协议（可选）', exact: true })).toHaveValue('synthetic-121');
});

test('持续规则的相对结束边界在义务、项目及事项页显示已计算区间', async ({ page, request }) => {
  const p = await project(request);
  const event = await api(request, `/projects/${p.id}/events`, { name: '合成持股开始', event_type: 'other', status: 'confirmed', occurred_on: '2026-01-15' });
  const rule = { schema_version: 1, kind: 'continuous', confirmation_status: 'confirmed', original_expression: '合成持股期间十年', review_mode: 'manual', starts_at: { type: 'event', event_id: event.id }, ends_at: { type: 'relative', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 10, unit: 'calendar_year', include_start_day: false }], convention } };
  const obligation = await api(request, `/projects/${p.id}/obligations`, { title: '合成持续承诺', source_type: 'manual', source_description: '合成区间条款', rule });
  await page.goto(`/projects/${p.id}/obligations`); await expect(page.getByText('履行期间：2026-01-15 至 2036-01-15 · 人工检查', { exact: true })).toBeVisible();
  await expect(page.getByText(/无固定终止日/)).toHaveCount(0);
  await page.goto(`/projects/${p.id}`); await expect(page.getByText('2026-01-15 至 2036-01-15', { exact: true })).toBeVisible();
  await page.goto(`/tasks/${obligation.tasks[0].id}`); await expect(page.getByText('2026-01-15 至 2036-01-15', { exact: true })).toBeVisible();
  await expect(page.getByText('期限待确定', { exact: true })).toHaveCount(0);
});

test('协议上传在服务端成功而浏览器丢响应后重试，复用键且仅保留一个文件版本', async ({ page, request }) => {
  const p = await project(request); const keys: string[] = [];
  await page.route(`**/api/v1/projects/${p.id}/documents`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch(); expect(response.ok()).toBeTruthy();
    if (keys.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  const file = { name: '合成丢响应.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 这是合成重传回归协议。') };
  await page.goto(`/projects/${p.id}/documents`); await page.getByLabel('选择协议文件', { exact: true }).setInputFiles(file);
  await expect(page.getByRole('alert')).toContainText(/失败|fetch/i); await expect(page.getByLabel('选择协议文件', { exact: true })).toBeEnabled();
  await page.getByLabel('选择协议文件', { exact: true }).setInputFiles(file);
  await expect(page.getByRole('link', { name: file.name, exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const documents = await api(request, `/projects/${p.id}/documents`); expect(documents.total).toBe(1); expect(documents.items[0].file_version).toBe(1);
});

test('配置上限未返回时不宣称20MB，读取8字节配置后在上传前拒绝超限文件', async ({ page, request }) => {
  const p = await project(request); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let uploads = 0;
  await page.route('**/api/v1/settings', async route => { const response = await route.fetch(); const body = await response.json(); await gate; await route.fulfill({ json: { ...body, data: { ...body.data, max_upload_bytes: 8 } } }); });
  await page.route(`**/api/v1/projects/${p.id}/documents`, route => { uploads++; return route.fulfill({ json: { data: {} } }); });
  await page.goto(`/projects/${p.id}/documents`);
  try { await expect(page.getByText(/正在读取上传上限/)).toBeVisible(); await expect(page.getByText(/20\s?MB/)).toHaveCount(0); }
  finally { release(); }
  await expect(page.getByText(/单文件上限 8 B/)).toBeVisible();
  await page.getByLabel('选择协议文件', { exact: true }).setInputFiles({ name: '合成超限.txt', mimeType: 'text/plain', buffer: Buffer.alloc(9, 'a') });
  await expect(page.getByRole('alert')).toContainText('超过单文件上限 8 B'); expect(uploads).toBe(0);
});

test('服务端配置25MB时21MB文件可进入上传请求', async ({ page, request }) => {
  const p = await project(request); let uploads = 0;
  await page.route('**/api/v1/settings', async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ json: { ...body, data: { ...body.data, max_upload_bytes: 25 * 1024 * 1024 } } }); });
  await page.route(`**/api/v1/projects/${p.id}/documents`, route => { uploads++; return route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC', message: '已进入合成上传端点' } } }); });
  await page.goto(`/projects/${p.id}/documents`); await expect(page.getByText(/单文件上限 25 MB/)).toBeVisible();
  await page.getByLabel('选择协议文件', { exact: true }).setInputFiles({ name: '合成大文件.txt', mimeType: 'text/plain', buffer: Buffer.alloc(21 * 1024 * 1024, 'a') });
  await expect(page.getByRole('alert')).toContainText('已进入合成上传端点'); expect(uploads).toBe(1);
});

test('完成提交失败后重试保留已上传凭证，丢响应的凭证重传仍复用上传键', async ({ page, request }) => {
  const p = await project(request); const obligation = await api(request, `/projects/${p.id}/obligations`, { title: '合成凭证恢复', source_type: 'manual', source_description: '合成凭证', rule: { schema_version: 1, kind: 'fixed', date: '2029-12-31', confirmation_status: 'confirmed', original_expression: '固定日期', convention } });
  const task = obligation.tasks[0]; const keys: string[] = []; let completions = 0;
  await page.route(`**/api/v1/tasks/${task.id}/evidence`, async route => { keys.push(route.request().headers()['idempotency-key']); const response = await route.fetch(); if (keys.length === 1) await route.abort('failed'); else await route.fulfill({ response }); });
  await page.route(`**/api/v1/tasks/${task.id}/complete`, async route => { completions++; if (completions === 1) await route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC', message: '合成完成提交失败' } } }); else await route.fulfill({ response: await route.fetch() }); });
  await page.goto(`/tasks/${task.id}`); await page.getByRole('button', { name: '完成事项', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '完成事项', exact: true });
  await dialog.getByLabel('完成凭证（可选）', { exact: true }).setInputFiles({ name: '合成凭证.txt', mimeType: 'text/plain', buffer: Buffer.from('合成完成凭证') });
  await dialog.getByRole('button', { name: '确认完成', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('未保存');
  await dialog.getByRole('button', { name: '确认完成', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('合成完成提交失败');
  await dialog.getByRole('button', { name: '确认完成', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(completions).toBe(2);
  const updated = await api(request, `/tasks/${task.id}`); expect(updated.status).toBe('done'); expect(updated.evidence.filter((item: any) => item.document_id)).toHaveLength(1); expect(updated.evidence.filter((item: any) => item.action === 'complete')).toHaveLength(1);
});


test('历史补传丢响应后以原版本重试仍复用键并保留文档标识', async ({ page, request }) => {
  const name = `合成补传恢复-${Date.now()}`;
  const preview = await api(request, '/imports/preview', { source_namespace: name, data: { projects: [{ id: 'legacy-project', name, uploadedFiles: ['合成缺失协议.txt'], tasks: [] }] } });
  await api(request, `/imports/${preview.id}/confirm`, {});
  const projects = await api(request, `/projects?q=${encodeURIComponent(name)}`);
  const documents = await api(request, `/projects/${projects.items[0].id}/documents`); const document = documents.items[0];
  const keys: string[] = [];
  await page.route(`**/api/v1/documents/${document.id}/supplement`, async route => {
    keys.push(route.request().headers()['idempotency-key']); const response = await route.fetch(); expect(response.ok()).toBeTruthy();
    if (keys.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.goto(`/documents/${document.id}`);
  const file = { name: '合成补传恢复.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 这是合成补传的原件。') };
  await page.getByLabel('补传历史原件', { exact: true }).setInputFiles(file);
  await expect(page.getByRole('alert')).toContainText(/失败|fetch/i);
  await page.getByLabel('补传历史原件', { exact: true }).setInputFiles(file);
  await expect(page.getByText('第一条 这是合成补传的原件。', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const updated = await api(request, `/documents/${document.id}`); expect(updated.id).toBe(document.id); expect(updated.version).toBe(document.version + 1); expect(updated.file_version).toBe(1);
});

test('多文件部分成功后继续剩余上传，不给先成功的原件增加版本', async ({ page, request }) => {
  const p = await project(request); const keys: string[] = [];
  await page.route(`**/api/v1/projects/${p.id}/documents`, async route => {
    keys.push(route.request().headers()['idempotency-key']); const response = await route.fetch(); expect(response.ok()).toBeTruthy();
    if (keys.length === 2) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.goto(`/projects/${p.id}/documents`);
  await page.getByLabel('选择协议文件', { exact: true }).setInputFiles([
    { name: '合成批次A.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 合成批次A。') },
    { name: '合成批次B.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 合成批次B。') },
  ]);
  await expect(page.getByRole('status').filter({ hasText: '已保存 1 份原文件；剩余文件尚未确认' })).toBeVisible();
  await page.getByRole('button', { name: '继续上传剩余 1 份', exact: true }).click();
  await expect(page.getByRole('link', { name: '合成批次B.txt', exact: true })).toBeVisible();
  await expect.poll(() => keys.length).toBe(3); expect(keys[0]).not.toBe(keys[1]); expect(keys[1]).toBe(keys[2]);
  const documents = await api(request, `/projects/${p.id}/documents`); expect(documents.total).toBe(2); expect(documents.items.every((item: any) => item.file_version === 1)).toBe(true);
});
