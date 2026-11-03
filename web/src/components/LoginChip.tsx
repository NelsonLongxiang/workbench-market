import { useEffect, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { LockOutlined, LogoutOutlined } from '@ant-design/icons';

/** 全站登录门的当前身份与退出入口（/api/auth/me）。登录门关着（off）且没有登录 cookie 时不显示。
 *  退出只清本站登录 cookie；Odoo 会话由 Odoo 自己管，浏览器还登着 Odoo 时刷新仍会被认出来。 */
type Me = { gate: 'enforce' | 'off'; authenticated: boolean; via: 'cli' | 'token' | 'cookie' | 'odoo' | null; login: string | null };
const VIA: Record<string, string> = { cookie: '管理员口令登录', odoo: 'Odoo', token: '管理员口令', cli: '本机' };

export default function LoginChip() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (live) setMe(j); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!me || (me.gate !== 'enforce' && me.via !== 'cookie') || !me.authenticated || !me.via) return null;

  const logout = async () => {
    setBusy(true);
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 照样去登录页 */ }
    window.location.assign('/login');
  };
  const label = me.via === 'odoo' && me.login ? `Odoo · ${me.login}` : VIA[me.via];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginInlineEnd: 8 }}>
      <Tag icon={<LockOutlined />} color="default" style={{ marginInlineEnd: 0 }} title="本站登录身份">{label}</Tag>
      <Tooltip title={me.via === 'odoo' ? '只清除本站登录；Odoo 会话需在 Odoo 里退出，否则刷新后仍会自动登录' : '清除本站登录，回到登录页'}>
        <Button size="small" type="link" icon={<LogoutOutlined />} loading={busy} onClick={logout}>退出</Button>
      </Tooltip>
    </span>
  );
}
