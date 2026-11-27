/** 视图台页面：从市场打开一张视图台卡片（入口 200）后画这一页。
 *  顶栏：返回、台名、右边「详情」；下面一排视图页签（一份视图就不出），地址带 ?v=<键>，筛选值带 p.<字段>，链接发给别人看到的是同一份。
 *  正文：带外框的 BenchView（和驾驶舱里同一套组件，驾驶舱里是不带外框的紧凑版）。表单在这里能交：交上去之后整页重新取数；没交上去在表单里说原因。
 *  台标识、视图键都不写在页面的字上（键只在地址里）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Empty, Result, Skeleton } from 'antd';
import { ApiOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { BenchView, type ViewResult } from '../bench-blocks/BenchView';
import { getBenchView, submitBenchForm, type BenchEntry } from '../api';
import { useChangePoll } from '../bench-change-poll';
import UseTopBar from '../components/UseTopBar';
import BenchLink from './BenchLink';
import { BackToTop, TocLayout, useAnchorJump } from '../components/PageToc';
import ViewTabs from '../components/ViewTabs';
import { viewTocEntries } from '../page-toc-view';
import { BENCH_VIEWS_OFF, benchViewError, isBenchViewsOff } from '../cockpit-frame-view';
import { afterReload, formError, pageTitle, paramsFromQuery, pollAction, shouldRefreshEntry, toQuery, viewFromQuery, type PollAction } from '../bench-page-view';
import BenchRename from './BenchRename';
import { ReportsLink } from './BenchReports';

type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult; requestKey: string } | { phase: 'off' } | { phase: 'error'; text: string };

export default function BenchPage({ cardId, entry, refreshEntry }: { cardId: string; entry: BenchEntry; refreshEntry: () => Promise<BenchEntry | null> }) {
  const nav = useNavigate();
  const [q, setQ] = useSearchParams();
  const view = viewFromQuery(entry, q);
  const params = paramsFromQuery(q);
  const key = JSON.stringify([cardId, view, params]);
  const [s, setS] = useState<State>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  useEffect(() => { document.title = pageTitle(entry); }, [entry]);
  // 标签页切回前台：重新问一次入口（别人改了台名，回来看到的是新名字）；30 秒内只问一次，不轮询
  const lastEntryAt = useRef(Date.now());
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== 'visible' || !shouldRefreshEntry(lastEntryAt.current, Date.now())) return;
      lastEntryAt.current = Date.now();
      void refreshEntry();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => { document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); };
  }, [refreshEntry]);

  // background：实时刷新触发的后台取数。临时失败时留着旧图（afterReload 的 keep），交给轮询退避再试
  const load = useCallback(async (background = false): Promise<PollAction> => {
    const mine = ++seq.current;
    const r = await getBenchView({ bench: cardId, view }, params);
    if (mine !== seq.current) return 'ok'; // 连着换了几次视图或筛选：只认最后一次（这一次由新的那次接手）
    setRefreshing(false);
    const act = pollAction(r.status, r.error, !!r.body);
    const next = afterReload(act, background);
    if (next === 'show') setS({ phase: 'ok', result: r.body as ViewResult, requestKey: key });
    else if (next === 'collapse') setS(isBenchViewsOff(r.status, r.error) ? { phase: 'off' } : { phase: 'error', text: benchViewError(r.status, r.error) });
    return act;
  // key 是视图和筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, key]);
  // 实时刷新：台库或视图变了就在后台重新取数（旧图照常显示）。没权限、台没了、未开启：作废在途的取数、收起旧结果
  const { paused } = useChangePoll({
    bench: cardId, cursor: s.phase === 'ok' ? s.result.cursor : null, active: s.phase === 'ok' && s.requestKey === key && !refreshing,
    onChanged: () => load(true),
    onStop: (status, error) => { seq.current++; setS(isBenchViewsOff(status, error) ? { phase: 'off' } : { phase: 'error', text: benchViewError(status, error) }); },
  });
  // 换了视图：先回骨架，免得新数据回来前正文还是上一份视图的、看错；只改筛选（同一份视图）时留着现在的数据，刷新按钮转着
  const shownView = useRef(view);
  useEffect(() => {
    const switched = shownView.current !== view;
    shownView.current = view;
    setS((cur) => (cur.phase === 'ok' && !switched ? cur : { phase: 'loading' }));
    setRefreshing(true); void load();
  // view 已经在 load 的 key 里，换视图一定会走到这里
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const go = (v: string, p: Record<string, string>) => setQ(new URLSearchParams(toQuery(entry, v, p)), { replace: false });
  // #1099 打开带 #<块键> 的地址：这份视图画好以后定位到那一块
  useAnchorJump(s.phase === 'ok', view);
  const submit = async (block: number, values: Record<string, unknown>) => {
    const version = s.phase === 'ok' ? s.result.version : entry.version;
    const r = await submitBenchForm(cardId, { view, block, version, values });
    if (r.status !== 200) throw formError(r.status, r.body);
    void load(); // 交上去了：整页按现在的视图和筛选重新取数
  };

  return (
    <div className="wm-use-wrap" data-testid="bench-page">
      <UseTopBar cardId={cardId} page="bench" title={<span className="wm-use-title" data-testid="bench-page-name">{entry.bench.title}</span>}>
        <div className="wm-bp-bar-extra">
          <BenchRename cardId={cardId} entry={entry} refreshEntry={refreshEntry} />
          <BenchLink cardId={cardId} entry={entry} refreshEntry={refreshEntry} />
          <ReportsLink cardId={cardId} entry={entry} />
          {entry.can.mcp ? <Link to={`/bench-mcp/${encodeURIComponent(entry.bench.slug)}`} data-testid="bench-page-mcp"><Button type="text" size="small" icon={<ApiOutlined />}>MCP 授权</Button></Link> : null}
          <Link to={`/market/wb/${encodeURIComponent(cardId)}`} data-testid="bench-page-detail"><Button type="text" size="small" icon={<InfoCircleOutlined />}>详情</Button></Link>
        </div>
      </UseTopBar>
      <div className="wm-bp-head">
        <h1 className="wm-bp-title" data-testid="bench-page-title">{entry.title}</h1>
        {entry.views.length > 1 ? (
          <ViewTabs views={entry.views} view={view} onPick={(k) => { if (k !== view) go(k, {}); }}>{entry.views.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={v.key === view} className={v.key === view ? 'wm-ck-tab on' : 'wm-ck-tab'} onClick={() => { if (v.key !== view) go(v.key, {}); }} data-testid="bench-page-tab">
                {v.title}
              </button>
            ))}</ViewTabs>
        ) : null}
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={refreshing && s.phase === 'ok'} onClick={() => { setRefreshing(true); void refreshEntry(); void load(); }} className="wm-bp-refresh" data-testid="bench-page-refresh">刷新</Button>
      </div>
      <main className="wm-bp-body">
        {paused && s.phase === 'ok' && <div className="wm-bb-truncated" role="status" data-testid="bench-page-poll-paused">自动刷新暂停（连不上服务），稍后会再试；现在显示的是上一次取到的数据。</div>}
        {s.phase === 'loading' ? <div className="wm-dash-card" data-testid="bench-page-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>
          : s.phase === 'off' ? <div className="wm-bp-state" data-testid="bench-page-off"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={BENCH_VIEWS_OFF} /></div>
            : s.phase === 'error' ? <div className="wm-bp-state" data-testid="bench-page-error"><Result status="warning" title={s.text} extra={<Button onClick={() => { setS({ phase: 'loading' }); void load(); }}>再试一次</Button>} /></div>
              : <TocLayout entries={viewTocEntries(s.result.blocks)}><BenchView result={s.result} tableBench={cardId} imageBench={cardId} tableDisabled={refreshing || s.requestKey !== key} frame="card" filterValue={params} onParams={(p) => go(view, p)} onSubmit={submit} /></TocLayout>}
        <BackToTop />
      </main>
    </div>
  );
}
