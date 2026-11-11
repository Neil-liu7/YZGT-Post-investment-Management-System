import { test, expect } from '@playwright/test';

test('解析失败可重试并显示错误，修复原件后重新解析成功', async ({ page, request }) => {
  test.setTimeout(25000);
  const project = (await (await request.post('/api/v1/projects', { data: { name: '解析重试合成', company: '合成公司' } })).json()).data;
  const uploaded = await request.post(`/api/v1/projects/${project.id}/documents`, { multipart: { file: { name: '可修复合成.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) } } });
  const document = (await uploaded.json()).data;
  expect(document.state).toBe('parse_failed');
  await page.goto(`/documents/${document.id}`);
  const failedResponse = page.waitForResponse(response => response.url().endsWith(`/documents/${document.id}/reparse`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '重新解析原件', exact: true }).click({ timeout: 8000 });
  expect((await failedResponse).status()).toBe(422);
  await expect(page.getByRole('alert').filter({ hasText: '文件为空' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '重新解析原件', exact: true })).toBeEnabled();
  const repaired = await request.post(`/_e2e/fixtures/documents/${document.id}/repair`, { data: { text: '第一条 修复后原文完整，可重新解析并保留。' } });
  expect(repaired.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '重新解析原件', exact: true }).click();
  await expect(page.getByText('第一条 修复后原文完整，可重新解析并保留。', { exact: true })).toBeVisible();
  await expect(page.getByText('已解析', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '提取候选义务', exact: true })).toBeEnabled();
  const stored = (await (await request.get(`/api/v1/documents/${document.id}`)).json()).data;
  expect(stored.state).toBe('parsed');
});
