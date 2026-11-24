/** 驾驶舱里的一份数据视图：按引用去台的视图入口取数，用数据视图的 BenchView 画。
 *  整份没取到（没权限、没开放、视图不在了、超时）在这一块里说一句，不影响别的块和整页；单个块的问题由块自己说。
 *  块不带外框、表格用紧凑的行高（外框是驾驶舱的这一块）。视图自己的筛选栏不画：值由页签顶上那一排共用的筛选经 params 传进来，
 *  取到的结果经 onLoaded 交回去（页签要知道它认哪些筛选项）。原来「不共用、自己画筛选栏」的那种用法没有调用方，已删（要用时按当时的需求写、带测试加回来）。
 *  表单在驾驶舱里先不让提交（写入只对管理层开，入口在台自己的页面）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Skeleton, Typography } from 'antd';
import { BenchView, type ViewResult } from '../../bench-blocks/BenchView';
import { getBenchView } from '../../api';
import { useChangePoll } from '../../bench-change-poll';
import { afterReload, pollAction, type PollAction } from '../../bench-page-view';
import { BENCH_VIEWS_OFF, benchViewError, isBenchViewsOff, type BenchViewRef } from '../../cockpit-frame-view';
import { panelHeading } from '../../cockpit-bench-view';

/** 视图自己的筛选栏不画，所以不会有筛选改动交上来 */
const NO_FILTERS = (): void => {};

/** requestKey：这份结果是哪个台、哪份视图、哪组筛选取来的 */
type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult; requestKey: string } | { phase: 'off' } | { phase: 'error'; text: string };

export default function BenchViewPanel({ refItem, params, heading, onLoaded }: {
  /** params：页签顶上那一排共用筛选里，这份视图认的值 */
  refItem: BenchViewRef; params?: Record<string, string>;
  /** 上面加一行小标题（视图名 · 台名；没取到时只写「一份数据视图」，不露标识） */
  heading?: boolean;
  /** 每次取完告诉外面：取到了给结果，没取到给 null */
  onLoaded?: (i: string, result: ViewResult | null) => void;
}) {
  const [s, setS] = useState<State>({ phase: 'loading' });
  const key = JSON.stringify(params ?? {});
  const reqKey = JSON.stringify([refItem.bench, refItem.view, key]);
  const seq = useRef(0);
  // fetching：换了台、视图或筛选后正在取数；这期间不轮询（旧结果不再对应当前筛选）
  const [fetching, setFetching] = useState(false);
  // background：实时刷新触发的后台取数。临时失败时留着旧图、也不叫外面清空（afterReload 的 keep），交给轮询退避再试
  const load = useCallback(async (background = false): Promise<PollAction> => {
    const mine = ++seq.current;
    const r = await getBenchView(refItem, params ?? {});
    if (mine !== seq.current) return 'ok'; // 筛选连着变了几次：只认最后一次取数的应答，早先的晚到了也不用
    setFetching(false);
    const act = pollAction(r.status, r.error, !!r.body);
    const next = afterReload(act, background);
    if (next === 'keep') return act;
    const got = next === 'show' ? r.body as ViewResult : null;
    onLoaded?.(refItem.i, got);
    setS(got ? { phase: 'ok', result: got, requestKey: JSON.stringify([refItem.bench, refItem.view, key]) } : isBenchViewsOff(r.status, r.error) ? { phase: 'off' } : { phase: 'error', text: benchViewError(r.status, r.error) });
    return act;
  // key 就是筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refItem.bench, refItem.view, refItem.i, key, onLoaded]);
  useEffect(() => { setS((cur) => (cur.phase === 'ok' ? cur : { phase: 'loading' })); setFetching(true); void load(); }, [load]);
  // 实时刷新：台库或视图变了在后台重新取数；没权限、台没了、未开启就作废在途的取数、收起旧结果
  const { paused } = useChangePoll({
    bench: refItem.bench, cursor: s.phase === 'ok' ? s.result.cursor : null, active: s.phase === 'ok' && s.requestKey === reqKey && !fetching,
    onChanged: () => load(true),
    // 停下：作废在途取数，收起这一块，也叫页签清掉这份结果（顶上共用筛选栏不再留着它的筛选项）
    onStop: (status, error) => { seq.current++; setFetching(false); onLoaded?.(refItem.i, null); setS(isBenchViewsOff(status, error) ? { phase: 'off' } : { phase: 'error', text: benchViewError(status, error) }); },
  });

  const head = heading ? <div className="wm-ck-bv-head" data-testid="ck-bv-head">{panelHeading(s.phase === 'ok' ? s.result : null)}</div> : null;
  if (s.phase === 'loading') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-loading"><Skeleton active paragraph={{ rows: 3 }} /></div></>;
  // 开关关着不是出错：不用警示色，说一句「数据视图未开启」，面板位照样留着
  if (s.phase === 'off') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-off"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={BENCH_VIEWS_OFF} /></div></>;
  if (s.phase === 'error') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-error"><Typography.Text type="secondary">{s.text}</Typography.Text></div></>;
  return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view">
    {paused && <div className="wm-bb-truncated" role="status" data-testid="ck-bench-view-poll-paused">自动刷新暂停，稍后会再试。</div>}
    <BenchView result={s.result} imageBench={refItem.bench} frame="none" dense hideFilters onParams={NO_FILTERS} onSubmit={() => Promise.reject(new Error('驾驶舱里不能提交'))} formDisabledReason="要填这张表，请到这个台自己的页面" />
  </div></>;
}
