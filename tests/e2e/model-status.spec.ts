import { test, expect } from '@playwright/test';

test('维护页展示模型服务状态，配置检查不发起模型请求', async ({ page, request }) => {
  await page.goto('/maintenance');
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI 提取配置', exact: true }) }).first();
  await expect(card).toContainText('模拟提取（不外发协议）');
  await expect(card).toContainText('模型服务'); await expect(card).toContainText('接口域名');
  await card.getByRole('button', { name: '刷新模型状态', exact: true }).click();
  await expect(card).toContainText('模拟提取（不外发协议）');
  const settings = await request.get('/api/v1/settings');
  expect(settings.ok()).toBeTruthy();
  const model = (await settings.json()).data.llm_status;
  expect(['glm', 'openai_compatible']).toContain(model.provider);
  expect(model).not.toHaveProperty('apiKey'); expect(model).not.toHaveProperty('baseUrl'); expect(model).not.toHaveProperty('endpoint');
});
