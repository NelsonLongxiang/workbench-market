/** 旧页面入口处的一句提示（阶段八 8d）：这里的待办也汇进了「关注」，在那里一次处理一条也行。旧页面照常能用。 */
import { Link } from 'react-router-dom';
import { Typography } from 'antd';

export default function AlsoInAttention({ what }: { what: string }) {
  return <Typography.Paragraph type="secondary" className="wm-mb-1" data-testid="also-in-attention">
    {what}也可以在<Link to="/attention">「关注」</Link>里处理，一次一条。
  </Typography.Paragraph>;
}
