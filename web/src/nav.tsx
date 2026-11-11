/** 菜单与面包屑的唯一数据源（PATTERNS.md §2.1）：App 的侧栏和 WmPage 的面包屑都从这里取，改分组只改这一处。 */
import type { ReactNode } from 'react';
import { WEB_EXTENSIONS } from './extensions';
import {
  AppstoreOutlined,
  BarChartOutlined,
  BookOutlined,
  CarryOutOutlined,
  BellOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  InboxOutlined,
  LayoutOutlined,
  LockOutlined,
  OrderedListOutlined,
  ProfileOutlined,
  SafetyOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';

export interface NavPage { path: string; name: string; icon: ReactNode }
/** key 只当菜单键用，不对应路由 */
export interface NavGroup { key: string; name: string; admin?: boolean; pages: NavPage[] }

/** 入口按原型排（产品化 3fbfd0b）：主入口一列，顺序是 全景、事项、驾驶舱、团队、谁能做什么、工作台市场、经验库。
 *  旧入口不删，先收进「更多」：关注的内容会并进全景的「等你拍板」，统一待办并进事项，SOP 交付空间和技能市场并进工作台市场的分类，
 *  并好之前从这里还能进。原来的总览挪到 /overview。 */
const BASE_GROUPS: NavGroup[] = [
  { key: '/g/main', name: '工作', pages: [
    { path: '/', name: '全景', icon: <DashboardOutlined /> },
    { path: '/work-items', name: '事项', icon: <ProfileOutlined /> },
    { path: '/cockpit', name: '驾驶舱', icon: <LayoutOutlined /> },
    { path: '/team', name: '团队', icon: <TeamOutlined /> },
    { path: '/access', name: '谁能做什么', icon: <SafetyOutlined /> },
    { path: '/market', name: '工作台市场', icon: <AppstoreOutlined /> },
    { path: '/knowledge', name: '经验库', icon: <BookOutlined /> },
  ] },
  { key: '/g/more', name: '更多', pages: [
    { path: '/attention', name: '关注', icon: <BellOutlined /> },
    { path: '/tasks', name: '统一待办', icon: <CarryOutOutlined /> },
    { path: '/sops', name: 'SOP 交付空间', icon: <OrderedListOutlined /> },
    { path: '/skills', name: '技能市场', icon: <ExperimentOutlined /> },
    { path: '/overview', name: '原来的总览', icon: <BarChartOutlined /> },
  ] },
  { key: '/g/admin', name: '管理', admin: true, pages: [
    { path: '/owner-pending', name: '待属主看板', icon: <InboxOutlined /> },
    { path: '/mcp-gateways', name: 'MCP 网关', icon: <SafetyCertificateOutlined /> },
    { path: '/vault', name: '凭据库', icon: <LockOutlined /> },
    { path: '/types', name: '类型管理', icon: <ClusterOutlined /> },
    { path: '/settings', name: '设置', icon: <SettingOutlined /> },
  ] },
];

/** 扩展的菜单项并进已有分组；新分组排在「管理」组之前 */
function withExtensions(base: NavGroup[]): NavGroup[] {
  const groups = base.map((g) => ({ ...g, pages: [...g.pages] }));
  for (const { group, page } of WEB_EXTENSIONS.flatMap((e) => e.nav ?? [])) {
    let g = groups.find((x) => x.key === group.key);
    if (!g) { g = { key: group.key, name: group.name ?? group.key, pages: [] }; groups.splice(groups.findIndex((x) => x.admin), 0, g); }
    g.pages.push(page);
  }
  return groups;
}
export const NAV_GROUPS: NavGroup[] = withExtensions(BASE_GROUPS);

/** 当前路径属于哪个分组、哪个页面（详情 /x/:id 归到 /x）；'/' 只精确匹配 */
export function findNav(pathname: string): { group: NavGroup; page: NavPage } | null {
  for (const group of NAV_GROUPS) {
    for (const page of group.pages) {
      if (page.path === '/' ? pathname === '/' : pathname === page.path || pathname.startsWith(page.path + '/')) return { group, page };
    }
  }
  return null;
}
