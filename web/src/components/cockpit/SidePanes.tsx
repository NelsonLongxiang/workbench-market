/** 驾驶舱两侧的块：左边「等你拍板」（「关注」给这个人的条目），右边「事项」（最近变化的事项）。
 *  都读真接口；读不到、没登录、为空各有一句说法。点一条去它该去的页面。 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Skeleton, Tag, Typography } from 'antd';
import { adminActive, apiFetch, subscribeAdminToken } from '../../admin-token';
import { answerChoices, groupCards, waited, type AttentionItem } from '../../attention-view';
import { stateLabel } from '../../work-item-view';
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

const CATEGORY: Record<string, string> = { ask: '在问', accept: '等验收', glance: '等过目', review: '等审核', grant: '待核准' };

/** 等你拍板：只列，不在这里办（办在全景的卡片和事项页）；返回件数给页签用。
 *  列哪些、算几件和全景、侧栏角标同一个口径（groupCards 的「现在能办」那一组），不把要到别处处理的和代办的算进来 */
export function AttentionPane({ onCount }: { onCount?: (n: number) => void }) {
  const s = useList<AttentionItem>('/api/attention', (b) => (Array.isArray((b as { items?: unknown }).items) ? (b as { items: AttentionItem[] }).items : []));
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const rows = s.state === 'ok' ? groupCards(s.rows, (x) => answerChoices(admin, x)).now : [];
  useEffect(() => { if (s.state === 'ok') onCount?.(rows.length); }, [s, rows.length, onCount]);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '等你拍板的事')}</Typography.Text></div>;
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有要你拍板的事" />;
  return <ul className="wm-ck-list" data-testid="ck-attention">{rows.map((a) => <li key={`${a.source}:${a.source_id}`}>
    {a.link && !a.link.startsWith('/api/') ? <Link to={a.link}>{a.title}</Link> : <span>{a.title}</span>}
    <Typography.Text type="secondary" className="wm-caption">{[CATEGORY[a.category] ?? '等你处理', a.since && `等了 ${waited(a.since)}`].filter(Boolean).join(' · ')}</Typography.Text>
  </li>)}</ul>;
}

type ItemRow = { id: string; title: string; state: string; updated_at: string };
type Items = { state: 'loading' } | { state: 'ok'; rows: ItemRow[]; view: unknown } | { state: 'error'; status: number };
/** 事项：最近变化的几件。先要「我安排的」（列表接口的 view=mine，#626）；这个视角对看的人不可用（403）就不带视角再要一次，
 *  落在服务端给的第一个有内容的视角。旧的服务端不认 view，照它原来的可见范围给。用的是哪个视角报给页签（onView） */
export function ItemsPane({ onView }: { onView?: (view: unknown) => void }) {
  const [s, setS] = useState<Items>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let r = await apiFetch('/api/work-items?view=mine&limit=12');
        if (r.status === 403) r = await apiFetch('/api/work-items?limit=12');
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
