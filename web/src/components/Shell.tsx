/** 外壳（产品化原型 3fbfd0b）：左边 248px 浅色侧栏，右边一张圆角的主区卡片。
 *  侧栏从上到下：品牌行 → 主入口一列（「全景」带等你拍板数）→ 我的驾驶舱 → 底部（管理员的设置 / 管理、口令、登录身份）。
 *  入口数据只来自 nav.tsx；AI 员工列表、在岗数、搜索等接口有了再加（不放占位）。 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Dropdown, Popover } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { NAV_GROUPS, findNav } from '../nav';
import { ATTENTION_CHANGED, getAttentionCount, getAuthMe, listCockpitsShared } from '../api';
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
  const [meOpen, setMeOpen] = useState(false);
  // 角标随换页、换身份刷新；驾驶舱和登录身份只在进来时读一次
  useEffect(() => { void getAttentionCount().then(setPending); }, [pathname, admin]);
  // 页面上办完一件（全景的卡片会广播 wm-attention-changed），角标当场刷新
  useEffect(() => {
    const on = () => { void getAttentionCount().then(setPending); };
    window.addEventListener(ATTENTION_CHANGED, on);
    return () => window.removeEventListener(ATTENTION_CHANGED, on);
  }, []);
  // 接口给的不是数组（出错、被拦、形状不对）就不显示这一块，别让侧栏把整页带崩
  useEffect(() => { listCockpitsShared().then((x) => setCockpits(Array.isArray(x) ? x : null), () => setCockpits(null)); }, [admin]);
  useEffect(() => { void getAuthMe().then((m) => setLogin(m?.authenticated ? m.login ?? null : null)); }, []);

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
          {admin && adminPages.length > 0 && <Dropdown placement="topLeft" trigger={['click', 'hover']} menu={{ items: adminPages.map((p) => ({ key: p.path, icon: p.icon, label: <Link to={p.path}>{p.name}</Link> })) }}>
            <button type="button" className={current && adminPages.some((p) => p.path === current.page.path) ? 'wm-nav-item on' : 'wm-nav-item'} data-testid="nav-admin">
              <span className="wm-nav-icon"><SettingOutlined /></span><span>设置 / 管理</span>
            </button>
          </Dropdown>}
          <Popover placement="topLeft" trigger="click" open={meOpen} onOpenChange={setMeOpen} content={<div className="wm-me-pop">{footer}</div>}>
            <button type="button" className="wm-me" data-testid="wm-me" aria-haspopup="dialog" aria-expanded={meOpen}>
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
