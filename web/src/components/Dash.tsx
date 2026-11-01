/** 数据看板（PATTERNS.md §6）：12 列栅格，卡片宽度只取 3 / 4 / 6 / 12；四类卡片共用一个卡片外框——
 *  头部（标题左、时间范围/操作右、过期时「数据截至 HH:mm」）+ 加载态 + 空态；卡片内不再嵌套卡片。
 *  颜色只用 --wm-* 变量：写字用 text / text-secondary / *-text，图表只用状态色与 primary 系（≤5 个系列）。 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, Skeleton } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

export type DashSpan = 3 | 4 | 6 | 12;
export const DASH_SPANS: readonly DashSpan[] = [3, 4, 6, 12];

export function DashGrid({ children }: { children: ReactNode }) {
  return <div className="wm-dash-grid">{children}</div>;
}

export interface DashCardProps {
  title: ReactNode;
  span: DashSpan;
  extra?: ReactNode;
  loading?: boolean;
  /** 为真时显示空态（empty 给描述与下一步操作） */
  isEmpty?: boolean;
  empty?: ReactNode;
  /** 数据时间；超过 staleAfterMs 时卡片头显示「数据截至 HH:mm」 */
  asOf?: number | null;
  staleAfterMs?: number;
  className?: string;
  children?: ReactNode;
}

export function DashCard({ title, span, extra, loading, isEmpty, empty, asOf, staleAfterMs, className, children }: DashCardProps) {
  const stale = asOf != null && staleAfterMs != null && Date.now() - asOf > staleAfterMs;
  return (
    <section className={['wm-dash-card', `wm-span-${span}`, className].filter(Boolean).join(' ')} data-span={span}>
      <header className="wm-dash-card-head">
        <h3 className="wm-dash-card-title">{title}</h3>
        <div className="wm-dash-card-extra">
          {stale && <span className="wm-dash-stale">数据截至 {dayjs(asOf).format('HH:mm')}</span>}
          {extra}
        </div>
      </header>
      <div className="wm-dash-card-body">
        {loading ? <Skeleton active paragraph={{ rows: 2 }} title={false} /> : isEmpty ? (empty ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />) : children}
      </div>
    </section>
  );
}

/** 指标卡：stat-label 标签 + display 大数 + 可选环比（带方向）+ 可选副行；可点则跳转列表页 */
export function MetricCard({ label, value, suffix, tone = 'default', delta, sub, to, span = 3, loading }: {
  label: string; value: ReactNode; suffix?: string; tone?: 'default' | 'success' | 'danger' | 'warning';
  delta?: { value: number; good?: 'up' | 'down' }; sub?: ReactNode; to?: string; span?: DashSpan; loading?: boolean;
}) {
  const navigate = useNavigate();
  const go = to ? () => navigate(to) : undefined;
  const onKey = (e: KeyboardEvent) => { if (go && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } };
  const deltaGood = delta && (delta.good ?? 'up') === (delta.value >= 0 ? 'up' : 'down');
  return (
    <section
      className={`wm-dash-card wm-stat-card wm-span-${span}${go ? ' wm-dash-clickable' : ''}`}
      data-span={span}
      {...(go ? { role: 'button', tabIndex: 0, 'aria-label': `${label}：点击跳转列表`, onClick: go, onKeyDown: onKey } : {})}
    >
      <span className="wm-stat-label">{label}</span>
      {loading ? <Skeleton.Button active size="small" style={{ width: 64 }} /> : (
        <div className={`wm-dash-display wm-num wm-tone-${tone}`}>
          {value}
          {suffix ? <span className="wm-dash-suffix">{suffix}</span> : null}
        </div>
      )}
      {delta && (
        <span className={`wm-dash-delta ${deltaGood ? 'wm-tone-success' : 'wm-tone-danger'}`}>
          {delta.value >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta.value)}
        </span>
      )}
      {sub ? <div className="wm-dash-sub">{sub}</div> : null}
    </section>
  );
}

/** 列表卡：最多 5 行 + 「查看全部」链到对应列表页 */
export function ListCard<T>({ title, span, rows, render, rowKey, moreTo, moreText = '查看全部', ...rest }: Omit<DashCardProps, 'children' | 'isEmpty'> & {
  rows: T[]; render: (row: T) => ReactNode; rowKey: (row: T) => string; moreTo: string; moreText?: string;
}) {
  return (
    <DashCard
      title={title}
      span={span}
      isEmpty={rows.length === 0}
      extra={<Link to={moreTo} className="wm-dash-more">{moreText} <RightOutlined /></Link>}
      {...rest}
    >
      <ul className="wm-dash-list">
        {rows.slice(0, 5).map((r) => <li key={rowKey(r)}>{render(r)}</li>)}
      </ul>
    </DashCard>
  );
}

/** 趋势卡（柱状）：图例在上；只用状态色与 primary 系，最多 5 个系列（超过就分组或改表格） */
export interface BarSeries { key: string; label: string; tone: 'primary' | 'success' | 'danger' | 'warning' | 'muted' }
export function BarChart({ series, data }: { series: BarSeries[]; data: Array<{ label: string; values: Record<string, number> }> }) {
  if (series.length > 5) throw new Error('BarChart：系列最多 5 个（PATTERNS.md §6）');
  const max = Math.max(1, ...data.map((d) => series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0)));
  return (
    <div className="wm-dash-chart">
      <div className="wm-dash-legend">
        {series.map((s) => <span key={s.key}><i className={`wm-swatch wm-fill-${s.tone}`} />{s.label}</span>)}
      </div>
      <div className="wm-dash-bars" role="img" aria-label={data.map((d) => `${d.label} ${series.map((s) => `${s.label} ${d.values[s.key] ?? 0}`).join(' ')}`).join('；')}>
        {data.map((d) => {
          const total = series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0);
          return (
            <div key={d.label} className="wm-dash-bar-row">
              <span className="wm-dash-bar-label" title={d.label}>{d.label}</span>
              <span className="wm-dash-bar-track">
                {series.map((s) => {
                  const v = d.values[s.key] ?? 0;
                  return v ? <span key={s.key} className={`wm-dash-bar wm-fill-${s.tone}`} style={{ width: `${(v / max) * 100}%` }} title={`${s.label} ${v}`} /> : null;
                })}
              </span>
              <span className="wm-dash-bar-value wm-num">{total}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 状态卡：一格一个对象的状态网格（如工作台健康） */
export function StatusGrid({ children }: { children: ReactNode }) {
  return <div className="wm-dash-status-grid">{children}</div>;
}
