/**
 * 用户卡里的「改密码」（站内账号，docs/local-accounts.md）：/api/auth/me 说这个人有站内账号（local_account）才出现。
 * 弹框填原密码、新密码、再输一次，页面先按服务端同样的规则核一遍（access-view.ts 的 passwordFormProblem），
 * 再交 POST /api/local-accounts/_self/password。改好之后这个账号的会话全部注销，回登录页用新密码再登。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { changeOwnPassword, getAuthMe } from '../api';
import { accountActionProblem, hasLocalAccount, localUsernameOf, passwordFormProblem } from '../access-view';

export default function PasswordChip() {
  const [me, setMe] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void getAuthMe().then((j) => { if (live) setMe(j); });
    return () => { live = false; };
  }, []);
  if (!me) return null; // 变异（勿合）：取到了就给「改密码」，不看是不是站内账号

  const username = localUsernameOf(me); // 站内用户名，不是 login（飞书等方式登录时两者不同）
  const problem = passwordFormProblem(current, next, confirm, username);
  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setErr(null); };
  const submit = async () => {
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    const r = await changeOwnPassword(current, next);
    setBusy(false);
    const p = accountActionProblem(r);
    if (p) { setErr(p); return; }
    reset(); setDone(true);
  };
  const relogin = () => window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);

  return (
    <>
      <Button size="small" type="link" icon={<KeyOutlined />} data-testid="pw-open" onClick={() => { reset(); setDone(false); setOpen(true); }}>改密码</Button>
      <Modal open={open} title="改密码" destroyOnClose data-testid="pw-modal"
        onCancel={() => { if (done) relogin(); else { setOpen(false); reset(); } }}
        footer={done
          ? <Button type="primary" data-testid="pw-relogin" onClick={relogin}>去登录</Button>
          : [<Button key="c" onClick={() => { setOpen(false); reset(); }}>算了</Button>,
            <Button key="ok" type="primary" loading={busy} disabled={!!problem} data-testid="pw-submit" onClick={submit}>改好</Button>]}>
        {done ? (
          <Alert type="success" showIcon data-testid="pw-done" message="密码改好了" description="为了安全，这个账号所有已登录的地方都已退出。请用新密码重新登录。" />
        ) : (
          <form className="wm-pw-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <label htmlFor="pw-current">原密码</label>
            <Input.Password id="pw-current" data-testid="pw-current" autoComplete="current-password" value={current} maxLength={512} onChange={(e) => setCurrent(e.target.value)} />
            <label htmlFor="pw-next">新密码</label>
            <Input.Password id="pw-next" data-testid="pw-next" autoComplete="new-password" value={next} maxLength={512} onChange={(e) => setNext(e.target.value)} />
            <label htmlFor="pw-confirm">再输一次</label>
            <Input.Password id="pw-confirm" data-testid="pw-confirm" autoComplete="new-password" value={confirm} maxLength={512} onChange={(e) => setConfirm(e.target.value)} />
            <p className="wm-pw-hint">至少 10 位，不能和用户名一样。改好之后要重新登录。</p>
            {(err || (next && confirm && problem)) && <Alert type="warning" showIcon data-testid="pw-problem" message={err ?? problem} />}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        )}
      </Modal>
    </>
  );
}
