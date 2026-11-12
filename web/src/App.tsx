import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Shell from './components/Shell';
import { KeyOutlined } from '@ant-design/icons';
import { api } from './api';
import Market from './pages/Market';
import MarketHome from './pages/market/Market';
import Access from './pages/access/Access';
import Types from './pages/Types';
import Settings from './pages/Settings';
import UseWorkbench from './pages/UseWorkbench';
import Cockpit from './pages/Cockpit';
import Sops from './pages/Sops';
import SopSpace from './pages/SopSpace';
import SopRunDetail from './pages/SopRunDetail';
import McpGateways from './pages/McpGateways';
import OwnerPending from './pages/OwnerPending';
import Vault from './pages/Vault';
import { adminActive, adminTokenPresent, checkAdminToken, getAdminToken, odooAdmin, refreshAdminIdentity, setAdminToken, subscribeAdminToken } from './admin-token';
import { marketOnly, marketUrl, onSurface, surface } from './surface';
import { WEB_EXTENSIONS } from './extensions';
import { Alert, Button as AButton, Input as AInput, Popover, Result, Tag } from 'antd';
import Attention from './pages/Attention';
import WorkItem from './pages/WorkItem';
import NotYet, { NOT_YET } from './pages/NotYet';
import Team from './pages/team/Team';
import Home from './pages/Home';

import WorkItems from './pages/WorkItems';
import SkillsPage from './pages/Skills';
import ViewerChip from './components/ViewerChip';
import LoginChip from './components/LoginChip';
// import.meta.hot 只在 vite dev 时有；正式构建里它是 undefined，这一行连同演示页整个被摇掉
const BenchBlocksDemo = import.meta.hot ? React.lazy(() => import('./pages/dev/BenchBlocksDemo')) : null;

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

/** 预发实例（WM_OUTBOUND=off）：每一页顶上一条醒目的横幅，免得被当成正式环境用 */
function OutboundBanner() {
  const [off, setOff] = React.useState(false);
  React.useEffect(() => { api.getHealth().then((h) => setOff(h.outbound?.mode === 'off')).catch(() => { /* 取不到就不显示 */ }); }, []);
  if (!off) return null;
  return <Alert type="error" banner showIcon message="预发实例：对外已断开（WM_OUTBOUND=off）" description="这个实例的所有出站都在发出前被拦下：投递、回执、通知都不会发出，探活和外部登录也不可用。不要把它当成正式环境使用。" />;
}

export default function App() {
  const location = useLocation();
  const admin = React.useSyncExternalStore(subscribeAdminToken, adminActive);
  React.useEffect(() => { void refreshAdminIdentity(); }, []);

  if (surface === 'control' && marketOnly(location.pathname)) return <MarketOnlyRedirect />;

  // 嵌入使用页占满整屏，脱离侧边栏壳
  if (location.pathname.startsWith('/use/')) {
    return (
      <>
        <OutboundBanner />
        <Routes>
          <Route path="/use/:id" element={<UseWorkbench />} />
        </Routes>
      </>
    );
  }

  return (
    <Shell admin={admin} footer={<><LoginChip />{surface !== 'control' && <ViewerChip />}<AdminTokenBadge /></>}>
      <OutboundBanner />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/team" element={<Team />} />
        <Route path="/access" element={<Access />} />
        <Route path="/knowledge" element={<NotYet spec={NOT_YET.knowledge} />} />
        <Route path="/cockpit" element={<Cockpit />} />
        <Route path="/cockpit/:id" element={<Cockpit />} />
        <Route path="/market" element={<MarketHome />} />
        <Route path="/market/manage" element={<Market />} />
        <Route path="/sops" element={<Sops />} />
        <Route path="/sops/:slug" element={<SopSpace />} />
        <Route path="/sops/:slug/runs/:id" element={<SopRunDetail />} />
        <Route path="/attention" element={<Attention />} />
        <Route path="/work-items" element={<WorkItems />} />
        <Route path="/work-items/:id" element={<WorkItem />} />
        {WEB_EXTENSIONS.flatMap((e) => (e.routes ?? []).map((r) => <Route key={`${e.name}:${r.path}`} path={r.path} element={r.element} />))}
        <Route path="/owner-pending" element={<OwnerPending />} />
        <Route path="/mcp-gateways" element={<McpGateways />} />
        <Route path="/vault" element={<Vault />} />
        <Route path="/types" element={<Types />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/settings" element={<Settings />} />
        {/* 数据视图组件的演示页：只在开发时有（合成数据），正式构建里没有这一行，也不进侧栏 */}
        {BenchBlocksDemo ? <Route path="/dev/bench-blocks" element={<React.Suspense fallback={null}><BenchBlocksDemo /></React.Suspense>} /> : null}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
