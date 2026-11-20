/** 旧页面入口处的一句提示（阶段八 8d）：这里的待办也汇进了「等你拍板」（全景首页那一栏的完整列表，/attention），在那里能直接批准或驳回。
 *  以前写的是「关注」——那个说法随旧侧栏撤掉了，属主照着找不到（11-18）。旧页面照常能用。 */
import { Link } from 'react-router-dom';
import { Typography } from 'antd';

export default function AlsoInAttention({ what }: { what: string }) {
  return <Typography.Paragraph type="secondary" className="wm-mb-1" data-testid="also-in-attention">
    {what}也汇进了<Link to="/attention">「等你拍板」</Link>（全景首页那一栏的完整列表），在那里能直接批准或驳回。
  </Typography.Paragraph>;
}
