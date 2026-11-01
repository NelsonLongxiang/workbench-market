/** 页面骨架（PATTERNS.md §3）：所有页面统一用它包——标题 + 一句说明 + 右上主操作（至多 1 个 primary）+ 内容区；
 *  面包屑 = 分组 / 页面 / 详情名，由 nav.tsx 生成（分组不可点；有详情时页面名可点回列表）。 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PageContainer } from '@ant-design/pro-components';
import type { PageContainerProps } from '@ant-design/pro-components';
import { findNav } from '../nav';

export interface WmPageProps extends Omit<PageContainerProps, 'breadcrumb' | 'title'> {
  /** 缺省取菜单里的页面名 */
  title?: ReactNode;
  /** 详情名：进 /x/:id 这类详情页时给，出现在面包屑末尾 */
  detail?: ReactNode;
  children?: ReactNode;
}

export default function WmPage({ title, detail, className, children, ...rest }: WmPageProps) {
  const nav = findNav(useLocation().pathname);
  const items = nav ? [
    { title: nav.group.name },
    { title: detail ? <Link to={nav.page.path}>{nav.page.name}</Link> : nav.page.name },
    ...(detail ? [{ title: detail }] : []),
  ] : [];
  return (
    <PageContainer
      title={title ?? nav?.page.name}
      breadcrumb={{ items }}
      className={['wm-page', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </PageContainer>
  );
}
