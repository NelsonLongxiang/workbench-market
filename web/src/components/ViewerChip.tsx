import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Descriptions, Popover, Tag, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { odooLoginHref } from '../pages/lifecycle-view';
import { ODOO_SESSION_CONFIRMED, useOdooPopupLogin } from '../pages/odoo-login';

/** #279 当前用户 chip（过渡：数据取 /api/lifecycle/whoami，即浏览器的 Odoo 会话；#221 落地后换成 /api/auth/me）。
 *  未配置生命周期源（503）或接口不通时不显示；未登录给 #277 的弹窗登录入口；角色暂无（来源待定、授权通道未实现）。 */
interface WhoamiViewer { login: string; uid: number; sub: string; name: string | null; kind: string }
type State = { kind: 'hidden' } | { kind: 'anon'; loginUrl: string | null } | { kind: 'ok'; viewer: WhoamiViewer };

const REFRESH_MS = 60_000; // 切回页面时最多每分钟复查一次（每次都要现查 Odoo）

export default function ViewerChip() {
  const [state, setState] = useState<State>({ kind: 'hidden' });
  const lastRef = useRef(0);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    lastRef.current = Date.now();
    const request = ++requestRef.current;
    try {
      const r = await fetch('/api/lifecycle/whoami', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (request !== requestRef.current) return;
      if (r.ok && j?.ok && j.viewer) setState({ kind: 'ok', viewer: j.viewer });
      else if (r.status === 401) setState({ kind: 'anon', loginUrl: typeof j?.login_url === 'string' ? j.login_url : null });
      else setState({ kind: 'hidden' });
    } catch { if (request === requestRef.current) setState({ kind: 'hidden' }); }
  }, []);
  useEffect(() => {
    void load();
    const onBack = () => { if (document.visibilityState === 'visible' && Date.now() - lastRef.current > REFRESH_MS) void load(); };
    const onConfirmed = () => { void load(); }; // bypass focus throttle after verified popup login
    window.addEventListener(ODOO_SESSION_CONFIRMED, onConfirmed);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => { ++requestRef.current; window.removeEventListener(ODOO_SESSION_CONFIRMED, onConfirmed); window.removeEventListener('focus', onBack); document.removeEventListener('visibilitychange', onBack); };
  }, [load]);

  const href = state.kind === 'anon' && state.loginUrl ? odooLoginHref(state.loginUrl) : null;
  const login = useOdooPopupLogin(href, () => {}); // confirmed event is the single refresh path

  if (state.kind === 'hidden') return null;
  if (state.kind === 'anon') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Tag icon={<UserOutlined />} color="default" style={{ marginInlineEnd: 0 }}>未登录 Odoo</Tag>
        {href && <Button size="small" type="link" onClick={login.open} disabled={login.polling}>{login.polling ? '等待登录…' : '登录'}</Button>}
        {login.blocked && <Typography.Text type="warning" style={{ fontSize: 12 }}>弹窗被拦截</Typography.Text>}
      </span>
    );
  }
  const v = state.viewer;
  const label = `${v.name ?? v.login}（${v.login}）· ${v.kind}`;
  return (
    <Popover trigger="click" title="当前用户" content={(
      <Descriptions size="small" column={1} style={{ width: 280 }} items={[
        { key: 'name', label: '显示名', children: v.name ?? '—' },
        { key: 'login', label: '登录名', children: v.login },
        { key: 'kind', label: '类别', children: v.kind },
        { key: 'sub', label: '主体', children: <Typography.Text code>{v.sub}</Typography.Text> },
        { key: 'roles', label: '角色', children: <Typography.Text type="secondary">暂无（授权通道未实现）</Typography.Text> },
        { key: 'src', label: '来源', children: <Typography.Text type="secondary" style={{ fontSize: 12 }}>Odoo 会话（过渡，#221 落地后换市场统一登录）</Typography.Text> },
      ]} />
    )}>
      <Tag icon={<UserOutlined />} color="blue" style={{ cursor: 'pointer', marginInlineEnd: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' }} title={label}>{label}</Tag>
    </Popover>
  );
}
