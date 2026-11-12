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
import { snapSpan, valueLabel, withLabelColumns, type BlockData, type BlockError } from './blocks-view';

type Block = { type: string; title?: string; span?: number; data?: BlockData; error?: BlockError; [k: string]: unknown };
export type ViewResult = { title: string; version: number; view: { key: string; title: string }; params: Record<string, string>; blocks: Block[] };

export interface BenchViewProps {
  result: ViewResult | null;
  loading?: boolean;
  onParams: (params: Record<string, string>) => void;
  onSubmit: (blockIndex: number, values: Record<string, unknown>) => Promise<unknown>;
  /** 表单现在不能提交的原因；给了，所有表单的按钮都不可点 */
  formDisabledReason?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
export function BenchView({ result, loading, onParams, onSubmit, formDisabledReason }: BenchViewProps) {
  const blocks = result?.blocks ?? [];
  return (
    <DashGrid>
      {blocks.map((b, i) => {
        const common = { title: b.title, span: snapSpan(b.span, b.type), loading, error: b.error ?? null, data: b.data ?? null };
        if (b.type === 'filter-bar') return <FilterBar key={i} title={b.title} span={common.span} fields={(b.fields as FilterField[]) ?? []} value={result?.params ?? {}} onChange={onParams} />;
        if (b.type === 'form') return <FormBlock key={i} title={b.title} span={common.span} error={b.error ?? null} fields={(b.columns as FormField[]) ?? []} submitLabel={str(b.submit_label) || undefined} onSubmit={(v) => onSubmit(i, v)} disabledReason={formDisabledReason} />;
        if (b.type === 'stat') return <StatBlock key={i} {...common} value={str(b.value)} unit={str(b.unit) || undefined} toneRules={b.tone_rules} />;
        if (b.type === 'progress') return <ProgressBlock key={i} {...common} value={str(b.value)} total={typeof b.total === 'number' ? b.total : str(b.total)} />;
        if (b.type === 'table') return <TableBlock key={i} {...common} data={withLabelColumns(common.data, b.value_labels)} statusText={(v, col) => valueLabel(b.value_labels, col, v)} columns={Array.isArray(b.columns) ? (b.columns as string[]) : undefined} pageSize={typeof b.page_size === 'number' ? b.page_size : undefined} />;
        if (b.type === 'bar') return <BarBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} stacked={b.stacked === true} horizontal={b.horizontal === true} toneRules={b.tone_rules} />;
        if (b.type === 'line') return <LineBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} area={b.area === true} />;
        if (b.type === 'pie') return <PieBlock key={i} {...common} label={str(b.label)} value={str(b.value)} donut={b.donut === true} />;
        return null; // 不认识的组件类型不画（保存视图描述时已经拦过）
      })}
    </DashGrid>
  );
}
