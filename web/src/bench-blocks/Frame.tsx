/**
 * 数据视图组件的外框和四种状态。每个块都包这一层，驾驶舱不用再包：
 * 标题在左，右上角是调用方给的操作和「数据截至 HH:mm」；读取中、出错、空、数据不全各有固定的样子。
 * 外框的类名沿用现有看板的（.wm-dash-card、.wm-span-N），放进 12 列栅格（DashGrid）里，宽度只取 3 / 4 / 6 / 12。
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Alert, Empty, Skeleton } from 'antd';
import dayjs from 'dayjs';
import { errorText, isEmptyData, type BlockData, type BlockError } from './blocks-view';

export type BlockSpan = 3 | 4 | 6 | 12;
export interface BlockFrameProps {
  title?: ReactNode;
  span?: BlockSpan;
  /** 右上角的操作（「查看全部」「就这个安排一件事」这类） */
  extra?: ReactNode;
  /** 数据是什么时候的；超过 staleAfterMs 就在块头显示「数据截至 HH:mm」 */
  asOf?: number | null;
  staleAfterMs?: number;
  loading?: boolean;
  error?: BlockError | null;
  /** 出错时说什么；不给用缺省的说法（blocks-view.ts 的 errorText） */
  errorMessage?: (e: BlockError) => string;
  /** 空的时候说什么：说清为什么空、下一步能做什么。不给就只说没有符合条件的数据 */
  empty?: string;
  data?: BlockData | null;
}

export function BlockFrame({ title, span = 6, extra, asOf, staleAfterMs, loading, error, errorMessage, empty, data, kind, skipEmpty, smallTitle, onClick, label, children }: BlockFrameProps & {
  /** skipEmpty：这个块没有「空」这一说（筛选栏、表单）。smallTitle：标题画成数字上面那行小标签（统计卡、进度），四种状态下都在 */
  kind: string; skipEmpty?: boolean; smallTitle?: boolean; onClick?: () => void; label?: string; children?: ReactNode;
}) {
  const stale = asOf != null && staleAfterMs != null && Date.now() - asOf > staleAfterMs;
  const head = (title && !smallTitle) || extra || stale;
  const onKey = (e: KeyboardEvent) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } };
  const state = loading ? 'loading' : error ? 'error' : !skipEmpty && isEmptyData(data) ? 'empty' : 'ready';
  return (
    <section
      className={`wm-dash-card wm-bb wm-bb-${kind} wm-span-${span}${onClick ? ' wm-dash-clickable' : ''}`}
      data-span={span} data-bb={kind} data-bb-state={state}
      {...(onClick ? { role: 'button', tabIndex: 0, 'aria-label': label, onClick, onKeyDown: onKey } : {})}
    >
      {head ? (
        <header className="wm-dash-card-head">
          <h3 className="wm-dash-card-title">{smallTitle ? null : title}</h3>
          <div className="wm-dash-card-extra">
            {stale && <span className="wm-dash-stale">数据截至 {dayjs(asOf).format('HH:mm')}</span>}
            {extra}
          </div>
        </header>
      ) : null}
      <div className="wm-dash-card-body wm-bb-body">
        {smallTitle && title ? <span className="wm-stat-label">{title}</span> : null}
        {state === 'loading' ? <Skeleton active paragraph={{ rows: 2 }} title={false} />
          : state === 'error' ? <Alert type="warning" showIcon message={(errorMessage ?? errorText)(error as BlockError)} />
            : state === 'empty' ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty ?? '没有符合条件的数据'} />
              : children}
        {state === 'ready' && data?.truncated ? <div className="wm-bb-truncated">数据不止这些，这里只显示了前 {data.rows.length} 行。把筛选范围缩小一点能看全。</div> : null}
      </div>
    </section>
  );
}
