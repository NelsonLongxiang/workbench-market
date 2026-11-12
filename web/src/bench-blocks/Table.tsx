/**
 * 表格：列按数据的列定义来，格子按列的画法画——数字右对齐、时间显示相对时间、人和席位照 people.ts 的规则、状态用标签。
 * 状态列排最左（列表的规矩）；整行可以点（onRowClick）。
 */
import { Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import RelTime from '../components/RelTime';
import { seatLabel, who } from '../people';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { cellKind, cellText, type BlockColumn } from './blocks-view';

type Row = Record<string, unknown>;
export interface TableBlockProps extends BlockFrameProps {
  /** 显示哪些列、按什么次序；不给就是数据里的全部列 */
  columns?: string[];
  pageSize?: number;
  onRowClick?: (row: Row) => void;
  /** 状态列的值怎么说、用什么颜色；没给的值原样显示成灰标签。不要把服务端的状态代号直接给人看 */
  statusText?: (value: unknown) => { text: string; tone?: 'success' | 'warning' | 'danger' | 'default' } | null;
}

const TONE: Record<string, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };

export function TableBlock({ columns, pageSize = 10, onRowClick, statusText, span = 12, ...frame }: TableBlockProps) {
  const defs = frame.data?.columns ?? [];
  const picked = (columns ? columns.map((n) => defs.find((c) => c.name === n)).filter((c): c is BlockColumn => !!c) : defs);
  // 状态列排最左
  const ordered = [...picked.filter((c) => cellKind(c) === 'status'), ...picked.filter((c) => cellKind(c) !== 'status')];
  const cols: ColumnsType<Row> = ordered.map((c) => {
    const kind = cellKind(c);
    return {
      title: c.label || c.name, dataIndex: c.name, key: c.name, align: kind === 'number' ? 'right' : 'left', ellipsis: kind === 'text',
      className: kind === 'number' ? 'wm-num' : undefined,
      render: (v: unknown) => {
        if (kind === 'time') return <RelTime value={typeof v === 'string' ? v : null} />;
        if (kind === 'person') return who(v) || '-';
        if (kind === 'seat') return seatLabel(who(v)) || '-';
        if (kind === 'status') {
          if (v === null || v === undefined || v === '') return '-';
          const s = statusText?.(v);
          return <Tag color={TONE[s?.tone ?? 'default']}>{s?.text ?? String(v)}</Tag>;
        }
        return cellText(v, kind);
      },
    };
  });
  const rows = frame.data?.rows ?? [];
  // 行没有天然的键：按它在这一页数据里的位置来
  const keyOf = new Map(rows.map((r, i) => [r, String(i)]));
  return (
    <BlockFrame {...frame} span={span} kind="table">
      <Table<Row>
        size="middle" columns={cols} dataSource={rows} rowKey={(r) => keyOf.get(r) ?? ''}
        pagination={rows.length > pageSize ? { pageSize, size: 'small', showSizeChanger: false, hideOnSinglePage: true } : false}
        onRow={onRowClick ? (row) => ({ onClick: () => onRowClick(row), className: 'wm-bb-row-click' }) : undefined}
      />
    </BlockFrame>
  );
}
