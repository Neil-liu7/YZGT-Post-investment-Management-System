import { expect, it } from 'vitest';
import { Store } from '../../apps/server/src/store';
import { Business } from '../../apps/server/src/business';
import { deadlineRuleSchema, type DeadlineRule } from '../../packages/contracts/src/index';

const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } as const;
const base = { schema_version: 1, confirmation_status: 'confirmed', original_expression: '合成安全回归' } as const;

it('completed and cancelled tasks reject manual changes and clearing overrides while preserving their historical deadline snapshots', () => {
  const store = new Store(':memory:', () => new Date('2026-11-11T02:00:00Z'));
  try {
    const business = new Business(store); const project = store.create('projects', { name: '合成历史期限' });
    for (const status of ['done', 'cancelled']) {
      const obligation = business.createObligation(project.id, { title: `合成 ${status}`, source_type: 'manual', source_description: '合成测试', rule: { ...base, kind: 'fixed', date: '2026-11-18', convention } });
      let task = obligation.tasks[0]; const manual = business.preview({ operation: 'manual_due', entity_id: task.id, version: task.version, changes: { manual_due_on: '2026-12-01' }, reason: '结束前已确认人工日期' }); business.commit(manual.id); task = store.require('tasks', task.id);
      task = business.transition(task.id, task.version, status === 'done' ? 'complete' : 'cancel', { reason: '合成结束操作' });
      const plansBefore = store.all('change_plans').length;
      for (const operation of ['manual_due', 'clear_manual']) expect(() => business.preview({ operation, entity_id: task.id, version: task.version, changes: operation === 'manual_due' ? { manual_due_on: '2027-01-01' } : {}, reason: '不得改写已结束快照' })).toThrow();
      expect(store.require('tasks', task.id)).toEqual(task); expect(store.all('change_plans')).toHaveLength(plansBefore);
    }
  } finally { store.close(); }
});

it('continuous rules validate nested calendar references and require an explicit boundary rule change for calendar replacement', () => {
  const store = new Store(':memory:', () => new Date('2026-11-11T02:00:00Z'));
  try {
    const business = new Business(store); const project = store.create('projects', { name: '合成持续承诺' });
    const event = store.create('events', { project_id: project.id, name: '收到材料', occurred_on: '2026-11-06' });
    const calendar = store.create('calendars', { confirmed: true, calendar_version: 1, start_on: '2026-01-01', end_on: '2028-12-31', overrides: {} });
    const boundary = { type: 'relative', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention: { ...convention, calendar_id: calendar.id, calendar_version: 1 } } as const;
    const rule: DeadlineRule = { ...base, kind: 'continuous', starts_at: { ...boundary, offsets: [...boundary.offsets] }, ends_at: null, review_mode: 'manual' };
    const obligation = business.createObligation(project.id, { title: '持续承诺', source_type: 'manual', source_description: '合成测试', rule });
    expect(() => business.validateRule(project.id, { ...rule, starts_at: { ...boundary, convention: { ...boundary.convention, calendar_id: 'missing-calendar' } } })).toThrow();
    expect(() => business.validateRule(project.id, { ...rule, ends_at: { ...boundary, convention: { ...boundary.convention, calendar_version: 2 } } })).toThrow();
    expect(() => business.preview({ operation: 'calendar', entity_id: obligation.id, version: obligation.version, changes: { calendar_id: calendar.id, calendar_version: 1 }, reason: '应使用区间边界规则变更' })).toThrow(/持续|规则变更/);
    expect(deadlineRuleSchema.safeParse(store.require('obligations', obligation.id).rule).success).toBe(true);
    expect(store.require('tasks', obligation.tasks[0].id).calculation.interval.start_on).toBe('2026-11-13');
    expect(store.all('change_plans')).toHaveLength(0);
  } finally { store.close(); }
});
