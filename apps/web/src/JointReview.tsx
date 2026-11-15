import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { draftDeadlineRuleSchema } from '../../../packages/contracts/src/index';
import { ApiError, continuousPeriod, items, patch, post, type Entity } from './api';
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageTitle, SaveForm, sourceLocation, useAllResource } from './components';
import { RuleEditor, blankRule } from './RuleEditor';
import { candidateReferences, draftIssue, eventKey, eventTypes, requiredEventDrafts, reviewEvents, ruleSummary } from './jointReviewData';
import s from './Workspace.module.css';
import j from './JointReview.module.css';

type Props = { run: Entity; loading: boolean; error: unknown; reload: () => void };
type ConfirmationPreview = { events: Entity[]; created: Entity[]; tasks: Entity[]; warnings: string[]; versions: Record<string, { id: string; version: number }[]> };
const available = (record: Entity) => record.review_state !== 'approved' && record.review_state !== 'ignored';

export function JointReviewPage({ run, loading, error: loadError, reload }: Props) {
  const drafts: Entity[] = run.candidates ?? run.drafts ?? [];
  const events: Entity[] = run.event_candidates ?? [];
  const existing = useAllResource(`/projects/${run.project_id}/events`);
  const calendars = useAllResource('/calendars');
  const [selected, setSelected] = useState(new Set<string>());
  const [explicitEvents, setExplicitEvents] = useState(new Set<string>());
  const [calendar, setCalendar] = useState('');
  const [editingEvent, setEditingEvent] = useState<Entity | null>(null);
  const [editingDraft, setEditingDraft] = useState<Entity | null>(null);
  const [preview, setPreview] = useState<ConfirmationPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState('');
  const initialized = useRef(false);
  const request = useRef(0);
  const stable = ['succeeded', 'partial'].includes(run.state);
  const versionKey = JSON.stringify([run.id, run.version, drafts.map(d => [d.id, d.version, d.review_state]), events.map(e => [e.id, e.version, e.review_state]), existing.data?.items.map(e => [e.id, e.version]), calendars.data?.items.map(c => [c.id, c.version]), calendar]);
  const currentVersion = useRef(versionKey); currentVersion.current = versionKey;
  function invalidate() { request.current++; setPreview(null); setAcknowledged(false); }
  useEffect(() => {
    request.current++; setPreview(null); setAcknowledged(false);
    if (!stable) return;
    if (!initialized.current) {
      initialized.current = true;
      setSelected(new Set(drafts.filter(d => available(d) && !draftIssue(d, events)).map(d => d.id)));
      setExplicitEvents(new Set(events.filter(available).map(e => e.id)));
    } else {
      setSelected(previous => new Set([...previous].filter(id => drafts.some(d => d.id === id && available(d) && !draftIssue(d, events)))));
      setExplicitEvents(previous => new Set([...previous].filter(id => events.some(e => e.id === id && available(e)))));
    }
  }, [versionKey, stable]);
  useEffect(() => {
    if (!['queued', 'running'].includes(run.state)) return;
    const timer = window.setInterval(reload, 1000);
    return () => window.clearInterval(timer);
  }, [run.id, run.state]);
  useEffect(() => () => { request.current++; }, []);
  const selectedDrafts = drafts.filter(d => selected.has(d.id) && available(d) && !draftIssue(d, events));
  const requiredEvents = requiredEventDrafts(selectedDrafts, events);
  const requiredIds = new Set(requiredEvents.map(e => e.id));
  const eventIds = new Set([...explicitEvents, ...requiredIds]);
  const selectedEvents = events.filter(e => eventIds.has(e.id) && e.review_state !== 'ignored');
  const eventOptions = reviewEvents(events, items(existing.data));
  const pending = busy || loading || !stable;
  const canPreview = !pending && !existing.loading && !existing.error && !calendars.loading && !calendars.error && Boolean(selectedDrafts.length || selectedEvents.length);
  const payload = () => {
    const selectedCalendar = items(calendars.data).find(item => `${item.id}@${item.calendar_version}` === calendar);
    return { draft_ids: selectedDrafts.map(d => d.id).sort(), event_draft_ids: selectedEvents.map(e => e.id).sort(), ...(selectedCalendar ? { calendar_id: selectedCalendar.id, calendar_version: selectedCalendar.calendar_version } : {}) };
  };
  function changeDraft(id: string, checked: boolean) {
    invalidate(); setSuccess(''); setError(null);
    setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  }
  function changeEvent(id: string, checked: boolean) {
    invalidate(); setSuccess(''); setError(null);
    setExplicitEvents(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  }
  async function ignore(record: Entity, kind: 'event' | 'obligation') {
    invalidate(); setBusy(true); setError(null); setSuccess('');
    try {
      const ignored = record.review_state !== 'ignored';
      await patch(`/draft-${kind === 'event' ? 'events' : 'obligations'}/${record.id}`, { version: record.version, review_state: ignored ? 'ignored' : 'needs_review' });
      if (kind === 'event' && ignored) {
        setExplicitEvents(previous => { const next = new Set(previous); next.delete(record.id); return next; });
        setSelected(previous => new Set([...previous].filter(id => !drafts.some(d => d.id === id && candidateReferences(d.rule).includes(eventKey(record))))));
      }
      if (kind === 'obligation' && ignored) setSelected(previous => { const next = new Set(previous); next.delete(record.id); return next; });
      reload();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  async function calculate() {
    const sequence = ++request.current, snapshot = versionKey;
    setBusy(true); setError(null); setSuccess(''); setPreview(null); setAcknowledged(false);
    try {
      const result = await post<ConfirmationPreview>(`/extractions/${run.id}/preview`, payload());
      if (request.current === sequence && currentVersion.current === snapshot) setPreview(result);
    } catch (failure) { if (request.current === sequence) setError(failure); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || !acknowledged) return;
    setBusy(true); setError(null); setSuccess('');
    try {
      const result = await post(`/extractions/${run.id}/confirm`, { ...payload(), confirm_review: true, expected_versions: preview.versions });
      setSuccess(`已确认导入 ${result.created?.length ?? 0} 条候选，新增 ${result.events_created?.length ?? 0} 个事件、复用 ${result.events_reused?.length ?? 0} 个事件，生成 ${result.tasks?.length ?? 0} 条执行事项。`);
      invalidate(); setSelected(new Set()); setExplicitEvents(new Set()); reload(); existing.reload();
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError && failure.status === 409) { invalidate(); reload(); existing.reload(); calendars.reload(); }
    } finally { setBusy(false); }
  }
  function refresh() { invalidate(); setError(null); reload(); existing.reload(); calendars.reload(); }
  return <>
    <Link className={s.back} to={`/documents/${run.document_id}`}>← 返回协议原文</Link>
    <PageTitle eyebrow="协议提取与人工审核" title="关键事件与义务审核" description="核对候选、预览结果，再统一确认。确认前不会生成正式记录。" actions={<button onClick={refresh} disabled={pending}>刷新候选</button>} />
    <div className={s.notice}>{run.mode === 'live' ? '外部模型候选' : '模拟模型候选'} · <Badge value={run.state} />{run.mode !== 'live' && <p>当前为模拟提取，仅演示确定性提取流程；复杂自然语言补充要求的效果需使用真实模型验证。</p>}{run.error && <p>{run.error}</p>}</div>
    {run.state === 'partial' && <div role="alert" className={s.hint}>
      <strong>部分片段提取失败，当前仅显示已成功提取的候选。</strong>
      <p>可以先审核现有候选；未提取的内容不会自动补齐，请返回原文重新发起提取。</p>
      {(Array.isArray(run.errors) ? run.errors : []).filter((item: unknown): item is string => typeof item === 'string').slice(0, 5).map((item: string, index: number) => <p key={index}>{item.slice(0, 1000)}</p>)}
      <Link className={s.textButton} to={`/documents/${run.document_id}`}>返回原文重新提取</Link>
    </div>}
    {run.prompt && <Card title="本次补充提取要求"><p className={s.prewrap}>{run.prompt}</p></Card>}
    <Card title="本次协议来源"><dl className={s.details}><dt>协议名称</dt><dd>{run.protocol_name ?? run.document_name ?? run.original_name ?? run.document?.original_name ?? '来源文件'}</dd><dt>原始文件</dt><dd>{run.original_name ?? run.document?.original_name ?? '—'}</dd><dt>提取批次</dt><dd>{run.id?.slice(0, 12) ?? '—'}</dd><dt>审核要求</dt><dd>事件、义务、期限和原文定位均需逐条核对</dd></dl></Card>
    <ErrorBox error={loadError} retry={refresh} /><ErrorBox error={error} />
    {success && <div role="status" className={s.notice}>{success}<Link to={`/projects/${run.project_id}`}>查看项目事项 →</Link><Link to={`/projects/${run.project_id}/events`}>查看正式事件 →</Link></div>}
    {!stable && ['queued', 'running'].includes(run.state) && <Loading />}
    <fieldset disabled={pending} className={j.selection}>
      <Card title={`关键事件候选（${events.length}）`} aside={<span className={s.muted}>日期未知可留空，确认后保持待事件</span>}>
        {!events.length ? <p className={s.muted}>本批次未识别到关键事件，固定日期义务仍可单独确认。</p> : <div className={j.candidates}>{events.map((event, index) => {
          const required = requiredIds.has(event.id), approved = event.review_state === 'approved', ignored = event.review_state === 'ignored';
          const reused = items(existing.data).find(item => item.id === event.reuse_event_id);
          const displayDate = event.reuse_event_id ? reused?.occurred_on ?? null : event.occurred_on;
          return <article key={event.id} className={j.candidate} aria-label={`事件候选 ${index + 1}`}>
            <div className={s.reviewHeading}><label className={s.checkbox}><input type="checkbox" aria-label={`选择事件 ${index + 1}`} checked={eventIds.has(event.id)} disabled={approved || ignored || required} onChange={e => changeEvent(event.id, e.target.checked)} /><strong>{event.name}</strong></label><Badge value={event.review_state} /></div>
            <div className={s.reviewGrid}><div className={s.source}><blockquote>{event.source_text}</blockquote><small>{event.clause_number ?? '协议原文'} · {sourceLocation(event)}</small></div><div><dl className={s.details}><dt>事件类型</dt><dd>{eventTypes[event.event_type] ?? '其他事件'}</dd><dt>实际发生日期</dt><dd>{displayDate ?? '待事件：原文未提供可确认的实际日期'}</dd><dt>投资方范围</dt><dd>{event.investor_label || '未限定'}</dd>{event.reuse_event_id && <><dt>复用事件</dt><dd>{reused?.name ?? '现有事件'}</dd></>}</dl>{required && <p className={s.hint}>由所选义务引用，将随义务一起确认；如需取消，请先取消相应义务。</p>}{(event.unresolved_items ?? []).length > 0 && <p className={s.hint}>{event.unresolved_items.join('；')}</p>}<div className={s.actions}><button disabled={approved} onClick={() => { invalidate(); setEditingEvent(event); }}>核对事件</button><button disabled={approved || busy} onClick={() => void ignore(event, 'event')}>{ignored ? '恢复事件候选' : '忽略事件'}</button></div></div></div>
          </article>;
        })}</div>}
      </Card>
      <Card title={`义务候选（${drafts.length}）`} aside={<button onClick={() => { invalidate(); setSelected(new Set(drafts.filter(d => available(d) && !draftIssue(d, events)).map(d => d.id))); }}>选择可导入义务</button>}>
        {!drafts.length ? <Empty title="暂无义务候选">可审核事件候选，或返回原文补充要求后重新提取。</Empty> : <div className={j.candidates}>{drafts.map((draft, index) => {
          const issue = draftIssue(draft, events), approved = draft.review_state === 'approved', ignored = draft.review_state === 'ignored';
          return <article key={draft.id} className={j.candidate} aria-label={`义务候选 ${index + 1}`}>
            <div className={s.reviewHeading}><label className={s.checkbox}><input type="checkbox" aria-label={`选择候选 ${index + 1}`} checked={selected.has(draft.id)} disabled={approved || ignored || Boolean(issue)} onChange={e => changeDraft(draft.id, e.target.checked)} /><strong>{draft.title}</strong></label><Badge value={draft.review_state} /></div>
            <div className={s.reviewGrid}><div className={s.source}><blockquote>{draft.source_text}</blockquote><small>{draft.clause_number ?? '协议原文'} · {sourceLocation(draft)}</small></div><div><p>{draft.description}</p><dl className={s.details}><dt>义务主体</dt><dd>{draft.obligor || '待核对'}</dd><dt>负责人</dt><dd>{draft.owner_label || '未指定'}</dd><dt>期限规则</dt><dd>{ruleSummary(draft.rule, eventOptions)}</dd></dl>{issue && <p className={s.hint}>{issue}</p>}{(draft.unresolved_items ?? []).length > 0 && <details><summary>查看提取时的待核对项</summary><p className={s.hint}>{draft.unresolved_items.join('；')}</p></details>}<div className={s.actions}><button disabled={approved} onClick={() => { invalidate(); setEditingDraft(draft); }}>核对并编辑</button><button disabled={approved || busy} onClick={() => void ignore(draft, 'obligation')}>{ignored ? '恢复义务候选' : '忽略候选'}</button></div></div></div>
          </article>;
        })}</div>}
      </Card>
      <Card title="预览与统一确认">
        <ErrorBox error={existing.error} retry={existing.reload} /><ErrorBox error={calendars.error} retry={calendars.reload} />
        <Field label="本次工作日日历（可选）" hint="只为尚未指定日历的工作日或顺延规则补充引用；不替换已有日历。"><select aria-label="本次工作日日历" value={calendar} disabled={calendars.loading} onChange={e => { invalidate(); setCalendar(e.target.value); }}><option value="">暂不指定，相关期限保留待确认</option>{items(calendars.data).filter(c => c.confirmed).map(c => <option key={c.id} value={`${c.id}@${c.calendar_version}`}>{c.name} · v{c.calendar_version}</option>)}</select></Field>
        <p className={s.muted}>已选 {selectedDrafts.length} 项义务、{selectedEvents.length} 个事件。日期未知不会编造截止日，未选候选继续保留。</p>
        <button className={s.primary} disabled={!canPreview} onClick={() => void calculate()}>{busy ? '处理中…' : '预览确认结果'}</button>
        {preview && <section aria-label="确认结果预览" className={s.impact}>
          <h3>确认结果预览</h3><p>本次预览没有生成正式记录。确认后按以下结果保存。</p>
          {!!preview.events?.length && <div className={s.tableWrap}><table><thead><tr><th>关键事件</th><th>实际日期</th></tr></thead><tbody>{preview.events.map((event, index) => <tr key={event.id ?? index}><td>{event.name}</td><td>{event.occurred_on ?? '未知，保留待事件'}</td></tr>)}</tbody></table></div>}
          {!!preview.tasks?.length && <div className={s.tableWrap}><table><thead><tr><th>执行事项</th><th>周期</th><th>截止日 / 履行期间</th><th>期限状态</th></tr></thead><tbody>{preview.tasks.map((task, index) => <tr key={task.id ?? index}><td>{task.title}</td><td>{task.occurrence_key === 'once' ? '单次' : task.occurrence_key}</td><td>{task.effective_due_on ?? (task.calculation?.interval ? continuousPeriod(task.rule_snapshot, task.calculation) : '待补充条件')}</td><td><Badge value={task.deadline_state} /></td></tr>)}</tbody></table></div>}
          {(preview.warnings ?? []).map((warning, index) => <p className={s.hint} key={index}>{warning}</p>)}
          <label className={s.checkbox}><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />已核对所选候选和原文</label>
          <button disabled={!acknowledged || busy} className={s.primary} onClick={() => void confirm()}>确认生成正式记录</button>
        </section>}
      </Card>
    </fieldset>
    {editingEvent && <EventCandidateForm event={editingEvent} existing={items(existing.data)} close={() => setEditingEvent(null)} saved={() => { setEditingEvent(null); invalidate(); reload(); }} />}
    {editingDraft && <JointDraftForm draft={editingDraft} events={eventOptions} projectId={run.project_id} close={() => setEditingDraft(null)} saved={() => { setEditingDraft(null); invalidate(); reload(); }} />}
  </>;
}

function EventCandidateForm({ event, existing, close, saved }: { event: Entity; existing: Entity[]; close: () => void; saved: () => void }) {
  const [name, setName] = useState(event.name);
  const [type, setType] = useState(event.event_type);
  const [date, setDate] = useState(event.occurred_on ?? '');
  const [investor, setInvestor] = useState(event.investor_label ?? '');
  const [reuse, setReuse] = useState(event.reuse_event_id ?? '');
  const selected = existing.find(item => item.id === reuse);
  return <Modal title="核对关键事件候选" close={close} wide><SaveForm cancel={close} label="保存事件候选" onSave={async () => {
    await patch(`/draft-events/${event.id}`, { version: event.version, name, event_type: type, occurred_on: reuse ? selected?.occurred_on ?? null : date || null, investor_label: investor, reuse_event_id: reuse || null, reuse_event_version: selected?.version ?? null }); saved();
  }}><blockquote className={s.source}>{event.source_text}</blockquote><Field label="事件名称"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="事件类型"><select value={type} onChange={e => setType(e.target.value)}>{Object.entries(eventTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="复用已有事件（可选）"><select aria-label="复用已有事件" value={reuse} onChange={e => setReuse(e.target.value)}><option value="">确认后新建事件</option>{existing.map(item => <option key={item.id} value={item.id}>{item.name} · {item.occurred_on ?? '日期待登记'}</option>)}</select></Field><Field label="实际发生日期（未知留空）"><input type="date" disabled={Boolean(reuse)} value={reuse ? selected?.occurred_on ?? '' : date} onChange={e => setDate(e.target.value)} /></Field><Field label="投资方 / 事件范围"><input value={investor} onChange={e => setInvestor(e.target.value)} /></Field><p className={s.hint}>只填写已发生且可核实的日期。原文中的计划日期不能直接当作实际发生日期；复用不会改写已有事件。</p></SaveForm></Modal>;
}

function JointDraftForm({ draft, events, projectId, close, saved }: { draft: Entity; events: Entity[]; projectId: string; close: () => void; saved: () => void }) {
  const [form, setForm] = useState({ title: draft.title ?? '', description: draft.description ?? '', obligor: draft.obligor ?? '', owner_label: draft.owner_label ?? '' });
  const [rule, setRule] = useState(draft.rule ?? blankRule());
  return <Modal title="核对候选义务" close={close} wide><SaveForm cancel={close} label="保存审核结果" onSave={async () => {
    const parsed = draftDeadlineRuleSchema.parse(rule);
    await patch(`/draft-obligations/${draft.id}`, { version: draft.version, ...form, rule: parsed, review_state: 'needs_review' }); saved();
  }}><blockquote className={s.source}>{draft.source_text}</blockquote><Field label="候选标题"><input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="候选履约说明"><textarea value={form.description} rows={3} onChange={e => setForm({ ...form, description: e.target.value })} /></Field><div className={s.grid2}><Field label="候选义务主体"><input value={form.obligor} onChange={e => setForm({ ...form, obligor: e.target.value })} /></Field><Field label="候选负责人"><input value={form.owner_label} onChange={e => setForm({ ...form, owner_label: e.target.value })} /></Field></div><RuleEditor value={rule} onChange={setRule} events={events} projectId={projectId} candidateMode /></SaveForm></Modal>;
}
