import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import {
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import Market from './pages/Market';
import Types from './pages/Types';
import Settings from './pages/Settings';
import UseWorkbench from './pages/UseWorkbench';

const menuRoutes = {
  path: '/',
  routes: [
    { path: '/', name: '总览', icon: <DashboardOutlined /> },
    { path: '/market', name: '工作台', icon: <AppstoreOutlined /> },
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
        <Route path="/market" element={<Market />} />
        <Route path="/types" element={<Types />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ProLayout>
  );
}
