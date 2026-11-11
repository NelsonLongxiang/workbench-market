/** 外壳（产品化原型 3fbfd0b）：左边 248px 浅色侧栏，右边一张圆角的主区卡片。
 *  侧栏从上到下：品牌行 → 主入口一列（「全景」带等你拍板数）→ 我的驾驶舱 → 底部（管理员的设置 / 管理、口令、登录身份）。
 *  入口数据只来自 nav.tsx；AI 员工列表、在岗数、搜索等接口有了再加（不放占位）。 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Dropdown } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { NAV_GROUPS, findNav } from '../nav';
import { api, getAttentionCount, getMe } from '../api';
import type { Cockpit } from '../types';

function NavItem({ to, icon, name, on, count }: { to: string; icon: ReactNode; name: string; on: boolean; count?: number | null }) {
  return <Link to={to} className={on ? 'wm-nav-item on' : 'wm-nav-item'} data-testid={`nav-${to}`}>
    <span className="wm-nav-icon">{icon}</span><span>{name}</span>
    {count ? <span className="wm-nav-cnt" data-testid="nav-pending">{count}</span> : null}
  </Link>;
}

export default function Shell({ admin, footer, children }: { admin: boolean; footer?: ReactNode; children: ReactNode }) {
  const { pathname } = useLocation();
  const current = findNav(pathname);
  const [pending, setPending] = useState<number | null>(null);
  const [cockpits, setCockpits] = useState<Cockpit[] | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  // 角标随换页、换身份刷新；驾驶舱和登录身份只在进来时读一次
  useEffect(() => { void getAttentionCount().then(setPending); }, [pathname, admin]);
  useEffect(() => { api.listCockpits().then(setCockpits, () => setCockpits(null)); }, [admin]);
  useEffect(() => { void getMe().then((m) => setLogin(m?.authenticated ? m.login ?? null : null)); }, []);

  const groups = NAV_GROUPS.filter((g) => !g.admin && !g.hidden);
  const adminPages = NAV_GROUPS.filter((g) => g.admin).flatMap((g) => g.pages);
  return (
    <div className="wm-app">
      <aside className="wm-side" data-testid="wm-side">
        <Link to="/" className="wm-brand"><span className="wm-logo">市</span><b>工作台市场</b></Link>
        {groups.map((g, gi) => <nav key={g.key} aria-label={g.name}>
          {gi > 0 && <div className="wm-nav-sec">{g.name}</div>}
          {g.pages.map((p) => <NavItem key={p.path} to={p.path} icon={p.icon} name={p.name} on={current?.page.path === p.path} count={p.path === '/' ? pending : null} />)}
        </nav>)}
        {cockpits && <nav aria-label="我的驾驶舱">
          <div className="wm-nav-sec"><span>我的驾驶舱</span><Link to="/cockpit" aria-label="新建或管理驾驶舱" className="wm-nav-sec-act"><PlusOutlined /></Link></div>
          {cockpits.length === 0
            ? <span className="wm-nav-sub wm-nav-empty">还没有驾驶舱</span>
            : cockpits.slice(0, 8).map((c) => <Link key={c.id} to={`/cockpit/${c.id}`} className={pathname === `/cockpit/${c.id}` ? 'wm-nav-sub on' : 'wm-nav-sub'}>{c.name}</Link>)}
        </nav>}
        <div className="wm-side-foot">
          {admin && adminPages.length > 0 && <Dropdown placement="topLeft" menu={{ items: adminPages.map((p) => ({ key: p.path, icon: p.icon, label: <Link to={p.path}>{p.name}</Link> })) }}>
            <button type="button" className={current && adminPages.some((p) => p.path === current.page.path) ? 'wm-nav-item on' : 'wm-nav-item'} data-testid="nav-admin">
              <span className="wm-nav-icon"><SettingOutlined /></span><span>设置 / 管理</span>
            </button>
          </Dropdown>}
          {footer}
          <div className="wm-me" data-testid="wm-me">
            <span className="wm-avatar">{(login ?? '?').slice(0, 1).toUpperCase()}</span>
            <span className="wm-me-name">{login ?? '未登录'}</span>
          </div>
        </div>
      </aside>
      <main className="wm-main">{children}</main>
    </div>
  );
}
