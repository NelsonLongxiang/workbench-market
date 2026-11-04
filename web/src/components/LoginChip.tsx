import { useEffect, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { LockOutlined, LogoutOutlined } from '@ant-design/icons';
import { logoutCurrentSession } from '../odoo-logout';

/** 全站登录门的当前身份与退出入口（/api/auth/me）。登录门关着（off）且没有登录 cookie 时不显示。
 *  同主机 Odoo 代理启用时退出同时撤销 Odoo 会话；旧模式下提示 Odoo 会话仍有效。 */
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
    const result = await logoutCurrentSession();
    if (!result.ok) window.alert(result.message ?? '无法确认已退出。');
    window.location.assign('/login');
  };
  const label = me.via === 'odoo' && me.login ? `Odoo · ${me.login}` : VIA[me.via];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginInlineEnd: 8 }}>
      <Tag icon={<LockOutlined />} color="default" style={{ marginInlineEnd: 0 }} title="本站登录身份">{label}</Tag>
      <Tooltip title={me.via === 'odoo' ? '退出市场与 Odoo 会话（旧模式会提示另行退出 Odoo）' : '退出当前登录并回到登录页'}>
        <Button size="small" type="link" icon={<LogoutOutlined />} loading={busy} onClick={logout}>退出</Button>
      </Tooltip>
    </span>
  );
}
