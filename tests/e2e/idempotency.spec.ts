import { test, expect } from '@playwright/test';

test('创建响应丢失后重试复用幂等键，保留一份项目', async ({ page, request }) => {
  const name = `响应丢失合成 ${Date.now()}`;
  let lost = false;
  const keys: Array<string | undefined> = [];
  await page.goto('/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByLabel('项目名称').fill(name);
  await page.getByLabel('公司全称').fill('合成公司');
  await page.route('**/api/v1/projects', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key']);
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('未保存');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const results = await request.get(`/api/v1/projects?q=${encodeURIComponent(name)}`);
  expect((await results.json()).data.total).toBe(1);
});
