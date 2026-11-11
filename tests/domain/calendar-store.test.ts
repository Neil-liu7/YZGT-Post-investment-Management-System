import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../apps/server/src/store.js';
import { Business } from '../../apps/server/src/business.js';
import { calculate } from '../../packages/domain/src/index.js';
import type { DeadlineRule } from '../../packages/contracts/src/index.js';

describe('calendar semantic version at the persistence boundary', () => {
  it('confirmation increments the row version without invalidating a rule referencing calendar version one', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-domain-calendar-'));
    const store = new Store(join(root, 'test.sqlite'), () => new Date('2026-11-11T02:00:00Z'));
    try {
      const calendar = store.create('calendars', { id: 'test-calendar', calendar_version: 1, confirmed: false, start_on: '2026-01-01', end_on: '2027-12-31', overrides: {} });
      store.update('calendars', calendar.id, calendar.version, { confirmed: true });
      store.create('events', { id: 'received', occurred_on: '2026-11-06' });
      const rule: DeadlineRule = { schema_version: 1, kind: 'relative', confirmation_status: 'confirmed', original_expression: '收到后五个工作日', anchor: { type: 'event', event_id: 'received' }, offsets: [{ amount: 5, unit: 'business_day', include_start_day: false }], convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: calendar.id, calendar_version: 1 } };
      const result = calculate(rule, new Business(store).context());
      expect(store.require('calendars', calendar.id).version).toBe(2);
      expect(result.state).toBe('calculated');
      expect(result.computed_due_on).toBe('2026-11-13');
      expect(result.dependency_versions.calendars).toEqual({ 'test-calendar': 1 });
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('F19 reopen recalculates current dependencies and retains historical snapshots', () => {
  it.each([false, true])('preserves completed history and manual override=%s', (manual) => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-domain-reopen-'));
    const store = new Store(join(root, 'test.sqlite'), () => new Date('2026-11-11T02:00:00Z'));
    try {
      const business = new Business(store);
      const project = store.create('projects', { name: 'F19 合成项目', company: '合成公司' });
      const event = store.create('events', { project_id: project.id, name: '协议签署', occurred_on: '2026-08-07' });
      const rule: DeadlineRule = { schema_version: 1, kind: 'relative', confirmation_status: 'confirmed', original_expression: '签署后三个月', anchor: { type: 'event', event_id: event.id }, offsets: [{ amount: 3, unit: 'calendar_month', include_start_day: false }], convention: { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null } };
      const obligation = business.createObligation(project.id, { title: 'F19 事项', source_type: 'manual', source_description: '合成测试', rule });
      let task = obligation.tasks[0];
      expect(task.effective_due_on).toBe('2026-11-07');
      if (manual) {
        const plan = business.preview({ operation: 'manual_due', entity_id: task.id, version: task.version, changes: { manual_due_on: '2026-12-31' }, reason: '人工协商改期' });
        business.commit(plan.id);
        task = store.require('tasks', task.id);
      }
      const revision = task.schedule_revision;
      task = business.transition(task.id, task.version, 'complete', {});
      const change = business.preview({ operation: 'event', entity_id: event.id, version: event.version, changes: { occurred_on: '2026-08-17' }, reason: '根据签署证明修正' });
      business.commit(change.id);
      expect(store.require('tasks', task.id).computed_due_on).toBe('2026-11-07');
      task = business.transition(task.id, task.version, 'reopen', { reason: '补充履约' });
      expect(task.computed_due_on).toBe('2026-11-17');
      expect(task.effective_due_on).toBe(manual ? '2026-12-31' : '2026-11-17');
      expect(task.schedule_revision).toBe(revision + (manual ? 0 : 1));
      const completedEvidence = store.all('evidence', { task_id: task.id }).find(item => item.action === 'complete');
      expect(completedEvidence.snapshot.computed_due_on).toBe('2026-11-07');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
