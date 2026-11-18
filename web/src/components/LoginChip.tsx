import { useEffect, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { LockOutlined, LogoutOutlined } from '@ant-design/icons';
import { logoutCurrentSession } from '../api';

/** 全站登录门的当前身份与退出入口（/api/auth/me）。登录门关着（off）且没有登录 cookie 时不显示。
 *  Odoo 已下线（2026-11-17）：登录的人只有市场会话（session：站内账号；source：飞书这类身份来源），退出就是注销市场会话。 */
type Me = { gate: 'enforce' | 'off'; authenticated: boolean; via: 'cli' | 'token' | 'cookie' | 'session' | 'source' | null; login: string | null };
const VIA: Record<string, string> = { cookie: '管理员口令登录', session: '站内账号', source: '已登录', token: '管理员口令', cli: '本机' };

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
  const label = (me.via === 'session' || me.via === 'source') && me.login ? `${VIA[me.via]} · ${me.login}` : (VIA[me.via] ?? '已登录');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginInlineEnd: 8 }}>
      <Tag icon={<LockOutlined />} color="default" style={{ marginInlineEnd: 0 }} title="本站登录身份">{label}</Tag>
      <Tooltip title="退出当前登录并回到登录页">
        <Button size="small" type="link" icon={<LogoutOutlined />} loading={busy} onClick={logout}>退出</Button>
      </Tooltip>
    </span>
  );
}
