/** 视图台页面：从市场打开一张视图台卡片（入口 200）后画这一页。
 *  顶栏：返回、台名、右边「详情」；下面一排视图页签（一份视图就不出），地址带 ?v=<键>，筛选值带 p.<字段>，链接发给别人看到的是同一份。
 *  正文：带外框的 BenchView（和驾驶舱里同一套组件，驾驶舱里是不带外框的紧凑版）。表单在这里能交：交上去之后整页重新取数；没交上去在表单里说原因。
 *  台标识、视图键都不写在页面的字上（键只在地址里）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Empty, Result, Skeleton, Typography } from 'antd';
import { ArrowLeftOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { BenchView, type ViewResult } from '../bench-blocks/BenchView';
import { getBenchView, submitBenchForm, type BenchEntry } from '../api';
import { BENCH_VIEWS_OFF, benchViewError, isBenchViewsOff } from '../cockpit-frame-view';
import { formError, pageTitle, paramsFromQuery, toQuery, viewFromQuery } from '../bench-page-view';

type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult } | { phase: 'off' } | { phase: 'error'; text: string };

export default function BenchPage({ cardId, entry }: { cardId: string; entry: BenchEntry }) {
  const nav = useNavigate();
  const [q, setQ] = useSearchParams();
  const view = viewFromQuery(entry, q);
  const params = paramsFromQuery(q);
  const key = JSON.stringify([view, params]);
  const [s, setS] = useState<State>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  useEffect(() => { document.title = pageTitle(entry); }, [entry]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await getBenchView({ bench: cardId, view }, params);
    if (mine !== seq.current) return; // 连着换了几次视图或筛选：只认最后一次
    setRefreshing(false);
    if (r.status === 200 && r.body) setS({ phase: 'ok', result: r.body as ViewResult });
    else if (isBenchViewsOff(r.status, r.error)) setS({ phase: 'off' });
    else setS({ phase: 'error', text: benchViewError(r.status, r.error) });
  // key 是视图和筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, key]);
  useEffect(() => { setS((cur) => (cur.phase === 'ok' ? cur : { phase: 'loading' })); setRefreshing(true); void load(); }, [load]);

  const go = (v: string, p: Record<string, string>) => setQ(new URLSearchParams(toQuery(entry, v, p)), { replace: false });
  const submit = async (block: number, values: Record<string, unknown>) => {
    const version = s.phase === 'ok' ? s.result.version : entry.version;
    const r = await submitBenchForm(cardId, { view, block, version, values });
    if (r.status !== 200) throw formError(r.status, r.body);
    void load(); // 交上去了：整页按现在的视图和筛选重新取数
  };

  const back = () => (window.history.length > 1 ? nav(-1) : nav('/'));
  return (
    <div className="wm-use-wrap" data-testid="bench-page">
      <div className="wm-use-bar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={back} aria-label="返回" />
        <Typography.Title level={5} className="wm-use-title" data-testid="bench-page-name">{entry.bench.title}</Typography.Title>
        <div className="wm-bp-bar-extra">
          <Link to={`/market/wb/${encodeURIComponent(cardId)}`} data-testid="bench-page-detail"><Button type="text" size="small" icon={<InfoCircleOutlined />}>详情</Button></Link>
        </div>
      </div>
      <div className="wm-bp-head">
        <h1 className="wm-bp-title" data-testid="bench-page-title">{entry.title}</h1>
        {entry.views.length > 1 ? (
          <div className="wm-bp-tabs" role="tablist" aria-label="视图">
            {entry.views.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={v.key === view} className={v.key === view ? 'wm-ck-tab on' : 'wm-ck-tab'} onClick={() => { if (v.key !== view) go(v.key, {}); }} data-testid="bench-page-tab">
                {v.title}
              </button>
            ))}
          </div>
        ) : null}
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={refreshing && s.phase === 'ok'} onClick={() => { setRefreshing(true); void load(); }} className="wm-bp-refresh" data-testid="bench-page-refresh">刷新</Button>
      </div>
      <main className="wm-bp-body">
        {s.phase === 'loading' ? <div className="wm-dash-card" data-testid="bench-page-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>
          : s.phase === 'off' ? <div className="wm-bp-state" data-testid="bench-page-off"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={BENCH_VIEWS_OFF} /></div>
            : s.phase === 'error' ? <div className="wm-bp-state" data-testid="bench-page-error"><Result status="warning" title={s.text} extra={<Button onClick={() => { setS({ phase: 'loading' }); void load(); }}>再试一次</Button>} /></div>
              : <BenchView result={s.result} frame="card" onParams={(p) => go(view, p)} onSubmit={submit} />}
      </main>
    </div>
  );
}
