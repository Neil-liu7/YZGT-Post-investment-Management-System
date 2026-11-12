import { describe, expect, it } from 'vitest';
import { candidateReferences, draftIssue, requiredEventDrafts, reviewEvents, ruleSummary } from '../../apps/web/src/jointReviewData';
import type { Entity } from '../../apps/web/src/api';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
const event = (key: string, status = 'draft'): Entity => ({ id: `draft-${key}`, version: 1, candidate_key: key, name: `候选${key}`, occurred_on: null, review_state: status });
const anchor = (key: string) => ({ type: 'event', event_id: `candidate-event:${key}` });
const relative = (key = 'signing') => ({ schema_version: 1, confirmation_status: 'needs_review', original_expression: '签署后3个月', kind: 'relative', anchor: anchor(key), offsets: [{ amount: 3, unit: 'calendar_month', include_start_day: false }], convention });
const draft = (rule: unknown): Entity => ({ id: 'obligation-draft', version: 1, rule });

describe('joint review selection and readable rules', () => {
  it('finds nested comparison and continuous boundary candidate references once', () => {
    const rule = { kind: 'continuous', starts_at: { type: 'earliest', anchors: [anchor('signing'), anchor('closing')] }, ends_at: { type: 'relative', anchor: anchor('signing'), offsets: [] } };
    expect(candidateReferences(rule)).toEqual(['signing', 'closing']);
    expect(candidateReferences({ kind: 'relative', anchor: { type: 'event', event_id: 'formal-event' } })).toEqual([]);
  });
  it('allows a structurally complete rule referencing a date-unknown candidate', () => {
    expect(draftIssue(draft(relative()), [event('signing')])).toBeNull();
  });
  it('keeps a missing first period incomplete instead of choosing a date', () => {
    const rule = { schema_version: 1, confirmation_status: 'needs_review', original_expression: '每季度结束后30日', kind: 'recurring', first_period_start: null, last_period_end: null, frequency: 'quarter', anchor: 'period_end', offsets: [], convention };
    expect(draftIssue(draft(rule), [])).toContain('首个周期开始日待补充');
    expect(ruleSummary(rule, [])).toContain('首个周期待补充');
    expect(rule.first_period_start).toBeNull();
  });
  it('rejects missing or ignored dependencies without silently restoring them', () => {
    expect(draftIssue(draft(relative()), [])).toContain('未找到');
    expect(draftIssue(draft(relative()), [event('signing', 'ignored')])).toContain('已忽略');
    expect(requiredEventDrafts([draft(relative())], [event('signing', 'ignored')])).toEqual([]);
  });
  it('includes already confirmed dependencies for explicit reuse and no unrelated event', () => {
    const signing = event('signing', 'approved'), closing = event('closing');
    expect(requiredEventDrafts([draft(relative())], [signing, closing])).toEqual([signing]);
  });
  it('uses the existing event date when a candidate explicitly reuses it', () => {
    const candidate = { ...event('signing'), occurred_on: '2026-08-07', reuse_event_id: 'existing' };
    const options = reviewEvents([candidate], [{ id: 'existing', version: 3, name: '实际签署', occurred_on: null }]);
    expect(options.find(item => item.id === 'candidate-event:signing')?.occurred_on).toBeNull();
    expect(candidate.occurred_on).toBe('2026-08-07');
  });
  it('shows event names and true units for relative and continuous rules', () => {
    const options = reviewEvents([event('signing')], []);
    expect(ruleSummary(relative(), options)).toContain('候选signing（候选）后 3 个自然月');
    const continuous = { kind: 'continuous', starts_at: anchor('signing'), ends_at: { type: 'relative', anchor: anchor('signing'), offsets: [{ amount: 10, unit: 'calendar_year', include_start_day: false }] } };
    expect(ruleSummary(continuous, options)).toContain('后 10 个自然年');
    expect(ruleSummary(continuous, options)).not.toContain('无固定终止条件');
  });
  it('does not consider a null or invalid rule ready for import', () => {
    expect(draftIssue(draft(null), [])).toContain('尚未识别');
    expect(draftIssue(draft({ ...relative(), offsets: [{ amount: 1.5, unit: 'calendar_month', include_start_day: false }] }), [event('signing')])).toContain('不完整');
  });
});
