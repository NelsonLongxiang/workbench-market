import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from 'antd';
import WmPage from '../components/WmPage';
import { LifecycleStatus, useLifecycleData } from '../components/LifecycleStatus';
import { adminActive, subscribeAdminToken } from '../admin-token';
import { readLifecycleBoard, type LifecycleRead } from '../lifecycle-view';

export default function LifecycleOverview({ extension }: { extension?: ReactNode }) {
  const { search } = useLocation();
  return <Overview key={search} search={search} extension={extension} />;
}

function Overview({ search, extension }: { search: string; extension?: ReactNode }) {
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const params = new URLSearchParams(search);
  const pd = params.get('pd');
  const asOf = params.get('as_of');
  const query = new URLSearchParams();
  if (pd) query.set('pd', pd);
  if (asOf) query.set('as_of', asOf);
  const path = query.size ? 'board?' + query.toString() : 'board';
  const read = useCallback((get: LifecycleRead) => readLifecycleBoard(get, path), [path]);
  const lifecycle = useLifecycleData(read);
  const { result, lastGood } = lifecycle;
  const data = result?.kind === 'ok' ? result.value : null;
  const filter = [pd, asOf].filter(Boolean).join(' · ');
  const previous = result?.kind === 'stale' ? lastGood?.value : undefined;
  const extra = data ? <Button onClick={lifecycle.retry} loading={lifecycle.loading}>刷新全景</Button> : undefined;
  if (extension && data) return <>
    {data.products === 0 && <LifecycleStatus {...lifecycle} admin={admin} label="生命周期对象" filter={filter} />}
    {extension}
  </>;
  return <WmPage title="生命周期全景" extra={extra}>
    {data && data.products > 0 ? <section className="wm-home-box" aria-label="生命周期对象">
      {filter && <p>筛选：{filter}</p>}
      <p>生命周期对象　{data.products}</p>
      <dl>{Object.entries(data.stages).map(([stage, n]) => <div key={stage}><dt>{stage}</dt><dd>{n}</dd></div>)}</dl>
    </section> : <LifecycleStatus {...lifecycle} admin={admin} label="生命周期对象" filter={filter}
      last={lastGood ? { count: lastGood.value.products, time: lastGood.time } : undefined} />}
    {previous && <section className="wm-home-box" aria-label="上次成功的阶段数量">
      <dl>{Object.entries(previous.stages).map(([stage, n]) => <div key={stage}><dt>{stage}</dt><dd>{n}</dd></div>)}</dl>
    </section>}
  </WmPage>;
}
