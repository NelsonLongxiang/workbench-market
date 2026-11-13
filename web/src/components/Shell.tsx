/** 外壳（产品化原型 3fbfd0b）：左边 248px 浅色侧栏，右边一张圆角的主区卡片。
 *  侧栏从上到下：品牌行 → 主入口一列（「全景」带等你拍板数）→ 我的驾驶舱 → 底部（管理员的设置 / 管理、口令、登录身份）。
 *  入口数据只来自 nav.tsx；AI 员工列表、在岗数、搜索等接口有了再加（不放占位）。 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Alert, Button, Dropdown, Popover } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { NAV_GROUPS, findNav } from '../nav';
import { ATTENTION_CHANGED, getAttention, getAuthMe, listCockpitsShared } from '../api';
import { answerChoices, decideCount, type AttentionItem } from '../attention-view';
import type { Cockpit } from '../types';
import { IDENTITY_DOWN_TEXT, identityDown, retryIdentityNow, subscribeIdentity } from '../identity-status';
import { personLabel } from '../people';

/** 角标：数字；身份服务连不上时是一个中性灰的「—」，悬停说明暂时取不到（不能写 0 或不显示——那会让人以为没有待办；四个字放不下） */
export type Pending = number | 'down' | null;

function NavItem({ to, icon, name, on, count }: { to: string; icon: ReactNode; name: string; on: boolean; count?: Pending }) {
  return <Link to={to} className={on ? 'wm-nav-item on' : 'wm-nav-item'} data-testid={`nav-${to}`}>
    <span className="wm-nav-icon">{icon}</span><span>{name}</span>
    {count === 'down' ? <span className="wm-nav-cnt wm-nav-cnt-off" data-testid="nav-pending" data-state="down" title="等你拍板的事暂时取不到" aria-label="等你拍板的事暂时取不到">—</span>
      : count ? <span className="wm-nav-cnt" data-testid="nav-pending">{count}</span> : null}
  </Link>;
}

/** footer：放进用户卡弹出层里的身份工具（登录状态、管理员口令、退出），侧栏底部只露一张用户卡 */
export default function Shell({ admin, footer, children }: { admin: boolean; footer?: ReactNode; children: ReactNode }) {
  const { pathname } = useLocation();
  const current = findNav(pathname);
  const [pending, setPending] = useState<Pending>(null);
  const down = useSyncExternalStore(subscribeIdentity, identityDown);
  const [cockpits, setCockpits] = useState<Cockpit[] | null>(null);
  /** 用户卡上的名字：有显示名用显示名，没有再退登录名（people.ts 同一个取名函数） */
  /** undefined = 还在问是谁（不写「未登录」，不先说一句否定的话）；null = 问过了，没登录 */
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const [meOpen, setMeOpen] = useState(false);
  // 角标随换页、换身份刷新；驾驶舱和登录身份只在进来时读一次
  // 角标 = 轮到你、能当场办的件数，和全景的总结句、「等你拍板」的数是同一个函数算的
  // 一个 effect 管两件事：换页、换身份时读一次；页面上办完一件（卡片会广播 wm-attention-changed）再读一次。
  // 监听写在同一个 effect 里、依赖带上 admin：分开写、依赖留空时，监听拿到的是第一次渲染的 admin，办完一件角标会被算成 0
  useEffect(() => {
    let live = true;
    const read = () => { void getAttention().then((a) => { if (live) setPending(a.identityDown ? 'down' : a.status >= 200 && a.status < 300 ? decideCount(a.items as unknown as AttentionItem[], (x) => answerChoices(admin, x)) : null); }); };
    read();
    window.addEventListener(ATTENTION_CHANGED, read);
    return () => { live = false; window.removeEventListener(ATTENTION_CHANGED, read); };
  }, [pathname, admin]);
  // 接口给的不是数组（出错、被拦、形状不对）就不显示这一块，别让侧栏把整页带崩
  useEffect(() => { listCockpitsShared().then((x) => setCockpits(Array.isArray(x) ? x : null), () => setCockpits(null)); }, [admin]);
  useEffect(() => { void getAuthMe().then((m) => setLogin(m?.authenticated ? personLabel({ principal: m.login ?? '', display_name: m.display_name }) || null : null)); }, []);

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
              <span className="wm-avatar" data-testid="wm-me-avatar">{login === undefined ? '' : (Array.from(login ?? '?')[0] ?? '?').toUpperCase()}</span>
              <span className="wm-me-name" data-testid="wm-me-name" aria-busy={login === undefined}>{login === undefined ? '' : login ?? '未登录'}</span>
            </button>
          </Popover>
        </div>
      </aside>
      <main className="wm-main">
        {down && <Alert type="warning" banner showIcon className="wm-identity-down" data-testid="wm-identity-down"
          message={`${IDENTITY_DOWN_TEXT}，认不出你是谁，有些内容这会儿取不到。正在自动重试，连上后这条提示会自己消失。`}
          action={<Button size="small" type="text" onClick={retryIdentityNow}>现在重试</Button>} />}
        {children}
      </main>
    </div>
  );
}
