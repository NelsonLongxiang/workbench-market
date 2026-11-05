import React from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import { KeyOutlined, AppstoreOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { findNav, NAV_GROUPS } from './nav';
import Dashboard from './pages/Dashboard';
import Market from './pages/Market';
import Types from './pages/Types';
import Settings from './pages/Settings';
import UseWorkbench from './pages/UseWorkbench';
import Cockpit from './pages/Cockpit';
import Sops from './pages/Sops';
import SopSpace from './pages/SopSpace';
import SopRunDetail from './pages/SopRunDetail';
import McpGateways from './pages/McpGateways';
import Vault from './pages/Vault';
import { adminActive, adminTokenPresent, checkAdminToken, getAdminToken, odooAdmin, refreshAdminIdentity, setAdminToken, subscribeAdminToken } from './admin-token';
import { marketOnly, marketUrl, onSurface, surface } from './surface';
import { WEB_EXTENSIONS } from './extensions';
import { Badge, Button as AButton, Input as AInput, Popover, Result, Tag } from 'antd';
import Tasks from './pages/Tasks';
import Reviews from './pages/Reviews';
import SkillsPage from './pages/Skills';
import ViewerChip from './components/ViewerChip';
import LoginChip from './components/LoginChip';
import { DESIGN_TOKENS as T } from './design-tokens';

/** #316 菜单分组（数据在 nav.tsx，扩展可加组）：一级是分组标题，二级才是页面；「管理」组仅持管理员口令时显示、默认折叠。
 *  页面路由不变，旧书签照用。 */
const ADMIN_GROUP = NAV_GROUPS.find((g) => g.admin)!.key;
const WORK_GROUPS = NAV_GROUPS.filter((g) => !g.admin).map((g) => g.key);
function menuRoutes(admin: boolean) {
  return {
    path: '/',
    routes: NAV_GROUPS.filter((g) => admin || !g.admin).map((g) => ({ path: g.key, name: g.name, routes: g.pages })),
  };
}

/** #292 M1：控制面上的业务页跳回业务面同 path */
function MarketOnlyRedirect() {
  const location = useLocation();
  const href = onSurface(marketUrl, location.pathname + location.search);
  React.useEffect(() => { if (href) window.location.replace(href); }, [href]);
  return <Result status="info" title="这是业务页面，请在业务面打开" extra={href ? <AButton type="primary" href={href}>去业务面</AButton> : null} />;
}

/** 管理身份：管理员口令或 Odoo 管理员登录（属主 2026-11-02 撤销「口令只在控制面输入」） */
function AdminTokenBadge() {
  const odoo = React.useSyncExternalStore(subscribeAdminToken, odooAdmin);
  return <>{odoo && <Tag color="blue" title="当前 Odoo 账号是管理员，管理操作无需另输口令">Odoo 管理员 · {odoo}</Tag>}<AdminTokenInput /></>;
}

function AdminTokenInput() {
  const [open, setOpen] = React.useState(false);
  const [val, setVal] = React.useState(getAdminToken());
  const [err, setErr] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const saved = React.useSyncExternalStore(subscribeAdminToken, adminTokenPresent); // GoFrame 里清除口令时同步
  const save = async () => {
    const t = val.trim();
    if (!t) { setAdminToken(''); setErr(''); setOpen(false); return; }
    setChecking(true);
    const why = await checkAdminToken(t);
    setChecking(false);
    if (why) { setErr(why); return; } // 口令不对就不存，免得各管理页再报「需要管理员」
    setAdminToken(t); setErr(''); setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="管理员口令（远程写操作需要）"
      content={(
        <div style={{ width: 260 }}>
          <AInput.Password
            defaultValue={val}
            placeholder="ADMIN_TOKEN（仅本页；刷新或在本标签页跳出后需重输）"
            onChange={(e) => { setVal(e.target.value); setErr(''); }}
            onPressEnter={() => { void save(); }}
            status={err ? 'error' : undefined}
          />
          {err && <div className="wm-mt-1 wm-caption wm-tone-danger" role="alert">{err}</div>}
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <AButton size="small" type="primary" loading={checking} onClick={() => { void save(); }}>保存</AButton>
          </div>
          <div className="wm-mt-1 wm-caption wm-secondary">本机 127.0.0.1 访问通常无需口令</div>
        </div>
      )}
    >
      <AButton size="small" icon={<KeyOutlined />} type={saved ? 'primary' : 'default'} ghost={saved}>
        {saved ? '口令已设' : '口令'}
      </AButton>
    </Popover>
  );
}

export default function App() {
  const location = useLocation();
  const admin = React.useSyncExternalStore(subscribeAdminToken, adminActive);
  React.useEffect(() => { void refreshAdminIdentity(); }, []);
  // 管理组默认折叠：初始只展开四个日常分组；当前页在管理组时也展开它
  const [openKeys, setOpenKeys] = React.useState<string[]>(() =>
    findNav(location.pathname)?.group.admin ? [...WORK_GROUPS, ADMIN_GROUP] : WORK_GROUPS);

  if (surface === 'control' && marketOnly(location.pathname)) return <MarketOnlyRedirect />;

  // 嵌入使用页占满整屏，脱离侧边栏壳
  if (location.pathname.startsWith('/use/')) {
    return (
      <Routes>
        <Route path="/use/:id" element={<UseWorkbench />} />
      </Routes>
    );
  }

  return (
    <ProLayout
      headerRender={() => <AdminTokenBadge />}
      title="工作台市场"
      logo={<AppstoreOutlined style={{ fontSize: 26, color: T.colors.success }} />}
      layout="side"
      fixSiderbar
      fixedHeader
      route={menuRoutes(admin)}
      openKeys={openKeys}
      menu={{ autoClose: false }}
      onOpenChange={(keys) => setOpenKeys((keys || []) as string[])}
      location={{ pathname: location.pathname }}
      // #316 子菜单模式下 ProLayout 只给一级显示图标；二级页面的专属图标在这里自己渲染
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path} className="wm-menu-link">{item.icon}{dom}</Link> : dom)}
      menuHeaderRender={() => (
        // ProLayout 默认把 logo 标题染成 colorPrimary（#1E3A5F  Navy），
        // 在深色侧栏上几乎不可见；接管渲染：白字 600 + 字距
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px' }}>
          <AppstoreOutlined style={{ fontSize: 22, color: T.colors.success }} />
          <span className="wm-strong" style={{ color: T.colors['nav-text-active'], fontSize: 16, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
            工作台市场
          </span>
        </Link>
      )}
      menuFooterRender={() => <AdminTokenBadge />}
      collapsedButtonRender={(collapsed) => (
        <span className="wm-sider-collapse">{collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}</span>
      )}
      token={{
        sider: {
          // #316：侧栏是唯一的深色区域，取 DESIGN.md 的 nav-* token
          colorMenuBackground: T.colors['nav-bg'],
          colorTextMenu: T.colors['nav-text'],
          colorTextMenuSelected: T.colors['nav-text-active'],
          colorBgMenuItemSelected: T.colors['nav-item-active-bg'],
          colorTextMenuActive: T.colors['nav-text-active'],
          colorTextMenuItemHover: T.colors['nav-text-active'],
          colorTextMenuTitle: T.colors['nav-text'],
        },
      }}
      contentStyle={{ padding: 16, paddingTop: 12 }}
    >
      {/* #279 当前用户：侧栏布局不渲染 headerRender，所以在内容区顶部右侧放一行，所有页面（含扩展页面）都能看到 */}
      <div className="wm-mb-1" style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 24 }}><LoginChip />{surface !== 'control' && <ViewerChip />}</div>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/cockpit" element={<Cockpit />} />
        <Route path="/cockpit/:id" element={<Cockpit />} />
        <Route path="/market" element={<Market />} />
        <Route path="/sops" element={<Sops />} />
        <Route path="/sops/:slug" element={<SopSpace />} />
        <Route path="/sops/:slug/runs/:id" element={<SopRunDetail />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/reviews" element={<Reviews />} />
        {WEB_EXTENSIONS.flatMap((e) => (e.routes ?? []).map((r) => <Route key={`${e.name}:${r.path}`} path={r.path} element={r.element} />))}
        <Route path="/mcp-gateways" element={<McpGateways />} />
        <Route path="/vault" element={<Vault />} />
        <Route path="/types" element={<Types />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ProLayout>
  );
}
