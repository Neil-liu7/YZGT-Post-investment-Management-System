import { describe, expect, it } from 'vitest';
import { deadlineRuleSchema, obligationSchema, type DeadlineRule } from '../../packages/contracts/src/index.js';
import { businessToday, calculate, dashboard, daysBetween, generateOccurrences, isoWeek, reminderStage } from '../../packages/domain/src/index.js';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } as const;
const base = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '合成期限' } as const;
const calendar = { id: 'cn', version: 1, confirmed: true, start_on: '2026-01-01', end_on: '2028-12-31', overrides: {} as Record<string, boolean> };
const workConvention = { ...convention, calendar_id: 'cn', calendar_version: 1 };
const event = (date: string | null, id = 'signed') => ({ id, occurred_on: date, version: 1 });
const relative = (amount: number, unit: 'calendar_day'|'business_day'|'calendar_month'|'calendar_year', include_start_day = false): Extract<DeadlineRule, { kind: 'relative' }> => ({ ...base, kind: 'relative', anchor: { type: 'event', event_id: 'signed' }, offsets: [{ amount, unit, include_start_day }], convention: unit === 'business_day' ? workConvention : convention });

describe('deterministic contract deadline examples', () => {
  it('F01 anchors three natural months to signing rather than investment', () => {
    expect(calculate(relative(3, 'calendar_month'), { events: [event('2026-08-07'), event('2026-10-20', 'investment')], calendars: [] }).computed_due_on).toBe('2026-11-07');
  });
  it('F02 counts ten days excluding start', () => {
    expect(calculate(relative(10, 'calendar_day'), { events: [event('2026-11-11')], calendars: [] }).computed_due_on).toBe('2026-11-21');
  });
  it('F03 never promotes an unconfirmed calendar estimate into an effective deadline', () => {
    const result = calculate(relative(5, 'business_day'), { events: [event('2026-11-06')], calendars: [{ ...calendar, confirmed: false }] });
    expect(result.state).toBe('needs_review');
    expect(result.computed_due_on).toBeNull();
    expect(result.estimated_due_on).toBe('2026-11-13');
  });
  it.each([
    [{}, '2026-11-13'],
    [{ '2026-11-07': true, '2026-11-11': false }, '2026-11-13'],
    [{ '2026-11-07': true }, '2026-11-12'],
    [{ '2026-11-11': false }, '2026-11-16'],
  ])('F04 respects workday overrides %j', (overrides, due) => {
    const result = calculate(relative(5, 'business_day'), { events: [event('2026-11-06')], calendars: [{ ...calendar, overrides }] });
    expect(result.computed_due_on).toBe(due);
    for (const [date, is_workday] of Object.entries(overrides)) {
      expect(result.steps).toContainEqual(expect.objectContaining({ type: 'calendar_day', date, is_workday }));
    }
    expect(result.dependency_versions.calendars).toEqual({ cn: 1 });
  });
  it('F05 executes offsets independently and in sequence', () => {
    const rule: DeadlineRule = { ...relative(30, 'calendar_day'), offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }, { amount: 5, unit: 'business_day', include_start_day: false }], convention: workConvention };
    const result = calculate(rule, { events: [event('2026-11-01')], calendars: [calendar] });
    expect(result.computed_due_on).toBe('2026-12-08');
    expect(result.steps).toContainEqual(expect.objectContaining({ type: 'offset', to: '2026-12-01' }));
  });
  it.each([['earliest', '2026-11-15'], ['latest', '2026-11-25']] as const)('F06 %s waits for every event', (type, due) => {
    const rule: DeadlineRule = { ...relative(5, 'calendar_day'), anchor: { type, anchors: [{ type: 'event', event_id: 'signed' }, { type: 'event', event_id: 'closed' }] } };
    expect(calculate(rule, { events: [event('2026-11-10'), event('2026-11-20', 'closed')], calendars: [] }).computed_due_on).toBe(due);
    const pending = calculate(rule, { events: [event('2026-11-10')], calendars: [] });
    expect(pending.state).toBe('waiting_event');
    expect(pending.computed_due_on).toBeNull();
    expect(pending.missing_inputs).toContain('event:closed');
  });
  it.each([['2027-01-31', '2027-02-28'], ['2028-01-31', '2028-02-29']])('F07 clamps %s to target month end', (start, due) => {
    expect(calculate(relative(1, 'calendar_month'), { events: [event(start)], calendars: [] }).computed_due_on).toBe(due);
  });
  it('F08 yields stable independent quarterly occurrence keys and period-start activation', () => {
    const rule: DeadlineRule = { ...base, kind: 'recurring', frequency: 'quarter', first_period_start: '2026-07-01', last_period_end: null, anchor: 'period_end', offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }], convention };
    const result = generateOccurrences(rule, { events: [], calendars: [] }, '2026-12-31');
    expect(result.map(x => [x.occurrence_key, x.activated_on, x.computed_due_on])).toEqual([['2026-Q3', '2026-07-01', '2026-10-30'], ['2026-Q4', '2026-10-01', '2027-01-30']]);
    expect(generateOccurrences(rule, { events: [], calendars: [] }, '2026-12-31')).toEqual(result);
  });
  it('F09 preserves fixed deadline through unrelated event changes', () => {
    const rule: DeadlineRule = { ...base, kind: 'fixed', date: '2029-12-31', convention };
    const result = calculate(rule, { events: [event('2030-01-01')], calendars: [] });
    expect(result.computed_due_on).toBe('2029-12-31');
    expect(result.dependency_versions.events).toEqual({});
  });
  it('F10 selects the current narrowest reminder stage', () => {
    expect([31, 30, 7, 1, 0, -1].map(x => reminderStage(x))).toEqual([null, 'T30', 'T7', 'T1', 'DUE', 'OVERDUE']);
    expect(reminderStage(15, 7)).toBeNull();
    expect(reminderStage(6, 15)).toBe('T7');
  });
  it('F11 uses Shanghai midnight and never calls due-today overdue', () => {
    expect(businessToday(new Date('2026-11-11T15:59:59Z'))).toBe('2026-11-11');
    expect(businessToday(new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-12');
    expect(daysBetween('2026-11-11', '2026-11-11')).toBe(0);
    expect(daysBetween('2026-11-11', '2026-11-12')).toBe(1);
  });
  it.each([['2026-11-06', '2026-11-12'], ['2026-11-07', '2026-11-13']])('F15 includes start only when %s is a workday', (start, due) => {
    expect(calculate(relative(5, 'business_day', true), { events: [event(start)], calendars: [calendar] }).computed_due_on).toBe(due);
  });
  it('F16 preserves negative offsets and month clamping', () => {
    expect(calculate(relative(-6, 'calendar_month'), { events: [event('2026-12-31')], calendars: [] }).computed_due_on).toBe('2026-06-30');
    expect(calculate(relative(-5, 'business_day', true), { events: [event('2026-11-13')], calendars: [calendar] }).computed_due_on).toBe('2026-11-09');
  });
});

describe('incomplete inputs, intervals and boundaries', () => {
  it('does not compute unreviewed rules or fabricate missing event dates', () => {
    expect(calculate({ ...relative(1, 'calendar_day'), confirmation_status: 'needs_review' }, { events: [event('2026-11-01')], calendars: [] }).state).toBe('needs_review');
    expect(calculate(relative(1, 'calendar_day'), { events: [event(null)], calendars: [] }).state).toBe('waiting_event');
  });
  it('marks dates outside a confirmed calendar as estimates', () => {
    const result = calculate(relative(5, 'business_day'), { events: [event('2026-11-06')], calendars: [{ ...calendar, end_on: '2026-11-10' }] });
    expect(result.state).toBe('needs_review');
    expect(result.computed_due_on).toBeNull();
    expect(result.estimated_due_on).toBe('2026-11-13');
  });
  it('collects every missing comparison event and preserves known dependency versions', () => {
    const rule: DeadlineRule = { ...relative(5, 'calendar_day'), anchor: { type: 'latest', anchors: [{ type: 'event', event_id: 'signed' }, { type: 'event', event_id: 'closed' }, { type: 'event', event_id: 'registered' }] } };
    const result = calculate(rule, { events: [{ ...event('2026-11-10'), version: 3 }], calendars: [] });
    expect(result.state).toBe('waiting_event');
    expect(result.missing_inputs).toEqual(['event:closed', 'event:registered']);
    expect(result.dependency_versions.events).toEqual({ signed: 3 });
    expect(result.computed_due_on).toBeNull();
  });
  it('refuses a known event from a different project', () => {
    const result = calculate(relative(5, 'calendar_day'), { project_id: 'p1', events: [{ ...event('2026-11-10'), project_id: 'p2' }], calendars: [] });
    expect(result.state).toBe('needs_review');
    expect(result.computed_due_on).toBeNull();
    expect(result.missing_inputs).toContain('event_project:signed');
  });
  it('does not substitute a different calendar version for the referenced version', () => {
    const result = calculate(relative(5, 'business_day'), { events: [event('2026-11-06')], calendars: [{ ...calendar, version: 2 }] });
    expect(result.state).toBe('needs_review');
    expect(result.computed_due_on).toBeNull();
    expect(result.missing_inputs).toContain('calendar:cn@1');
    expect(result.estimated_due_on).toBe('2026-11-13');
  });
  it('applies end-day adjustment after all offsets', () => {
    const result = calculate({ ...relative(1, 'calendar_day'), convention: { ...workConvention, end_day_adjustment: 'next_workday' } }, { events: [event('2026-11-06')], calendars: [calendar] });
    expect(result.computed_due_on).toBe('2026-11-09');
    expect(result.steps).toContainEqual(expect.objectContaining({ type: 'adjustment', from: '2026-11-07', to: '2026-11-09' }));
  });
  it('continuous commitment returns its interval without inventing a final delivery', () => {
    const result = calculate({ ...base, kind: 'continuous', starts_at: { type: 'event', event_id: 'signed' }, ends_at: { type: 'relative', anchor: { type: 'event', event_id: 'signed' }, offsets: [{ amount: 10, unit: 'calendar_year', include_start_day: false }], convention }, review_mode: 'manual' }, { events: [event('2026-11-11')], calendars: [] });
    expect(result.computed_due_on).toBeNull();
    expect(result.interval).toEqual({ start_on: '2026-11-11', end_on: '2036-11-11' });
    expect(result.state).toBe('calculated');
  });
  it('uses ISO week year across New Year', () => {
    expect(isoWeek('2021-01-01')).toBe('2020-W53');
    expect(isoWeek('2026-11-11')).toBe('2026-W46');
  });
  it('dashboard excludes future periods, deleted, cancelled and archived tasks', () => {
    const tasks = [
      { status: 'done', activated_on: '2026-01-01', effective_due_on: '2026-11-01', deadline_state: 'calculated' },
      { status: 'pending', activated_on: '2026-01-01', effective_due_on: '2026-11-11', deadline_state: 'calculated' },
      { status: 'doing', activated_on: '2026-01-01', effective_due_on: '2026-11-10', deadline_state: 'manual' },
      { status: 'pending', activated_on: '2026-01-01', effective_due_on: null, deadline_state: 'waiting_event' },
      { status: 'pending', activated_on: '2027-01-01', effective_due_on: '2027-01-30' },
      { status: 'cancelled' }, { status: 'pending', deleted_at: '2026-11-01' }, { status: 'pending', project_archived: true },
    ];
    expect(dashboard(tasks, '2026-11-11')).toMatchObject({ total: 4, done: 1, pending: 2, doing: 1, due_soon: 1, overdue: 1, undetermined: 1, completion_rate: 25 });
    expect(dashboard([], '2026-11-11')).toMatchObject({ total: 0, completion_rate: 0 });
  });
});

describe('shared schema rejects ambiguous or malformed deadline contracts', () => {
  it('rejects impossible dates and noninteger offsets', () => {
    expect(deadlineRuleSchema.safeParse({ ...base, kind: 'fixed', date: '2026-02-30', convention }).success).toBe(false);
    expect(deadlineRuleSchema.safeParse(relative(0.5, 'calendar_day')).success).toBe(false);
    expect(deadlineRuleSchema.safeParse(relative(1, 'calendar_month', true)).success).toBe(false);
    expect(deadlineRuleSchema.safeParse(relative(0, 'calendar_day', true)).success).toBe(false);
  });
  it('requires natural period boundaries', () => {
    const rule = { ...base, kind: 'recurring', frequency: 'quarter', first_period_start: '2026-07-02', last_period_end: null, anchor: 'period_end', offsets: [], convention };
    expect(deadlineRuleSchema.safeParse(rule).success).toBe(false);
    expect(deadlineRuleSchema.safeParse({ ...rule, first_period_start: '2026-07-01', last_period_end: '2026-12-30' }).success).toBe(false);
  });
  it('limits comparisons to depth four and at least two branches', () => {
    let anchor: unknown = { type: 'event', event_id: 'signed' };
    for (let i = 0; i < 4; i++) anchor = { type: 'earliest', anchors: [anchor, { type: 'event', event_id: 'signed' }] };
    expect(deadlineRuleSchema.safeParse({ ...relative(1, 'calendar_day'), anchor }).success).toBe(false);
    expect(deadlineRuleSchema.safeParse({ ...relative(1, 'calendar_day'), anchor: { type: 'earliest', anchors: [{ type: 'event', event_id: 'signed' }] } }).success).toBe(false);
  });
  it('validates source requirements without inventing a document for manual entry', () => {
    const obligation = { title: '报送资料', description: '', owner_label: '张三', obligor: '目标公司', source_type: 'manual', source_description: '人工记录的会议安排', rule: relative(1, 'calendar_day') };
    expect(obligationSchema.safeParse(obligation).success).toBe(true);
    expect(obligationSchema.safeParse({ ...obligation, source_description: '' }).success).toBe(false);
    expect(obligationSchema.safeParse({ ...obligation, source_type: 'ai', source_description: '' }).success).toBe(false);
    expect(obligationSchema.safeParse({ ...obligation, source_type: 'ai', document_version_id: 'v1', source_text: '协议原文' }).success).toBe(true);
  });
});
