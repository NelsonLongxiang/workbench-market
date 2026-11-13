/**
 * 把一次视图取数的结果（台库 renderView 的应答）排成一页：照视图描述里的次序，一个组件一个块，放进 12 列栅格。
 * 筛选栏变了就把新的值交给调用方去重新取数；表单提交交给调用方。这里不取数、不判权限。
 */
import { DashGrid } from '../components/Dash';
import { BarBlock, LineBlock, PieBlock } from './Chart';
import { FilterBar, type FilterField } from './FilterBar';
import { FormBlock, type FormField } from './Form';
import { ProgressBlock } from './Progress';
import { StatBlock } from './Stat';
import { TableBlock } from './Table';
import { layoutSpans, snapSpan, valueLabel, withLabelColumns, type BlockData, type BlockError } from './blocks-view';

type Block = { type: string; title?: string; span?: number; data?: BlockData; error?: BlockError; [k: string]: unknown };
export type ViewResult = { title: string; version: number; view: { key: string; title: string }; params: Record<string, string>; blocks: Block[] };

export interface BenchViewProps {
  result: ViewResult | null;
  loading?: boolean;
  onParams: (params: Record<string, string>) => void;
  onSubmit: (blockIndex: number, values: Record<string, unknown>) => Promise<unknown>;
  /** 表单现在不能提交的原因；给了，所有表单的按钮都不可点（比如驾驶舱里一律不能交）。没给时按块：取数应答里表单块的 can_submit 是 false，那一块不可点、说明原因 */
  formDisabledReason?: string;
  /** 外框：card（缺省，单独成页）/ none（拼进驾驶舱的面板里：每个块都不带外框） */
  frame?: 'card' | 'none';
  /** 表格用紧凑的行高（拼进面板里用） */
  dense?: boolean;
  /** 不画视图自己的筛选栏：筛选由外面管（驾驶舱顶上那一排），值照样经取数传进来 */
  hideFilters?: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** 表单块的 can_submit 是 false 时的说法 */
export const FORM_DENIED = '你的账号不能在这个台上填表。要填的话，请管理层为你开通这个台的权限。';
export function BenchView({ result, loading, onParams, onSubmit, formDisabledReason, frame, dense, hideFilters }: BenchViewProps) {
  const blocks = result?.blocks ?? [];
  // 宽度按真正画出来的块排（隐藏的筛选栏不占位）：独占一行又没写 span 的块撑满这一行
  const KNOWN = new Set(['filter-bar', 'form', 'stat', 'progress', 'table', 'bar', 'line', 'pie']);
  const shown = blocks.map((b, i) => ({ b, i })).filter(({ b }) => KNOWN.has(b.type) && !(b.type === 'filter-bar' && hideFilters));
  const laid = layoutSpans(shown.map(({ b }) => b));
  const spanOf = new Map(shown.map(({ i }, k) => [i, laid[k]]));
  return (
    <DashGrid top>
      {blocks.map((b, i) => {
        const common = { frame, title: b.title, span: spanOf.get(i) ?? snapSpan(b.span, b.type), loading, error: b.error ?? null, data: b.data ?? null };
        if (b.type === 'filter-bar') return hideFilters ? null : <FilterBar key={i} frame={frame} title={b.title} span={common.span} fields={(b.fields as FilterField[]) ?? []} value={result?.params ?? {}} onChange={onParams} />;
        if (b.type === 'form') return <FormBlock key={i} frame={frame} title={b.title} span={common.span} error={b.error ?? null} fields={(b.columns as FormField[]) ?? []} submitLabel={str(b.submit_label) || undefined} onSubmit={(v) => onSubmit(i, v)} disabledReason={formDisabledReason ?? (b.can_submit === false ? FORM_DENIED : undefined)} />;
        if (b.type === 'stat') return <StatBlock key={i} {...common} value={str(b.value)} unit={str(b.unit) || undefined} toneRules={b.tone_rules} />;
        if (b.type === 'progress') return <ProgressBlock key={i} {...common} value={str(b.value)} total={typeof b.total === 'number' ? b.total : str(b.total)} />;
        if (b.type === 'table') return <TableBlock key={i} {...common} dense={dense} data={withLabelColumns(common.data, b.value_labels)} statusText={(v, col) => valueLabel(b.value_labels, col, v)} columns={Array.isArray(b.columns) ? (b.columns as string[]) : undefined} pageSize={typeof b.page_size === 'number' ? b.page_size : undefined} />;
        if (b.type === 'bar') return <BarBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} stacked={b.stacked === true} horizontal={b.horizontal === true} toneRules={b.tone_rules} />;
        if (b.type === 'line') return <LineBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} area={b.area === true} />;
        if (b.type === 'pie') return <PieBlock key={i} {...common} label={str(b.label)} value={str(b.value)} donut={b.donut === true} />;
        return null; // 不认识的组件类型不画（保存视图描述时已经拦过）
      })}
    </DashGrid>
  );
}
