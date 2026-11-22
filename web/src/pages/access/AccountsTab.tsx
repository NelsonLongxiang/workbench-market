/**
 * 「谁能做什么」的「账号」页签（docs/local-accounts.md P4）：站内账号的管理，只有管理员能用（系统管理员也行，账号是系统的事）。
 *  · 待核准：自己注册的账号，核准（新建对应的人）或拒绝（删掉这个还没对接的账号）；
 *  · 建一个账号：用户名、显示名，建好后临时密码只显示这一次；
 *  · 全部账号：状态（正常、已停用、已锁定、要改密码），谁建的、最近登录；重置密码（同样只显示一次新临时密码）、解锁、停用和恢复（要写理由，会留痕）。
 * 接口都在服务端判权；页面只照应答说话。判断和说法在 web/src/access-view.ts（有单测）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { approveLocalAccount, createLocalAccount, getLocalAccounts, rejectLocalAccount, resetLocalAccount, setPrincipalStatus, unlockLocalAccount } from '../../api';
import {
  TEMP_PASSWORD_NOTE, USERNAME_HINT, accountActionProblem, accountOrigin, accountTags, accountsOf, accountsProblem, declineReasonOk, lastLoginLabel, usernameOk,
} from '../../access-view';
import type { LocalAccount, SourceResult, Tone } from '../../access-view';

const TAG: Record<Tone, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };

/** 刚拿到的临时密码：只在这一次显示，换页、刷新就没了 */
type Shown = { username: string; password: string; what: string };

function StatusEdit({ a, onDone }: { a: LocalAccount; onDone: (err: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const disabled = a.principal_status === 'disabled';
  if (!a.principal) return null;
  if (!open) return <Button size="small" danger={!disabled} data-testid={disabled ? 'acct-restore' : 'acct-disable'} onClick={() => setOpen(true)}>{disabled ? '恢复' : '停用'}</Button>;
  return (
    <span className="wm-acct-reason" data-testid="acct-status-form">
      <Input size="small" data-testid="acct-status-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={disabled ? '为什么恢复（会留痕）' : '为什么停用（会留痕）'} />
      <Button size="small" danger={!disabled} type="primary" disabled={!declineReasonOk(reason)} loading={busy} data-testid="acct-status-confirm" onClick={async () => {
        setBusy(true);
        const r = await setPrincipalStatus(a.principal!, disabled, reason.trim());
        setBusy(false); setOpen(false); setReason('');
        onDone(accountActionProblem(r));
      }}>{disabled ? '确认恢复' : '确认停用'}</Button>
      <Button size="small" type="text" disabled={busy} onClick={() => { setOpen(false); setReason(''); }}>算了</Button>
    </span>
  );
}

export default function AccountsTab() {
  const [src, setSrc] = useState<SourceResult | null>(null);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void getLocalAccounts().then((r) => { if (live) setSrc(r); });
    return () => { live = false; };
  }, [tick]);

  /** 做一步：成功就重读列表；带回临时密码的，显示这一次 */
  const act = async (key: string, fn: () => Promise<SourceResult>, what?: string) => {
    setBusy(key); setErr(null);
    const r = await fn();
    setBusy(null);
    const p = accountActionProblem(r);
    if (p) { setErr(p); return false; }
    const temp = r.body && typeof r.body === 'object' ? (r.body as { temp_password?: unknown; account?: { username?: unknown } }) : null;
    if (what && typeof temp?.temp_password === 'string') setShown({ username: String(temp.account?.username ?? ''), password: temp.temp_password, what });
    reload();
    return true;
  };

  if (!src) return <Skeleton active />;
  const problem = accountsProblem(src);
  if (problem) return <Alert className="wm-acc-alert" type={problem.type} showIcon message={problem.text} />;
  const all = accountsOf(src.body);
  const pending = all.filter((a) => a.pending);
  const accounts = all.filter((a) => !a.pending);
  const nameBad = username !== '' && !usernameOk(username);

  const columns: ColumnsType<LocalAccount> = [
    { title: '状态', key: 'st', width: 160, render: (_v, a) => <span className="wm-acc-st">{accountTags(a).map((t) => <Tag key={t.text} color={TAG[t.tone]}>{t.text}</Tag>)}</span> },
    { title: '账号', key: 'who', render: (_v, a) => <span className="wm-acc-who"><b>{a.display_name || a.username}</b>{a.display_name && <span className="wm-acc-kind">{a.username}</span>}</span> },
    { title: '谁建的', key: 'by', render: (_v, a) => accountOrigin(a.created_by) },
    { title: '最近登录', key: 'last', render: (_v, a) => lastLoginLabel(a.last_login_at) },
    { title: '', key: 'ops', render: (_v, a) => (
      <span className="wm-acct-ops" data-testid="acct-ops" data-user={a.username}>
        <Popconfirm title={`给 ${a.username} 重置密码？`} description="会发一个新的临时密码，他已有的登录会被注销。" okText="重置" cancelText="算了" onConfirm={() => act(`reset:${a.username}`, () => resetLocalAccount(a.username), '重置密码')}>
          <Button size="small" loading={busy === `reset:${a.username}`} data-testid="acct-reset">重置密码</Button>
        </Popconfirm>
        {a.locked && <Button size="small" loading={busy === `unlock:${a.username}`} data-testid="acct-unlock" onClick={() => act(`unlock:${a.username}`, () => unlockLocalAccount(a.username))}>解锁</Button>}
        <StatusEdit a={a} onDone={(p) => { if (p) setErr(p); else { setErr(null); reload(); } }} />
      </span>
    ) },
  ];

  return (
    <div data-testid="acct-tab">
      <p className="wm-acc-intro">站内账号用用户名和密码登录，不依赖别的系统。管理员在这里建人、重置密码、解锁、停用；自己注册的账号要在这里核准才进得去。任命管理员走「人和权限」里的授予。</p>
      {err && <Alert className="wm-acc-alert" type="warning" showIcon closable message={err} onClose={() => setErr(null)} data-testid="acct-err" />}
      {shown && (
        <Alert className="wm-acc-alert" type="success" showIcon closable onClose={() => setShown(null)} data-testid="acct-temp"
          message={<span>{shown.what}：{shown.username} 的临时密码 <Typography.Text code copyable data-testid="acct-temp-password">{shown.password}</Typography.Text></span>}
          description={TEMP_PASSWORD_NOTE} />
      )}

      {pending.length > 0 && (
        <>
          <div className="wm-acc-sec"><h3>待核准的注册</h3><span className="wm-acc-n">{pending.length}</span><span className="wm-acc-cap">核准就是给他开通，会新建对应的人</span></div>
          <div className="wm-acc-asks">{pending.map((a) => (
            <div key={a.username} className="wm-acc-ask" data-testid="acct-pending" data-user={a.username}>
              <div className="wm-acc-ask-head"><b>{a.display_name || a.username}</b>{a.display_name && <span className="wm-acc-kind">{a.username}</span>}<Tag color="warning" className="wm-acc-ask-st">待核准</Tag></div>
              <div className="wm-acc-ask-meta">自己注册 · 用户名 {a.username}</div>
              <div className="wm-acc-ask-ops">
                <Button size="small" type="primary" loading={busy === `approve:${a.username}`} data-testid="acct-approve" onClick={() => act(`approve:${a.username}`, () => approveLocalAccount(a.username))}>核准</Button>
                <Popconfirm title={`拒绝 ${a.username} 的注册？`} description="这个账号会被删掉，对方可以换个用户名重新注册。" okText="拒绝" okButtonProps={{ danger: true }} cancelText="算了" onConfirm={() => act(`reject:${a.username}`, () => rejectLocalAccount(a.username).then(() => rejectLocalAccount(a.username)) /* 变异（勿合）：拒绝发两次 */)}>
                  <Button size="small" danger loading={busy === `reject:${a.username}`} data-testid="acct-reject">拒绝</Button>
                </Popconfirm>
              </div>
            </div>
          ))}</div>
        </>
      )}

      <div className="wm-acc-sec"><h3>建一个账号</h3><span className="wm-acc-cap">建好后给一个临时密码，对方第一次登录先改</span></div>
      <form className="wm-acct-new" data-testid="acct-new" onSubmit={async (e) => {
        e.preventDefault();
        if (!usernameOk(username)) return;
        if (await act('create', () => createLocalAccount(username, displayName.trim()), '建好了')) { setUsername(''); setDisplayName(''); }
      }}>
        <Input data-testid="acct-new-username" value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.trim())} placeholder="用户名" status={nameBad ? 'error' : undefined} />
        <Input data-testid="acct-new-name" value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} placeholder="显示名（可不填）" />
        <Button htmlType="submit" type="primary" disabled={!usernameOk(username)} loading={busy === 'create'} data-testid="acct-new-submit">建账号</Button>
        {nameBad && <span className="wm-acc-ask-denied" data-testid="acct-new-hint">用户名只能用{USERNAME_HINT}</span>}
      </form>

      <div className="wm-acc-sec"><h3>全部账号</h3><span className="wm-acc-n">{accounts.length}</span><span className="wm-acc-cap">状态 · 账号 · 谁建的 · 最近登录</span></div>
      {accounts.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有站内账号。在上面建一个，或者等有人自己注册。" />
        : <Table<LocalAccount> className="wm-acc-table" size="middle" rowKey="username" columns={columns} dataSource={accounts} pagination={accounts.length > 20 ? { pageSize: 20 } : false} />}
    </div>
  );
}
