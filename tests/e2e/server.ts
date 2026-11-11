import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
process.env.LLM_MODE = 'mock';
process.env.OUTBOUND_MODE = 'mock';
process.env.SCHEDULER_ENABLED = 'false';
const folder = mkdtempSync(join(tmpdir(), 'yizhuang-e2e-'));
process.env.BACKUP_DIR = join(folder, 'backups');
process.env.DATABASE_FILE = join(folder, 'test.sqlite');
process.env.STORAGE_DIR = join(folder, 'storage');
const { createApp } = await import('../../apps/server/src/app');
const { app, store, notifications } = createApp({ database_file: join(folder, 'test.sqlite'), storage_dir: join(folder, 'storage'), clock: () => new Date('2026-11-11T03:00:00Z') });
// Fixture is registered only in this isolated test server, never in the production app.
app.post('/_e2e/fixtures/documents/:id/repair', (req, res) => {
  const document = store.require('documents', String(req.params.id));
  const target = resolve(folder, 'storage', document.storage_name);
  if (!target.startsWith(resolve(folder, 'storage') + sep)) { res.sendStatus(422); return; }
  const content = Buffer.from(String(req.body.text), 'utf8');
  writeFileSync(target, content);
  store.update('documents', document.id, document.version, { state: 'stored', error: null, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  res.json({ repaired: true });
});
const server = app.listen(Number(process.env.E2E_PORT ?? 8887), '127.0.0.1');
const tick = setInterval(() => { void notifications.processQueue(); }, 200);
function close() { clearInterval(tick); server.close(() => { store.close(); if (resolve(folder).startsWith(resolve(tmpdir()) + sep) && folder.includes('yizhuang-e2e-')) rmSync(folder, { recursive: true, force: true }); process.exit(); }); }
process.once('SIGTERM', close); process.once('SIGINT', close);
