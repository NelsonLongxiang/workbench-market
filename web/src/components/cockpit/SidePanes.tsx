/** 驾驶舱两侧的块：左边「等你拍板」（「关注」给这个人的条目），右边「事项」（最近变化的事项）。
 *  都读真接口；读不到、没登录、为空各有一句说法。点一条去它该去的页面。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Skeleton, Tag, Typography } from 'antd';
import { apiFetch } from '../../admin-token';
import { waited, type AttentionItem } from '../../attention-view';
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

/** 等你拍板：只列，不在这里办（办在全景的卡片和事项页）；返回件数给页签用 */
export function AttentionPane({ onCount }: { onCount?: (n: number) => void }) {
  const s = useList<AttentionItem>('/api/attention', (b) => (Array.isArray((b as { items?: unknown }).items) ? (b as { items: AttentionItem[] }).items : []));
  useEffect(() => { if (s.state === 'ok') onCount?.(s.rows.length); }, [s, onCount]);
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '等你拍板的事')}</Typography.Text></div>;
  if (!s.rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有要你拍板的事" />;
  return <ul className="wm-ck-list" data-testid="ck-attention">{s.rows.map((a) => <li key={`${a.source}:${a.source_id}`}>
    {a.link && !a.link.startsWith('/api/') ? <Link to={a.link}>{a.title}</Link> : <span>{a.title}</span>}
    <Typography.Text type="secondary" className="wm-caption">{[CATEGORY[a.category] ?? '等你处理', a.since && `等了 ${waited(a.since)}`].filter(Boolean).join(' · ')}</Typography.Text>
  </li>)}</ul>;
}

type ItemRow = { id: string; title: string; state: string; updated_at: string };
/** 事项：最近变化的几件（可见范围同事项页：管理员看全部，别人只看自己建立的） */
export function ItemsPane() {
  const s = useList<ItemRow>('/api/work-items?limit=12', (b) => (Array.isArray((b as { items?: unknown }).items) ? (b as { items: ItemRow[] }).items : []));
  if (s.state === 'loading') return <div className="wm-ck-pad"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.state === 'error') return <div className="wm-ck-pad"><Typography.Text type="secondary">{sayError(s.status, '事项')}</Typography.Text></div>;
  if (!s.rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有事项" />;
  return <ul className="wm-ck-list" data-testid="ck-items">{s.rows.map((r) => <li key={r.id}>
    <Link to={`/work-items/${encodeURIComponent(r.id)}`}>{r.title || '（没写标题）'}</Link>
    <span><Tag>{stateLabel(r.state)}</Tag><RelTime value={r.updated_at} /></span>
  </li>)}</ul>;
}
