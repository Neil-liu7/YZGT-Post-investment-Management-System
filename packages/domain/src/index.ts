import { deadlineRuleSchema, isBusinessDate, type Anchor, type DateBoundary, type DateConvention, type DeadlineRule, type Offset } from '../../contracts/src/index.js';

export type CalendarInput = { id: string; version: number; confirmed: boolean; start_on: string; end_on: string; overrides: Record<string, boolean> };
export type EventInput = { id: string; occurred_on: string|null; version: number; project_id?: string };
export type CalculationContext = { events: EventInput[]; calendars: CalendarInput[]; today?: string; project_id?: string };
export type CalculationStep = { type: string; detail: string; from?: string; to?: string; date?: string; is_workday?: boolean };
export type Calculation = {
  state: 'calculated'|'waiting_event'|'needs_review'; computed_due_on: string|null; estimated_due_on?: string|null;
  steps: CalculationStep[]; missing_inputs: string[];
  dependency_versions: { events: Record<string, number>; calendars: Record<string, number> };
  interval?: { start_on: string|null; end_on: string|null };
};
export type Occurrence = Calculation & { occurrence_key: string; activated_on: string };

const DAY = 86_400_000;
function dateValue(value: string): Date {
  if (!isBusinessDate(value)) throw new RangeError(`无效业务日期: ${value}`);
  return new Date(`${value}T00:00:00Z`);
}
function dateString(value: Date): string {
  const year = value.getUTCFullYear();
  if (!Number.isFinite(value.getTime()) || year < 1 || year > 9999) throw new RangeError('日期超出公历 0001–9999 范围');
  return value.toISOString().slice(0, 10);
}
function addDays(value: string, amount: number): string {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateString(date);
}
function addMonths(value: string, amount: number): string {
  const date = dateValue(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const month = date.getUTCMonth();
  date.setUTCDate(day);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return dateString(date);
}

export function businessToday(date: Date|string = new Date()): string {
  const instant = typeof date === 'string' ? new Date(date) : date;
  if (!Number.isFinite(instant.getTime())) throw new RangeError('无效时间点');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}
/** Signed natural-day distance from a to b; both inputs remain pure dates. */
export function daysBetween(a: string, b: string): number { return Math.round((dateValue(b).getTime() - dateValue(a).getTime()) / DAY); }

type Evaluation = { result: Calculation; context: CalculationContext; waiting: Set<string>; review: Set<string> };
function evaluateAnchor(anchor: Anchor, evaluation: Evaluation): string|null {
  if (anchor.type === 'event') {
    const event = evaluation.context.events.find(item => item.id === anchor.event_id);
    if (event) evaluation.result.dependency_versions.events[event.id] = event.version;
    if (!event || !event.occurred_on) { evaluation.waiting.add(`event:${anchor.event_id}`); return null; }
    if (evaluation.context.project_id && event.project_id && event.project_id !== evaluation.context.project_id) {
      evaluation.review.add(`event_project:${anchor.event_id}`); return null;
    }
    if (!isBusinessDate(event.occurred_on)) { evaluation.review.add(`event_date:${event.id}`); return null; }
    evaluation.result.steps.push({ type: 'anchor', to: event.occurred_on, detail: `事件 ${event.id} v${event.version}` });
    return event.occurred_on;
  }
  const dates = anchor.anchors.map(item => evaluateAnchor(item, evaluation));
  if (dates.some(date => date === null)) return null;
  const sorted = (dates as string[]).sort();
  const selected = anchor.type === 'earliest' ? sorted[0] : sorted[sorted.length - 1];
  evaluation.result.steps.push({ type: 'comparison', to: selected, detail: `${anchor.type}: ${sorted.join(', ')}` });
  return selected;
}
function workday(date: string, convention: DateConvention, evaluation: Evaluation): boolean {
  const calendar = evaluation.context.calendars.find(item => item.id === convention.calendar_id && item.version === convention.calendar_version);
  if (!calendar) evaluation.review.add(`calendar:${convention.calendar_id ?? 'unconfigured'}@${convention.calendar_version ?? 'unconfigured'}`);
  else {
    evaluation.result.dependency_versions.calendars[calendar.id] = calendar.version;
    if (!calendar.confirmed) evaluation.review.add(`calendar_unconfirmed:${calendar.id}@${calendar.version}`);
    if (date < calendar.start_on || date > calendar.end_on) evaluation.review.add(`calendar_coverage:${calendar.id}:${date}`);
  }
  const weekday = dateValue(date).getUTCDay();
  const inCoverage = calendar && date >= calendar.start_on && date <= calendar.end_on;
  const isWorkday = inCoverage && Object.hasOwn(calendar.overrides, date) ? calendar.overrides[date] : weekday !== 0 && weekday !== 6;
  evaluation.result.steps.push({ type: 'calendar_day', date, is_workday: isWorkday, detail: `${date} ${isWorkday ? '工作' : '休息'}${calendar ? `，日历 ${calendar.id} v${calendar.version}` : '，仅排周末预估'}` });
  return isWorkday;
}
function applyOffsets(anchor: string, offsets: Offset[], convention: DateConvention, evaluation: Evaluation): string {
  let current = anchor;
  for (const offset of offsets) {
    const from = current;
    const direction = Math.sign(offset.amount);
    if (offset.unit === 'calendar_month') current = addMonths(current, offset.amount);
    else if (offset.unit === 'calendar_year') current = addMonths(current, offset.amount * 12);
    else if (offset.unit === 'calendar_day') {
      const count = Math.abs(offset.amount) - (offset.include_start_day && offset.amount !== 0 ? 1 : 0);
      current = addDays(current, direction * count);
    } else if (offset.amount !== 0) {
      let remaining = Math.abs(offset.amount);
      if (offset.include_start_day && workday(current, convention, evaluation)) remaining--;
      let visits = 0;
      while (remaining > 0) {
        if (++visits > 100000) throw new RangeError('工作日计算范围超限');
        current = addDays(current, direction);
        if (workday(current, convention, evaluation)) remaining--;
      }
    }
    evaluation.result.steps.push({ type: 'offset', from, to: current, detail: `${offset.amount} ${offset.unit}，${offset.include_start_day ? '计入' : '不计'}起算日` });
  }
  if (convention.end_day_adjustment !== 'none') {
    const from = current;
    const direction = convention.end_day_adjustment === 'next_workday' ? 1 : -1;
    let visits = 0;
    while (!workday(current, convention, evaluation)) {
      if (++visits > 100000) throw new RangeError('工作日顺延范围超限');
      current = addDays(current, direction);
    }
    evaluation.result.steps.push({ type: 'adjustment', from, to: current, detail: convention.end_day_adjustment });
  }
  return current;
}
function evaluateBoundary(boundary: DateBoundary, evaluation: Evaluation): string|null {
  if (boundary.type === 'date') return boundary.date;
  if (boundary.type === 'relative') {
    const anchor = evaluateAnchor(boundary.anchor, evaluation);
    return anchor ? applyOffsets(anchor, boundary.offsets, boundary.convention, evaluation) : null;
  }
  return evaluateAnchor(boundary, evaluation);
}
function calculateInternal(rule: DeadlineRule, context: CalculationContext, periodAnchor?: string): Calculation {
  const result: Calculation = { state: 'calculated', computed_due_on: null, steps: [], missing_inputs: [], dependency_versions: { events: {}, calendars: {} } };
  const evaluation: Evaluation = { result, context, waiting: new Set(), review: new Set() };
  if (!deadlineRuleSchema.safeParse(rule).success) return { ...result, state: 'needs_review', missing_inputs: ['invalid_rule'] };
  if (rule.confirmation_status !== 'confirmed') return { ...result, state: 'needs_review', missing_inputs: ['rule_confirmation'] };
  let due: string|null = null;
  try {
    if (rule.kind === 'fixed') due = applyOffsets(rule.date, [], rule.convention, evaluation);
    else if (rule.kind === 'relative') {
      const anchor = evaluateAnchor(rule.anchor, evaluation);
      if (anchor) due = applyOffsets(anchor, rule.offsets, rule.convention, evaluation);
    } else if (rule.kind === 'recurring') {
      if (!periodAnchor) evaluation.review.add('occurrence_context');
      else due = applyOffsets(periodAnchor, rule.offsets, rule.convention, evaluation);
    } else {
      const start = evaluateBoundary(rule.starts_at, evaluation);
      const end = rule.ends_at ? evaluateBoundary(rule.ends_at, evaluation) : null;
      result.interval = { start_on: start, end_on: end };
      if (start && end && start > end) evaluation.review.add('interval_end_before_start');
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    evaluation.review.add('date_range_exceeded');
  }
  result.state = evaluation.waiting.size ? 'waiting_event' : evaluation.review.size ? 'needs_review' : 'calculated';
  result.missing_inputs = [...evaluation.waiting, ...evaluation.review];
  if (result.state === 'calculated') result.computed_due_on = due;
  else if (due && result.state === 'needs_review') result.estimated_due_on = due;
  return result;
}

export function calculate(rule: DeadlineRule, context: CalculationContext): Calculation { return calculateInternal(rule, context); }

/** Pure generation: persistence enforces the (obligation_id, occurrence_key) unique key. */
export function generateOccurrences(rule: DeadlineRule, context: CalculationContext, windowEnd?: string): Occurrence[] {
  const today = context.today ?? businessToday();
  if (rule.kind !== 'recurring') return [{ occurrence_key: 'once', activated_on: today, ...calculate(rule, context) }];
  if (!deadlineRuleSchema.safeParse(rule).success) return [];
  const until = windowEnd ?? addMonths(today, 12);
  dateValue(until);
  const months = rule.frequency === 'month' ? 1 : rule.frequency === 'quarter' ? 3 : 12;
  const result: Occurrence[] = [];
  for (let index = 0; index < 120000; index++) {
    // Every start is derived from the original first period, so clamping cannot drift.
    const start = addMonths(rule.first_period_start, index * months);
    if (start > until || (rule.last_period_end && start > rule.last_period_end)) break;
    const end = addDays(addMonths(start, months), -1);
    const key = rule.frequency === 'month' ? start.slice(0, 7) : rule.frequency === 'year' ? start.slice(0, 4) : `${start.slice(0, 4)}-Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1}`;
    result.push({ occurrence_key: key, activated_on: start, ...calculateInternal(rule, context, rule.anchor === 'period_start' ? start : end) });
  }
  return result;
}

export function reminderStage(remaining: number, lead = 30): string|null {
  if (!Number.isInteger(remaining) || !Number.isInteger(lead) || lead < 1 || lead > 90) throw new RangeError('提醒天数须为整数，提前量为 1–90');
  if (remaining < 0) return 'OVERDUE';
  if (remaining === 0) return 'DUE';
  const stages = [...new Set([lead, 7, 1])].filter(stage => stage <= lead).sort((a, b) => a - b);
  const stage = stages.find(value => remaining <= value);
  return stage === undefined ? null : `T${stage}`;
}

export function isoWeek(date: string): string {
  const value = dateValue(date);
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - weekday);
  const isoYear = value.getUTCFullYear();
  const yearStart = dateValue(`${String(isoYear).padStart(4, '0')}-01-01`);
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export type DashboardTask = { status: string; activated_on?: string|null; effective_due_on?: string|null; deadline_state?: string; deleted_at?: string|null; project_archived?: boolean|number; archived?: boolean|number };
export function dashboard(tasks: DashboardTask[], today: string): { total: number; pending: number; doing: number; done: number; due_soon: number; overdue: number; undetermined: number; completion_rate: number } {
  dateValue(today);
  const active = tasks.filter(task => !task.deleted_at && !task.project_archived && !task.archived && task.status !== 'cancelled' && (!task.activated_on || task.activated_on <= today));
  const done = active.filter(task => task.status === 'done').length;
  const open = active.filter(task => task.status === 'pending' || task.status === 'doing');
  const dated = open.filter(task => task.effective_due_on && (!task.deadline_state || ['calculated', 'manual'].includes(task.deadline_state)));
  return {
    total: active.length, pending: active.filter(task => task.status === 'pending').length, doing: active.filter(task => task.status === 'doing').length, done,
    due_soon: dated.filter(task => { const remaining = daysBetween(today, task.effective_due_on!); return remaining >= 0 && remaining <= 7; }).length,
    overdue: dated.filter(task => task.effective_due_on! < today).length,
    undetermined: open.length - dated.length,
    completion_rate: active.length ? Math.round(done * 10000 / active.length) / 100 : 0,
  };
}
