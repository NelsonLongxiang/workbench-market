/** 统计卡：小标签 + 大数 + 单位，可带环比；可以点（跳到对应的列表）。 */
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { fmtNumber, statOf } from './blocks-view';

export interface StatBlockProps extends BlockFrameProps {
  /** 取哪一列的数（第一行） */
  value: string;
  unit?: string;
  /** 环比：value 是变化量；direction 是涨还是跌；good 说哪个方向算好（缺省涨算好），决定用成功色还是危险色 */
  delta?: { value: number; direction: 'up' | 'down'; label?: string; good?: 'up' | 'down' };
  onClick?: () => void;
}

export function StatBlock({ value, unit, delta, onClick, title, span = 3, ...frame }: StatBlockProps) {
  const n = statOf(frame.data, value);
  const good = delta && (delta.good ?? 'up') === delta.direction;
  return (
    <BlockFrame {...frame} title={title} smallTitle span={span} kind="stat" onClick={onClick} label={typeof title === 'string' ? `${title}：点开看明细` : undefined}>
      <div className="wm-dash-display wm-num">
        {fmtNumber(n)}
        {unit ? <span className="wm-dash-suffix">{unit}</span> : null}
      </div>
      {delta ? (
        <span className={`wm-dash-delta ${good ? 'wm-tone-success' : 'wm-tone-danger'}`}>
          {delta.direction === 'up' ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {fmtNumber(Math.abs(delta.value))}{delta.label ? ` ${delta.label}` : ''}
        </span>
      ) : null}
    </BlockFrame>
  );
}
