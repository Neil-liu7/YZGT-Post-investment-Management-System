import { useEffect, useRef, useState } from 'react';
import { allPages, message, post, type Entity } from './api';
import { deadlineRuleSchema, draftDeadlineRuleSchema, type Anchor, type DateBoundary, type DateConvention, type Offset } from '../../../packages/contracts/src/index';
import type { Calculation, Occurrence } from '../../../packages/domain/src/index';
import { Badge, Field } from './components';
import s from './Workspace.module.css';
import r from './RuleEditor.module.css';

export const defaultConvention: DateConvention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
export const blankRule = () => ({ schema_version: 1, confirmation_status: 'needs_review', original_expression: '', kind: 'fixed', date: '', convention: { ...defaultConvention } });
const blankAnchor = (): Anchor => ({ type: 'event', event_id: '' });
const blankOffset = (): Offset => ({ amount: 0, unit: 'calendar_day', include_start_day: false });
const units = { calendar_day: '自然日', business_day: '工作日', calendar_month: '自然月', calendar_year: '自然年' };
type Preview = Calculation & { occurrences?: Occurrence[] };

function firstEvent(anchor: Anchor): Anchor { return anchor.type === 'event' ? anchor : firstEvent(anchor.anchors[0] ?? blankAnchor()); }
function changeAnchorType(anchor: Anchor, type: Anchor['type']): Anchor {
  if (type === 'event') return firstEvent(anchor);
  return { type, anchors: anchor.type === 'event' ? [anchor, blankAnchor()] : anchor.anchors };
}

function AnchorEditor({ value, onChange, events, label = '起算', depth = 1, showType = true }: { value: Anchor; onChange: (value: Anchor) => void; events: Entity[]; label?: string; depth?: number; showType?: boolean }) {
  const missingEvent = value.type === 'event' && value.event_id && !events.some(event => event.id === value.event_id);
  return <fieldset className={r.anchor} aria-label={`${label}条件编辑`}>
    {showType && <Field label={`${label}方式`}><select value={value.type} onChange={event => onChange(changeAnchorType(value, event.target.value as Anchor['type']))}>
      <option value="event">单个事件日期</option><option value="earliest" disabled={depth >= 4}>多个日期孰早</option><option value="latest" disabled={depth >= 4}>多个日期孰晚</option>
    </select></Field>}
    {value.type === 'event' ? <Field label={`${label}事件`} hint="事件尚未发生时保留空日期，不把今天当作起算日。"><select required value={value.event_id} onChange={event => onChange({ type: 'event', event_id: event.target.value })}>
      <option value="">请选择本项目事件</option>{missingEvent && <option value={value.event_id}>原起算事件尚未关联（引用保留）</option>}{events.map(event => <option key={event.id} value={event.id}>{event.name} · {event.occurred_on ?? '日期待登记'}</option>)}
    </select></Field> : <>
      <p className={s.hint}>所有必要日期齐全后，取{value.type === 'earliest' ? '最早' : '最晚'}日期。每组至少保留两个条件。</p>
      {value.anchors.map((anchor, index) => <div className={r.condition} key={index}>
        <div className={r.conditionHeading}><strong>条件 {index + 1}</strong><button type="button" aria-label={`${label}移除条件${index + 1}`} disabled={value.anchors.length <= 2} onClick={() => onChange({ ...value, anchors: value.anchors.filter((_, position) => position !== index) })}>移除条件</button></div>
        <AnchorEditor value={anchor} events={events} label={`${label}条件${index + 1}`} depth={depth + 1} onChange={next => onChange({ ...value, anchors: value.anchors.map((item, position) => position === index ? next : item) })} />
      </div>)}
      <button type="button" aria-label={`${label}增加比较条件`} onClick={() => onChange({ ...value, anchors: [...value.anchors, blankAnchor()] })}>＋ 增加比较条件</button>
    </>}
    {missingEvent && <p className={s.hint}>请关联当前项目的具体事件后再确认生效。</p>}
  </fieldset>;
}

function OffsetsEditor({ value, onChange, prefix = '' }: { value: Offset[]; onChange: (value: Offset[]) => void; prefix?: string }) {
  function edit(index: number, changes: Partial<Offset>) {
    onChange(value.map((item, position) => {
      if (position !== index) return item;
      const next = { ...item, ...changes };
      if (!Number.isInteger(next.amount) || next.amount === 0 || !['calendar_day', 'business_day'].includes(next.unit)) next.include_start_day = false;
      return next;
    }));
  }
  return <fieldset className={s.offsets} aria-label={`${prefix}期限偏移步骤`}>
    <p className={s.hint}>按从上到下的顺序计算。正数表示之后，负数表示之前，0 表示该段不移动日期。</p>
    {!value.length && <p className={s.muted}>没有偏移步骤，使用起算日期。</p>}
    {value.map((offset, index) => <div key={index} className={s.offset}>
      <Field label={`${prefix}第 ${index + 1} 段偏移`}><input type="number" step="1" required value={Number.isFinite(offset.amount) ? offset.amount : ''} onChange={event => edit(index, { amount: event.target.value === '' ? NaN : Number(event.target.value) })} /></Field>
      <Field label="期限单位"><select aria-label={`${prefix}第 ${index + 1} 段期限单位`} value={offset.unit} onChange={event => edit(index, { unit: event.target.value as Offset['unit'] })}>{Object.entries(units).map(([unit, label]) => <option key={unit} value={unit}>{label}</option>)}</select></Field>
      <label className={s.checkbox}><input aria-label={`${prefix}第 ${index + 1} 段计入起算日`} type="checkbox" checked={offset.include_start_day} disabled={!Number.isInteger(offset.amount) || offset.amount === 0 || !['calendar_day', 'business_day'].includes(offset.unit)} onChange={event => edit(index, { include_start_day: event.target.checked })} />计入起算日</label>
      <button type="button" aria-label={`${prefix}移除偏移步骤${index + 1}`} onClick={() => onChange(value.filter((_, position) => position !== index))}>移除</button>
    </div>)}
    <button type="button" aria-label={`${prefix}增加偏移步骤`} onClick={() => onChange([...value, blankOffset()])}>＋ 增加偏移步骤</button>
  </fieldset>;
}

function ConventionEditor({ value, onChange, calendars, calendarLoading, prefix = '' }: { value: DateConvention; onChange: (value: DateConvention) => void; calendars: Entity[]; calendarLoading: boolean; prefix?: string }) {
  const key = value.calendar_id === null ? '' : `${value.calendar_id}@${value.calendar_version}`;
  const selected = calendars.find(calendar => `${calendar.id}@${calendar.calendar_version}` === key);
  const available = calendars.filter(calendar => calendar.confirmed);
  return <>
    <div className={s.grid2}><Field label={`${prefix}届满日调整`}><select value={value.end_day_adjustment} onChange={event => onChange({ ...value, end_day_adjustment: event.target.value as DateConvention['end_day_adjustment'] })}><option value="none">不自动顺延</option><option value="next_workday">顺延至下一工作日</option><option value="previous_workday">提前至上一工作日</option></select></Field><Field label={`${prefix}月末处理`}><input readOnly value="超出目标月份天数时取目标月末" /></Field></div>
    <Field label={`${prefix}工作日日历`} hint="选择已核对的日历版本。新增日历不会自动替换已有规则的引用。"><select disabled={calendarLoading} value={key} onChange={event => {
      const calendar = available.find(item => `${item.id}@${item.calendar_version}` === event.target.value);
      onChange({ ...value, calendar_id: calendar?.id ?? null, calendar_version: calendar?.calendar_version ?? null });
    }}>
      <option value="">不指定日历（工作日或顺延期限将待确认）</option>
      {key && !selected?.confirmed && <option value={key}>{calendarLoading ? '正在读取原日历引用…' : selected ? `${selected.name} · v${selected.calendar_version}（尚未确认）` : '原日历版本未找到（引用保留）'}</option>}
      {available.map(calendar => <option key={calendar.id} value={`${calendar.id}@${calendar.calendar_version}`}>{calendar.name} · v{calendar.calendar_version} · {calendar.start_on} 至 {calendar.end_on}</option>)}
    </select></Field>
    {selected && <p className={s.hint}>覆盖范围：{selected.start_on} 至 {selected.end_on}；来源：{selected.source}。{selected.confirmed ? '已确认。' : '尚未确认，不能作为正式工作日期限依据。'}</p>}
    {!calendarLoading && key && !selected && <p className={s.hint}>未找到原日历版本，当前引用已保留。请刷新日历列表，或明确选择其他已确认日历。</p>}
  </>;
}

function BoundaryEditor({ value, onChange, label, events, calendars, calendarLoading, optional = false }: { value: DateBoundary | null; onChange: (value: DateBoundary | null) => void; label: string; events: Entity[]; calendars: Entity[]; calendarLoading: boolean; optional?: boolean }) {
  function changeType(type: string) {
    if (type === 'none') { onChange(null); return; }
    if (type === 'date') { onChange(value?.type === 'date' ? value : { type: 'date', date: '' }); return; }
    const anchor = !value || value.type === 'date' ? blankAnchor() : value.type === 'relative' ? value.anchor : value;
    if (type === 'relative') onChange(value?.type === 'relative' ? value : { type: 'relative', anchor, offsets: [blankOffset()], convention: { ...defaultConvention } });
    else onChange(changeAnchorType(anchor, type as Anchor['type']));
  }
  return <fieldset className={r.boundary} aria-label={`${label}条件`}>
    <legend>{label === '区间开始' ? '履行区间开始' : '履行区间结束'}</legend>
    <Field label={`${label}类型`}><select value={value?.type ?? 'none'} onChange={event => changeType(event.target.value)}>
      {optional && <option value="none">无固定结束条件</option>}<option value="date">固定日期</option><option value="event">事件当日</option><option value="earliest">多个事件日期孰早</option><option value="latest">多个事件日期孰晚</option><option value="relative">事件前后计算</option>
    </select></Field>
    {value?.type === 'date' && <Field label={`${label}日期`}><input required type="date" value={value.date} onChange={event => onChange({ type: 'date', date: event.target.value })} /></Field>}
    {value?.type === 'relative' ? <>
      <AnchorEditor value={value.anchor} events={events} label={`${label}起算`} onChange={anchor => onChange({ ...value, anchor })} />
      <OffsetsEditor value={value.offsets} prefix={label} onChange={offsets => onChange({ ...value, offsets })} />
      <ConventionEditor value={value.convention} calendars={calendars} calendarLoading={calendarLoading} prefix={label} onChange={convention => onChange({ ...value, convention })} />
    </> : value && value.type !== 'date' && <AnchorEditor value={value} events={events} label={label} onChange={onChange} showType={false} />}
  </fieldset>;
}

function missingDescription(input: string, events: Entity[]) {
  if (input === 'rule_confirmation') return '规则尚未人工确认，请先核对原文及时间计算约定。';
  if (input.startsWith('event:')) return `请登记${events.find(event => event.id === input.slice(6))?.name ?? '必要起算事件'}的发生日期。`;
  if (input.startsWith('calendar_coverage:')) return '所选工作日日历未覆盖全部计算日期。';
  if (input.startsWith('calendar_unconfirmed:')) return '引用的日历尚未确认。';
  if (input.startsWith('calendar:')) return '请为工作日或顺延规则选择已确认的日历版本。';
  if (input === 'interval_end_before_start') return '履行区间结束日期早于开始日期，请核对边界。';
  if (input === 'date_range_exceeded') return '计算超出支持的日期范围，请核对偏移数量。';
  if (input.startsWith('event_project:')) return '起算事件不属于当前项目，请重新选择。';
  if (input === 'occurrence_context') return '周期义务应按每个具体周期分别计算。';
  return /[\u3400-\u9fff]/.test(input) ? input : '仍有待核对的计算条件，请检查规则与来源。';
}

function CalculationView({ value, events, calendars, hasEnd }: { value: Calculation; events: Entity[]; calendars: Entity[]; hasEnd?: boolean }) {
  function stepText(text: string) {
    let result = text.replace('earliest:', '孰早：').replace('latest:', '孰晚：').replace('next_workday', '顺延至下一工作日').replace('previous_workday', '提前至上一工作日');
    for (const [unit, label] of Object.entries(units)) result = result.replaceAll(unit, label);
    for (const event of events) result = result.replaceAll(event.id, event.name);
    for (const calendar of calendars) result = result.replaceAll(calendar.id, calendar.name);
    return result;
  }
  return <>
    <p><Badge value={value.state} /> {value.computed_due_on ? <strong>计算截止日：{value.computed_due_on}</strong> : value.interval ? <span>履行期间：{value.interval.start_on ?? '待确定'} 至 {value.interval.end_on ?? (hasEnd === false ? '无固定结束日' : '待确定')}</span> : '暂无正式截止日'}</p>
    {value.estimated_due_on && <p className={s.hint}>预估日期：{value.estimated_due_on}，尚不能用于正式提醒。</p>}
    {!!value.missing_inputs?.length && <ul className={r.missing}>{[...new Set(value.missing_inputs.map(input => missingDescription(input, events)))].map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {!!value.steps?.length && <details><summary>查看计算过程（{value.steps.length} 步）</summary><ol className={r.steps}>{value.steps.slice(0, 100).map((step, index) => <li key={index}>{stepText(step.detail)}{step.from && step.to && <span>：{step.from} → {step.to}</span>}</li>)}</ol>{value.steps.length > 100 && <p className={s.muted}>逐日核验共 {value.steps.length} 步，此处展示前 100 步。</p>}</details>}
  </>;
}

export function RuleEditor({ value, onChange, events = [], projectId, candidateMode = false }: { value: any; onChange: (value: any) => void; events?: Entity[]; projectId?: string; candidateMode?: boolean }) {
  const editSchema = candidateMode ? draftDeadlineRuleSchema : deadlineRuleSchema;
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [calendars, setCalendars] = useState<Entity[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState('');
  const [calendarReload, setCalendarReload] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const jsonInput = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(0);
  const valueKey = JSON.stringify(value);
  const contextKey = `${projectId ?? ''}:${valueKey}`;
  const currentKey = useRef(contextKey);
  currentKey.current = contextKey;

  useEffect(() => {
    let active = true;
    setCalendarLoading(true); setCalendarError(''); setCalendars([]);
    void (async () => {
      try {
        const result = await allPages('/calendars');
        if (active) setCalendars(result.items);
      } catch (error) { if (active) setCalendarError(message(error)); }
      finally { if (active) setCalendarLoading(false); }
    })();
    return () => { active = false; };
  }, [calendarReload]);
  useEffect(() => { revision.current++; setPreview(null); setPreviewError(''); setPreviewBusy(false); }, [valueKey, projectId]);
  useEffect(() => () => { revision.current++; }, []);
  useEffect(() => { jsonInput.current?.setCustomValidity(jsonError ? '请修正规则 JSON 后保存' : ''); }, [advanced, jsonError]);

  function update(next: any) {
    revision.current++; setPreview(null); setPreviewError(''); setPreviewBusy(false);
    onChange(next);
    if (advanced) setJson(JSON.stringify(next, null, 2));
  }
  const change = (key: string, next: any) => update({ ...value, [key]: next });
  function changeKind(kind: string) {
    const base = { schema_version: 1, confirmation_status: value.confirmation_status, original_expression: value.original_expression };
    update(kind === 'fixed' ? { ...base, kind, date: '', convention: { ...defaultConvention } }
      : kind === 'relative' ? { ...base, kind, anchor: blankAnchor(), offsets: [blankOffset()], convention: { ...defaultConvention } }
      : kind === 'recurring' ? { ...base, kind, frequency: 'quarter', first_period_start: '', last_period_end: null, anchor: 'period_end', offsets: [blankOffset()], convention: { ...defaultConvention } }
      : { ...base, kind, starts_at: { type: 'date', date: '' }, ends_at: null, review_mode: 'manual' });
  }
  function toggleAdvanced() {
    if (!advanced) { setJson(JSON.stringify(value, null, 2)); setJsonError(''); setAdvanced(true); return; }
    try { const parsed = editSchema.parse(JSON.parse(json)); update(parsed); setJsonError(''); setAdvanced(false); }
    catch { setJsonError('JSON 或时间规则无效，请修正后返回表单；当前输入已保留。'); }
  }
  async function calculatePreview() {
    const parsed = deadlineRuleSchema.safeParse(value);
    if (!parsed.success || jsonError) { setPreviewError('请先完善日期、起算条件、偏移和周期范围，并修正规则格式。'); return; }
    const request = ++revision.current;
    const snapshot = contextKey;
    setPreviewBusy(true); setPreviewError(''); setPreview(null);
    try {
      const result = await post<Preview>('/deadline-rules/preview', { rule: parsed.data, ...(projectId ? { project_id: projectId } : {}) });
      if (revision.current === request && currentKey.current === snapshot) setPreview(result);
    } catch (error) { if (revision.current === request) setPreviewError(message(error)); }
    finally { if (revision.current === request) setPreviewBusy(false); }
  }

  return <section className={s.ruleEditor} aria-label="期限规则编辑器">
    <div className={s.cardHeading}><h3>期限规则</h3><button type="button" className={s.textButton} onClick={toggleAdvanced}>{advanced ? '返回表单' : '高级 JSON'}</button></div>
    {advanced ? <>
      <textarea ref={jsonInput} aria-label="规则 JSON" className={s.codeInput} value={json} onChange={event => {
        setJson(event.target.value); revision.current++; setPreview(null); setPreviewBusy(false);
        try { const parsed = editSchema.parse(JSON.parse(event.target.value)); onChange(parsed); setJsonError(''); event.target.setCustomValidity(''); }
        catch { setJsonError('JSON 或时间规则格式无效，请修正后保存。'); event.target.setCustomValidity('请修正规则 JSON 后保存'); }
      }} rows={12} />
      {jsonError && <p role="alert" className={s.error}>{jsonError}</p>}
    </> : <>
      <div className={s.grid2}><Field label="时间类型"><select value={value.kind} onChange={event => changeKind(event.target.value)}><option value="fixed">固定日期</option><option value="relative">事件后 / 前</option><option value="recurring">周期报送</option><option value="continuous">持续性承诺</option></select></Field><Field label="原始期限表述"><input value={value.original_expression ?? ''} onChange={event => change('original_expression', event.target.value)} placeholder="按原文录入，不确定时保留待确认" /></Field></div>
      {value.kind === 'fixed' && <Field label="固定截止日"><input type="date" required value={value.date ?? ''} onChange={event => change('date', event.target.value)} /></Field>}
      {value.kind === 'relative' && <AnchorEditor value={value.anchor} events={events} onChange={anchor => change('anchor', anchor)} />}
      {value.kind === 'recurring' && <div className={s.grid2}>
        <Field label="报送频率"><select value={value.frequency} onChange={event => change('frequency', event.target.value)}><option value="month">每月</option><option value="quarter">每季度</option><option value="year">每年</option></select></Field>
        <Field label="周期锚点"><select value={value.anchor} onChange={event => change('anchor', event.target.value)}><option value="period_end">周期结束日</option><option value="period_start">周期开始日</option></select></Field>
        <Field label="首个周期开始日" hint="必须是对应自然月、季度或年度的第一天。"><input type="date" required={!candidateMode} value={value.first_period_start ?? ''} onChange={event => change('first_period_start', event.target.value || (candidateMode ? null : ''))} /></Field>
        <Field label="最后周期结束日（可选）"><input type="date" value={value.last_period_end ?? ''} onChange={event => change('last_period_end', event.target.value || null)} /></Field>
      </div>}
      {value.kind === 'continuous' && <>
        <BoundaryEditor label="区间开始" value={value.starts_at} onChange={boundary => change('starts_at', boundary)} events={events} calendars={calendars} calendarLoading={calendarLoading} />
        <BoundaryEditor label="区间结束" value={value.ends_at} onChange={boundary => change('ends_at', boundary)} events={events} calendars={calendars} calendarLoading={calendarLoading} optional />
        <p className={s.hint}>持续义务保留履行期间，检查事项另行建立；到达区间末日不代表已自动确认合规。</p>
      </>}
      {['relative', 'recurring'].includes(value.kind) && <OffsetsEditor value={value.offsets} onChange={offsets => change('offsets', offsets)} />}
      {value.kind !== 'continuous' && <ConventionEditor value={value.convention} onChange={convention => change('convention', convention)} calendars={calendars} calendarLoading={calendarLoading} />}
      <div className={r.calendarTools}><span className={s.muted}>{calendarLoading ? '正在读取工作日日历…' : `${calendars.filter(calendar => calendar.confirmed).length} 个已确认日历可选`}</span><button type="button" className={s.textButton} disabled={calendarLoading} onClick={() => setCalendarReload(count => count + 1)}>刷新日历列表</button></div>
      {calendarError && <p role="alert" className={s.error}>日历列表读取失败：{calendarError}。原引用保留，可刷新后重试。</p>}
    </>}
    <label className={s.checkbox}><input type="checkbox" disabled={advanced && !!jsonError} checked={value.confirmation_status === 'confirmed'} onChange={event => change('confirmation_status', event.target.checked ? 'confirmed' : 'needs_review')} />已核对原文及时间计算约定</label>
    <p className={s.hint}>未确认规则不生成正式截止日；工作日须使用已确认且覆盖计算区间的日历。预览只作核对，不保存规则或发送提醒。</p>
    {candidateMode && <p className={s.hint}>候选事件尚未生成正式记录。保存候选后，返回审核页预览所选事件与义务的完整计算结果。</p>}
    {!candidateMode && <button type="button" disabled={previewBusy || !!jsonError} onClick={() => void calculatePreview()}>{previewBusy ? '正在计算…' : '预览期限计算'}</button>}
    {previewError && <p role="alert" className={s.error}>{previewError}</p>}
    {preview && <section className={s.impact} aria-label="期限计算预览"><h3>期限计算预览</h3>
      {value.kind === 'recurring' && preview.occurrences ? <>
        <p className={s.muted}>按首期开始逐期展示，最多预览 3 期，各期独立计算。</p>
        {preview.occurrences.length ? preview.occurrences.map(occurrence => <article className={r.occurrence} key={occurrence.occurrence_key}><h4>{occurrence.occurrence_key}</h4><CalculationView value={occurrence} events={events} calendars={calendars} /></article>) : <p>当前周期范围内没有可生成的执行事项。</p>}
      </> : <CalculationView value={preview} events={events} calendars={calendars} hasEnd={value.kind === 'continuous' ? value.ends_at !== null : undefined} />}
    </section>}
  </section>;
}
