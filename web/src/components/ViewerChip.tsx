import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Descriptions, Popover, Tag, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { logoutCurrentSession } from '../api';
import { loginHref } from '../login-href';

/** 当前用户 chip（GET /api/auth/viewer）。Odoo 下线（2026-11-17）后认的是市场会话（站内账号、飞书登录）：
 *  - 200：显示是谁；
 *  - 401（带 auth_required、login_url）：没登录或会话失效 → 「未登录」加去登录页的链接（整页跳，登录完回到当前页）；
 *  - 403：账号停用 → 照实说，给「退出」；
 *  - 503：一种登录方式也没有 → 只提示，不清会话、不跳走；
 *  - 别的（接口不通、回答不认得）：不显示。
 *  弹出层不再写「来源：Odoo 会话」那一栏（原型里没有登录来源这一项）。 */
interface Viewer { login: string; sub: string; name: string | null; kind: string }
type State =
  | { kind: 'hidden' }
  | { kind: 'anon'; loginUrl: unknown }
  | { kind: 'disabled'; error: string }
  | { kind: 'unavailable'; error: string }
  | { kind: 'ok'; viewer: Viewer };

const REFRESH_MS = 60_000; // 切回页面时最多每分钟复查一次

export default function ViewerChip() {
  const [state, setState] = useState<State>({ kind: 'hidden' });
  const [loggingOut, setLoggingOut] = useState(false);
  const lastRef = useRef(0);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    lastRef.current = Date.now();
    const request = ++requestRef.current;
    try {
      const r = await fetch('/api/auth/viewer', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (request !== requestRef.current) return;
      const v = j?.viewer;
      if (r.ok && j?.ok === true && v && typeof v.login === 'string' && v.login && typeof v.sub === 'string') setState({ kind: 'ok', viewer: v });
      else if (r.status === 401) setState({ kind: 'anon', loginUrl: j?.login_url });
      else if (r.status === 403) setState({ kind: 'disabled', error: typeof j?.error === 'string' ? j.error : '账号已停用' });
      else if (r.status === 503) setState({ kind: 'unavailable', error: typeof j?.error === 'string' ? j.error : '现在没有可用的登录方式' });
      else setState({ kind: 'hidden' });
    } catch { if (request === requestRef.current) setState({ kind: 'hidden' }); }
  }, []);
  useEffect(() => {
    void load();
    const onBack = () => { if (document.visibilityState === 'visible' && Date.now() - lastRef.current > REFRESH_MS) void load(); };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => { ++requestRef.current; window.removeEventListener('focus', onBack); document.removeEventListener('visibilitychange', onBack); };
  }, [load]);

  const logout = async () => {
    setLoggingOut(true);
    const result = await logoutCurrentSession();
    if (!result.ok) window.alert(result.message ?? '无法确认已退出。');
    window.location.assign('/login');
  };
  if (state.kind === 'hidden') return null;
  if (state.kind === 'unavailable') return <Tag icon={<UserOutlined />} color="warning" className="wm-viewer-tag" title={state.error} data-testid="viewer-unavailable">暂时登录不了</Tag>;
  if (state.kind === 'disabled') {
    return <span className="wm-viewer-chip">
      <Tag icon={<UserOutlined />} color="error" className="wm-viewer-tag" title={state.error} data-testid="viewer-disabled">账号已停用</Tag>
      <Button size="small" type="link" loading={loggingOut} onClick={logout}>退出</Button>
    </span>;
  }
  if (state.kind === 'anon') {
    const href = loginHref(state.loginUrl, window.location.pathname + window.location.search + window.location.hash);
    return <span className="wm-viewer-chip">
      <Tag icon={<UserOutlined />} color="default" className="wm-viewer-tag" data-testid="viewer-anon">未登录</Tag>
      <Button size="small" type="link" href={href} data-testid="viewer-login">登录</Button>
    </span>;
  }
  const v = state.viewer;
  const label = `${v.name ?? v.login}（${v.login}）`;
  return (
    <Popover trigger="click" title="当前用户" content={(
      <><Descriptions size="small" column={1} style={{ width: 280 }} items={[
        { key: 'name', label: '显示名', children: v.name ?? '—' },
        { key: 'login', label: '登录名', children: v.login },
      ]} /><Button size="small" loading={loggingOut} onClick={logout}>退出</Button></>
    )}>
      <Tag icon={<UserOutlined />} color="blue" className="wm-viewer-tag wm-viewer-me" title={label} data-testid="viewer-ok">{label}</Tag>
    </Popover>
  );
}
