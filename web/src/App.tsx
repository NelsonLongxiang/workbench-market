import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import {
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  LayoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  OrderedListOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import Market from './pages/Market';
import Types from './pages/Types';
import Settings from './pages/Settings';
import UseWorkbench from './pages/UseWorkbench';
import Cockpit from './pages/Cockpit';
import Sops from './pages/Sops';

const menuRoutes = {
  path: '/',
  routes: [
    { path: '/', name: '总览', icon: <DashboardOutlined /> },
    { path: '/cockpit', name: '驾驶舱', icon: <LayoutOutlined /> },
    { path: '/market', name: '工作台', icon: <AppstoreOutlined /> },
    { path: '/sops', name: 'SOP 台', icon: <OrderedListOutlined /> },
    { path: '/types', name: '类型管理', icon: <ClusterOutlined /> },
    { path: '/settings', name: '设置', icon: <SettingOutlined /> },
  ],
};

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
        <Route path="/types" element={<Types />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ProLayout>
  );
}
