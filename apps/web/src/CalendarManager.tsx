import { useEffect, useState, type FormEvent } from 'react';
import { businessDateSchema } from '../../../packages/contracts/src/index';
import { api, post, type Entity, type Page } from './api';
import { Badge, Card, ErrorBox, Field, JsonView, Loading, Modal } from './components';
import s from './Workspace.module.css';
import c from './CalendarManager.module.css';

type Override = { key: string; date: string; working: boolean };
type Draft = { name: string; region: string; start_on: string; end_on: string; source: string; overrides: Override[] };
const emptyDraft = (): Draft => ({ name: '', region: 'CN', start_on: '', end_on: '', source: '', overrides: [] });
const pageSize = 20;

function calendarInput(draft: Draft) {
  const name = draft.name.trim(), region = draft.region.trim(), source = draft.source.trim();
  if (!name || !region || !source) throw new Error('请填写日历名称、地区和来源说明，不能仅填写空白。');
  if (!businessDateSchema.safeParse(draft.start_on).success || !businessDateSchema.safeParse(draft.end_on).success) throw new Error('请选择有效的覆盖开始日和覆盖结束日。');
  if (draft.start_on > draft.end_on) throw new Error('覆盖结束日不能早于开始日。');
  const overrides: Record<string, boolean> = {};
  for (const [index, row] of draft.overrides.entries()) {
    if (!businessDateSchema.safeParse(row.date).success) throw new Error(`第 ${index + 1} 行调休日期无效，请选择日期或移除此行。`);
    if (row.date < draft.start_on || row.date > draft.end_on) throw new Error(`调休日期 ${row.date} 不在日历覆盖范围内。`);
    if (Object.hasOwn(overrides, row.date)) throw new Error(`调休日期 ${row.date} 重复，请保留一行。`);
    overrides[row.date] = row.working;
  }
  return { name, region, start_on: draft.start_on, end_on: draft.end_on, source, overrides };
}

function CalendarSnapshot({ calendar }: { calendar: Entity }) {
  const overrides = Object.entries(calendar.overrides ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return <div className={c.snapshot}>
    <dl className={c.facts}>
      <dt>日历名称</dt><dd>{calendar.name}</dd>
      <dt>地区</dt><dd>{calendar.region}</dd>
      <dt>覆盖范围</dt><dd>{calendar.start_on} 至 {calendar.end_on}</dd>
      <dt>日历版本</dt><dd>v{calendar.calendar_version ?? 1}</dd>
      <dt>来源说明</dt><dd className={c.source}>{calendar.source}</dd>
      <dt>基础规则</dt><dd>周一至周五工作，周六、周日休息；以下调休日期优先。</dd>
    </dl>
    {overrides.length ? <div className={s.tableWrap}><table aria-label="日历调休明细"><thead><tr><th>日期</th><th>调整后类型</th></tr></thead><tbody>{overrides.map(([date, working]) => <tr key={date}><td>{date}</td><td>{working ? '工作日' : '休息日'}</td></tr>)}</tbody></table></div> : <p className={s.muted}>未设置额外调休日期，仅按上述基础规则计算。</p>}
  </div>;
}

export function CalendarManager() {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [preview, setPreview] = useState<Entity | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState('');
  const [calendars, setCalendars] = useState<Entity[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<unknown>(null);
  const [retryPage, setRetryPage] = useState(1);
  const [review, setReview] = useState<Entity | null>(null);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [reviewError, setReviewError] = useState<unknown>(null);

  async function loadCalendars(nextPage = 1) {
    setLoading(true); setListError(null); setRetryPage(nextPage);
    try {
      const result = await api<Page>(`/calendars?page=${nextPage}&page_size=${pageSize}`);
      setCalendars(previous => nextPage === 1 ? result.items : [...previous.filter(item => !result.items.some(next => next.id === item.id)), ...result.items]);
      setPage(nextPage); setTotal(result.total);
    } catch (failure) { setListError(failure); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadCalendars(); }, []);

  function edit(changes: Partial<Draft>) {
    setDraft(previous => ({ ...previous, ...changes }));
    setPreview(null); setChecked(false); setError(null); setSuccess('');
  }
  function editOverride(key: string, changes: Partial<Override>) {
    edit({ overrides: draft.overrides.map(row => row.key === key ? { ...row, ...changes } : row) });
  }
  async function previewCalendar(event: FormEvent) {
    event.preventDefault(); setError(null); setSuccess(''); setBusy(true);
    try {
      const result = await post<Entity>('/calendars/import-preview', calendarInput(draft));
      setPreview(result); setChecked(false);
      await loadCalendars();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  async function confirmCalendar(calendar: Entity, fromList: boolean) {
    if (fromList ? !reviewChecked : !checked) return;
    setBusy(true); setError(null); setReviewError(null); setSuccess('');
    try {
      await post(`/calendars/${calendar.id}/confirm`, { version: calendar.version });
      if (fromList) {
        setReview(null); setReviewChecked(false);
        if (preview?.id === calendar.id) { setPreview(null); setChecked(false); }
      }
      else { setPreview(null); setChecked(false); setDraft(emptyDraft()); }
      setSuccess('日历版本已确认，可在期限规则中选择；已有义务仍保留原日历引用。');
      await loadCalendars();
    } catch (failure) {
      if (fromList) setReviewError(failure); else setError(failure);
    } finally { setBusy(false); }
  }
  function openReview(calendar: Entity) {
    setReview(calendar); setReviewChecked(false); setReviewError(null);
  }

  return <>
    <Card title="工作日日历">
      <p className={s.muted}>填写覆盖范围和来源，再逐项登记调休。默认周一至周五工作、周末休息；请核对范围内的全部节假日及调休，确认后才用于正式工作日期限。</p>
      <form aria-label="创建工作日日历" onSubmit={previewCalendar} noValidate>
        <fieldset disabled={busy}>
          <div className={s.grid2}>
            <Field label="日历名称"><input aria-label="日历名称" required maxLength={300} value={draft.name} onChange={event => edit({ name: event.target.value })} placeholder="例如：中国 2026 年工作日日历" /></Field>
            <Field label="日历地区"><input aria-label="日历地区" required maxLength={100} value={draft.region} onChange={event => edit({ region: event.target.value })} /></Field>
            <Field label="覆盖开始日"><input aria-label="覆盖开始日" required type="date" value={draft.start_on} onChange={event => edit({ start_on: event.target.value })} /></Field>
            <Field label="覆盖结束日"><input aria-label="覆盖结束日" required type="date" min={draft.start_on || undefined} value={draft.end_on} onChange={event => edit({ end_on: event.target.value })} /></Field>
          </div>
          <Field label="日历来源说明" hint="填写来源和核对依据，例如通知名称或网址。"><textarea aria-label="日历来源说明" required maxLength={20000} rows={3} value={draft.source} onChange={event => edit({ source: event.target.value })} /></Field>
          <div className={c.overrideHeading}><h3>节假日与调休日期</h3><button type="button" onClick={() => edit({ overrides: [...draft.overrides, { key: crypto.randomUUID(), date: '', working: false }] })}>增加调休日期</button></div>
          {draft.overrides.length ? draft.overrides.map((row, index) => <div className={c.overrideRow} key={row.key}>
            <Field label={`调休日期 ${index + 1}`}><input aria-label={`调休日期 ${index + 1}`} type="date" required min={draft.start_on || undefined} max={draft.end_on || undefined} value={row.date} onChange={event => editOverride(row.key, { date: event.target.value })} /></Field>
            <Field label={`调整后类型 ${index + 1}`}><select aria-label={`调整后类型 ${index + 1}`} value={row.working ? 'work' : 'rest'} onChange={event => editOverride(row.key, { working: event.target.value === 'work' })}><option value="rest">休息日</option><option value="work">工作日</option></select></Field>
            <button type="button" aria-label={`移除调休日期 ${index + 1}`} className={c.remove} onClick={() => edit({ overrides: draft.overrides.filter(item => item.key !== row.key) })}>移除此日期</button>
          </div>) : <p className={s.hint}>尚未添加调休日期。没有调休的覆盖范围也需人工核对后确认。</p>}
          <button type="submit" className={s.primary}>{busy ? '处理中…' : '预览日历版本'}</button>
        </fieldset>
      </form>
      <ErrorBox error={error} />
      {preview && <section aria-label="日历预览" className={c.preview}>
        <h3>待确认日历预览</h3><CalendarSnapshot calendar={preview} />
        <fieldset disabled={busy}>
          <label className={s.checkbox}><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />已核对日历来源、覆盖范围和全部调休日期</label>
          <button type="button" className={s.primary} disabled={!checked} onClick={() => void confirmCalendar(preview, false)}>确认日历版本</button>
        </fieldset>
      </section>}
      {success && <div role="status" className={s.notice}>{success}</div>}
    </Card>
    <Card title="已有日历版本" aside={<button type="button" disabled={busy || loading} onClick={() => void loadCalendars()}>刷新日历列表</button>}>
      <p className={s.muted}>日历版本表示这一份计算规则；确认状态更新不会改变日历版本。各份日历独立保存，已有义务切换日历须另行预览期限影响。</p>
      <ErrorBox error={listError} retry={() => void loadCalendars(retryPage)} />
      {loading && !calendars.length ? <Loading /> : calendars.length ? <div className={s.tableWrap}><table aria-label="已有工作日日历"><thead><tr><th>名称 / 地区</th><th>覆盖范围</th><th>日历版本</th><th>状态</th><th>操作</th></tr></thead><tbody>{calendars.map(calendar => <tr key={calendar.id}>
        <td>{calendar.name}<small>{calendar.region}</small></td><td>{calendar.start_on}<small>至 {calendar.end_on}</small></td><td>v{calendar.calendar_version ?? 1}</td><td><Badge value={calendar.confirmed ? 'confirmed' : 'needs_review'} /></td>
        <td><button type="button" disabled={busy || loading} aria-label={`${calendar.confirmed ? '查看日历' : '查看并确认日历'} ${calendar.name}`} onClick={() => openReview(calendar)}>{calendar.confirmed ? '查看日历' : '查看并确认'}</button></td>
      </tr>)}</tbody></table></div> : !listError && <p className={s.muted}>尚无日历版本，请在上方创建。</p>}
      <div className={c.listFooter}><span className={s.muted}>已加载 {calendars.length} / {total} 份日历</span>{calendars.length < total && <button type="button" disabled={busy || loading} onClick={() => void loadCalendars(page + 1)}>{loading ? '正在加载…' : '加载更多日历'}</button>}</div>
    </Card>
    {review && <Modal title={review.confirmed ? '查看日历版本' : '核对日历版本'} close={() => { if (!busy) setReview(null); }} wide>
      <div className={c.review}><p className={s.muted}>下方为这份已保存日历的来源和调休快照，确认操作不会使用上方正在编辑的其他草稿。</p><CalendarSnapshot calendar={review} />
        <ErrorBox error={reviewError} />
        <fieldset disabled={busy}>
          {!review.confirmed && <label className={s.checkbox}><input type="checkbox" checked={reviewChecked} onChange={event => setReviewChecked(event.target.checked)} />已核对日历来源、覆盖范围和全部调休日期</label>}
          <div className={s.actions}><button type="button" onClick={() => setReview(null)}>关闭日历详情</button>{!review.confirmed && <button type="button" className={s.primary} disabled={!reviewChecked} onClick={() => void confirmCalendar(review, true)}>确认此日历版本</button>}</div>
        </fieldset>
        <details><summary>技术详情（可选）</summary><JsonView value={review} /></details>
      </div>
    </Modal>}
  </>;
}
