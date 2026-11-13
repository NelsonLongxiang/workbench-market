/**
 * 表格：列按数据的列定义来，格子按列的画法画——数字右对齐、时间显示相对时间、人和席位照 people.ts 的规则、状态用标签。
 * 状态列排最左（列表的规矩）；整行可以点（onRowClick）。
 */
import type { ReactNode } from 'react';
import { Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import RelTime from '../components/RelTime';
import { seatLabel, who } from '../people';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { cellKind, cellText, nowrapWidth, type BlockColumn } from './blocks-view';

type Row = Record<string, unknown>;
export interface TableBlockProps extends BlockFrameProps {
  /** 显示哪些列、按什么次序；不给就是数据里的全部列 */
  columns?: string[];
  pageSize?: number;
  onRowClick?: (row: Row) => void;
  /** 每行的操作：内容由调用方给，这里把它放在最右一列并固定。直接露出的不超过 2 个，多的由调用方收进「更多」（components/RowActions.tsx） */
  rowActions?: (row: Row) => ReactNode;
  /** 紧凑：行高照原型明细表的密度。拼进面板里用；单独成页不给 */
  dense?: boolean;
  /** 状态列的值怎么说、用什么颜色；没给的值原样显示成灰标签。不要把服务端的状态代号直接给人看 */
  statusText?: (value: unknown, column: string) => { text: string; tone?: 'success' | 'warning' | 'danger' | 'default' } | null;
}

const TONE: Record<string, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };

export function TableBlock({ columns, pageSize = 10, onRowClick, rowActions, statusText, dense, span = 12, ...frame }: TableBlockProps) {
  const defs = frame.data?.columns ?? [];
  const picked = (columns ? columns.map((n) => defs.find((c) => c.name === n)).filter((c): c is BlockColumn => !!c) : defs);
  // 状态列排最左
  const ordered = [...picked.filter((c) => cellKind(c) === 'status'), ...picked.filter((c) => cellKind(c) !== 'status')];
  const rows = frame.data?.rows ?? [];
  let fixedSum = 0, flexCount = 0;
  const cols: ColumnsType<Row> = ordered.map((c) => {
    const kind = cellKind(c);
    // 短值列（数字、日期、时间、是否、状态）不折行：按这一页最长的值给列宽；文本列分剩下的宽度、超长省略
    const shownText = (v: unknown) => (kind === 'status' ? (statusText?.(v, c.name)?.text ?? String(v ?? '')) : cellText(v, kind));
    const width = nowrapWidth(kind, c.label || c.name, rows.map((r) => shownText(r[c.name])));
    if (width) fixedSum += width; else flexCount++;
    return {
      title: c.label || c.name, dataIndex: c.name, key: c.name, align: kind === 'number' ? 'right' : 'left', ellipsis: kind === 'text',
      width, className: [kind === 'number' ? 'wm-num' : '', width ? 'wm-bb-nowrap' : ''].filter(Boolean).join(' ') || undefined,
      render: (v: unknown) => {
        if (kind === 'time') return <RelTime value={typeof v === 'string' ? v : null} />;
        if (kind === 'person') return who(v) || '-';
        if (kind === 'seat') return seatLabel(who(v)) || '-';
        if (kind === 'status') {
          if (v === null || v === undefined || v === '') return '-';
          const s = statusText?.(v, c.name);
          // 没配说法的取值：灰色的原文，比标签弱一档，一眼看得出「这个还没配说法」
          if (!s) return <span className="wm-bb-raw" title="这个取值还没有配说法">{String(v)}</span>;
          return <Tag color={TONE[s.tone ?? 'default']}>{s.text}</Tag>;
        }
        return cellText(v, kind);
      },
    };
  });
  // 操作列排最右、固定；点操作不算点这一行
  if (rowActions) cols.push({ title: '操作', key: '__actions', align: 'right', fixed: 'right', width: 1, className: 'wm-bb-actions', render: (_: unknown, row) => <span onClick={(e) => e.stopPropagation()}>{rowActions(row)}</span> });
  // 行没有天然的键：按它在这一页数据里的位置来
  const keyOf = new Map(rows.map((r, i) => [r, String(i)]));
  return (
    <BlockFrame {...frame} span={span} kind="table">
      <Table<Row>
        size={dense ? 'small' : 'middle'} className={dense ? 'wm-bb-dense' : undefined} scroll={rowActions ? { x: 'max-content' } : fixedSum ? { x: fixedSum + flexCount * 160 } : undefined} columns={cols} dataSource={rows} rowKey={(r) => keyOf.get(r) ?? ''}
        pagination={rows.length > pageSize ? { pageSize, size: 'small', showSizeChanger: false, hideOnSinglePage: true } : false}
        onRow={onRowClick ? (row) => ({ onClick: () => onRowClick(row), className: 'wm-bb-row-click' }) : undefined}
      />
    </BlockFrame>
  );
}
