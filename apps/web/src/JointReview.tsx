import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { draftDeadlineRuleSchema } from '../../../packages/contracts/src/index';
import { ApiError, continuousPeriod, items, patch, post, type Entity } from './api';
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageTitle, SaveForm, sourceLocation, useAllResource, useResource } from './components';
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
  const document = useResource<Entity>(`/documents/${run.document_id}`);
  const protocolName = run.protocol_name ?? run.document_name ?? run.original_name ?? run.document?.original_name ?? document.data?.original_name ?? '来源文件';
  const protocolFile = run.original_name ?? run.document?.original_name ?? document.data?.original_name ?? '—';
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
    <PageTitle eyebrow="协议自动提取与审核" title="关键事件与义务审核" description="系统已经自动读取协议并识别关键事件、义务、责任主体和期限；你不需要先手动定义关键事件，只需核对异常项并确认。" actions={<button onClick={refresh} disabled={pending}>刷新候选</button>} />
    <div className={s.notice}>{run.mode === 'live' ? '外部模型候选' : '模拟模型候选'} · <Badge value={run.state} />{stable && <p><strong>系统已自动勾选可直接确认的候选。</strong> 日期未知的事件会保留为“待事件”，不会被系统猜测；只有识别不完整的候选需要你补充。</p>}{run.mode !== 'live' && <p>当前为模拟提取，仅演示确定性提取流程；复杂自然语言补充要求的效果需使用真实模型验证；接入真实模型后会按相同审核流程返回协议内容。</p>}{run.error && <p>{run.error}</p>}</div>
    {run.state === 'partial' && <div role="alert" className={s.hint}>
      <strong>部分片段提取失败，当前仅显示已成功提取的候选。</strong>
      <p>可以先审核现有候选；未提取的内容不会自动补齐，请返回原文重新发起提取。</p>
      {(Array.isArray(run.errors) ? run.errors : []).filter((item: unknown): item is string => typeof item === 'string').slice(0, 5).map((item: string, index: number) => <p key={index}>{item.slice(0, 1000)}</p>)}
      <Link className={s.textButton} to={`/documents/${run.document_id}`}>返回原文重新提取</Link>
    </div>}
    {run.prompt && <Card title="本次补充提取要求"><p className={s.prewrap}>{run.prompt}</p></Card>}
    <Card title="本次协议来源"><dl className={s.details}><dt>协议名称</dt><dd className={j.breakWord}>{protocolName}</dd><dt>原始文件</dt><dd className={j.breakWord}>{protocolFile}</dd><dt>提取批次</dt><dd>{run.id?.slice(0, 12) ?? '—'}</dd><dt>你的操作</dt><dd>只需审核异常项并确认；不需要先创建关键事件</dd></dl></Card>
    <Card title="协议关键事项概览" aside={<span className={s.muted}>{events.length} 个事件 · {drafts.length} 项义务</span>}>
      <p className={s.muted}>以下是从本协议原文定位出的候选摘要；完整字段和风险提示请在下方逐条审核。</p>
      <div className={j.overviewGrid}>
        <div><strong>关键事件</strong>{events.length ? <ul>{events.map(event => <li key={event.id}>{event.name} · {event.occurred_on ?? '日期待核对'} · {event.clause_number ?? '条款待核对'} · {sourceLocation(event)}</li>)}</ul> : <p className={s.muted}>未识别到关键事件</p>}</div>
        <div><strong>关键义务</strong>{drafts.length ? <ul>{drafts.slice(0, 20).map(draft => <li key={draft.id}>{draft.title} · {draft.obligor || '主体待核对'} · {draft.rule?.original_expression || '期限待核对'} · {draft.clause_number ?? '条款待核对'}</li>)}</ul> : <p className={s.muted}>未识别到义务候选</p>}</div>
      </div>
      {drafts.length > 20 && <p className={s.hint}>当前仅在概览显示前20项，全部 {drafts.length} 项仍保留在下方逐条审核。</p>}
    </Card>
    <ErrorBox error={loadError} retry={refresh} /><ErrorBox error={error} />
    {success && <div role="status" className={s.notice}>{success}<Link to={`/projects/${run.project_id}`}>查看项目事项 →</Link><Link to={`/projects/${run.project_id}/events`}>查看正式事件 →</Link></div>}
    {!stable && ['queued', 'running'].includes(run.state) && <Loading />}
    <fieldset disabled={pending} className={j.selection}>
      <Card title={`关键事件候选（${events.length}）`} aside={<span className={s.muted}>已自动识别；日期未知自动保留为待事件</span>}>
        {!events.length ? <p className={s.muted}>本批次未识别到关键事件，固定日期义务仍可单独确认。</p> : <div className={j.candidates}>{events.map((event, index) => {
          const required = requiredIds.has(event.id), approved = event.review_state === 'approved', ignored = event.review_state === 'ignored';
          const reused = items(existing.data).find(item => item.id === event.reuse_event_id);
          const displayDate = event.reuse_event_id ? reused?.occurred_on ?? null : event.occurred_on;
          return <article key={event.id} className={j.candidate} aria-label={`事件候选 ${index + 1}`}>
            <div className={s.reviewHeading}><label className={s.checkbox}><input type="checkbox" aria-label={`选择事件 ${index + 1}`} checked={eventIds.has(event.id)} disabled={approved || ignored || required} onChange={e => changeEvent(event.id, e.target.checked)} /><strong>{event.name}</strong></label><Badge value={event.review_state} /></div>
            <div className={s.reviewGrid}><div className={s.source}><SourceMeta protocolName={protocolName} protocolFile={protocolFile} record={event} /><blockquote className={j.sourceText}>{event.source_text}</blockquote></div><div><dl className={s.details}><dt>事件名称</dt><dd className={j.breakWord}>{event.name}</dd><dt>事件类型</dt><dd>{eventTypes[event.event_type] ?? '其他事件'}</dd><dt>实际发生日期</dt><dd>{displayDate ?? '待事件：原文未提供可确认的实际日期'}</dd><dt>投资方范围</dt><dd className={j.breakWord}>{event.investor_label || '未限定'}</dd>{event.reuse_event_id && <><dt>复用事件</dt><dd className={j.breakWord}>{reused?.name ?? '现有事件'}</dd></>}</dl>{required && <p className={s.hint}>由所选义务引用，将随义务一起确认；如需取消，请先取消相应义务。</p>}<RiskItems items={event.unresolved_items} fallback={displayDate ? '已提取实际日期，仍需核对协议原文。' : '实际日期待核对，不能用计划日期代替。'} /><div className={s.actions}><button disabled={approved} onClick={() => { invalidate(); setEditingEvent(event); }}>核对事件</button><button disabled={approved || busy} onClick={() => void ignore(event, 'event')}>{ignored ? '恢复事件候选' : '忽略事件'}</button></div></div></div>
          </article>;
        })}</div>}
      </Card>
      <Card title={`义务候选（${drafts.length}）`} aside={<button onClick={() => { invalidate(); setSelected(new Set(drafts.filter(d => available(d) && !draftIssue(d, events)).map(d => d.id))); }}>选择可导入义务</button>}>
        {!drafts.length ? <Empty title="暂无义务候选">可审核事件候选，或返回原文补充要求后重新提取。</Empty> : <div className={j.candidates}>{drafts.map((draft, index) => {
          const issue = draftIssue(draft, events), approved = draft.review_state === 'approved', ignored = draft.review_state === 'ignored';
          return <article key={draft.id} className={j.candidate} aria-label={`义务候选 ${index + 1}`}>
            <div className={s.reviewHeading}><label className={s.checkbox}><input aria-label={`选择候选 ${index + 1}`} type="checkbox" checked={selected.has(draft.id)} disabled={approved || ignored || Boolean(issue)} onChange={e => changeDraft(draft.id, e.target.checked)} /><strong className={j.candidateTitle}><span>事项标题</span>{draft.title}</strong></label><Badge value={draft.review_state} /></div>
            <div className={s.reviewGrid}><div className={s.source}><SourceMeta protocolName={protocolName} protocolFile={protocolFile} record={draft} /><blockquote className={j.sourceText}>{draft.source_text}</blockquote></div><div><dl className={`${s.details} ${j.fieldDetails}`}><dt>事项标题</dt><dd className={j.breakWord}>{draft.title}</dd><dt>义务主体</dt><dd className={j.breakWord}>{draft.obligor || '待核对'}</dd><dt>动作</dt><dd className={j.breakWord}>{draft.action || '待核对'}</dd><dt>交付物</dt><dd className={j.breakWord}>{draft.deliverable || '待核对'}</dd><dt>触发条件</dt><dd className={j.breakWord}>{draft.trigger || '无明确触发条件 / 待核对'}</dd><dt>原期限</dt><dd className={j.breakWord}>{draft.rule?.original_expression || '待核对'}</dd><dt>期限规则</dt><dd className={j.breakWord}>{ruleSummary(draft.rule, eventOptions)}</dd><dt>负责人</dt><dd className={j.breakWord}>{draft.owner_label || '未指定'}</dd></dl>{draft.description && <p className={j.description}><strong>提取说明：</strong>{draft.description}</p>}<RiskItems items={[...(issue ? [issue] : []), ...(draft.unresolved_items ?? [])]} fallback="未发现自动风险；仍需核对原文、责任方和期限计算。" /><div className={s.actions}><button disabled={approved} onClick={() => { invalidate(); setEditingDraft(draft); }}>核对并编辑</button><button disabled={approved || busy} onClick={() => void ignore(draft, 'obligation')}>{ignored ? '恢复义务候选' : '忽略候选'}</button></div></div></div>
          </article>;
        })}</div>}
      </Card>
      <Card title="预览与统一确认">
        <ErrorBox error={existing.error} retry={existing.reload} /><ErrorBox error={calendars.error} retry={calendars.reload} />
        <Field label="本次工作日日历（可选）" hint="只为尚未指定日历的工作日或顺延规则补充引用；不替换已有日历。"><select aria-label="本次工作日日历" value={calendar} disabled={calendars.loading} onChange={e => { invalidate(); setCalendar(e.target.value); }}><option value="">暂不指定，相关期限保留待确认</option>{items(calendars.data).filter(c => c.confirmed).map(c => <option key={c.id} value={`${c.id}@${c.calendar_version}`}>{c.name} · v{c.calendar_version}</option>)}</select></Field>
        <p className={s.muted}>系统已自动选中可直接确认的候选：{selectedDrafts.length} 项义务、{selectedEvents.length} 个事件。日期未知不会编造截止日，识别不完整的候选会保留待补充。</p>
        <button className={s.primary} disabled={!canPreview} onClick={() => void calculate()}>{busy ? '处理中…' : preview ? '重新预览确认结果' : '预览确认结果'}</button>
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

function SourceMeta({ protocolName, protocolFile, record }: { protocolName: string; protocolFile: string; record: Entity }) {
  return <dl className={j.sourceMeta}>
    <dt>协议名称</dt><dd className={j.breakWord}>{protocolName}</dd>
    <dt>来源文件</dt><dd className={j.breakWord}>{protocolFile}</dd>
    <dt>条款/页码定位</dt><dd className={j.breakWord}>{record.clause_number ?? '条款号待核对'} · {sourceLocation(record)}</dd>
  </dl>;
}

function RiskItems({ items, fallback }: { items?: unknown; fallback: string }) {
  const values = (Array.isArray(items) ? items : []).filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim());
  const unique = [...new Set(values)];
  return <div className={unique.length ? j.risk : j.riskOk}><strong>风险/待核对项</strong>{unique.length ? <ul>{unique.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>{fallback}</p>}</div>;
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
  const [form, setForm] = useState({ title: draft.title ?? '', description: draft.description ?? '', obligor: draft.obligor ?? '', action: draft.action ?? '', deliverable: draft.deliverable ?? '', trigger: draft.trigger ?? '', owner_label: draft.owner_label ?? '' });
  const [rule, setRule] = useState(draft.rule ?? blankRule());
  return <Modal title="核对候选义务" close={close} wide><SaveForm cancel={close} label="保存审核结果" onSave={async () => {
    const parsed = draftDeadlineRuleSchema.parse(rule);
    await patch(`/draft-obligations/${draft.id}`, { version: draft.version, ...form, rule: parsed, review_state: 'needs_review' }); saved();
  }}><blockquote className={s.source}>{draft.source_text}</blockquote><Field label="候选标题"><input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="候选履约说明"><textarea value={form.description} rows={3} onChange={e => setForm({ ...form, description: e.target.value })} /></Field><div className={s.grid2}><Field label="候选义务主体"><input value={form.obligor} onChange={e => setForm({ ...form, obligor: e.target.value })} /></Field><Field label="候选负责人"><input value={form.owner_label} onChange={e => setForm({ ...form, owner_label: e.target.value })} /></Field></div><div className={s.grid2}><Field label="动作"><input value={form.action} onChange={e => setForm({ ...form, action: e.target.value })} /></Field><Field label="交付物"><input value={form.deliverable} onChange={e => setForm({ ...form, deliverable: e.target.value })} /></Field></div><Field label="触发条件"><input value={form.trigger} onChange={e => setForm({ ...form, trigger: e.target.value })} /></Field><RuleEditor value={rule} onChange={setRule} events={events} projectId={projectId} candidateMode /></SaveForm></Modal>;
}
