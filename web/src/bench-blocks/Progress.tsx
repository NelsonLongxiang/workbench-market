/** 进度：做了多少 / 一共多少，一条进度条加两个数。总数可以取一列，也可以是写死的数字。 */
import { Progress } from 'antd';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { fmtNumber, progressOf } from './blocks-view';
import { DESIGN_TOKENS as T } from '../design-tokens';

export interface ProgressBlockProps extends BlockFrameProps { value: string; total: string | number; unit?: string }

export function ProgressBlock({ value, total, unit, span = 3, ...frame }: ProgressBlockProps) {
  const p = progressOf(frame.data, value, total);
  return (
    <BlockFrame {...frame} smallTitle span={span} kind="progress">
      <div className="wm-bb-progress-nums wm-num">
        <span className="wm-dash-display">{fmtNumber(p?.value)}</span>
        <span className="wm-dash-suffix">/ {fmtNumber(p?.total)}{unit ? ` ${unit}` : ''}</span>
      </div>
      <Progress
        percent={p?.ratio == null ? 0 : Math.round(p.ratio * 100)} showInfo={p?.ratio != null} size="small"
        strokeColor={p?.ratio === 1 ? T.colors.success : T.colors.primary} trailColor={T.colors.page}
      />
    </BlockFrame>
  );
}
