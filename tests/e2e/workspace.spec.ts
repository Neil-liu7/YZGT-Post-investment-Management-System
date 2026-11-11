import { test, expect } from '@playwright/test';

test('空库项目到人工义务、完成和重开保留历史', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByLabel('项目名称').fill(`浏览器合成项目 ${Date.now()}`);
  await page.getByLabel('公司全称').fill('合成技术有限公司');
  await page.getByLabel('项目负责人').fill('测试负责人');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: /浏览器合成项目/ })).toBeVisible();
  await page.getByRole('button', { name: '创建义务', exact: true }).first().click();
  await page.getByLabel('义务标题').fill('提交年度报告');
  await page.getByLabel('来源说明').fill('人工录入的合成业务约定');
  await page.getByLabel('固定截止日').fill('2029-12-31');
  await page.getByLabel('已核对原文及时间计算约定').check();
  await page.getByRole('button', { name: '保存义务', exact: true }).click();
  await page.getByRole('link', { name: '提交年度报告', exact: true }).click();
  await expect(page.getByText('2029-12-31').first()).toBeVisible();
  await page.getByRole('button', { name: '人工指定截止日', exact: true }).click();
  await page.getByLabel('人工截止日').fill('2030-01-15');
  await page.getByLabel('操作原因').fill('合成测试经确认延期');
  await page.getByRole('button', { name: '预览期限影响', exact: true }).click();
  await expect(page.getByRole('heading', { name: '变更影响预览' })).toBeVisible();
  await page.getByRole('button', { name: '确认变更截止日', exact: true }).click();
  await expect(page.getByText('2030-01-15', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完成事项', exact: true }).click();
  await page.getByRole('button', { name: '确认完成', exact: true }).click();
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await page.getByLabel('操作原因').fill('合成测试需补充报告');
  await page.getByRole('button', { name: '确认重开', exact: true }).click();
  await expect(page.getByText('待开始', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '提交年度报告' })).toBeVisible();
});

test('失败保存保留草稿并显示未保存', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByLabel('项目名称').fill('不能丢失的草稿');
  await page.getByLabel('公司全称').fill('合成公司');
  await page.route('**/api/v1/projects', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '记录已被修改，请刷新后重试' } }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('未保存');
  await expect(page.getByLabel('项目名称')).toHaveValue('不能丢失的草稿');
});

test('上传真实 TXT、审核原文和固定日期、确认导入幂等', async ({ page, request }) => {
  const result = await request.post('/api/v1/projects', { data: { name: `协议审核 ${Date.now()}`, company: '合成企业', owner_label: '审核人' } });
  const { data: project } = await result.json();
  await page.goto(`/projects/${project.id}/documents`);
  await page.getByLabel('选择协议文件').setInputFiles({ name: '合成协议.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 公司应于2029年12月31日前完成实缴。', 'utf8') });
  await expect(page.getByRole('link', { name: '合成协议.txt', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '合成协议.txt', exact: true }).click();
  await expect(page.getByText('第一条 公司应于2029年12月31日前完成实缴。', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载原件', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('合成协议.txt');
  await page.getByRole('button', { name: '提取候选义务', exact: true }).click();
  await page.getByRole('button', { name: '核对并编辑', exact: true }).first().click();
  await page.getByLabel('候选标题').fill('经审核的实缴义务');
  await page.getByLabel('固定截止日').fill('2029-12-31');
  await page.getByLabel('已核对原文及时间计算约定').check();
  await page.getByRole('button', { name: '保存审核结果', exact: true }).click();
  await page.getByLabel('选择候选 1', { exact: true }).check();
  const runId = page.url().split('/extractions/')[1].split('/')[0];
  const runResponse = await request.get(`/api/v1/extractions/${runId}`);
  const run = (await runResponse.json()).data;
  await page.getByRole('button', { name: '确认导入 1 条', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已确认导入 1 条候选');
  const repeated = await request.post(`/api/v1/extractions/${runId}/confirm`, { data: { draft_ids: [run.drafts[0].id] } });
  expect(repeated.ok()).toBeTruthy();
  const taskResponse = await request.get(`/api/v1/projects/${project.id}/tasks`);
  expect((await taskResponse.json()).data.total).toBe(1);
  await page.getByRole('link', { name: '查看项目事项 →' }).click();
  await expect(page.getByRole('link', { name: '经审核的实缴义务', exact: true })).toBeVisible();
});

test('提醒预览可编辑并显示模拟最终结果', async ({ page }) => {
  await page.goto('/reminders');
  await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
  await page.getByLabel('邮件主题').fill('合成预览测试');
  await page.getByLabel('发送正文').fill('仅用于模拟适配器验证。');
  await page.getByRole('button', { name: '确认模拟发送', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '模拟完成' })).toBeVisible();
  await expect(page.getByText('模拟完成', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('窄屏可读且关键入口可操作', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: '项目管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await expect(page.getByLabel('项目名称')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('历史原件补传保留文档标识并可核对解析原文', async ({ page, request }) => {
  const preview = (await (await request.post('/api/v1/imports/preview', { data: { source_namespace: `browser-legacy-${Date.now()}`, data: { projects: [{ id: 'legacy-project', name: '补传合成项目', uploadedFiles: ['缺失的历史协议.txt'], tasks: [] }] } } })).json()).data;
  await request.post(`/api/v1/imports/${preview.id}/confirm`);
  const projects = (await (await request.get('/api/v1/projects?q=补传合成项目')).json()).data;
  const documents = (await (await request.get(`/api/v1/projects/${projects.items[0].id}/documents`)).json()).data;
  const id = documents.items[0].id;
  await page.goto(`/documents/${id}`);
  await page.getByLabel('补传历史原件').setInputFiles({ name: '补传核对原件.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 补传的原始协议应完整留存。', 'utf8') });
  await expect(page.getByText('第一条 补传的原始协议应完整留存。', { exact: true })).toBeVisible();
  expect(page.url()).toContain(`/documents/${id}`);
  const stored = (await (await request.get(`/api/v1/documents/${id}`)).json()).data;
  expect(stored.state).toBe('parsed');
  expect(stored.id).toBe(id);
});
