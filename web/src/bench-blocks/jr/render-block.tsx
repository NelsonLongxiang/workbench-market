/** 按原有组件、原有回调绘制取数结果。 */
import { BarBlock, LineBlock, PieBlock } from '../Chart';
import { FilterBar, type FilterField } from '../FilterBar';
import { RecordsBlock } from '../Records';
import { FormBlock, type FormField } from '../Form';
import { ProgressBlock } from '../Progress';
import { StatBlock } from '../Stat';
import { TableBlock } from '../Table';
import { NativeTable } from '../NativeTable';
import { DagBlock, type DagBlockProps } from '../DagBlock';
import { GanttBlock, type GanttBlockProps } from '../GanttBlock';
import { BlockFrame } from '../Frame';
import { asTableContext } from '../../bench-table-view';
import { filterBarValue, layoutSpans, snapSpan, valueLabel, withLabelColumns } from '../blocks-view';
import type { BenchViewProps, ViewResult } from '../BenchView';
export const FORM_DENIED = '你的账号不能在这个台上填表。要填的话，请管理层为你开通这个台的权限。';

type Block = ViewResult['blocks'][number];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
export interface BlockCtx { result: ViewResult | null; spanOf: Map<number, ReturnType<typeof layoutSpans>[number]>; props: BenchViewProps }
export function renderBenchBlock(b: Block, i: number, c: BlockCtx) {
  const { result, spanOf } = c;
  const { loading, onParams, onSubmit, formDisabledReason, frame, dense, hideFilters, tableBench, tableDisabled, filterValue } = c.props;

  const common = { frame, title: b.title, span: spanOf.get(i) ?? snapSpan(b.span, b.type), loading, error: b.error ?? null, data: b.data ?? null };
  if (b.type === 'filter-bar') return hideFilters ? null : <FilterBar key={i} frame={frame} title={b.title} span={common.span} fields={(b.fields as FilterField[]) ?? []} value={filterValue ? filterBarValue((b.fields as FilterField[]) ?? [], filterValue) : result?.params ?? {}} onChange={onParams} />;
  if (b.type === 'form') return <FormBlock key={i} frame={frame} title={b.title} span={common.span} error={b.error ?? null} fields={(b.columns as FormField[]) ?? []} submitLabel={str(b.submit_label) || undefined} onSubmit={(v) => onSubmit(i, v)} disabledReason={formDisabledReason ?? (b.can_submit === false ? FORM_DENIED : undefined)} />;
  if (b.type === 'stat') return <StatBlock key={i} {...common} value={str(b.value)} unit={str(b.unit) || undefined} toneRules={b.tone_rules} />;
  if (b.type === 'progress') return <ProgressBlock key={i} {...common} value={str(b.value)} total={typeof b.total === 'number' ? b.total : str(b.total)} />;
  if (b.type === 'table') {
    const props = { ...common, dense, data: withLabelColumns(common.data, b.value_labels), statusText: (v: unknown, col: string) => valueLabel(b.value_labels, col, v), columns: Array.isArray(b.columns) ? b.columns as string[] : undefined, pageSize: typeof b.page_size === 'number' ? b.page_size : undefined };
    const context = asTableContext(b.table_context);
    return tableBench && context ? <NativeTable key={i} {...props} bench={tableBench} context={context} disabled={tableDisabled} /> : <TableBlock key={i} {...props} />;
  }
  if (b.type === 'records') return <RecordsBlock key={i} {...common} dense={dense} empty={str(b.empty_text) || undefined} linkTargets={b.link_targets} pageSize={typeof b.page_size === 'number' ? b.page_size : undefined}
    spec={{ title_col: str(b.title_col), badges: b.badges as string[] | undefined, fields: b.fields as string[] | undefined, details: b.details as string[] | undefined, date_col: str(b.date_col) || undefined, links: b.links as { col: string; label: string }[] | undefined, value_labels: b.value_labels }} />;
  if (b.type === 'bar') return <BarBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} stacked={b.stacked === true} horizontal={b.horizontal === true} toneRules={b.tone_rules} />;
  if (b.type === 'line') return <LineBlock key={i} {...common} x={str(b.x)} y={(b.y as string | string[]) ?? []} series={str(b.series) || undefined} area={b.area === true} />;
  if (b.type === 'pie') return <PieBlock key={i} {...common} label={str(b.label)} value={str(b.value)} donut={b.donut === true} />;
  if (b.type === 'dag') return <DagBlock key={i} {...common} spec={{ id_col: str(b.id_col), label_col: str(b.label_col), deps_col: str(b.deps_col), role_col: str(b.role_col), status_col: str(b.status_col) || undefined,
    done_values: Array.isArray(b.done_values) ? b.done_values as string[] : undefined, progress_col: str(b.progress_col) || undefined, source_col: str(b.source_col) || undefined, group_col: str(b.group_col) || undefined,
    detail_cols: Array.isArray(b.detail_cols) ? b.detail_cols as string[] : undefined, direction: b.direction === 'TB' ? 'TB' : 'LR' }} graphMeta={b.graph_meta as DagBlockProps['graphMeta']} valueLabels={b.value_labels} />;
  if (b.type === 'flow') return <DagBlock key={i} kind="flow" {...common} spec={{ id_col: str(b.id_col), label_col: str(b.label_col), deps_col: str(b.deps_col), role_col: str(b.role_col), status_col: str(b.status_col) || undefined,
    done_values: Array.isArray(b.done_values) ? b.done_values as string[] : undefined, progress_col: str(b.progress_col) || undefined, source_col: str(b.source_col) || undefined, group_col: str(b.group_col) || undefined,
    detail_cols: Array.isArray(b.detail_cols) ? b.detail_cols as string[] : undefined, direction: b.direction === 'TB' ? 'TB' : 'LR', shape_col: str(b.shape_col) || undefined }} graphMeta={b.graph_meta as DagBlockProps['graphMeta']} valueLabels={b.value_labels} />;
  if (b.type === 'gantt') return <GanttBlock key={i} {...common} spec={{ id_col: str(b.id_col), label_col: str(b.label_col), start_col: str(b.start_col), end_col: str(b.end_col), deps_col: str(b.deps_col) || undefined, role_col: str(b.role_col) || undefined,
    status_col: str(b.status_col) || undefined, done_values: Array.isArray(b.done_values) ? b.done_values as string[] : undefined, progress_col: str(b.progress_col) || undefined, group_col: str(b.group_col) || undefined,
    detail_cols: Array.isArray(b.detail_cols) ? b.detail_cols as string[] : undefined }} graphMeta={b.graph_meta as GanttBlockProps['graphMeta']} />;
  // 不认识的组件类型：说一句，不画空白
  return <BlockFrame key={i} frame={frame} title={b.title} span={common.span} kind="unknown" skipEmpty><div className="wm-bb-truncated" data-testid="block-unknown">这个组件（{String(b.type).slice(0, 32)}）要新版页面才能显示，刷新页面或稍后再试。</div></BlockFrame>;
}
