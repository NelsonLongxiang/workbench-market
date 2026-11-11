/** 外壳（产品化原型 3fbfd0b）：左边 248px 浅色侧栏，右边一张圆角的主区卡片。
 *  侧栏从上到下：品牌行 → 主入口一列（「全景」带等你拍板数）→ 我的驾驶舱 → 底部（管理员的设置 / 管理、口令、登录身份）。
 *  入口数据只来自 nav.tsx；AI 员工列表、在岗数、搜索等接口有了再加（不放占位）。 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Dropdown, Popover } from 'antd';
import { HistoryOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { NAV_GROUPS, findNav } from '../nav';
import { api, getAttentionCount } from '../api';
import { getMe } from '../me';
import type { Cockpit } from '../types';

function NavItem({ to, icon, name, on, count }: { to: string; icon: ReactNode; name: string; on: boolean; count?: number | null }) {
  return <Link to={to} className={on ? 'wm-nav-item on' : 'wm-nav-item'} data-testid={`nav-${to}`}>
    <span className="wm-nav-icon">{icon}</span><span>{name}</span>
    {count ? <span className="wm-nav-cnt" data-testid="nav-pending">{count}</span> : null}
  </Link>;
}

/** footer：放进用户卡弹出层里的身份工具（登录状态、管理员口令、退出），侧栏底部只露一张用户卡 */
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
  // 旧版页面：还没并进新页面的旧功能，人人都点得到；每并掉一个就从 nav.tsx 的隐藏组里删一个，空了整个菜单就不出现
  const legacyPages = NAV_GROUPS.filter((g) => g.hidden).flatMap((g) => g.pages);
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
          {admin && adminPages.length > 0 && <Dropdown placement="topLeft" trigger={['click', 'hover']} menu={{ items: adminPages.map((p) => ({ key: p.path, icon: p.icon, label: <Link to={p.path}>{p.name}</Link> })) }}>
            <button type="button" className={current && adminPages.some((p) => p.path === current.page.path) ? 'wm-nav-item on' : 'wm-nav-item'} data-testid="nav-admin">
              <span className="wm-nav-icon"><SettingOutlined /></span><span>设置 / 管理</span>
            </button>
          </Dropdown>}
          {legacyPages.length > 0 && <Dropdown placement="topLeft" trigger={['click', 'hover']} menu={{ items: legacyPages.map((p) => ({ key: p.path, label: <Link to={p.path}>{p.name}</Link> })) }}>
            <button type="button" className={current && legacyPages.some((p) => p.path === current.page.path) ? 'wm-nav-item wm-nav-quiet on' : 'wm-nav-item wm-nav-quiet'} data-testid="nav-legacy">
              <span className="wm-nav-icon"><HistoryOutlined /></span><span>旧版页面</span>
            </button>
          </Dropdown>}
          <Popover placement="topLeft" trigger="click" content={<div className="wm-me-pop">{footer}</div>}>
            <button type="button" className="wm-me" data-testid="wm-me">
              <span className="wm-avatar">{(login ?? '?').slice(0, 1).toUpperCase()}</span>
              <span className="wm-me-name">{login ?? '未登录'}</span>
            </button>
          </Popover>
        </div>
      </aside>
      <main className="wm-main">{children}</main>
    </div>
  );
}
