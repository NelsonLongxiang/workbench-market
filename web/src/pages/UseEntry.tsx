import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { getBenchEntry, type BenchEntry } from '../api';
import UseWorkbench from './UseWorkbench';
import BenchPage from './BenchPage';
import { ENTRY_TEXT, entryOutcome, latestOnly, type EntryOutcome } from '../bench-page-view';

/** 打开一张卡片：先问视图台的入口。是视图台、读得到 → 数据视图页；404（不存在的、不是视图台的）、401（没登录）、403（只带管理口令、跨站）
 *  → 一律照原来嵌页面（入口先判权、不透露哪张卡片是视图台）；读不到 → 再试一次 */
export default function UseEntry() {
  const { id = '' } = useParams();
  const [tries, setTries] = useState(0);
  const [out, setOut] = useState<EntryOutcome | null>(null);
  useEffect(() => {
    let live = true;
    setOut(null);
    void getBenchEntry(id).then((r) => { if (live) setOut(entryOutcome(r.status, r.body)); });
    return () => { live = false; };
  }, [id, tries]);
  // 页内显式刷新（BenchPage 的刷新按钮、改名、切回标签页）：后台再问一次入口，不闪整页、不重挂页面；
  // 只有取到新的视图台入口才替换（标题、菜单跟着新）；别的应答（401/403/404/5xx）保持现状，正文那次取数自己会说错。
  // 返回取到的新入口，没取到是 null——调用方据此知道这一次成没成（改名对话框「重新读一次」失败时不改输入框）
  const idNow = useRef(id); idNow.current = id;
  // 连着几次重取（改名后自动的 + 手点「刷新」）只认最后发出的那一次：先发的后到也不会把顶栏退回旧名（latestOnly）
  const refreshEntry = useMemo(() => latestOnly(async (): Promise<BenchEntry | null> => {
    const asked = id;
    const r = await getBenchEntry(asked);
    if (idNow.current !== asked) return null; // 已经换到别的卡片了
    const next = entryOutcome(r.status, r.body);
    return next.kind === 'bench' ? next.entry : null;
  }, (entry) => { if (entry && idNow.current === id) setOut({ kind: 'bench', entry }); }), [id]);
  if (!out) return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }} data-testid="use-entry-loading"><Spin size="large" /></div>;
  if (out.kind === 'bench') return <BenchPage key={id} cardId={id} entry={out.entry} refreshEntry={refreshEntry} />;
  if (out.kind === 'card') return <UseWorkbench />;
  return <div data-testid="use-entry-error"><Result status="warning" title={ENTRY_TEXT.error} subTitle={ENTRY_TEXT.errorSub} extra={<Button type="primary" onClick={() => setTries((n) => n + 1)}>再试一次</Button>} /></div>;
}
