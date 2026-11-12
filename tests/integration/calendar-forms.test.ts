import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';

const resources: { app: ReturnType<typeof createApp>; root: string }[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yzgt-calendar-forms-'));
  const app = createApp({ database_file: join(root, 'app.sqlite'), storage_dir: join(root, 'storage'), clock: () => new Date('2026-11-11T02:00:00Z') });
  resources.push({ app, root });
  return app;
}
afterEach(() => { for (const { app, root } of resources.splice(0)) { app.store.close(); rmSync(root, { recursive: true, force: true }); } });
const calendarInput = { name: '合成日历', region: 'CN', start_on: '2026-01-01', end_on: '2026-12-31', source: '仅用于合成规则核验', overrides: { '2026-11-07': true, '2026-11-11': false } };
const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };

describe('calendar forms and safe previews', () => {
  it.each([
    { name: '   ' }, { source: '   ' }, { region: ' ' },
    { end_on: '2025-12-31' }, { overrides: { '2027-01-01': true } }, { overrides: { '2026-02-30': false } },
  ])('rejects invalid calendar input before storing a draft: %j', async changes => {
    const s = setup();
    const response = await request(s.app).post('/api/v1/calendars/import-preview').send({ ...calendarInput, ...changes });
    expect(response.status).toBe(422);
    expect(s.store.all('calendars')).toHaveLength(0);
  });

  it('retries preview and confirmation idempotently while keeping the calendar rule version stable', async () => {
    const s = setup();
    const create = () => request(s.app).post('/api/v1/calendars/import-preview').set('Idempotency-Key', 'calendar-draft').send({ ...calendarInput, name: '  合成日历  ' });
    const draft = (await create()).body.data;
    expect(draft.name).toBe('合成日历'); expect(draft.confirmed).toBe(false);
    expect((await create()).body.data.id).toBe(draft.id);
    const confirm = () => request(s.app).post(`/api/v1/calendars/${draft.id}/confirm`).set('Idempotency-Key', 'calendar-confirm').send({ version: draft.version });
    const confirmed = await confirm();
    expect(confirmed.status).toBe(200); expect(confirmed.body.data.version).toBe(2);
    expect(confirmed.body.data.calendar_version).toBe(1);
    expect((await confirm()).body.data).toEqual(confirmed.body.data);
    expect(s.store.all('calendars')).toHaveLength(1);
    expect(s.store.all('audit_logs').filter(row => row.entity_id === draft.id)).toHaveLength(2);
    const conflict = await request(s.app).post('/api/v1/calendars/import-preview').set('Idempotency-Key', 'calendar-draft').send({ ...calendarInput, name: '另一份日历' });
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('revalidates persisted legacy drafts before confirming them', async () => {
    const s = setup();
    const draft = s.store.create('calendars', { ...calendarInput, overrides: { '2027-01-01': false }, confirmed: false, calendar_version: 1 });
    const response = await request(s.app).post(`/api/v1/calendars/${draft.id}/confirm`).send({ version: draft.version });
    expect(response.status).toBe(422);
    expect(s.store.require('calendars', draft.id).confirmed).toBe(false);
    expect(s.store.require('calendars', draft.id).version).toBe(1);
  });

  it.each([
    ['month', '2026-07-01', ['2026-08-30', '2026-09-30', '2026-10-30']],
    ['quarter', '2026-07-01', ['2026-10-30', '2027-01-30', '2027-04-30']],
    ['year', '2026-01-01', ['2027-01-30', '2028-01-30', '2029-01-30']],
  ])('previews only three %s periods without creating business records', async (frequency, start, expected) => {
    const s = setup();
    const rule = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '每期结束后30自然日', kind: 'recurring', frequency, first_period_start: start, last_period_end: null, anchor: 'period_end', offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }], convention };
    const response = await request(s.app).post('/api/v1/deadline-rules/preview').send({ rule });
    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('calculated'); expect(response.body.data.missing_inputs).toEqual([]);
    expect(response.body.data.computed_due_on).toBeNull();
    expect(response.body.data.occurrences.map((item: any) => item.computed_due_on)).toEqual(expected);
    expect(response.body.data.occurrences.every((item: any) => item.state === 'calculated')).toBe(true);
    expect(s.store.all('tasks')).toHaveLength(0); expect(s.store.all('obligations')).toHaveLength(0);
  });

  it('honors a recurring termination date rather than showing nonexistent future periods', async () => {
    const s = setup();
    const rule = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '两季度合成报送', kind: 'recurring', frequency: 'quarter', first_period_start: '2026-07-01', last_period_end: '2026-12-31', anchor: 'period_end', offsets: [], convention };
    const response = await request(s.app).post('/api/v1/deadline-rules/preview').send({ rule });
    expect(response.body.data.occurrences.map((item: any) => item.occurrence_key)).toEqual(['2026-Q3', '2026-Q4']);
  });

  it('keeps unconfirmed calendars as estimates and uses the semantic version after confirmation', async () => {
    const s = setup();
    const project = s.store.create('projects', { name: '期限表单项目', company: '合成公司' });
    const event = s.store.create('events', { project_id: project.id, name: '收款', occurred_on: '2026-11-06' });
    const draft = (await request(s.app).post('/api/v1/calendars/import-preview').send(calendarInput)).body.data;
    const rule = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '收款后5工作日', kind: 'relative', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention: { ...convention, calendar_id: draft.id, calendar_version: draft.calendar_version } };
    const preview = () => request(s.app).post('/api/v1/deadline-rules/preview').send({ project_id: project.id, rule });
    const estimate = (await preview()).body.data;
    expect(estimate.state).toBe('needs_review'); expect(estimate.computed_due_on).toBeNull(); expect(estimate.estimated_due_on).toBe('2026-11-13');
    await request(s.app).post(`/api/v1/calendars/${draft.id}/confirm`).send({ version: draft.version });
    const calculated = (await preview()).body.data;
    expect(calculated.state).toBe('calculated'); expect(calculated.computed_due_on).toBe('2026-11-13');
    expect(calculated.dependency_versions.calendars).toEqual({ [draft.id]: 1 });
    expect(calculated.steps.filter((step: any) => step.type === 'calendar_day').map((step: any) => step.date)).toContain('2026-11-11');
    const unknown = s.store.update('events', event.id, event.version, { occurred_on: null });
    expect(unknown.occurred_on).toBeNull();
    const waiting = (await preview()).body.data;
    expect(waiting.state).toBe('waiting_event'); expect(waiting.computed_due_on).toBeNull();
    expect(s.store.all('tasks')).toHaveLength(0);
  });

  it('reports out-of-range recurring preview dates as validation errors', async () => {
    const s = setup();
    const rule = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '范围边界', kind: 'recurring', frequency: 'year', first_period_start: '9999-01-01', last_period_end: null, anchor: 'period_end', offsets: [], convention };
    const response = await request(s.app).post('/api/v1/deadline-rules/preview').send({ rule });
    expect(response.status).toBe(422); expect(response.body.error.code).toBe('DATE_RANGE_EXCEEDED');
    expect(s.store.all('tasks')).toHaveLength(0);
  });
});
