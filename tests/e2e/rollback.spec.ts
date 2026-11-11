import { test, expect } from '@playwright/test';

test('迁移预览确认后预览回退影响并回退未修改批次', async ({ page, request }) => {
  const namespace = `浏览器回退-${Date.now()}`;
  const projectName = `可回退合成项目-${Date.now()}`;
  await page.goto('/maintenance');
  await page.getByLabel('源命名空间', { exact: true }).fill(namespace);
  await page.getByLabel('旧版 JSON 数据').fill(JSON.stringify({ projects: [{ id: 'rollback-project', name: projectName, tasks: [{ id: 'rollback-task', title: '历史合成事项', status: 'pending', dueDate: '2026-12-31' }] }] }));
  await page.getByRole('button', { name: '生成迁移预览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '迁移对账预览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认导入本次预览', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('迁移已确认');
  const row = page.locator('tr').filter({ hasText: namespace });
  await row.getByRole('button', { name: '回退本批次', exact: true }).click();
  await page.getByLabel('回退原因', { exact: true }).fill('合成验收完成，回退本次迁移');
  await page.getByRole('button', { name: '预览回退影响', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回退影响预览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认回退本批次', exact: true }).click();
  await expect(row.getByText('已回退', { exact: true })).toBeVisible();
  const projects = (await (await request.get(`/api/v1/projects?q=${encodeURIComponent(projectName)}`)).json()).data;
  expect(projects.total).toBe(0);
});
