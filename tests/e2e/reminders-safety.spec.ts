import { test, expect, type Page } from '@playwright/test';

async function openPreview(page: Page) {
  await page.route('**/api/v1/notifications/preview', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
      id: 'synthetic-recipient-snapshot', channel: 'email', mode: 'mock', recipients: ['old-target@example.invalid'],
      content: { subject: '合成原始主题', body: '仅供浏览器拦截验证的合成正文。' },
    } }),
  }));
  await page.goto('/reminders');
  await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
  await expect(page.getByLabel('收件人', { exact: true })).toHaveValue('old-target@example.invalid');
  await page.getByLabel('邮件主题', { exact: true }).fill('保留已编辑主题');
  await page.getByRole('textbox', { name: '发送正文', exact: true }).fill('保留已编辑正文，仅为合成数据。');
}

async function interceptBatch(page: Page, id: string) {
  let sends = 0, tests = 0;
  await page.route('**/api/v1/notifications/send', route => {
    sends++;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: { id, status: 'queued', mode: 'mock' } }) });
  });
  await page.route('**/api/v1/notifications/test', route => {
    tests++;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: { id: `${id}-unexpected-test`, status: 'queued', mode: 'mock' } }) });
  });
  return { sends: () => sends, tests: () => tests };
}

test('清空邮件收件人显式发送空数组，失败后保留草稿并复用幂等键', async ({ page }) => {
  const requests: { body: Record<string, unknown>; key?: string }[] = [];
  await page.route('**/api/v1/notifications/send', route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RECIPIENT_NOT_CONFIGURED', message: '接收目标未配置' } }) });
  });
  await openPreview(page);
  await page.getByLabel('收件人', { exact: true }).fill('');
  const send = page.getByRole('button', { name: '确认模拟发送', exact: true });
  await send.click();
  await expect(page.getByRole('alert').filter({ hasText: '接收目标未配置' })).toBeVisible();
  expect(requests[0].body.recipients).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: /已入队|模拟完成/ })).toHaveCount(0);
  await expect(page.getByLabel('收件人', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('邮件主题', { exact: true })).toHaveValue('保留已编辑主题');
  await expect(page.getByRole('textbox', { name: '发送正文', exact: true })).toHaveValue('保留已编辑正文，仅为合成数据。');
  await send.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].body.recipients).toEqual([]);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1].key).toBe(requests[0].key);
  await expect(send).toBeEnabled();
  await page.getByLabel('收件人', { exact: true }).fill(' first@example.invalid ； second@example.invalid , ');
  await send.click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].body.recipients).toEqual(['first@example.invalid', 'second@example.invalid']);
});

test('退避重试持续轮询并锁定发送和测试按钮，直到同一批次最终完成', async ({ page }) => {
  const id = 'synthetic-retry-wait-batch';
  const batches = await interceptBatch(page, id);
  let status = 'retry_wait', polls = 0;
  await page.route(`**/api/v1/notifications/${id}`, route => {
    polls++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { id, status, mode: 'mock', attempts: 1 } }) });
  });
  await openPreview(page);
  await page.getByRole('button', { name: '确认模拟发送', exact: true }).click();
  const pending = page.getByRole('button', { name: '等待发送结果…', exact: true });
  const testMessage = page.getByRole('button', { name: '发送测试消息', exact: true });
  await expect(pending).toBeDisabled();
  await expect(testMessage).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: '等待重试' })).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
  await expect(pending).toBeDisabled();
  await expect(testMessage).toBeDisabled();
  expect(batches.sends()).toBe(1);
  expect(batches.tests()).toBe(0);
  status = 'mock_completed';
  await expect(page.getByRole('status').filter({ hasText: '模拟完成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认模拟发送', exact: true })).toBeEnabled();
  await expect(testMessage).toBeEnabled();
  expect(batches.sends()).toBe(1);
  expect(batches.tests()).toBe(0);
});

test('发送后查询网络失败仍保留批次，恢复查询后清错并得到最终状态', async ({ page }) => {
  const id = 'synthetic-poll-recovery-batch';
  const batches = await interceptBatch(page, id);
  let status = 'sending', polls = 0;
  await page.route(`**/api/v1/notifications/${id}`, route => {
    polls++;
    if (polls === 1) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { id, status, mode: 'mock' } }) });
  });
  await openPreview(page);
  await page.getByRole('button', { name: '确认模拟发送', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '等待发送结果…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送测试消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '发送正文', exact: true })).toHaveValue('保留已编辑正文，仅为合成数据。');
  await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  status = 'mock_completed';
  await expect(page.getByRole('status').filter({ hasText: '模拟完成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认模拟发送', exact: true })).toBeEnabled();
  expect(batches.sends()).toBe(1);
  expect(batches.tests()).toBe(0);
});

test('提醒设置可以临时暂停自动提醒并在页面明确显示状态', async ({ page }) => {
  await page.goto('/reminders');
  await page.getByRole('button', { name: '提醒设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提醒计划设置', exact: true });
  await dialog.getByLabel('暂停自动提醒（手动预览和测试消息仍可用）', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存提醒设置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '自动提醒已暂停' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '自动提醒已暂停' })).toBeVisible();
  await page.getByRole('button', { name: '提醒设置', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '提醒计划设置', exact: true });
  await expect(reopened.getByLabel('暂停自动提醒（手动预览和测试消息仍可用）', { exact: true })).toBeChecked();
  await reopened.getByLabel('暂停自动提醒（手动预览和测试消息仍可用）', { exact: true }).uncheck();
  await reopened.getByRole('button', { name: '保存提醒设置', exact: true }).click();
});
