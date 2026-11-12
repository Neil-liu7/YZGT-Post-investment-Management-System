import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { config } from '../../apps/server/src/config';

const resources: { runtime: ReturnType<typeof createApp>; root: string }[] = [];
const originalMode = config.llm_mode;
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-model-status-'));
  const runtime = createApp({ database_file: join(root, 'app.sqlite'), storage_dir: join(root, 'storage'), clock: () => new Date('2026-11-11T02:00:00Z') });
  resources.push({ runtime, root });
  return runtime;
}
afterEach(() => {
  config.llm_mode = originalMode; vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const { runtime, root } of resources.splice(0)) { runtime.store.close(); rmSync(root, { recursive: true, force: true }); }
});
async function extract(s: ReturnType<typeof createApp>) {
  const project = s.store.create('projects', { name: '模型配置合成项目', company: '合成公司' });
  const document = s.store.create('documents', { project_id: project.id, state: 'parsed', file_version: 1, text: '公司应于2029年12月31日提交资料。' });
  s.store.create('clauses', { project_id: project.id, document_id: document.id, text: document.text, locator: { paragraph: 1 } });
  const created = await request(s.app).post(`/api/v1/documents/${document.id}/extractions`).send({});
  expect(created.status).toBe(202);
  let run = created.body.data;
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(run.state); attempt++) {
    await new Promise(done => setTimeout(done, 10));
    run = (await request(s.app).get(`/api/v1/extractions/${run.id}`)).body.data;
  }
  return run;
}

describe('model status and extraction audit boundary', () => {
  it('exposes provider readiness without a key or private URL path', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai_compatible'); vi.stubEnv('LLM_BASE_URL', 'https://models.example.invalid/private-gateway');
    vi.stubEnv('LLM_MODEL', 'synthetic-model'); vi.stubEnv('LLM_API_KEY', 'synthetic-secret-value'); vi.stubEnv('ALLOW_EXTERNAL_MODEL', 'false');
    const s = setup();
    const response = await request(s.app).get('/api/v1/settings');
    expect(response.status).toBe(200);
    expect(response.body.data.llm_status).toMatchObject({ provider: 'openai_compatible', model: 'synthetic-model', host: 'models.example.invalid', configured: true, ready: false });
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-secret-value|private-gateway/);
  });
  it('records mock provenance and leaves model candidates unconfirmed without creating tasks', async () => {
    config.llm_mode = 'mock';
    const trap = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不得产生真实网络请求'));
    const s = setup(), run = await extract(s);
    expect(run).toMatchObject({ state: 'succeeded', mode: 'mock', provider: 'mock', model: 'deterministic-mock-v1' });
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0].review_state).toBe('draft'); expect(run.candidates[0].rule.confirmation_status).toBe('needs_review');
    expect(s.store.all('tasks')).toHaveLength(0); expect(s.store.all('obligations')).toHaveLength(0);
    expect(trap).not.toHaveBeenCalled();
  });
  it('records a stable blocked-live error while automatic tests never reach a real transport', async () => {
    config.llm_mode = 'live';
    const trap = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('synthetic-secret-value'));
    const s = setup(), run = await extract(s);
    expect(run).toMatchObject({ state: 'failed', mode: 'live', error_code: 'TEST_OUTBOUND_BLOCKED' });
    expect(run.error).toContain('自动测试'); expect(JSON.stringify(run)).not.toContain('synthetic-secret-value');
    expect(run.candidates).toHaveLength(0); expect(trap).not.toHaveBeenCalled();
  });
});
