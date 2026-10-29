import React from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import { KeyOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  LayoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  OrderedListOutlined,
  CarryOutOutlined,
  NodeIndexOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import Market from './pages/Market';
import Types from './pages/Types';
import Settings from './pages/Settings';
import UseWorkbench from './pages/UseWorkbench';
import Cockpit from './pages/Cockpit';
import Sops from './pages/Sops';
import McpGateways from './pages/McpGateways';
import { getAdminToken, setAdminToken } from './admin-token';
import { Badge, Button as AButton, Input as AInput, Popover } from 'antd';
import Tasks from './pages/Tasks';
import Lifecycle from './pages/Lifecycle';
import SkillsPage from './pages/Skills';

const menuRoutes = {
  path: '/',
  routes: [
    { path: '/', name: '总览', icon: <DashboardOutlined /> },
    { path: '/cockpit', name: '驾驶舱', icon: <LayoutOutlined /> },
    { path: '/market', name: '工作台', icon: <AppstoreOutlined /> },
    { path: '/sops', name: 'SOP 台', icon: <OrderedListOutlined /> },
    { path: '/tasks', name: '统一待办', icon: <CarryOutOutlined /> },
    { path: '/lifecycle', name: '生命周期全景', icon: <NodeIndexOutlined /> },
    { path: '/mcp-gateways', name: 'MCP 网关', icon: <SafetyCertificateOutlined /> },
    { path: '/types', name: '类型管理', icon: <ClusterOutlined /> },
    { path: '/skills', name: '技能市场', icon: <CarryOutOutlined /> },
    { path: '/settings', name: '设置', icon: <SettingOutlined /> },
  ],
};

function AdminTokenBadge() {
  const [open, setOpen] = React.useState(false);
  const [val, setVal] = React.useState(getAdminToken());
  const saved = getAdminToken() !== '';
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
            placeholder="ADMIN_TOKEN（会话级存储，关闭浏览器即失效）"
            onChange={(e) => setVal(e.target.value)}
          />
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <AButton size="small" type="primary" onClick={() => { setAdminToken(val.trim()); setOpen(false); }}>保存</AButton>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>本机 127.0.0.1 访问通常无需口令</div>
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
      logo={<AppstoreOutlined style={{ fontSize: 26, color: '#059669' }} />}
      layout="side"
      fixSiderbar
      fixedHeader
      route={menuRoutes}
      location={{ pathname: location.pathname }}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      menuHeaderRender={() => (
        // ProLayout 默认把 logo 标题染成 colorPrimary（#1E3A5F  Navy），
        // 在深色侧栏上几乎不可见；接管渲染：白字 600 + 字距
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
          <AppstoreOutlined style={{ fontSize: 22, color: '#059669' }} />
          <span style={{ color: '#FFFFFF', fontSize: 16, fontWeight: 600, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
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
          colorMenuBackground: '#0F172A',
          colorTextMenu: '#CBD5E1',
          colorTextMenuSelected: '#FFFFFF',
          colorBgMenuItemSelected: '#1E3A5F',
          colorTextMenuActive: '#FFFFFF',
          colorTextMenuItemHover: '#FFFFFF',
        },
      }}
      contentStyle={{ padding: 16, paddingTop: 12 }}
    >
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/cockpit" element={<Cockpit />} />
        <Route path="/cockpit/:id" element={<Cockpit />} />
        <Route path="/market" element={<Market />} />
        <Route path="/sops" element={<Sops />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/lifecycle" element={<Lifecycle />} />
        <Route path="/mcp-gateways" element={<McpGateways />} />
        <Route path="/types" element={<Types />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ProLayout>
  );
}
