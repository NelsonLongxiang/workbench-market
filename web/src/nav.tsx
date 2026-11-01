/** 菜单与面包屑的唯一数据源（PATTERNS.md §2.1）：App 的侧栏和 WmPage 的面包屑都从这里取，改分组只改这一处。 */
import type { ReactNode } from 'react';
import {
  AppstoreOutlined,
  CarryOutOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  LayoutOutlined,
  LockOutlined,
  NodeIndexOutlined,
  OrderedListOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons';

export interface NavPage { path: string; name: string; icon: ReactNode }
/** key 只当菜单键用，不对应路由 */
export interface NavGroup { key: string; name: string; admin?: boolean; pages: NavPage[] }

export const NAV_GROUPS: NavGroup[] = [
  { key: '/g/work', name: '工作', pages: [
    { path: '/', name: '总览', icon: <DashboardOutlined /> },
    { path: '/tasks', name: '统一待办', icon: <CarryOutOutlined /> },
    { path: '/cockpit', name: '驾驶舱', icon: <LayoutOutlined /> },
  ] },
  { key: '/g/deliver', name: '交付', pages: [
    { path: '/sops', name: 'SOP 交付空间', icon: <OrderedListOutlined /> },
  ] },
  { key: '/g/resource', name: '资源', pages: [
    { path: '/market', name: '工作台市场', icon: <AppstoreOutlined /> },
    { path: '/skills', name: '技能市场', icon: <ExperimentOutlined /> },
  ] },
  { key: '/g/govern', name: '治理', pages: [
    { path: '/lifecycle', name: '生命周期全景', icon: <NodeIndexOutlined /> },
  ] },
  { key: '/g/admin', name: '管理', admin: true, pages: [
    { path: '/mcp-gateways', name: 'MCP 网关', icon: <SafetyCertificateOutlined /> },
    { path: '/vault', name: '凭据库', icon: <LockOutlined /> },
    { path: '/types', name: '类型管理', icon: <ClusterOutlined /> },
    { path: '/settings', name: '设置', icon: <SettingOutlined /> },
  ] },
];

/** 当前路径属于哪个分组、哪个页面（详情 /x/:id 归到 /x）；'/' 只精确匹配 */
export function findNav(pathname: string): { group: NavGroup; page: NavPage } | null {
  for (const group of NAV_GROUPS) {
    for (const page of group.pages) {
      if (page.path === '/' ? pathname === '/' : pathname === page.path || pathname.startsWith(page.path + '/')) return { group, page };
    }
  }
  return null;
}
