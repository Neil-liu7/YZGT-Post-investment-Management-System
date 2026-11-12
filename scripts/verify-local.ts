import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';

// Exercise the production HTTP service against synthetic data, never the user's database.
assert.ok(existsSync('dist/server.mjs'), '请先运行 npm run build');
const root = mkdtempSync(join(tmpdir(), '亦庄 Mac 业务验证 '));
const initial = join(root, '原始 数据');
const restored = join(root, '全新 恢复目录');
const completedSteps: string[] = [];
const children = new Set<ChildProcess>();
const started = new Date();
const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safeEnv = { ...process.env, NODE_ENV: 'test', LLM_MODE: 'mock', OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: 'false', ALLOW_EXTERNAL_MODEL: 'false', GLM_API_KEY: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', FEISHU_WEBHOOK_URL: '', MAIL_TO: '' };

async function start(directory: string) {
  const port = await new Promise<number>((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      probe.close(error => error ? reject(error) : done(address.port));
    });
  });
  const env = { ...safeEnv, PORT: String(port), DATABASE_FILE: join(directory, 'app.sqlite'), STORAGE_DIR: join(directory, 'storage'), BACKUP_DIR: join(root, '备份 数据') };
  const child = spawn(process.execPath, ['scripts/start.mjs'], { env, windowsHide: true });
  children.add(child);
  let logs = '';
  child.stdout?.on('data', chunk => { logs += String(chunk); });
  child.stderr?.on('data', chunk => { logs += String(chunk); });
  child.on('error', error => { logs += error.message; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`生产服务提前退出：${logs}`);
    try {
      const response = await fetch(base + '/health');
      if (response.ok) {
        const health = (await response.json()).data;
        assert.equal(health.llm_mode, 'mock');
        assert.equal(health.outbound_mode, 'mock');
        return { child, base, env };
      }
    } catch { /* Wait for this isolated child to become ready. */ }
    await sleep(100);
  }
  throw new Error(`生产服务未就绪：${logs}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('验证服务未正常停止')); }, 5000);
    child.once('exit', () => { clearTimeout(timeout); children.delete(child); done(); });
    child.kill('SIGTERM');
  });
}

async function api(base: string, path: string, method = 'GET', body?: any, key?: string) {
  const multipart = body instanceof FormData;
  const response = await fetch(base + '/api/v1' + path, { method, headers: { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? multipart ? body : JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path} 返回 ${response.status}：${JSON.stringify(result.error)}`);
  return result.data;
}

async function notificationDone(base: string, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const notification = await api(base, `/notifications/${id}`);
    if (notification.status === 'mock_completed') return notification;
    assert.ok(['queued', 'sending'].includes(notification.status), `模拟通知异常状态：${notification.status}`);
    await sleep(100);
  }
  throw new Error('模拟通知未完成');
}

function readDatabase(directory: string) {
  const db = new Database(join(directory, 'app.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal((db.pragma('quick_check') as any[])[0].quick_check, 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    return Object.fromEntries(['projects', 'documents', 'clauses', 'extractions', 'drafts', 'obligations', 'tasks', 'evidence', 'notifications', 'reminders', 'attempts', 'audit_logs', 'idempotency_requests'].map(table => [table, db.prepare(`SELECT id,data FROM ${table} ORDER BY id`).all()]));
  } finally { db.close(); }
}

try {
  let service = await start(initial);
  const page = await fetch(service.base + '/projects');
  assert.ok(page.ok && (await page.text()).includes('root'));
  assert.equal((await api(service.base, '/projects')).total, 0);
  completedSteps.push('生产构建启动、空库页面和模拟模式');

  const project = await api(service.base, '/projects', 'POST', { name: 'Mac 合成业务验证项目', company: '合成公司', owner_label: '合成负责人' }, 'mac-project');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const due = new Date(`${today}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + 1);
  const dueOn = due.toISOString().slice(0, 10);
  const source = `第1条 公司应于${dueOn}前提交验收材料。\n第2条 公司应于${dueOn}前报送财务报告。`;
  const upload = new FormData(); upload.append('file', new Blob([source], { type: 'text/plain' }), '合成 协议.txt');
  const document = await api(service.base, `/projects/${project.id}/documents`, 'POST', upload, 'mac-upload');
  assert.equal(document.state, 'parsed');
  assert.equal(document.original_name, '合成 协议.txt');
  const downloaded = new Uint8Array(await (await fetch(service.base + `/api/v1/documents/${document.id}/content`)).arrayBuffer());
  assert.equal(sha256(downloaded), sha256(Buffer.from(source)));
  completedSteps.push('创建项目、中文文件上传、解析和受控原件下载');

  let run = await api(service.base, `/documents/${document.id}/extractions`, 'POST', {}, 'mac-extraction');
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(run.state); attempt++) {
    await sleep(100); run = await api(service.base, `/extractions/${run.id}`);
  }
  assert.equal(run.state, 'succeeded'); assert.equal(run.candidates.length, 2);
  for (const candidate of run.candidates) {
    assert.ok(source.includes(candidate.source_text));
    await api(service.base, `/draft-obligations/${candidate.id}`, 'PATCH', { version: candidate.version, owner_label: '合成负责人', rule: { ...candidate.rule, confirmation_status: 'confirmed' } });
  }
  const confirmationBody = { draft_ids: run.candidates.map((candidate: any) => candidate.id) };
  const confirmation = await api(service.base, `/extractions/${run.id}/confirm`, 'POST', confirmationBody, 'mac-confirm');
  assert.equal(confirmation.created.length, 2);
  await api(service.base, `/extractions/${run.id}/confirm`, 'POST', confirmationBody, 'mac-confirm');
  const tasks = (await api(service.base, `/projects/${project.id}/tasks`)).items;
  assert.equal(tasks.length, 2); assert.ok(tasks.every((task: any) => task.effective_due_on === dueOn));
  completedSteps.push('模拟提取、原文定位、逐条确认期限及幂等导入');

  const evidenceBytes = Buffer.from('合成验收凭证，仅用于本机自动验证');
  const evidenceUpload = new FormData(); evidenceUpload.append('file', new Blob([evidenceBytes]), '合成 完成凭证.txt');
  const evidence = await api(service.base, `/tasks/${tasks[0].id}/evidence`, 'POST', evidenceUpload);
  await api(service.base, `/tasks/${tasks[0].id}/complete`, 'POST', { version: tasks[0].version, completed_on: today, completion_note: '合成履约完成', evidence_ids: [evidence.id] });
  const completed = await api(service.base, `/tasks/${tasks[0].id}`);
  assert.equal(completed.status, 'done'); assert.equal(completed.completed_on, today);
  assert.ok(completed.evidence.some((entry: any) => entry.id === evidence.id));
  const evidenceDownload = new Uint8Array(await (await fetch(service.base + `/api/v1/documents/${evidence.document_id}/content`)).arrayBuffer());
  assert.equal(sha256(evidenceDownload), sha256(evidenceBytes));
  completedSteps.push('上传完成凭证、完成事项及审计留痕');

  const settings = await api(service.base, '/settings');
  await api(service.base, '/settings', 'PATCH', { version: settings.version, feishu_enabled: true });
  const scan = await api(service.base, '/scans', 'POST', { channels: ['feishu'] });
  assert.equal(scan.mode, 'mock'); assert.equal(scan.notifications.length, 1);
  const automatic = await notificationDone(service.base, scan.notifications[0].id);
  assert.deepEqual(automatic.content.items.map((item: any) => item.task_id), [tasks[1].id]);
  assert.equal((await api(service.base, '/scans', 'POST', { channels: ['feishu'] })).notifications.length, 0);
  const preview = await api(service.base, '/reminders/preview', 'POST', { channel: 'email', project_id: project.id, recipients: 'mac-test@example.invalid' });
  assert.equal(preview.content.items.length, 2);
  const sendBody = { snapshot_id: preview.id, body: preview.content.body + '\n合成验证备注' };
  const manual = await api(service.base, '/reminders/send', 'POST', sendBody, 'mac-manual-mail');
  assert.equal((await api(service.base, '/reminders/send', 'POST', sendBody, 'mac-manual-mail')).id, manual.id);
  await notificationDone(service.base, manual.id);
  completedSteps.push('自动提醒排除完成事项、阶段去重和手动模拟发送');

  const beforeRestart = readDatabase(initial);
  assert.equal(beforeRestart.reminders.length, 1); assert.equal(beforeRestart.notifications.length, 2);
  await stop(service.child); service = await start(initial);
  assert.deepEqual(readDatabase(initial), beforeRestart);
  assert.equal((await api(service.base, `/tasks/${tasks[0].id}`)).status, 'done');
  assert.equal((await api(service.base, '/scans', 'POST', { channels: ['feishu'] })).notifications.length, 0);
  completedSteps.push('生产服务重启后业务、原文、凭证与发送去重状态保留');

  const backup = await api(service.base, '/backups', 'POST', {});
  assert.equal(backup.sealed, true); assert.equal(backup.files, 3);
  const expected = readDatabase(initial);
  await stop(service.child);
  const recovery = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'restore', '--from', backup.directory, '--to', restored], { env: service.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
  assert.match(recovery.stdout, /verified: true/);
  assert.deepEqual(readDatabase(restored), expected);
  service = await start(restored);
  const recoveredDocument = await api(service.base, `/documents/${document.id}`);
  assert.equal(recoveredDocument.text, source);
  assert.equal(recoveredDocument.clauses.length, 2);
  assert.equal((await api(service.base, `/tasks/${tasks[0].id}`)).status, 'done');
  assert.equal((await api(service.base, '/notification-events')).total, 2);
  const restoredDownload = new Uint8Array(await (await fetch(service.base + `/api/v1/documents/${document.id}/content`)).arrayBuffer());
  assert.equal(sha256(restoredDownload), sha256(Buffer.from(source)));
  const restoredEvidence = new Uint8Array(await (await fetch(service.base + `/api/v1/documents/${evidence.document_id}/content`)).arrayBuffer());
  assert.equal(sha256(restoredEvidence), sha256(evidenceBytes));
  assert.equal((await api(service.base, '/scans', 'POST', { channels: ['feishu'] })).notifications.length, 0);
  completedSteps.push('一致性备份、CLI新目录恢复、原件摘要和完整关联核验');
  const result = { status: 'passed', recorded_at: new Date().toISOString(), started_at: started.toISOString(), os: process.platform, arch: process.arch, node: process.versions.node, mode: 'production bundle / synthetic data / mock model and notifications', chinese_paths_with_spaces: true, completed_steps: completedSteps, counts: Object.fromEntries(Object.entries(expected).map(([table, records]) => [table, records.length])), live_model: 'not_run', live_notifications: 'not_run', user_database_used: false };
  writeFileSync('docs/Mac业务验证.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const child of children) await stop(child);
  if (resolve(root).startsWith(resolve(tmpdir()) + sep)) rmSync(root, { recursive: true, force: true });
}
