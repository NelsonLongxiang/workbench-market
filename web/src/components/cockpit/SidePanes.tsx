/** 驾驶舱两侧的块：左边「等你拍板」（「关注」给这个人的条目，用全景同一张卡，当场能办），
 *  右边「办理过程」（左边点了「看办理过程」的那件事项的时间线，和详情页同一个组件）和「事项」（最近变化的事项）。
 *  都读真接口；读不到、没登录、为空各有一句说法。 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, Skeleton, Tag, Typography } from 'antd';
import { adminActive, apiFetch, subscribeAdminToken } from '../../admin-token';
import { answerChoices, groupCards, workItemIdOf, type AttentionItem, type LogRow } from '../../attention-view';
import { ATTENTION_CHANGED, getRosterTeams, getWorkItem } from '../../api';
import DecisionCard from '../DecisionCard';
import WorkItemTimeline from '../WorkItemTimeline';
import { rosterNames, withRoster } from '../../names';
import { seatLabel, who } from '../../people';
import { hiddenInTimeline, stateLabel } from '../../work-item-view';
import RelTime from '../RelTime';

type Load<T> = { state: 'loading' } | { state: 'ok'; rows: T[] } | { state: 'error'; status: number };
const sayError = (status: number, what: string) => (status === 401 ? '请先登录' : status === 403 ? `你的账号现在看不了${what}` : `读不到${what}，稍后再试`);

function useList<T>(url: string, pick: (body: unknown) => T[]): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch(url);
        const body: unknown = await r.json().catch(() => ({}));
        if (live) setS(r.ok ? { state: 'ok', rows: pick(body) } : { state: 'error', status: r.status });
      } catch { if (live) setS({ state: 'error', status: 0 }); }
    })();
    return () => { live = false; };
  // pick 是稳定的取数函数，只跟着 url 重读
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return s;
}

/** 等你拍板：全景同一张卡（当场能办），只列轮到你、能当场办的——件数和侧栏角标、全景同一个算法。
 *  挂着事项的卡下面多一个「看办理过程」，右栏切到那件事的时间线。
 *  还没按这个驾驶舱筛：驾驶舱和事项之间没有关联字段，先列该你办的全部 */
export function AttentionPane({ onCount, onPick, picked }: { onCount?: (n: number) => void; onPick?: (workItemId: string) => void; picked?: string | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const on = () => setTick((n) => n + 1); window.addEventListener(ATTENTION_CHANGED, on); return () => window.removeEventListener(ATTENTION_CHANGED, on); }, []);
  const s = useList<AttentionItem>(`/api/attention?_=${tick}`, (b) => (Array.isArray((b as { items?: unknown }).items) ? (b as { items: AttentionItem[] }).items : []));
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const rows = s.state === 'ok' ? groupCards(s.rows, (x) => answerChoices(admin, x)).now : [];
  useEffect(() => { if (s.state === 'ok') onCount?.(rows.length); }, [s, rows.length, onCount]);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '等你拍板的事')}</Typography.Text></div>;
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有要你拍板的事" />;
  return <div className="wm-ck-cards" data-testid="ck-attention">{rows.map((a) => {
    const wid = workItemIdOf(a);
    return <div key={`${a.source}:${a.source_id}`} className={wid && wid === picked ? 'wm-ck-card on' : 'wm-ck-card'}>
      <DecisionCard item={a} admin={admin} onDone={() => undefined} />
      {wid && onPick && <Button type="link" size="small" className="wm-ck-card-pick" onClick={() => onPick(wid)} data-testid="ck-pick">看办理过程 →</Button>}
    </div>;
  })}</div>;
}

type Detail = { item?: { title?: string; seat?: unknown }; log?: LogRow[] };
/** 办理过程：一件事项的时间线。没选的时候说怎么选 */
export function ProcessPane({ itemId }: { itemId: string | null }) {
  const [s, setS] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'ok'; d: Detail } | { state: 'error'; status: number }>({ state: 'idle' });
  const [roster, setRoster] = useState<Record<string, string>>({});
  // 名册只在选了一件之后才读（没选的时候用不上）
  const wantRoster = itemId !== null;
  useEffect(() => { if (wantRoster) void getRosterTeams().then((t) => setRoster(rosterNames(t))); }, [wantRoster]);
  useEffect(() => {
    if (!itemId) { setS({ state: 'idle' }); return; }
    let live = true;
    setS({ state: 'loading' });
    void getWorkItem(itemId).then((r) => { if (live) setS(r.status >= 200 && r.status < 300 ? { state: 'ok', d: r.body as Detail } : { state: 'error', status: r.status }); });
    return () => { live = false; };
  }, [itemId]);
  if (s.state === 'idle') return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="在左边「等你拍板」里点一条的「看办理过程」，这里显示它从头到尾怎么办的" />;
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 4 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{s.status === 404 ? '这件事项你看不到，或者已经不在了' : sayError(s.status, '这件事项')}</Typography.Text></div>;
  const log = (s.d.log ?? []).filter((r) => !hiddenInTimeline(r));
  return <div className="wm-ck-pad" data-testid="ck-process">
    <div className="wm-ck-process-h"><Link to={`/work-items/${encodeURIComponent(itemId ?? '')}`}><b>{s.d.item?.title || '（没写标题）'}</b></Link></div>
    <WorkItemTimeline log={log} nameOf={(x) => seatLabel(withRoster(who(x), roster))} />
  </div>;
}

type ItemRow = { id: string; title: string; state: string; updated_at: string };
type Items = { state: 'loading' } | { state: 'ok'; rows: ItemRow[]; view: unknown } | { state: 'error'; status: number };
/** 事项：最近变化的几件。先要「我安排的」（列表接口的 view=mine，#626）；这个视角对看的人不可用（403）就不带视角再要一次，
 *  落在服务端给的第一个有内容的视角。8 秒没回就当读不到。旧的服务端不认 view，照它原来的可见范围给。用的是哪个视角报给页签（onView） */
export function ItemsPane({ onView }: { onView?: (view: unknown) => void }) {
  const [s, setS] = useState<Items>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // 最多等 8 秒：服务端认人要问上游，上游慢的时候不让这一栏一直转（也不拖住整页）
        const get = (url: string) => apiFetch(url, { signal: AbortSignal.timeout(8000) });
        let r = await get('/api/work-items?view=mine&limit=12');
        if (r.status === 403) r = await get('/api/work-items?limit=12');
        const body = await r.json().catch(() => ({})) as { items?: unknown; view?: unknown };
        if (live) setS(r.ok ? { state: 'ok', rows: Array.isArray(body.items) ? body.items as ItemRow[] : [], view: body.view } : { state: 'error', status: r.status });
      } catch { if (live) setS({ state: 'error', status: 0 }); }
    })();
    return () => { live = false; };
  }, []);
  useEffect(() => { if (s.state === 'ok') onView?.(s.view); }, [s, onView]);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '事项')}</Typography.Text></div>;
  if (!s.rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有事项" />;
  return <ul className="wm-ck-list" data-testid="ck-items">{s.rows.map((r) => <li key={r.id}>
    <Link to={`/work-items/${encodeURIComponent(r.id)}`}>{r.title || '（没写标题）'}</Link>
    <span><Tag>{stateLabel(r.state)}</Tag><RelTime value={r.updated_at} /></span>
  </li>)}</ul>;
}
