/** 驾驶舱里的一份数据视图：按引用去台的视图入口取数，用数据视图的 BenchView 画。
 *  整份没取到（没权限、没开放、视图不在了、超时）在这一块里说一句，不影响别的块和整页；单个块的问题由块自己说。
 *  块不带外框、表格用紧凑的行高（外框是驾驶舱的这一块）。视图自己的筛选栏先照画：驾驶舱顶上那一排「看的是」接上之后改成由它管。
 *  表单在驾驶舱里先不让提交（写入只对管理层开，入口在台自己的页面）。 */
import { useCallback, useEffect, useState } from 'react';
import { Skeleton, Typography } from 'antd';
import { BenchView, type ViewResult } from '../../bench-blocks/BenchView';
import { getBenchView } from '../../api';
import { benchViewError, type BenchViewRef } from '../../cockpit-frame-view';

type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult } | { phase: 'error'; text: string };

export default function BenchViewPanel({ refItem, params }: { refItem: BenchViewRef; params?: Record<string, string> }) {
  const [own, setOwn] = useState<Record<string, string>>({});
  const [s, setS] = useState<State>({ phase: 'loading' });
  const key = JSON.stringify({ ...params, ...own });
  const load = useCallback(async () => {
    const r = await getBenchView(refItem, { ...params, ...own });
    setS(r.status === 200 && r.body ? { phase: 'ok', result: r.body as ViewResult } : { phase: 'error', text: benchViewError(r.status, r.error) });
  // key 就是筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refItem.bench, refItem.view, key]);
  useEffect(() => { setS((cur) => (cur.phase === 'ok' ? cur : { phase: 'loading' })); void load(); }, [load]);

  if (s.phase === 'loading') return <div className="wm-ck-pad" data-testid="ck-bench-view-loading"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (s.phase === 'error') return <div className="wm-ck-pad" data-testid="ck-bench-view-error"><Typography.Text type="secondary">{s.text}</Typography.Text></div>;
  return <div className="wm-ck-pad" data-testid="ck-bench-view">
    {/* 「不带外框、表格紧凑」的画法（frame="none" dense）在 #617，那条合并后在这里加上 */}
    <BenchView result={s.result} onParams={setOwn} onSubmit={() => Promise.reject(new Error('驾驶舱里不能提交'))} formDisabledReason="要填这张表，请到这个台自己的页面" />
  </div>;
}
