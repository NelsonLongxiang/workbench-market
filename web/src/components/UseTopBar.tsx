/** #1098 台页、报告页、嵌入使用页的顶栏：「上一页」、市场标识、面包屑（全景 / 台名 / 报告），右边放各页自己的按钮（children）。
 *  保留整屏（嵌入页要宽度），不放回侧栏；不改 iframe 里的台页本身。 */
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Breadcrumb, Button, Tooltip } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { backTarget, topCrumbs, type UsePage } from '../use-topbar-view';

export default function UseTopBar({ cardId, page, title, children }: { cardId: string; page: UsePage; title: ReactNode; children?: ReactNode }) {
  const nav = useNavigate();
  const { key } = useLocation();
  const back = () => { const t = backTarget(key); if (t === -1) nav(-1); else nav('/'); };
  return (
    <div className="wm-use-bar" data-testid="use-top-bar">
      <Tooltip title="返回上一页">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={back} data-testid="use-top-back">上一页</Button>
      </Tooltip>
      <Link to="/" className="wm-use-brand" aria-label="回到全景" data-testid="use-top-logo"><span className="wm-logo">市</span></Link>
      <Breadcrumb className="wm-use-crumbs" items={topCrumbs(cardId, '', page).map((c) => {
        const label = c.key === 'bench' ? title : c.label;
        return { key: c.key, title: c.to ? <Link to={c.to} data-testid={c.testid}>{label}</Link> : <span data-testid={c.testid} aria-current="page">{label}</span> };
      })} />
      {children}
    </div>
  );
}
