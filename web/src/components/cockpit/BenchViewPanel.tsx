/** 驾驶舱里的一份数据视图：按引用去台的视图入口取数，用数据视图的 BenchView 画。
 *  整份没取到（没权限、没开放、视图不在了、超时）在这一块里说一句，不影响别的块和整页；单个块的问题由块自己说。
 *  块不带外框、表格用紧凑的行高（外框是驾驶舱的这一块）。筛选两种用法：单独用时视图自己的筛选栏照画；
 *  放在页签里（shared）时不画，值由页签顶上那一排共用的筛选经 params 传进来，取到的结果经 onLoaded 交回去（页签要知道它认哪些筛选项）。
 *  表单在驾驶舱里先不让提交（写入只对管理层开，入口在台自己的页面）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Skeleton, Typography } from 'antd';
import { BenchView, type ViewResult } from '../../bench-blocks/BenchView';
import { getBenchView } from '../../api';
import { BENCH_VIEWS_OFF, benchViewError, isBenchViewsOff, type BenchViewRef } from '../../cockpit-frame-view';
import { panelHeading } from '../../cockpit-bench-view';

type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult } | { phase: 'off' } | { phase: 'error'; text: string };

export default function BenchViewPanel({ refItem, params, shared, heading, onLoaded }: {
  refItem: BenchViewRef; params?: Record<string, string>;
  /** 筛选由外面管：不画视图自己的筛选栏 */
  shared?: boolean;
  /** 上面加一行小标题（视图名 · 台名；没取到时只写「一份数据视图」，不露标识） */
  heading?: boolean;
  /** 每次取完告诉外面：取到了给结果，没取到给 null */
  onLoaded?: (i: string, result: ViewResult | null) => void;
}) {
  const [own, setOwn] = useState<Record<string, string>>({});
  const [s, setS] = useState<State>({ phase: 'loading' });
  const key = JSON.stringify({ ...params, ...own });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await getBenchView(refItem, { ...params, ...own });
    if (mine !== seq.current) return; // 筛选连着变了几次：只认最后一次取数的应答，早先的晚到了也不用
    const got = r.status === 200 && r.body ? r.body as ViewResult : null;
    onLoaded?.(refItem.i, got);
    setS(got ? { phase: 'ok', result: got } : isBenchViewsOff(r.status, r.error) ? { phase: 'off' } : { phase: 'error', text: benchViewError(r.status, r.error) });
  // key 就是筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refItem.bench, refItem.view, refItem.i, key, onLoaded]);
  useEffect(() => { setS((cur) => (cur.phase === 'ok' ? cur : { phase: 'loading' })); void load(); }, [load]);

  const head = heading ? <div className="wm-ck-bv-head" data-testid="ck-bv-head">{panelHeading(s.phase === 'ok' ? s.result : null)}</div> : null;
  if (s.phase === 'loading') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-loading"><Skeleton active paragraph={{ rows: 3 }} /></div></>;
  // 开关关着不是出错：不用警示色，说一句「数据视图未开启」，面板位照样留着
  if (s.phase === 'off') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-off"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={BENCH_VIEWS_OFF} /></div></>;
  if (s.phase === 'error') return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view-error"><Typography.Text type="secondary">{s.text}</Typography.Text></div></>;
  return <>{head}<div className="wm-ck-pad" data-testid="ck-bench-view">
    <BenchView result={s.result} frame="none" dense hideFilters={shared} onParams={setOwn} onSubmit={() => Promise.reject(new Error('驾驶舱里不能提交'))} formDisabledReason="要填这张表，请到这个台自己的页面" />
  </div></>;
}
