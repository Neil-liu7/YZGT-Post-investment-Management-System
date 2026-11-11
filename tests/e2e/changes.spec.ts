import { test, expect } from '@playwright/test';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
test('关键事件变更预览后提交，取消预览不修改生效期限', async ({ page, request }) => {
  const project = (await (await request.post('/api/v1/projects', { data: { name: '事件变更合成', company: '合成公司' } })).json()).data;
  const event = (await (await request.post(`/api/v1/projects/${project.id}/events`, { data: { name: '协议签署', event_type: 'signing', occurred_on: '2026-08-07' } })).json()).data;
  const obligation = (await (await request.post(`/api/v1/projects/${project.id}/obligations`, { data: { title: '签署后三月报送', source_type: 'manual', source_description: '合成规则', rule: { schema_version: 1, kind: 'relative', confirmation_status: 'confirmed', original_expression: '签署后三个月', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 3, unit: 'calendar_month', include_start_day: false }], convention } } })).json()).data;
  await page.goto(`/projects/${project.id}/events`);
  await page.getByRole('button', { name: '修改事件', exact: true }).click();
  await page.getByLabel('发生日期（未知可留空）').fill('2026-08-17');
  await page.getByLabel('修改原因').fill('核对合成协议原文');
  await page.getByRole('button', { name: '预览期限影响', exact: true }).click();
  await expect(page.getByText('2026-11-07 → 2026-11-17', { exact: true })).toBeVisible();
  let task = (await (await request.get(`/api/v1/tasks/${obligation.tasks[0].id}`)).json()).data;
  expect(task.effective_due_on).toBe('2026-11-07');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '修改事件', exact: true }).click();
  await page.getByLabel('发生日期（未知可留空）').fill('2026-08-17');
  await page.getByLabel('修改原因').fill('核对合成协议原文');
  await page.getByRole('button', { name: '预览期限影响', exact: true }).click();
  await page.getByRole('button', { name: '确认变更影响', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  task = (await (await request.get(`/api/v1/tasks/${obligation.tasks[0].id}`)).json()).data;
  expect(task.effective_due_on).toBe('2026-11-17');
});

test('筛选子集上移保留隐藏事项及其位置', async ({ page, request }) => {
  const project = (await (await request.post('/api/v1/projects', { data: { name: '筛选排序合成', company: '合成公司' } })).json()).data;
  const ids: string[] = [];
  for (const [index, title] of ['可见 A', '隐藏 B', '可见 C', '隐藏 D'].entries()) {
    const obligation = (await (await request.post(`/api/v1/projects/${project.id}/obligations`, { data: { title, source_type: 'manual', source_description: '合成排序', rule: { schema_version: 1, kind: 'fixed', confirmation_status: 'confirmed', original_expression: '固定日期', date: '2029-12-31', convention } } })).json()).data;
    const task = obligation.tasks[0]; ids.push(task.id);
    if (index % 2) await request.patch(`/api/v1/tasks/${task.id}`, { data: { version: task.version, status: 'doing' } });
  }
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel('执行状态筛选').selectOption('pending');
  await expect(page.getByRole('link', { name: '隐藏 B', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '上移 可见 C', exact: true }).click();
  await expect(page.locator('article').first()).toContainText('可见 C');
  const tasks = (await (await request.get(`/api/v1/projects/${project.id}/tasks?page_size=100`)).json()).data;
  expect(tasks.total).toBe(4);
  expect(tasks.items.map((t: { id: string }) => t.id)).toEqual([ids[2], ids[1], ids[0], ids[3]]);
  await page.locator('article').filter({ has: page.getByRole('link', { name: '可见 A', exact: true }) }).dragTo(page.locator('article').filter({ has: page.getByRole('link', { name: '可见 C', exact: true }) }));
  await expect(page.locator('article').first()).toContainText('可见 A');
  const dragged = (await (await request.get(`/api/v1/projects/${project.id}/tasks?page_size=100`)).json()).data;
  expect(dragged.items.map((t: { id: string }) => t.id)).toEqual(ids);
});
