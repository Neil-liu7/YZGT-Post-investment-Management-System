import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { tables } from '../../apps/server/src/store';

const resources: { root: string; runtime: ReturnType<typeof createApp> }[] = [];
const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
const lines = [
  '本协议于2026年11月1日签署。公司应于签署后10日提交申请。',
  '公司应于收到款项后5个工作日提供凭证。',
  '公司应于2029年12月31日前完成实缴。',
  '每季度结束后30日内报送财务报表。',
];
const network = vi.fn(() => { throw new Error('Unexpected external model or notification request'); });
beforeEach(() => vi.stubGlobal('fetch', network));
afterEach(() => {
  for (const { root, runtime } of resources.splice(0)) { runtime.store.close(); rmSync(root, { recursive: true, force: true }); }
  expect(network).not.toHaveBeenCalled(); network.mockClear(); vi.unstubAllGlobals();
});
function setup(paymentDate: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-joint-review-'));
  const runtime = createApp({ database_file: join(root, 'app.sqlite'), storage_dir: join(root, 'storage'), clock: () => new Date('2026-11-12T02:00:00.000Z') });
  resources.push({ root, runtime }); const { store } = runtime;
  const project = store.create('projects', { name: '合成联合提取项目', company: '合成公司', archived: false });
  const document = store.create('documents', { project_id: project.id, state: 'parsed', text: lines.join('\n'), file_version: 1 });
  const run = store.create('extractions', { project_id: project.id, document_id: document.id, document_version: 1, state: 'succeeded', mode: 'mock', joint_extraction: true, prompt: '重点关注申请和凭证' });
  const source = (index: number) => ({ extraction_id: run.id, project_id: project.id, document_id: document.id, document_version_id: document.id, source_text: lines[index], clause_index: index, locator: { paragraph: index + 1 }, review_state: 'draft' });
  const event = (key: string, date: string | null, index: number) => store.create('event_drafts', { ...source(index), candidate_key: key, name: key === 'signing' ? '协议签署' : '收到款项', event_type: key === 'signing' ? 'signing' : 'investment', investor_label: '', occurred_on: date, reuse_event_id: null, reuse_event_version: null });
  const signing = event('signing', '2026-11-01', 0), payment = event('payment', paymentDate, 1);
  const base = { schema_version: 1, confirmation_status: 'needs_review', original_expression: '从原文提取' };
  const draft = (title: string, index: number, rule: unknown) => store.create('drafts', { ...source(index), title, description: title, obligor: '公司', owner_label: '', action: title.slice(0, 2), deliverable: title.slice(2), trigger: title.includes('申请') ? '协议签署' : title.includes('凭证') ? '收到款项' : '', rule });
  const application = draft('提交申请', 0, { ...base, kind: 'relative', anchor: { type: 'event', event_id: 'candidate-event:signing' }, offsets: [{ amount: 10, unit: 'calendar_day', include_start_day: false }], convention });
  const receipt = draft('提供凭证', 1, { ...base, kind: 'relative', anchor: { type: 'event', event_id: 'candidate-event:payment' }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention });
  const fixed = draft('完成实缴', 2, { ...base, kind: 'fixed', date: '2029-12-31', convention });
  const recurring = draft('报送财务报表', 3, { ...base, kind: 'recurring', frequency: 'quarter', first_period_start: null, last_period_end: null, anchor: 'period_end', offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }], convention });
  return { ...runtime, root, project, document, run, signing, payment, application, receipt, fixed, recurring };
}
const body = (r: ReturnType<typeof setup>) => ({ draft_ids: [r.application.id, r.receipt.id, r.fixed.id], event_draft_ids: [r.signing.id, r.payment.id] });
const api = (r: ReturnType<typeof setup>, suffix: string, data: any) => request(r.app).post(`/api/v1/extractions/${r.run.id}/${suffix}`).send(data);
async function preview(r: ReturnType<typeof setup>, selection = body(r)) { const response = await api(r, 'preview', selection); expect(response.status, JSON.stringify(response.body.error)).toBe(200); return response.body.data; }
const confirm = (r: ReturnType<typeof setup>, selection: Record<string, unknown>, versions: unknown) => api(r, 'confirm', { ...selection, confirm_review: true, expected_versions: versions });
const snapshot = (r: ReturnType<typeof setup>) => Object.fromEntries(tables.map(table => [table, r.store.all(table)]));

describe('joint extraction human review and atomic confirmation', () => {
  it('starts a joint extraction by default, persists its request and candidates, and leaves formal records absent', async () => {
    const r = setup(), text = readFileSync('tests/fixtures/agreement.txt', 'utf8');
    r.store.update('documents', r.document.id, r.document.version, { text });
    text.trim().split('\n').forEach((line, index) => r.store.create('clauses', { project_id: r.project.id, document_id: r.document.id, text: line, locator: { paragraph: index + 1 }, clause_number: `第${index + 1}条` }));
    const created = await request(r.app).post(`/api/v1/documents/${r.document.id}/extractions`).set('Idempotency-Key', 'joint-extract-default').send({});
    expect(created.status).toBe(202); expect(created.body.data).toMatchObject({ joint_extraction: true, prompt: '', mode: 'mock' });
    const runId = created.body.data.id;
    let run: any;
    for (let index = 0; index < 100; index++) { run = (await request(r.app).get(`/api/v1/extractions/${runId}`)).body.data; if (!['queued', 'running'].includes(run.state)) break; await new Promise(done => setTimeout(done, 5)); }
    expect(run.state).toBe('succeeded'); expect(run.event_candidates).toHaveLength(3); expect(run.candidates).toHaveLength(6);
    expect(run.event_candidates.every((e: any) => e.occurred_on === null && e.candidate_key)).toBe(true);
    expect(run.candidates.find((d: any) => d.rule?.kind === 'recurring').rule.first_period_start).toBeNull();
    expect(r.store.all('events')).toHaveLength(0); expect(r.store.all('obligations')).toHaveLength(0); expect(r.store.all('tasks')).toHaveLength(0);
    const repeated = await request(r.app).post(`/api/v1/documents/${r.document.id}/extractions`).set('Idempotency-Key', 'joint-extract-default').send({});
    expect(repeated.body.data.id).toBe(runId); expect(r.store.all('extractions')).toHaveLength(2);
  });

  it('persists supplemental extraction requirements and rejects oversized or unsupported request fields', async () => {
    const r = setup();
    r.store.create('clauses', { project_id: r.project.id, document_id: r.document.id, text: lines[1], locator: { paragraph: 2 } });
    const path = `/api/v1/documents/${r.document.id}/extractions`;
    expect((await request(r.app).post(path).send({ prompt: 'x'.repeat(4001) })).status).toBe(422);
    expect((await request(r.app).post(path).send({ prompt: '筛选凭证', mode: 'live' })).status).toBe(422);
    const created = await request(r.app).post(path).send({ prompt: '  只提取凭证  ' }); expect(created.status).toBe(202); expect(created.body.data.prompt).toBe('只提取凭证');
    let run: any;
    for (let index = 0; index < 100; index++) { run = (await request(r.app).get(`/api/v1/extractions/${created.body.data.id}`)).body.data; if (!['queued', 'running'].includes(run.state)) break; await new Promise(done => setTimeout(done, 5)); }
    expect(run.state).toBe('succeeded'); expect(run.prompt_notice).toContain('模拟'); expect(run.candidates).toHaveLength(1); expect(run.event_candidates).toHaveLength(1);
    expect(run.prompt).toBe('只提取凭证');
  });

  it('previews every selected result without any live record or audit write, then confirms unknown dates without inventing deadlines', async () => {
    const r = setup(), before = snapshot(r), selected = body(r);
    const p = await preview(r, selected);
    expect(snapshot(r)).toEqual(before); expect(p.events).toHaveLength(2); expect(p.tasks).toHaveLength(3);
    expect(p.tasks.find((t: any) => t.title === '提交申请')).toMatchObject({ effective_due_on: '2026-11-11', deadline_state: 'calculated' });
    expect(p.tasks.find((t: any) => t.title === '提供凭证')).toMatchObject({ effective_due_on: null, deadline_state: 'waiting_event' });
    const result = await confirm(r, selected, p.versions); expect(result.status).toBe(200);
    expect(result.body.data.events_created).toHaveLength(2); expect(r.store.all('obligations')).toHaveLength(3); expect(r.store.all('tasks')).toHaveLength(3);
    expect(r.store.all('obligations').find((o: any) => o.title === '提交申请')).toMatchObject({ action: '提交', deliverable: '申请', trigger: '协议签署' });
    expect(r.store.all('tasks').find((t: any) => t.title === '提交申请')).toMatchObject({ action: '提交', deliverable: '申请', trigger: '协议签署' });
    expect(r.store.require('event_drafts', r.payment.id)).toMatchObject({ review_state: 'approved', occurred_on: null });
    expect(r.store.all('events').find(e => e.event_type === 'investment').occurred_on).toBeNull();
    expect(r.store.all('obligations').every(o => !JSON.stringify(o.rule).includes('candidate-event:') && o.rule.confirmation_status === 'confirmed')).toBe(true);
  });

  it('repeated confirmation preserves the original events, task progress and human edits', async () => {
    const r = setup(), selected = body(r), p = await preview(r, selected);
    expect((await confirm(r, selected, p.versions)).status).toBe(200);
    const event = r.store.all('events')[0], task = r.store.all('tasks')[0], obligation = r.store.all('obligations')[0];
    r.store.update('events', event.id, event.version, { occurred_on: '2026-11-02', name: '人工修订名称' });
    r.store.update('tasks', task.id, task.version, { status: 'done', manual_due_on: '2026-12-01', effective_due_on: '2026-12-01' });
    r.store.update('obligations', obligation.id, obligation.version, { title: '人工修订标题' });
    const before = snapshot(r), repeated = await confirm(r, selected, p.versions);
    expect(repeated.status).toBe(200); expect(repeated.body.data.created).toHaveLength(0); expect(repeated.body.data.skipped).toHaveLength(3); expect(snapshot(r)).toEqual(before);
  });

  it('reuses the exact same command key and refuses changed confirmation data', async () => {
    const r = setup(), selected = body(r), p = await preview(r, selected);
    const payload = { ...selected, confirm_review: true, expected_versions: p.versions };
    const send = (data: any) => request(r.app).post(`/api/v1/extractions/${r.run.id}/confirm`).set('Idempotency-Key', 'joint-confirm-once').send(data);
    const first = await send(payload), second = await send(payload); expect(first.status).toBe(200); expect(second.body.data).toEqual(first.body.data);
    expect((await send({ ...payload, draft_ids: [r.fixed.id] })).status).toBe(409); expect(r.store.all('events')).toHaveLength(2);
  });

  it('keeps an incomplete recurring proposal as a draft and rolls back all other selections', async () => {
    const r = setup(), before = snapshot(r), selected = { ...body(r), draft_ids: [r.application.id, r.recurring.id] };
    const result = await api(r, 'preview', selected); expect(result.status).toBe(422); expect(result.body.error.code).toBe('DRAFT_RULE_INCOMPLETE'); expect(snapshot(r)).toEqual(before);
    const direct = await confirm(r, selected, { drafts: [], event_drafts: [], events: [], calendars: [] }); expect(direct.status).toBe(409); expect(snapshot(r)).toEqual(before);
    const baseline = { drafts: [r.application, r.recurring].map(d => ({ id: d.id, version: d.version })), event_drafts: [r.signing, r.payment].map(d => ({ id: d.id, version: d.version })), events: [], calendars: [] };
    const failedCommit = await confirm(r, selected, baseline); expect(failedCommit.status).toBe(422); expect(failedCommit.body.error.code).toBe('DRAFT_RULE_INCOMPLETE'); expect(snapshot(r)).toEqual(before);
  });

  it('refuses an unselected or ignored event dependency without leaving partial events', async () => {
    const r = setup();
    const missing = await api(r, 'preview', { draft_ids: [r.application.id], event_draft_ids: [] }); expect(missing.status).toBe(422); expect(missing.body.error.code).toBe('EVENT_CANDIDATE_NOT_SELECTED');
    r.store.update('event_drafts', r.signing.id, r.signing.version, { review_state: 'ignored' });
    const ignored = await api(r, 'preview', body(r)); expect(ignored.status).toBe(422); expect(r.store.all('events')).toHaveLength(0);
  });

  it('detects candidate edits between preview and confirm and preserves the edit', async () => {
    const r = setup(), p = await preview(r);
    r.store.update('event_drafts', r.signing.id, r.signing.version, { occurred_on: '2026-11-02' });
    const before = snapshot(r), response = await confirm(r, body(r), p.versions);
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('REVIEW_PREVIEW_STALE'); expect(snapshot(r)).toEqual(before);
  });

  it('requires an explicit review acknowledgement and a complete preview baseline', async () => {
    const r = setup(); expect((await api(r, 'confirm', { ...body(r), confirm_review: true })).status).toBe(409);
    expect((await api(r, 'confirm', { ...body(r), confirm_review: false })).body.error.code).toBe('REVIEW_CONFIRMATION_REQUIRED');
    const p = await preview(r); const omitted = { ...p.versions, event_drafts: [] };
    expect((await confirm(r, body(r), omitted)).status).toBe(409); expect(r.store.all('events')).toHaveLength(0);
  });

  it('supports event-only review, leaving obligations absent until separately confirmed', async () => {
    const r = setup(), selected = { draft_ids: [], event_draft_ids: [r.signing.id] }, p = await preview(r, selected);
    expect((await confirm(r, selected, p.versions)).status).toBe(200); expect(r.store.all('events')).toHaveLength(1); expect(r.store.all('obligations')).toHaveLength(0);
    const follow = { draft_ids: [r.application.id], event_draft_ids: [r.signing.id] }, next = await preview(r, follow);
    expect(next.versions.events).toHaveLength(1); expect((await confirm(r, follow, next.versions)).body.data.events_created).toHaveLength(0); expect(r.store.all('tasks')).toHaveLength(1);
  });

  it('makes missing workday calendars explicit and allows an explicitly chosen confirmed calendar', async () => {
    const r = setup('2026-11-06'); const selected = { draft_ids: [r.receipt.id], event_draft_ids: [r.payment.id] };
    const absent = await preview(r, selected); expect(absent.tasks[0]).toMatchObject({ deadline_state: 'needs_review', effective_due_on: null });
    const calendar = r.store.create('calendars', { name: '合成周末日历', confirmed: true, calendar_version: 1, start_on: '2026-01-01', end_on: '2027-12-31', overrides: {} });
    const withCalendar = { ...selected, calendar_id: calendar.id, calendar_version: 1 }, p = await preview(r, withCalendar);
    expect(p.tasks[0].effective_due_on).toBe('2026-11-13'); expect((await confirm(r, withCalendar, p.versions)).status).toBe(200);
    expect(r.store.all('tasks')[0].deadline_state).toBe('calculated');
  });

  it('applies a shared calendar only to rules that require workdays and preserves fixed/natural-day conventions', async () => {
    const r = setup('2026-11-06'), calendar = r.store.create('calendars', { name: '合成日历', confirmed: true, calendar_version: 1, start_on: '2026-01-01', end_on: '2027-12-31', overrides: {} });
    const selected = { ...body(r), calendar_id: calendar.id, calendar_version: 1 }, p = await preview(r, selected);
    expect((await confirm(r, selected, p.versions)).status).toBe(200);
    const rules = Object.fromEntries(r.store.all('obligations').map(o => [o.title, o.rule]));
    expect(rules['提供凭证'].convention.calendar_id).toBe(calendar.id);
    expect(rules['完成实缴'].convention).toEqual(convention); expect(rules['提交申请'].convention).toEqual(convention);
  });

  it('detects calendar entity edits after preview even when the calculation version stays unchanged', async () => {
    const r = setup('2026-11-06'), calendar = r.store.create('calendars', { name: '合成日历', confirmed: true, calendar_version: 1, start_on: '2026-01-01', end_on: '2027-12-31', overrides: {} });
    const selected = { ...body(r), calendar_id: calendar.id, calendar_version: 1 }, p = await preview(r, selected);
    r.store.update('calendars', calendar.id, calendar.version, { overrides: { '2026-11-09': false } });
    expect((await confirm(r, selected, p.versions)).status).toBe(409); expect(r.store.all('events')).toHaveLength(0);
  });

  it('explicitly reuses an existing event and checks its version without overwriting its date', async () => {
    const r = setup(), existing = r.store.create('events', { name: '已核对签署', project_id: r.project.id, occurred_on: '2026-10-01', event_type: 'signing', document_id: r.document.id });
    const edit = await request(r.app).patch(`/api/v1/draft-events/${r.signing.id}`).send({ version: r.signing.version, reuse_event_id: existing.id, reuse_event_version: existing.version }); expect(edit.status).toBe(200);
    const selected = { draft_ids: [r.application.id], event_draft_ids: [r.signing.id] }, p = await preview(r, selected);
    expect(p.tasks[0].effective_due_on).toBe('2026-10-11'); expect(p.versions.events).toEqual([{ id: existing.id, version: existing.version }]);
    const confirmed = await confirm(r, selected, p.versions); expect(confirmed.status).toBe(200); expect(confirmed.body.data.events_reused).toHaveLength(1); expect(r.store.require('events', existing.id)).toEqual(existing);
  });

  it('detects reused event changes after preview', async () => {
    const r = setup(), existing = r.store.create('events', { name: '签署', project_id: r.project.id, occurred_on: '2026-10-01' });
    r.store.update('event_drafts', r.signing.id, r.signing.version, { reuse_event_id: existing.id, reuse_event_version: existing.version });
    const p = await preview(r); r.store.update('events', existing.id, existing.version, { occurred_on: '2026-10-02' });
    expect((await confirm(r, body(r), p.versions)).status).toBe(409); expect(r.store.all('obligations')).toHaveLength(0);
  });

  it('does not merge different document or investor event scopes by name', async () => {
    const r = setup(); const second = r.store.create('event_drafts', { ...r.signing, id: undefined, candidate_key: 'signing-other-investor', investor_label: '另一投资方' });
    const selected = { draft_ids: [], event_draft_ids: [r.signing.id, second.id] }, p = await preview(r, selected);
    expect((await confirm(r, selected, p.versions)).status).toBe(200); expect(r.store.all('events')).toHaveLength(2);
  });

  it('keeps two separately named phases in one source clause independent even with the same type and investor', async () => {
    const r = setup();
    const second = r.store.create('event_drafts', { ...r.signing, id: undefined, candidate_key: 'second-signing', name: '第二期协议签署', occurred_on: null });
    const selected = { draft_ids: [], event_draft_ids: [r.signing.id, second.id] }, p = await preview(r, selected);
    expect(p.events).toHaveLength(2); expect((await confirm(r, selected, p.versions)).status).toBe(200); expect(r.store.all('events')).toHaveLength(2);
  });

  it('re-extraction reuses exact source events and obligations while preserving later human changes', async () => {
    const r = setup(), selected = { draft_ids: [r.application.id], event_draft_ids: [r.signing.id] }, first = await preview(r, selected);
    expect((await confirm(r, selected, first.versions)).status).toBe(200);
    const event = r.store.all('events')[0], obligation = r.store.all('obligations')[0];
    r.store.update('obligations', obligation.id, obligation.version, { owner_label: '人工负责人' });
    const anotherRun = r.store.create('extractions', { ...r.run, id: undefined });
    const eventDraft = r.store.create('event_drafts', { ...r.signing, id: undefined, extraction_id: anotherRun.id });
    const draft = r.store.create('drafts', { ...r.application, id: undefined, extraction_id: anotherRun.id });
    const payload = { draft_ids: [draft.id], event_draft_ids: [eventDraft.id] };
    const p = await request(r.app).post(`/api/v1/extractions/${anotherRun.id}/preview`).send(payload); expect(p.status).toBe(200);
    const result = await request(r.app).post(`/api/v1/extractions/${anotherRun.id}/confirm`).send({ ...payload, confirm_review: true, expected_versions: p.body.data.versions });
    expect(result.status).toBe(200); expect(result.body.data.skipped).toEqual([obligation.id]); expect(r.store.all('events')).toEqual([event]); expect(r.store.all('obligations')[0].owner_label).toBe('人工负责人');
  });

  it('rejects changed same-source dates until the reviewer explicitly chooses how to reuse the existing event', async () => {
    const r = setup(), selected = { draft_ids: [], event_draft_ids: [r.signing.id] }, first = await preview(r, selected);
    await confirm(r, selected, first.versions); const existing = r.store.all('events')[0]; r.store.update('events', existing.id, existing.version, { occurred_on: '2026-11-03' });
    const anotherRun = r.store.create('extractions', { ...r.run, id: undefined }), e = r.store.create('event_drafts', { ...r.signing, id: undefined, extraction_id: anotherRun.id });
    const response = await request(r.app).post(`/api/v1/extractions/${anotherRun.id}/preview`).send({ draft_ids: [], event_draft_ids: [e.id] });
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('EVENT_SOURCE_CONFLICT'); expect(r.store.all('events')).toHaveLength(1);
  });

  it('refuses cross-run and foreign project references as one atomic operation', async () => {
    const r = setup(), foreign = setup();
    const wrongRun = await api(r, 'preview', { ...body(r), draft_ids: [foreign.application.id] }); expect(wrongRun.status).toBe(404);
    const other = r.store.create('projects', { name: '另一合成项目' }), event = r.store.create('events', { project_id: other.id, name: '异项目事件', occurred_on: null });
    expect((await request(r.app).patch(`/api/v1/draft-events/${r.signing.id}`).send({ version: r.signing.version, reuse_event_id: event.id, reuse_event_version: event.version })).status).toBe(422);
    r.store.update('drafts', r.application.id, r.application.version, { rule: { ...r.application.rule, anchor: { type: 'event', event_id: event.id } } });
    expect((await api(r, 'preview', body(r))).status).toBe(422); expect(r.store.all('events')).toHaveLength(1); expect(r.store.all('obligations')).toHaveLength(0);
  });

  it('resolves nested comparison and continuous boundaries without leaking candidate identifiers', async () => {
    const r = setup('2026-11-06'), calendar = r.store.create('calendars', { name: '合成日历', confirmed: true, calendar_version: 1, start_on: '2026-01-01', end_on: '2027-12-31', overrides: {} });
    r.store.update('drafts', r.application.id, r.application.version, { rule: { schema_version: 1, confirmation_status: 'needs_review', original_expression: '合成嵌套区间', kind: 'continuous', review_mode: 'manual', starts_at: { type: 'earliest', anchors: [{ type: 'event', event_id: 'candidate-event:signing' }, { type: 'event', event_id: 'candidate-event:payment' }] }, ends_at: { type: 'relative', anchor: { type: 'event', event_id: 'candidate-event:payment' }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention } } });
    const selected = { draft_ids: [r.application.id], event_draft_ids: [r.signing.id, r.payment.id], calendar_id: calendar.id, calendar_version: 1 }, p = await preview(r, selected);
    expect(p.tasks[0].calculation.interval).toEqual({ start_on: '2026-11-01', end_on: '2026-11-13' });
    expect((await confirm(r, selected, p.versions)).status).toBe(200);
    expect(JSON.stringify(r.store.all('obligations')[0].rule)).not.toContain('candidate-event:');
    expect(r.store.all('obligations')[0].rule.ends_at.convention.calendar_id).toBe(calendar.id);
  });

  it('rejects an altered source and a still-running extraction before any formal write', async () => {
    const r = setup();
    r.store.update('drafts', r.application.id, r.application.version, { source_text: '不在该协议中的伪造原文' });
    expect((await api(r, 'preview', body(r))).body.error.code).toBe('INVALID_SOURCE');
    r.store.update('extractions', r.run.id, r.run.version, { state: 'running' });
    expect((await api(r, 'preview', { draft_ids: [r.fixed.id], event_draft_ids: [] })).body.error.code).toBe('EXTRACTION_NOT_READY');
    expect(r.store.all('events')).toHaveLength(0); expect(r.store.all('obligations')).toHaveLength(0);
  });

  it('keeps legacy obligation-only confirmation compatible without silently importing event proposals', async () => {
    const r = setup();
    const confirmed = await api(r, 'confirm', { draft_ids: [r.fixed.id] }); expect(confirmed.status).toBe(200); expect(confirmed.body.data.created).toHaveLength(1);
    expect(r.store.all('events')).toHaveLength(0); expect(r.store.all('event_drafts').every(e => e.review_state === 'draft')).toBe(true);
  });

  it('stores editable event drafts and refuses invalid dates, stale versions, or editing approved rows', async () => {
    const r = setup();
    const path = `/api/v1/draft-events/${r.signing.id}`;
    expect((await request(r.app).patch(path).send({ version: 1, occurred_on: '2026-02-30' })).status).toBe(422);
    const update = await request(r.app).patch(path).send({ version: 1, occurred_on: null, name: '签署尚未完成' }); expect(update.status).toBe(200); expect(update.body.data.version).toBe(2);
    expect((await request(r.app).patch(path).send({ version: 1, name: '不应覆盖' })).status).toBe(409);
    const selected = { draft_ids: [], event_draft_ids: [r.signing.id] }, p = await preview(r, selected); await confirm(r, selected, p.versions);
    expect((await request(r.app).patch(path).send({ version: 3, occurred_on: '2026-11-01' })).status).toBe(409);
    const run = await request(r.app).get(`/api/v1/extractions/${r.run.id}`); expect(run.body.data.event_candidates).toHaveLength(2); expect(run.body.data.prompt).toBe('重点关注申请和凭证');
  });
});
