import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { getBenchEntry } from '../api';
import UseWorkbench from './UseWorkbench';
import BenchPage from './BenchPage';
import { ENTRY_TEXT, entryOutcome, type EntryOutcome } from '../bench-page-view';

/** 打开一张卡片：先问视图台的入口。是视图台、读得到 → 数据视图页；404（读不到的、不存在的、不是视图台的，一样的应答）→ 照原来嵌页面；
 *  没登录 → 去登录；只带管理口令或跨站 → 说要用自己的账号；读不到 → 再试一次 */
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
  if (!out) return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }} data-testid="use-entry-loading"><Spin size="large" /></div>;
  if (out.kind === 'bench') return <BenchPage key={id} cardId={id} entry={out.entry} />;
  if (out.kind === 'card') return <UseWorkbench />;
  if (out.kind === 'login') return <div data-testid="use-entry-login"><Result status="info" title={ENTRY_TEXT.login} subTitle={ENTRY_TEXT.loginSub} extra={<Button type="primary" onClick={() => window.location.assign('/login')}>去登录</Button>} /></div>;
  if (out.kind === 'forbidden') return <div data-testid="use-entry-forbidden"><Result status="info" title={ENTRY_TEXT.forbidden} subTitle={ENTRY_TEXT.forbiddenSub} extra={<Link to="/market"><Button>回工作台市场</Button></Link>} /></div>;
  return <div data-testid="use-entry-error"><Result status="warning" title={ENTRY_TEXT.error} subTitle={ENTRY_TEXT.errorSub} extra={<Button type="primary" onClick={() => setTries((n) => n + 1)}>再试一次</Button>} /></div>;
}
