import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
let sequence = 0;
const unique = (name: string) => `${name}-${Date.now()}-${sequence++}`;

async function api(request: APIRequestContext, path: string, data?: unknown) {
  const response = data === undefined ? await request.get(`/api/v1${path}`) : await request.post(`/api/v1${path}`, { data });
  const body = await response.json();
  expect(response.ok(), `${path}: ${JSON.stringify(body.error)}`).toBeTruthy();
  return body.data;
}

async function createProject(request: APIRequestContext) {
  return api(request, '/projects', { name: unique('期限表单合成项目'), company: '合成公司' });
}

async function createEvent(request: APIRequestContext, projectId: string, name: string, occurredOn: string) {
  return api(request, `/projects/${projectId}/events`, { name, event_type: 'other', occurred_on: occurredOn });
}

async function createCalendar(request: APIRequestContext, overrides: Record<string, boolean> = {}) {
  const draft = await api(request, '/calendars/import-preview', {
    name: unique('合成工作日日历'), region: '合成地区', source: '仅供自动化测试，不作为真实节假日日历',
    start_on: '2026-01-01', end_on: '2027-12-31', overrides,
  });
  return api(request, `/calendars/${draft.id}/confirm`, { version: draft.version });
}

async function openCreate(page: Page, projectId: string, title: string) {
  await page.goto(`/projects/${projectId}/obligations`);
  await page.getByRole('button', { name: '创建义务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建义务', exact: true });
  await dialog.getByLabel('义务标题', { exact: true }).fill(title);
  await dialog.getByLabel('来源说明', { exact: true }).fill('合成条款，人工核对后确认');
  return dialog;
}

async function saveCreated(page: Page, dialog: Locator, request: APIRequestContext, projectId: string, title: string) {
  await dialog.getByRole('button', { name: '保存义务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const obligations = await api(request, `/projects/${projectId}/obligations?page_size=100`);
  const obligation = obligations.items.find((item: { title: string }) => item.title === title);
  expect(obligation).toBeTruthy();
  const tasks = await api(request, `/projects/${projectId}/tasks?page_size=100`);
  return { obligation, tasks: tasks.items.filter((item: { obligation_id: string }) => item.obligation_id === obligation.id) };
}

async function fillCalendarForm(page: Page, name: string) {
  const form = page.getByRole('form', { name: '创建工作日日历', exact: true });
  await form.getByLabel('日历名称', { exact: true }).fill(name);
  await form.getByLabel('日历地区', { exact: true }).fill('合成地区');
  await form.getByLabel('覆盖开始日', { exact: true }).fill('2026-11-01');
  await form.getByLabel('覆盖结束日', { exact: true }).fill('2026-12-31');
  await form.getByLabel('日历来源说明', { exact: true }).fill('合成调休规则：11月7日工作、11月11日休息');
  return form;
}

test('调休日历编辑后旧预览失效，确认显示计算版本v1而非实体版本2', async ({ page, request }) => {
  const name = unique('调休表单日历');
  await page.goto('/maintenance');
  const form = await fillCalendarForm(page, name);
  await form.getByRole('button', { name: '增加调休日期', exact: true }).click();
  await form.getByLabel('调休日期 1', { exact: true }).fill('2026-11-07');
  await form.getByLabel('调整后类型 1', { exact: true }).selectOption('work');
  await form.getByRole('button', { name: '增加调休日期', exact: true }).click();
  await form.getByLabel('调休日期 2', { exact: true }).fill('2026-11-11');
  await form.getByRole('button', { name: '预览日历版本', exact: true }).click();
  const preview = page.getByRole('region', { name: '日历预览', exact: true });
  await expect(preview.getByRole('row').filter({ hasText: '2026-11-07' })).toContainText('工作日');
  await expect(preview.getByRole('row').filter({ hasText: '2026-11-11' })).toContainText('休息日');
  await preview.getByLabel('已核对日历来源、覆盖范围和全部调休日期', { exact: true }).check();
  const revisedName = `${name}-修订`;
  await form.getByLabel('日历名称', { exact: true }).fill(revisedName);
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认日历版本', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '预览日历版本', exact: true }).click();
  await expect(preview.getByLabel('已核对日历来源、覆盖范围和全部调休日期', { exact: true })).not.toBeChecked();
  await preview.getByLabel('已核对日历来源、覆盖范围和全部调休日期', { exact: true }).check();
  await preview.getByRole('button', { name: '确认日历版本', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '日历版本已确认' })).toBeVisible();
  const row = page.getByRole('table', { name: '已有工作日日历', exact: true }).getByRole('row').filter({ hasText: revisedName });
  await expect(row.getByRole('cell', { name: 'v1', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '已确认', exact: true })).toBeVisible();
  const calendars = await api(request, '/calendars?page_size=100');
  const confirmed = calendars.items.find((item: { name: string }) => item.name === revisedName);
  expect(confirmed).toMatchObject({ confirmed: true, version: 2, calendar_version: 1, overrides: { '2026-11-07': true, '2026-11-11': false } });
  expect(calendars.items.find((item: { name: string }) => item.name === name).confirmed).toBe(false);
});

test('日历拒绝重复和越界调休，服务器失败时保留全部草稿', async ({ page }) => {
  await page.goto('/maintenance');
  const name = unique('失败保留日历');
  const form = await fillCalendarForm(page, name);
  for (const index of [1, 2]) {
    await form.getByRole('button', { name: '增加调休日期', exact: true }).click();
    await form.getByLabel(`调休日期 ${index}`, { exact: true }).fill('2026-11-07');
  }
  await form.getByRole('button', { name: '预览日历版本', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '调休日期 2026-11-07 重复' })).toBeVisible();
  await form.getByLabel('调休日期 2', { exact: true }).fill('2027-01-01');
  await form.getByRole('button', { name: '预览日历版本', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '不在日历覆盖范围内' })).toBeVisible();
  await expect(form.getByLabel('调休日期 2', { exact: true })).toHaveValue('2027-01-01');
  await form.getByLabel('调休日期 2', { exact: true }).fill('2026-11-11');
  await page.route('**/api/v1/calendars/import-preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_SAVE_FAILED', message: '合成日历保存失败，请重试' } }) }));
  await form.getByRole('button', { name: '预览日历版本', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '合成日历保存失败' })).toBeVisible();
  await expect(form.getByLabel('日历名称', { exact: true })).toHaveValue(name);
  await expect(form.getByLabel('调休日期 1', { exact: true })).toHaveValue('2026-11-07');
  await expect(form.getByLabel('调休日期 2', { exact: true })).toHaveValue('2026-11-11');
  await expect(page.getByRole('region', { name: '日历预览', exact: true })).toHaveCount(0);
});

test('通过日历名称选择调休版本，预览并保存F04工作日期限', async ({ page, request }) => {
  const project = await createProject(request);
  const event = await createEvent(request, project.id, '合成收款事件', '2026-11-06');
  const calendar = await createCalendar(request, { '2026-11-07': true, '2026-11-11': false });
  const title = unique('调休后五工作日');
  const dialog = await openCreate(page, project.id, title);
  await dialog.getByRole('combobox', { name: '时间类型', exact: true }).selectOption('relative');
  await dialog.getByRole('combobox', { name: /^起算事件/ }).selectOption({ label: '合成收款事件 · 2026-11-06' });
  await dialog.getByLabel('第 1 段偏移', { exact: true }).fill('5');
  await dialog.getByLabel('第 1 段期限单位', { exact: true }).selectOption('business_day');
  const option = dialog.getByRole('combobox', { name: /^工作日日历/ }).getByRole('option').filter({ hasText: calendar.name });
  await expect(option).toHaveCount(1);
  await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption({ label: await option.innerText() });
  await expect(dialog.getByLabel('工作日日历标识（如适用）', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('已核对原文及时间计算约定', { exact: true }).check();
  await dialog.getByRole('button', { name: '预览期限计算', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '期限计算预览', exact: true })).toContainText('2026-11-13');
  const saved = await saveCreated(page, dialog, request, project.id, title);
  expect(saved.obligation.rule.anchor).toEqual({ type: 'event', event_id: event.id });
  expect(saved.obligation.rule.convention).toMatchObject({ calendar_id: calendar.id, calendar_version: 1 });
  expect(saved.tasks).toHaveLength(1);
  expect(saved.tasks[0]).toMatchObject({ effective_due_on: '2026-11-13', deadline_state: 'calculated' });
});

test('孰早孰晚与自然日再工作日的多段规则实际计算后保存', async ({ page, request }) => {
  const project = await createProject(request);
  const first = await createEvent(request, project.id, '合成交割', '2026-11-01');
  const second = await createEvent(request, project.id, '合成登记', '2026-11-10');
  const calendar = await createCalendar(request);
  for (const [comparison, dueOn] of [['earliest', '2026-12-08'], ['latest', '2026-12-17']]) {
    const title = unique(`${comparison}多段义务`);
    const dialog = await openCreate(page, project.id, title);
    await dialog.getByRole('combobox', { name: '时间类型', exact: true }).selectOption('relative');
    await dialog.getByRole('combobox', { name: '起算方式', exact: true }).selectOption(comparison);
    await dialog.getByRole('combobox', { name: /^起算条件1事件/ }).selectOption(first.id);
    await dialog.getByRole('combobox', { name: /^起算条件2事件/ }).selectOption(second.id);
    await dialog.getByLabel('第 1 段偏移', { exact: true }).fill('30');
    await dialog.getByRole('button', { name: '增加偏移步骤', exact: true }).click();
    await dialog.getByLabel('第 2 段偏移', { exact: true }).fill('5');
    await dialog.getByLabel('第 2 段期限单位', { exact: true }).selectOption('business_day');
    await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption(`${calendar.id}@1`);
    await dialog.getByLabel('已核对原文及时间计算约定', { exact: true }).check();
    await dialog.getByRole('button', { name: '预览期限计算', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '期限计算预览', exact: true })).toContainText(dueOn);
    const saved = await saveCreated(page, dialog, request, project.id, title);
    expect(saved.obligation.rule.anchor).toEqual({ type: comparison, anchors: [{ type: 'event', event_id: first.id }, { type: 'event', event_id: second.id }] });
    expect(saved.obligation.rule.offsets).toEqual([{ amount: 30, unit: 'calendar_day', include_start_day: false }, { amount: 5, unit: 'business_day', include_start_day: false }]);
    expect(saved.tasks[0].effective_due_on).toBe(dueOn);
  }
});

test('持续区间回显事件和相对比较边界，无效高级JSON不能丢弃或提交', async ({ page, request }) => {
  const project = await createProject(request);
  const first = await createEvent(request, project.id, '合成持股开始', '2026-11-01');
  const second = await createEvent(request, project.id, '合成登记完成', '2026-11-10');
  const rule = {
    schema_version: 1, kind: 'continuous', confirmation_status: 'confirmed', original_expression: '合成持股期间持续承诺', review_mode: 'manual',
    starts_at: { type: 'event', event_id: first.id },
    ends_at: { type: 'relative', anchor: { type: 'latest', anchors: [{ type: 'event', event_id: first.id }, { type: 'event', event_id: second.id }] }, offsets: [{ amount: 1, unit: 'calendar_year', include_start_day: false }], convention },
  };
  const obligation = await api(request, `/projects/${project.id}/obligations`, { title: unique('持续承诺'), source_type: 'manual', source_description: '合成区间', rule });
  await page.goto(`/projects/${project.id}/obligations`);
  await page.getByRole('button', { name: '变更规则', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '变更时间规则', exact: true });
  await expect(dialog.getByRole('combobox', { name: '区间开始类型', exact: true })).toHaveValue('event');
  await expect(dialog.getByRole('combobox', { name: /^区间开始事件/ })).toHaveValue(first.id);
  await expect(dialog.getByRole('combobox', { name: '区间结束类型', exact: true })).toHaveValue('relative');
  await expect(dialog.getByRole('combobox', { name: '区间结束起算方式', exact: true })).toHaveValue('latest');
  await expect(dialog.getByRole('combobox', { name: /^区间结束起算条件1事件/ })).toHaveValue(first.id);
  await expect(dialog.getByRole('combobox', { name: /^区间结束起算条件2事件/ })).toHaveValue(second.id);
  await dialog.getByLabel('变更原因', { exact: true }).fill('仅核对已存在的复杂区间');
  await dialog.getByRole('button', { name: '高级 JSON', exact: true }).click();
  const json = dialog.getByLabel('规则 JSON', { exact: true });
  await json.fill('{"kind":');
  await dialog.getByRole('button', { name: '返回表单', exact: true }).click();
  await expect(json).toHaveValue('{"kind":');
  const submit = dialog.getByRole('button', { name: '预览规则影响', exact: true });
  if (await submit.isEnabled()) await submit.click();
  await expect(dialog.getByRole('heading', { name: '变更影响预览', exact: true })).toHaveCount(0);
  expect((await api(request, `/obligations/${obligation.id}`)).rule).toEqual(rule);
  await json.fill(JSON.stringify(rule));
  await dialog.getByRole('button', { name: '返回表单', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '区间结束起算方式', exact: true })).toHaveValue('latest');
  await dialog.getByRole('button', { name: '预览期限计算', exact: true }).click();
  const preview = dialog.getByRole('region', { name: '期限计算预览', exact: true });
  await expect(preview).toContainText('2026-11-01');
  await expect(preview).toContainText('2027-11-10');
  await dialog.getByRole('button', { name: '预览规则影响', exact: true }).click();
  await dialog.getByRole('button', { name: '确认变更规则', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await api(request, `/obligations/${obligation.id}`)).rule).toEqual(rule);
  const task = await api(request, `/tasks/${obligation.tasks[0].id}`);
  expect(task.effective_due_on).toBeNull();
  expect(task.calculation.interval).toEqual({ start_on: '2026-11-01', end_on: '2027-11-10' });
});

test('周期报送展示首三期日期并生成各自独立事项', async ({ page, request }) => {
  const project = await createProject(request);
  const title = unique('季度报送');
  const dialog = await openCreate(page, project.id, title);
  await dialog.getByRole('combobox', { name: '时间类型', exact: true }).selectOption('recurring');
  await dialog.getByLabel('首个周期开始日').fill('2026-07-01');
  await dialog.getByLabel('最后周期结束日（可选）', { exact: true }).fill('2027-03-31');
  await dialog.getByLabel('第 1 段偏移', { exact: true }).fill('30');
  await dialog.getByLabel('已核对原文及时间计算约定', { exact: true }).check();
  await dialog.getByRole('button', { name: '预览期限计算', exact: true }).click();
  const preview = dialog.getByRole('region', { name: '期限计算预览', exact: true });
  const periods = [['2026-Q3', '2026-10-30'], ['2026-Q4', '2027-01-30'], ['2027-Q1', '2027-04-30']];
  for (const [period, dueOn] of periods) await expect(preview.getByRole('article').filter({ hasText: period })).toContainText(dueOn);
  const saved = await saveCreated(page, dialog, request, project.id, title);
  expect(saved.tasks.map((item: { occurrence_key: string; effective_due_on: string }) => [item.occurrence_key, item.effective_due_on])).toEqual(periods);
  expect(new Set(saved.tasks.map((item: { id: string }) => item.id)).size).toBe(3);
});

test('已有义务切换日历需重新预览，保留人工覆盖并提交新计划', async ({ page, request }) => {
  const project = await createProject(request);
  const event = await createEvent(request, project.id, '合成起算事件', '2026-11-06');
  const firstCalendar = await createCalendar(request);
  const nextCalendar = await createCalendar(request, { '2026-11-07': true });
  const rule = { schema_version: 1, kind: 'relative', confirmation_status: 'confirmed', original_expression: '事件后五工作日', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention: { ...convention, calendar_id: firstCalendar.id, calendar_version: 1 } };
  const obligation = await api(request, `/projects/${project.id}/obligations`, { title: unique('人工覆盖保护'), source_type: 'manual', source_description: '合成变更规则', rule });
  const originalTask = obligation.tasks[0];
  expect(originalTask.effective_due_on).toBe('2026-11-13');
  const manual = await api(request, '/change-plans/preview', { operation: 'manual_due', entity_id: originalTask.id, version: originalTask.version, changes: { manual_due_on: '2026-11-20' }, reason: '合成业务确认人工期限' });
  await api(request, `/change-plans/${manual.id}/commit`, {});
  await page.goto(`/projects/${project.id}/obligations`);
  await page.getByRole('button', { name: '变更规则', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '变更时间规则', exact: true });
  await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption(`${nextCalendar.id}@1`);
  await dialog.getByLabel('变更原因', { exact: true }).fill('采用经核对的调休日历');
  const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/change-plans/preview') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '预览规则影响', exact: true }).click();
  const firstPlan = (await (await firstResponse).json()).data;
  await expect(dialog.getByText('2026-11-20 → 2026-11-20', { exact: true })).toBeVisible();
  await expect(dialog.getByText('保留人工日期', { exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption(`${firstCalendar.id}@1`);
  await expect(dialog.getByRole('button', { name: '确认变更规则', exact: true })).toHaveCount(0);
  expect((await api(request, `/obligations/${obligation.id}`)).rule.convention.calendar_id).toBe(firstCalendar.id);
  await dialog.getByRole('combobox', { name: /^工作日日历/ }).selectOption(`${nextCalendar.id}@1`);
  const nextResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/change-plans/preview') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '预览规则影响', exact: true }).click();
  const nextPlan = (await (await nextResponse).json()).data;
  expect(nextPlan.id).not.toBe(firstPlan.id);
  const commit = page.waitForRequest(request => request.url().endsWith(`/api/v1/change-plans/${nextPlan.id}/commit`));
  await dialog.getByRole('button', { name: '确认变更规则', exact: true }).click();
  await commit;
  await expect(dialog).toHaveCount(0);
  const task = await api(request, `/tasks/${originalTask.id}`);
  expect(task).toMatchObject({ computed_due_on: '2026-11-12', manual_due_on: '2026-11-20', effective_due_on: '2026-11-20', deadline_state: 'manual' });
  expect((await api(request, `/obligations/${obligation.id}`)).rule.convention).toMatchObject({ calendar_id: nextCalendar.id, calendar_version: 1 });
});
