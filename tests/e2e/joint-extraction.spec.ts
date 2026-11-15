import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const sample = readFileSync('tests/fixtures/agreement.txt', 'utf8');
async function api(request: APIRequestContext, path: string, data?: unknown, method = 'POST') {
  const response = data === undefined ? await request.get(`/api/v1${path}`) : await request.fetch(`/api/v1${path}`, { method, data });
  const body = await response.json(); expect(response.ok(), `${path}: ${JSON.stringify(body.error)}`).toBeTruthy(); return body.data;
}
async function openReview(page: Page, request: APIRequestContext, source = sample, prompt = '') {
  const project = await api(request, '/projects', { name: `联合审核合成-${Date.now()}`, company: '合成企业' });
  await page.goto(`/projects/${project.id}/documents`);
  await page.getByLabel('选择协议文件', { exact: true }).setInputFiles({ name: '联合提取合成.txt', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.getByRole('link', { name: '联合提取合成.txt', exact: true }).click();
  const documentId = page.url().split('/documents/')[1];
  await page.getByLabel('补充提取要求', { exact: true }).fill(prompt);
  await expect(page.getByRole('button', { name: '一键提取事件与义务', exact: true })).toHaveText('一键提取事件与义务');
  await page.getByRole('button', { name: '一键提取事件与义务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '关键事件与义务审核', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览确认结果', exact: true })).toBeEnabled();
  const runId = page.url().split('/extractions/')[1].split('/')[0];
  return { project, documentId, runId, run: await api(request, `/extractions/${runId}`) };
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  const preview = page.getByRole('region', { name: '确认结果预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: '确认生成正式记录', exact: true })).toBeDisabled();
  await preview.getByLabel('已核对所选候选和原文', { exact: true }).check();
  await preview.getByRole('button', { name: '确认生成正式记录', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已确认导入' })).toBeVisible();
}

test('默认联合提取保留未知事件和首期；统一审核前包括预览都不生成正式记录', async ({ page, request }) => {
  const f = await openReview(page, request);
  expect(f.run.joint_extraction).toBe(true); expect(f.run.event_candidates).toHaveLength(3); expect(f.run.drafts).toHaveLength(6);
  await expect(page.getByText('当前为模拟提取', { exact: false })).toBeVisible();
  await expect(page.getByText('首个周期开始日待补充，暂不导入。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('选择候选 6', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('选择候选 6', { exact: true })).toBeDisabled();
  for (const path of ['events', 'obligations', 'tasks']) expect((await api(request, `/projects/${f.project.id}/${path}`)).total).toBe(0);
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  const preview = page.getByRole('region', { name: '确认结果预览', exact: true }); await expect(preview).toContainText('待事件');
  for (const path of ['events', 'obligations', 'tasks']) expect((await api(request, `/projects/${f.project.id}/${path}`)).total).toBe(0);
  await preview.getByLabel('已核对所选候选和原文', { exact: true }).check(); await preview.getByRole('button', { name: '确认生成正式记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已确认导入 5 条候选');
  const tasks = await api(request, `/projects/${f.project.id}/tasks?page_size=100`);
  expect(tasks.total).toBe(5); expect(tasks.items.filter((t: any) => t.deadline_state === 'waiting_event')).toHaveLength(4);
  const events = await api(request, `/projects/${f.project.id}/events`); expect(events.total).toBe(3); expect(events.items.every((e: any) => e.occurred_on === null)).toBe(true);
  const remaining = await api(request, `/extractions/${f.runId}`); expect(remaining.drafts[5].review_state).not.toBe('approved');
});

test('自然语言补充要求原样保存并展示；模拟模式明确效果边界', async ({ page, request }) => {
  const prompt = '重点关注登记、收款凭证；原文不明确的实际日期保持空白。';
  const f = await openReview(page, request, sample, prompt);
  expect(f.run.prompt).toBe(prompt); await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByText(/复杂自然语言补充要求的效果需使用真实模型验证/)).toBeVisible();
  await page.goto(`/documents/${f.documentId}`);
  await expect(page.getByLabel('补充提取要求', { exact: true })).toHaveAttribute('maxlength', '4000');
});

test('已识别的实际日期自动关联规则，无需逐条编辑即可审核确认', async ({ page, request }) => {
  const source = '本协议已于2026年8月7日签署。\n公司应于本协议签署后3个月提交登记材料。';
  const f = await openReview(page, request, source);
  expect(f.run.event_candidates[0].occurred_on).toBe('2026-08-07');
  await expect(page.getByRole('article', { name: '事件候选 1', exact: true })).toContainText('2026-08-07');
  await confirm(page);
  const tasks = await api(request, `/projects/${f.project.id}/tasks`); expect(tasks.total).toBe(1); expect(tasks.items[0].effective_due_on).toBe('2026-11-07');
});

test('忽略引用事件会取消相关义务选择，自动依赖不会恢复忽略事件', async ({ page, request }) => {
  const f = await openReview(page, request, '公司应于本协议签署后3个月提交登记材料。');
  await expect(page.getByLabel('选择事件 1', { exact: true })).toBeChecked();
  await expect(page.getByLabel('选择事件 1', { exact: true })).toBeDisabled();
  await page.getByRole('article', { name: '事件候选 1', exact: true }).getByRole('button', { name: '忽略事件', exact: true }).click();
  await expect(page.getByLabel('选择候选 1', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('选择候选 1', { exact: true })).toBeDisabled();
  await expect(page.getByText('关联事件已忽略，请恢复该事件或修改义务的关联。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择可导入义务', exact: true }).click();
  await expect(page.getByLabel('选择事件 1', { exact: true })).not.toBeChecked();
  expect((await api(request, `/extractions/${f.runId}`)).event_candidates[0].review_state).toBe('ignored');
  expect((await api(request, `/projects/${f.project.id}/events`)).total).toBe(0);
});

test('补齐事件日期及周期首期后统一预览，编辑使旧预览与审核勾选失效', async ({ page, request }) => {
  const f = await openReview(page, request);
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  await page.getByLabel('已核对所选候选和原文', { exact: true }).check();
  const firstEvent = page.getByRole('article', { name: '事件候选 1', exact: true }); await firstEvent.getByRole('button', { name: '核对事件', exact: true }).click();
  await expect(page.getByRole('region', { name: '确认结果预览', exact: true })).toHaveCount(0);
  const eventDialog = page.getByRole('dialog', { name: '核对关键事件候选', exact: true });
  await eventDialog.getByLabel('实际发生日期（未知留空）', { exact: true }).fill('2026-08-07');
  await eventDialog.getByRole('button', { name: '保存事件候选', exact: true }).click(); await expect(eventDialog).toHaveCount(0);
  const recurring = page.getByRole('article', { name: '义务候选 6', exact: true }); await recurring.getByRole('button', { name: '核对并编辑', exact: true }).click();
  const draftDialog = page.getByRole('dialog', { name: '核对候选义务', exact: true });
  await expect(draftDialog.getByLabel(/^首个周期开始日/)).toHaveValue('');
  await draftDialog.getByLabel(/^首个周期开始日/).fill('2026-07-01');
  await draftDialog.getByLabel('最后周期结束日（可选）', { exact: true }).fill('2026-12-31');
  await draftDialog.getByRole('button', { name: '保存审核结果', exact: true }).click(); await expect(draftDialog).toHaveCount(0);
  await page.getByRole('button', { name: '选择可导入义务', exact: true }).click();
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  const preview = page.getByRole('region', { name: '确认结果预览', exact: true });
  await expect(preview).toContainText('2026-11-07'); await expect(preview).toContainText('2026-10-30'); await expect(preview).toContainText('2027-01-30');
  await expect(preview.getByLabel('已核对所选候选和原文', { exact: true })).not.toBeChecked();
  await preview.getByLabel('已核对所选候选和原文', { exact: true }).check(); await preview.getByRole('button', { name: '确认生成正式记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已确认导入 6 条候选'); expect((await api(request, `/projects/${f.project.id}/tasks`)).total).toBe(7);
});

test('确认失败保留候选选择和预览，丢响应后重试复用键且不重复生成', async ({ page, request }) => {
  const f = await openReview(page, request, '公司应于2029年12月31日前完成实缴。');
  const keys: string[] = [];
  await page.route(`**/api/v1/extractions/${f.runId}/confirm`, async route => {
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch(); expect(response.ok()).toBeTruthy();
    if (keys.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  await page.getByLabel('已核对所选候选和原文', { exact: true }).check();
  await page.getByRole('button', { name: '确认生成正式记录', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('选择候选 1', { exact: true })).toBeChecked();
  await expect(page.getByLabel('已核对所选候选和原文', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: '确认生成正式记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已确认导入 1 条候选');
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  expect((await api(request, `/projects/${f.project.id}/obligations`)).total).toBe(1); expect((await api(request, `/projects/${f.project.id}/tasks`)).total).toBe(1);
});

test('复用现有事件不改写日期，预览后事件变更会拒绝整批确认', async ({ page, request }) => {
  const f = await openReview(page, request, '公司应于本协议签署后3个月提交登记材料。');
  const existing = await api(request, `/projects/${f.project.id}/events`, { name: '已有签署', event_type: 'signing', occurred_on: '2026-08-07' });
  await page.getByRole('button', { name: '刷新候选', exact: true }).click();
  await page.getByRole('button', { name: '核对事件', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '核对关键事件候选', exact: true });
  await dialog.getByLabel('复用已有事件', { exact: true }).selectOption(existing.id);
  await expect(dialog.getByLabel('实际发生日期（未知留空）', { exact: true })).toHaveValue('2026-08-07');
  await dialog.getByRole('button', { name: '保存事件候选', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click(); await page.getByLabel('已核对所选候选和原文', { exact: true }).check();
  await api(request, `/events/${existing.id}`, { version: existing.version, occurred_on: '2026-08-10' }, 'PATCH');
  await page.getByRole('button', { name: '确认生成正式记录', exact: true }).click(); await expect(page.getByRole('alert')).toContainText(/变化|过期/);
  await expect(page.getByRole('region', { name: '确认结果预览', exact: true })).toHaveCount(0);
  expect((await api(request, `/projects/${f.project.id}/events`)).total).toBe(1);
  expect((await api(request, `/projects/${f.project.id}/obligations`)).total).toBe(0); expect((await api(request, `/projects/${f.project.id}/tasks`)).total).toBe(0);
});

test('持续规则的未知相对结束边界在整体预览中显示待确定，不误标无终止日', async ({ page, request }) => {
  const f = await openReview(page, request, '公司应于协议签署后10日提交申请。\n公司应于交割后20日提供文件。');
  const signing = f.run.event_candidates.find((e: any) => e.event_type === 'signing');
  const closing = f.run.event_candidates.find((e: any) => e.event_type === 'closing');
  expect(signing).toBeTruthy(); expect(closing).toBeTruthy();
  await api(request, `/draft-events/${signing.id}`, { version: signing.version, occurred_on: '2026-08-07' }, 'PATCH');
  const draft = f.run.drafts[0];
  await api(request, `/draft-obligations/${draft.id}`, { version: draft.version, rule: {
    schema_version: 1, kind: 'continuous', confirmation_status: 'needs_review', original_expression: '合成审核者编辑的持续规则', review_mode: 'manual',
    starts_at: { type: 'event', event_id: `candidate-event:${signing.candidate_key}` },
    ends_at: { type: 'relative', anchor: { type: 'event', event_id: `candidate-event:${closing.candidate_key}` }, offsets: [{ amount: 10, unit: 'calendar_year', include_start_day: false }], convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } },
  } }, 'PATCH');
  await page.getByRole('button', { name: '刷新候选', exact: true }).click();
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  const preview = page.getByRole('region', { name: '确认结果预览', exact: true });
  await expect(preview).toContainText('2026-08-07 至 结束日期待确定');
  await expect(preview).not.toContainText('无固定终止日');
  expect((await api(request, `/projects/${f.project.id}/obligations`)).total).toBe(0);
});

test('联合提取处理中持续读取结果，结束后自动进入可审核状态', async ({ page, request }) => {
  let polls = 0;
  await page.route('**/api/v1/extractions/*', async route => {
    if (route.request().method() !== 'GET' || !/\/api\/v1\/extractions\/[^/?]+$/.test(new URL(route.request().url()).pathname)) { await route.continue(); return; }
    const response = await route.fetch(); const body = await response.json(); polls++;
    await route.fulfill({ json: { ...body, data: { ...body.data, state: polls <= 2 ? 'running' : body.data.state } } });
  });
  await openReview(page, request, '公司应于2029年12月31日前完成实缴。');
  expect(polls).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('button', { name: '预览确认结果', exact: true })).toBeEnabled();
  await expect(page.getByLabel('选择候选 1', { exact: true })).toBeChecked();
});

test('部分成功明确仅展示成功候选和失败摘要，可先预览并返回原文重提', async ({ page, request }) => {
  await page.route('**/api/v1/extractions/*', async route => {
    if (route.request().method() !== 'GET' || !/\/api\/v1\/extractions\/[^/?]+$/.test(new URL(route.request().url()).pathname)) { await route.continue(); return; }
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ json: { ...body, data: { ...body.data, state: ['queued', 'running'].includes(body.data.state) ? body.data.state : 'partial', errors: ['第2分片：合成响应未完整返回，请重新提取。'] } } });
  });
  const f = await openReview(page, request, '公司应于2029年12月31日前完成实缴。');
  const notice = page.getByRole('alert').filter({ hasText: '部分片段提取失败' });
  await expect(notice).toContainText('当前仅显示已成功提取的候选');
  await expect(notice).toContainText('第2分片：合成响应未完整返回');
  await expect(notice.getByRole('link', { name: '返回原文重新提取', exact: true })).toHaveAttribute('href', `/documents/${f.documentId}`);
  await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
  await expect(page.getByRole('region', { name: '确认结果预览', exact: true })).toBeVisible();
  expect((await api(request, `/projects/${f.project.id}/obligations`)).total).toBe(0);
  await notice.getByRole('link', { name: '返回原文重新提取', exact: true }).click();
  await expect(page.getByRole('button', { name: '一键提取事件与义务', exact: true })).toBeEnabled();
});

test('每条义务候选固定展示来源、定位、业务字段和风险项，窄屏长文本不溢出', async ({ page, request }) => {
  const longSource = `第1条 ${'公司应按协议约定提交材料并完成后续履约。'.repeat(12)} 公司应于2029年12月31日前完成实缴。`;
  await openReview(page, request, longSource);
  const card = page.getByRole('article', { name: '义务候选 1', exact: true });
  for (const label of ['协议名称', '来源文件', '条款/页码定位', '事项标题', '义务主体', '动作', '交付物', '触发条件', '原期限', '期限规则', '风险/待核对项']) await expect(card).toContainText(label);
  await expect(card).toContainText('完成实缴');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBeTruthy();
});
