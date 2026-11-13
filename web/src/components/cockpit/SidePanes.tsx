/** 驾驶舱两侧的块：左边「等你拍板」（「关注」给这个人的条目，照原型一行一条的紧凑行），
 *  右边「办理过程」（左边选中的那一条：上面是它的答法——全景同一张卡，下面是它挂的事项的时间线，和详情页同一个组件）和「事项」（最近变化的事项）。
 *  都读真接口；读不到、没登录、为空各有一句说法。 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, Skeleton, Tag, Typography } from 'antd';
import './attention-rows.css';
import { adminActive, apiFetch, subscribeAdminToken } from '../../admin-token';
import { answerChoices, groupCards, waited, workItemIdOf, type AttentionItem, type LogRow } from '../../attention-view';
import { rowKey, rowTag, stillThere, TAG_COLOR } from '../../cockpit-attention';
import { pageLink, fallbackPlace } from '../../page-paths';
import { ATTENTION_CHANGED, getMyTeams, getRosterTeams, getTeams, getWorkItem } from '../../api';
import { busyText, ledTeams, myStaff, staffLink, type LedTeam, type StaffCard } from '../../ai-staff-view';
import DecisionCard from '../DecisionCard';
import WorkItemTimeline from '../WorkItemTimeline';
import { rosterNames, withRoster } from '../../names';
import { seatLabel, waitingLabel, who } from '../../people';
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

/** 等你拍板：照原型一行一条（标题、等了多久、右边一个「等你做什么」的标签），没有按钮；点一行在右栏「办理过程」看它、在那里办。
 *  只列轮到你、能当场办的——件数和侧栏角标、全景同一个算法（groupCards 的 now，即 isMyDecision）。
 *  选中的那一条答完会从列表里消失：这时告诉页面「没选了」，右栏回到没选的样子。
 *  还没按这个驾驶舱筛：驾驶舱和事项之间没有关联字段，先列该你办的全部 */
export function AttentionPane({ onCount, onPick, picked }: { onCount?: (n: number) => void; onPick?: (item: AttentionItem | null) => void; picked?: string | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const on = () => setTick((n) => n + 1); window.addEventListener(ATTENTION_CHANGED, on); return () => window.removeEventListener(ATTENTION_CHANGED, on); }, []);
  const s = useList<AttentionItem>(`/api/attention?_=${tick}`, (b) => (Array.isArray((b as { items?: unknown }).items) ? (b as { items: AttentionItem[] }).items : []));
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const rows = s.state === 'ok' ? groupCards(s.rows, (x) => answerChoices(admin, x)).now : [];
  useEffect(() => { if (s.state === 'ok') onCount?.(rows.length); }, [s, rows.length, onCount]);
  const gone = s.state === 'ok' && picked != null && !stillThere(picked, rows);
  useEffect(() => { if (gone) onPick?.(null); }, [gone, onPick]);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '等你拍板的事')}</Typography.Text></div>;
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有要你拍板的事" />;
  return <div className="wm-ck-rows" data-testid="ck-attention" role="list">
    {/* 驾驶舱和事项之间还没有关联字段，列的是该你办的全部（协调：标题下写明，别让人以为只是这个驾驶舱的） */}
    <Typography.Text type="secondary" className="wm-caption wm-ck-rows-scope" data-testid="ck-attention-scope">列的是该你办的全部，还没按这个驾驶舱筛</Typography.Text>
    {rows.map((a) => {
      const k = rowKey(a);
      const asker = a.category === 'ask' ? waitingLabel(a.waiting_for, { people: [a.creator ?? {}], name: a.waiting_for_name }) : '';
      return <button key={k} type="button" role="listitem" aria-current={k === picked ? 'true' : undefined} className={k === picked ? 'wm-ck-row on' : 'wm-ck-row'} data-testid="ck-row" data-key={k} onClick={() => onPick?.(a)}>
        <span className="wm-ck-row-main">
          <span className="wm-ck-row-title">{a.title || '（没写标题）'}</span>
          <span className="wm-ck-row-sub">等了 {waited(a.since)}</span>
        </span>
        <Tag color={TAG_COLOR[a.category] ?? 'default'}>{rowTag(a, asker)}</Tag>
      </button>;
    })}
  </div>;
}

type Detail = { item?: { title?: string; seat?: unknown }; log?: LogRow[] };
/** 办理过程：左栏选中的那一条。上面「看详情 →」和它的答法（全景同一张卡、同一套答法）；它挂着事项的，下面是那件事项的时间线。
 *  没选的时候说怎么选；挂的不是事项（授权、核准这类）就只有答法和去处 */
export function ProcessPane({ item }: { item: AttentionItem | null }) {
  const itemId = item ? workItemIdOf(item) : null;
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
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
  if (!item) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="在左边「等你拍板」里点一条，这里显示它的答法和从头到尾怎么办的" />;
  const more = itemId ? `/work-items/${encodeURIComponent(itemId)}` : pageLink(item.link) ?? fallbackPlace(item.source).link;
  const log = s.state === 'ok' ? (s.d.log ?? []).filter((r) => !hiddenInTimeline(r)) : [];
  return <div className="wm-ck-pad wm-ck-picked" data-testid="ck-process">
    {more && <div className="wm-ck-picked-top"><Link to={more} data-testid="ck-process-more">看详情 →</Link></div>}
    <div data-testid="ck-process-answer"><DecisionCard key={rowKey(item)} item={item} admin={admin} onDone={() => undefined} more={false} /></div>
    {itemId && s.state === 'loading' && <Skeleton active paragraph={{ rows: 4 }} />}
    {itemId && s.state === 'error' && <Typography.Text type="secondary">{s.status === 404 ? '这件事项你看不到，或者已经不在了' : sayError(s.status, '这件事项的办理过程')}</Typography.Text>}
    {itemId && s.state === 'ok' && <div data-testid="ck-process-timeline"><WorkItemTimeline log={log} nameOf={(x) => seatLabel(withRoster(who(x), roster))} /></div>}
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

/** AI 员工：分给我的成员（首字头像、名字、团队、在不在线、手上在办几件）；负责人多一组「我负责的团队的成员」。
 *  点一个去事项列表「我的 AI 员工手上的」视角按它筛。本周办结、通过率没有数，不放 */
export function StaffPane() {
  const [s, setS] = useState<{ state: 'loading' } | { state: 'ok'; mine: StaffCard[]; led: LedTeam[] } | { state: 'error'; status: number }>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      const m = await getMyTeams();
      if (!live) return;
      if (m.status < 200 || m.status >= 300) { setS({ state: 'error', status: m.status }); return; }
      const mine = myStaff(m.body);
      const me = typeof (m.body as { principal?: unknown } | null)?.principal === 'string' ? (m.body as { principal: string }).principal : '';
      const leads = Array.isArray((m.body as { teams?: unknown } | null)?.teams) && ((m.body as { teams: unknown[] }).teams.length > 0);
      // 只有负责团队的人才去读 /api/teams：普通员工用不上
      const t = leads ? await getTeams() : null;
      if (!live) return;
      setS({ state: 'ok', mine, led: t && t.status >= 200 && t.status < 300 ? ledTeams(t.body, me, new Set(mine.map((c) => c.key))) : [] });
    })();
    return () => { live = false; };
  }, []);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, 'AI 员工')}</Typography.Text></div>;
  const card = (c: StaffCard) => <li key={c.key} data-testid="ck-staff">
    <Link to={staffLink(c)} className="wm-ck-staff">
      <span className="wm-avatar" aria-hidden>{c.initial}</span>
      <span className="wm-ck-staff-main"><b>{c.name}</b><Typography.Text type="secondary" className="wm-caption">{[c.team, c.online ? '在线' : '不在线'].filter(Boolean).join(' · ')}</Typography.Text></span>
      <Typography.Text type="secondary" className="wm-caption wm-ck-staff-busy">{busyText(c.active)}</Typography.Text>
    </Link>
  </li>;
  return <div data-testid="ck-staff-pane">
    <div className="wm-ck-pad wm-ck-note"><Typography.Text type="secondary" className="wm-caption">列的是全部，还没按这个驾驶舱筛</Typography.Text></div>
    <div className="wm-ck-sub">分给你的 AI 员工</div>
    {s.mine.length
      ? <ul className="wm-ck-list" data-testid="ck-staff-mine">{s.mine.map(card)}</ul>
      : <div className="wm-ck-pad" data-testid="ck-staff-none"><Typography.Text type="secondary">还没有分给你的 AI 员工。</Typography.Text> <Link to="/team">去团队页看看 →</Link></div>}
    {s.led.map((t) => <div key={t.key} data-testid="ck-staff-led">
      <div className="wm-ck-sub">我负责的团队：{t.name}</div>
      {t.members.length ? <ul className="wm-ck-list">{t.members.map(card)}</ul> : <div className="wm-ck-pad"><Typography.Text type="secondary">这个团队还没有别的成员。</Typography.Text></div>}
    </div>)}
  </div>;
}
