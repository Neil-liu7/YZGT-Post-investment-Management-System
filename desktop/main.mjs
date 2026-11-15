import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const development = !app.isPackaged;
const appRoot = development ? resolve(here, '..') : join(process.resourcesPath, 'app');
const runtimeRoot = development ? join(appRoot, 'desktop', 'runtime') : join(process.resourcesPath, 'runtime');
let mainWindow;
let server;
let serverPort;

function runtimeBinary() {
  if (process.env.YZGT_NODE && existsSync(process.env.YZGT_NODE)) return process.env.YZGT_NODE;
  const candidates = process.platform === 'win32'
    ? [join(runtimeRoot, 'node.exe'), join(runtimeRoot, 'win-x64', 'node.exe')]
    : [join(runtimeRoot, 'node'), join(runtimeRoot, `${process.platform}-${process.arch}`, 'bin', 'node')];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const pathNode = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0];
  return pathNode || null;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolvePort(port)); });
  });
}

function sidecarEnv(userData, port) {
  const storage = join(userData, 'storage');
  const backups = join(userData, 'backups');
  const supervisor = join(userData, 'supervisor');
  mkdirSync(storage, { recursive: true }); mkdirSync(backups, { recursive: true }); mkdirSync(supervisor, { recursive: true });
  return { ...process.env, DOTENV_CONFIG_PATH: join(userData, '.env'), DATABASE_FILE: join(userData, 'var', 'app.sqlite'), STORAGE_DIR: storage, BACKUP_DIR: backups, SUPERVISOR_LOG_DIR: supervisor, SUPERVISOR_ALERT_FILE: join(supervisor, 'alerts.jsonl'), PORT: String(port), HOST: '127.0.0.1', APP_MODE: 'desktop' };
}

function runSetup(values, userData) {
  const node = runtimeBinary();
  if (!node) throw new Error('未找到内置 Node 运行时。请重新安装应用，或设置 YZGT_NODE 指向 Node 22.22.2。');
  const tsx = join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env = { ...sidecarEnv(userData, serverPort ?? 8765), ...Object.fromEntries(Object.entries({ DATABASE_FILE: join(userData, 'var', 'app.sqlite'), STORAGE_DIR: join(userData, 'storage'), BACKUP_DIR: join(userData, 'backups'), ...values }).map(([key, value]) => [`SETUP_${key}`, String(value ?? '')])) };
  const configFile = join(userData, '.env');
  const result = spawnSync(node, [tsx, join(appRoot, 'scripts', 'setup.ts'), '--non-interactive', `--config-file=${configFile}`, `--template=${join(appRoot, '.env.example')}`, `--backup-dir=${join(userData, 'config-backups')}`], { cwd: appRoot, env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || '配置未通过，请检查输入。');
  const text = result.stdout.trim(); const start = text.indexOf('{');
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

function runConfigCheck(userData) {
  const node = runtimeBinary();
  if (!node) throw new Error('未找到内置 Node 运行时。');
  const tsx = join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(node, [tsx, join(appRoot, 'scripts', 'config-check.ts'), '--json', '--skip-port', `--config-file=${join(userData, '.env')}`], { cwd: appRoot, env: sidecarEnv(userData, serverPort ?? 8765), encoding: 'utf8', windowsHide: true });
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  return { ok: result.status === 0, output };
}

async function startServer(userData) {
  if (server) return;
  const node = runtimeBinary();
  if (!node) throw new Error('未找到内置 Node 运行时。');
  serverPort = await freePort();
  const tsx = join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const supervisor = join(appRoot, 'scripts', 'supervise.ts');
  server = spawn(node, [tsx, supervisor], { cwd: appRoot, env: sidecarEnv(userData, serverPort), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', data => process.stdout.write(data)); server.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${serverPort}/health`); if (response.ok) return; } catch { /* starting */ } await new Promise(resolveWait => setTimeout(resolveWait, 250)); }
  throw new Error('本地服务启动超时，请查看应用日志。');
}

function windowOptions() { return { width: 1440, height: 960, minWidth: 960, minHeight: 720, show: false, webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } }; }

async function createWindow(userData) {
  mainWindow = new BrowserWindow(windowOptions());
  console.log(`[desktop] appRoot=${appRoot} userData=${userData} packaged=${app.isPackaged} env=${existsSync(join(userData, '.env'))}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  if (!existsSync(join(userData, '.env'))) await mainWindow.loadFile(join(here, 'onboarding.html'));
  else { await startServer(userData); await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`); }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  ipcMain.handle('desktop:configure', (_event, values) => { const result = runSetup(values, userData); return result; });
  ipcMain.handle('desktop:check', () => runConfigCheck(userData));
  ipcMain.handle('desktop:start', async () => { await startServer(userData); await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`); return { port: serverPort }; });
  await createWindow(userData);
}).catch(error => { console.error(`[desktop] startup failed: ${error?.stack || error}`); app.quit(); });

app.on('before-quit', () => { if (server && !server.killed) server.kill('SIGTERM'); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
