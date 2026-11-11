/** 页面骨架（产品化原型 3fbfd0b）：主区顶上一条 52px 的顶栏——左边页面名（详情页是「页面 / 详情」两级，可返回），
 *  右边页面的操作；下面是内容区，居中、有最大宽度。页面名缺省取菜单里的名字（nav.tsx 是唯一来源）。 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Spin, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { findNav } from '../nav';

export interface WmPageProps {
  /** 缺省取菜单里的页面名 */
  title?: ReactNode;
  /** 页面名旁边的一句说明 */
  subTitle?: ReactNode;
  /** 顶栏下面、内容之前的一段说明 */
  content?: ReactNode;
  /** 顶栏右侧的操作（至多一个主按钮） */
  extra?: ReactNode;
  /** 详情名：进 /x/:id 这类详情页时给，顶栏显示「页面 / 详情」 */
  detail?: ReactNode;
  /** 多级详情：按顺序接在页面名后，除最后一级外可带 to 链接；给了就不用 detail */
  trail?: Array<{ title: ReactNode; to?: string }>;
  onBack?: () => void;
  loading?: boolean;
  /** 内容区放宽：表格多的页面用 */
  wide?: boolean;
  icon?: ReactNode;
  /** 页面名后面的标签（状态等） */
  tags?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export default function WmPage({ title, subTitle, content, extra, detail, trail, onBack, loading, wide, tags, className, children }: WmPageProps) {
  const nav = findNav(useLocation().pathname);
  const tail = trail ?? (detail ? [{ title: detail }] : []);
  const name = nav?.page.name ?? title;
  return (
    <div className={['wm-page', className].filter(Boolean).join(' ')}>
      <div className="wm-top" data-testid="wm-top">
        {onBack && <Button type="text" size="small" aria-label="返回" icon={<ArrowLeftOutlined />} onClick={onBack} />}
        {tail.length ? <span className="wm-top-crumb">
          {nav ? <Link to={nav.page.path}>{nav.page.name}</Link> : <span>{title}</span>}
          {tail.map((t, i) => <span key={i}><span className="wm-top-sep">/</span>{t.to && i < tail.length - 1 ? <Link to={t.to}>{t.title}</Link> : <b>{t.title}</b>}</span>)}
        </span> : <b className="wm-top-title">{title ?? name}</b>}
        {tags}
        {subTitle && <Typography.Text type="secondary" className="wm-top-sub">{subTitle}</Typography.Text>}
        <span className="wm-top-actions">{extra}</span>
      </div>
      <div className={wide ? 'wm-page-body wm-page-body-wide' : 'wm-page-body'}>
        {content && <div className="wm-page-intro">{content}</div>}
        {loading ? <Spin className="wm-page-spin" /> : children}
      </div>
    </div>
  );
}
