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
  /** 多级详情（如 SOP / 单次记录）：按顺序接在页面名后，除最后一级外可带 to 链接；给了就不用 detail */
  trail?: Array<{ title: ReactNode; to?: string }>;
  children?: ReactNode;
}

export default function WmPage({ title, detail, trail, className, children, ...rest }: WmPageProps) {
  const nav = findNav(useLocation().pathname);
  const tail = trail ?? (detail ? [{ title: detail }] : []);
  const items = nav ? [
    { title: nav.group.name },
    { title: tail.length ? <Link to={nav.page.path}>{nav.page.name}</Link> : nav.page.name },
    ...tail.map((t, i) => ({ title: t.to && i < tail.length - 1 ? <Link to={t.to}>{t.title}</Link> : t.title })),
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
