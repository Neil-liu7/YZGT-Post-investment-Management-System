#!/usr/bin/env node
/**
 * Record a complete, synthetic product walkthrough.
 * The server is isolated and forces mock model/notification modes; no .env is read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { expect: testExpect } = require('@playwright/test');
const assertion = expect ?? testExpect;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.env.NO_PROXY = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
const port = Number(process.env.DEMO_PORT || 8896);
const baseURL = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = resolve(process.env.DEMO_OUTPUT || join(root, 'var', `功能演示-${stamp}`));
const serverLog = join(outputDir, 'server.log');
mkdirSync(outputDir, { recursive: true });
const framesDir = join(outputDir, 'frames'); mkdirSync(framesDir, { recursive: true });

const tsxModule = process.env.TSX_MODULE || join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nodeArgs = [tsxModule, join(root, 'tests/e2e/server.ts')];
const server = spawn(process.execPath, nodeArgs, {
  cwd: root,
  env: {
    ...process.env,
    LLM_MODE: 'mock', OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: 'false', E2E_PORT: String(port),
    MAIL_TO: 'demo@example.invalid', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    LLM_API_KEY: '', GLM_API_KEY: '', FEISHU_WEBHOOK_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
async function stop() {
  if (server.exitCode !== null || server.killed) return;
  server.kill('SIGTERM');
  await delay(250);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 90; attempt++) {
    try { const response = await fetch(`${baseURL}/health`); if (response.ok) return; } catch { /* server still starting */ }
    await delay(250);
  }
  throw new Error(`演示服务启动失败：${serverOutput.slice(-4000)}`);
}

async function overlay(page, text) {
  await page.evaluate(label => {
    let element = globalThis.document.getElementById('__demo_step_overlay');
    if (!element) {
      element = globalThis.document.createElement('div'); element.id = '__demo_step_overlay';
      Object.assign(element.style, { position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '10px 18px', borderRadius: '999px', background: '#173f35', color: '#fff', font: '600 16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', boxShadow: '0 5px 24px rgba(0,0,0,.18)', pointerEvents: 'none', letterSpacing: '.02em' });
      globalThis.document.body.appendChild(element);
    }
    element.textContent = label;
  }, text);
  await frame(page);
  await delay(850);
}

let frameNumber = 0;
async function frame(page) {
  frameNumber += 1;
  await page.screenshot({ path: join(framesDir, `frame-${String(frameNumber).padStart(4, '0')}.png`), fullPage: false });
}

async function api(path, options = {}) {
  const response = await fetch(`${baseURL}/api/v1${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body.error)}`);
  return body.data;
}

async function main() {
  await waitForHealth();
  const browserOptions = { headless: true, slowMo: 45 };
  let browser;
  try { browser = await chromium.launch({ ...browserOptions, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }); }
  catch { browser = await chromium.launch(browserOptions); }
  const recordVideo = process.env.DEMO_RECORD_VIDEO === '1';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(recordVideo ? { recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } } } : {}) });
  const page = await context.newPage();
  const samplePath = join(root, 'tests/fixtures/agreement.txt');
  try {
    await overlay(page, '亦庄国投投后管理系统 · 完整功能演示');
    await page.goto(`${baseURL}/projects`); await page.waitForLoadState('networkidle');
    await overlay(page, '1. 新建项目');
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
    await page.getByLabel('项目名称').fill('样例协议演示项目');
    await page.getByLabel('公司全称').fill('合成技术有限公司');
    await page.getByLabel('项目负责人').fill('演示审核人');
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await expectVisible(page, 'heading', '样例协议演示项目');
    const projectId = new URL(page.url()).pathname.split('/')[2];

    await overlay(page, '2. 上传样例协议');
    await page.getByRole('link', { name: '协议文件', exact: true }).click();
    await page.getByLabel('选择协议文件', { exact: true }).setInputFiles(samplePath);
    await expectVisible(page, 'link', 'agreement.txt');
    await page.getByRole('link', { name: 'agreement.txt', exact: true }).click();
    await expectVisible(page, 'heading', 'agreement.txt');

    await overlay(page, '3. 一键提取关键事件与义务');
    await page.getByLabel('补充提取要求', { exact: true }).fill('重点关注出资、登记材料和季度报送；日期不明确时保留待确认。');
    await page.getByRole('button', { name: '一键提取事件与义务', exact: true }).click();
    await expectVisible(page, 'heading', '关键事件与义务审核');
    await expectVisible(page, 'button', '预览确认结果');

    await overlay(page, '4. 人工审核候选并预览');
    await page.getByRole('button', { name: '预览确认结果', exact: true }).click();
    const preview = page.getByRole('region', { name: '确认结果预览', exact: true });
    await preview.waitFor(); await delay(900);
    await preview.getByLabel('已核对所选候选和原文', { exact: true }).check();
    await overlay(page, '5. 确认生成正式履约记录');
    await preview.getByRole('button', { name: '确认生成正式记录', exact: true }).click();
    await assertion(page.getByRole('status')).toContainText('已确认导入');
    await page.getByRole('link', { name: '查看项目事项 →', exact: true }).click();
    await expectVisible(page, 'heading', '样例协议演示项目');

    await overlay(page, '6. 打开履约事项并完成事项');
    const tasks = await api(`/projects/${projectId}/tasks?page_size=100`);
    if (!tasks.items?.length) throw new Error('样例协议没有生成履约事项。');
    await page.getByRole('link', { name: tasks.items[0].title, exact: true }).click();
    await expectVisible(page, 'heading', tasks.items[0].title);
    await page.getByRole('button', { name: '完成事项', exact: true }).click();
    await page.getByLabel('完成说明').fill('演示中已完成该协议事项，并保留完成记录。');
    await page.getByLabel('完成凭证（可选）').setInputFiles({ name: '样例完成凭证.txt', mimeType: 'text/plain', buffer: Buffer.from('样例协议演示完成凭证。', 'utf8') });
    await page.getByRole('button', { name: '确认完成', exact: true }).click();
    await assertion(page.getByText('已完成', { exact: true }).first()).toBeVisible();

    await overlay(page, '7. 生成提醒预览并模拟发送');
    await page.goto(`${baseURL}/reminders`); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '生成发送预览', exact: true }).click();
    await expectVisible(page, 'text', '模拟发送预览');
    await page.getByLabel('邮件主题').fill('样例协议演示提醒');
    await page.getByLabel('发送正文').fill('样例协议事项已完成，这是一条模拟提醒消息。');
    await page.getByRole('button', { name: '确认模拟发送', exact: true }).click();
    await assertion(page.getByRole('status').filter({ hasText: '模拟完成' })).toBeVisible();
    await overlay(page, '演示完成 · 数据全程为合成数据，通知为模拟发送');
    await page.screenshot({ path: join(outputDir, 'final.png'), fullPage: true });
  } finally {
    const video = recordVideo ? page.video() : null;
    await context.close();
    await browser.close();
    if (video) {
      const raw = await video.path();
      try { execFileSync('cp', [raw, join(outputDir, '样例协议完整功能演示.webm')]); } catch { /* preserve the Playwright artifact */ }
      try { execFileSync('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outputDir, '样例协议完整功能演示.mp4')], { stdio: 'ignore' }); } catch { /* webm remains usable */ }
    } else {
      try { execFileSync('ffmpeg', ['-y', '-framerate', '1/2', '-i', join(framesDir, 'frame-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outputDir, '样例协议完整功能演示.mp4')], { stdio: 'ignore' }); } catch { /* frames remain usable */ }
    }
    await stop(); await delay(300);
    writeFileSync(serverLog, serverOutput);
  }
}

async function expectVisible(page, type, value) {
  const locator = type === 'heading' ? page.getByRole('heading', { name: value, exact: true }) : type === 'link' ? page.getByRole('link', { name: value, exact: true }) : type === 'button' ? page.getByRole('button', { name: value, exact: true }) : page.getByText(value, { exact: false });
  await locator.waitFor({ state: 'visible', timeout: 30000 });
}

main().catch(async error => { console.error(error instanceof Error ? error.stack : error); await stop(); process.exitCode = 1; });
