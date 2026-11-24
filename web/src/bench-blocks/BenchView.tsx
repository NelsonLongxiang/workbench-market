/**
 * 把一次视图取数的结果（台库 renderView 的应答）排成一页：照视图描述里的次序，一个组件一个块，放进 12 列栅格。
 * 筛选栏变了就把新的值交给调用方去重新取数；表单提交交给调用方。这里不取数、不判权限。
 */
import { DashGrid } from '../components/Dash';
import { BarBlock, LineBlock, PieBlock } from './Chart';
import { FilterBar, type FilterField } from './FilterBar';
import { RecordsBlock } from './Records';
import { FormBlock, type FormField } from './Form';
import { ProgressBlock } from './Progress';
import { StatBlock } from './Stat';
import { TableBlock } from './Table';
import { NativeTable } from './NativeTable';
import { DagBlock, type DagBlockProps } from './DagBlock';
import { BlockFrame } from './Frame';
import { ImageSourceContext } from './BenchImage';
import { asTableContext } from '../bench-table-view';
import { filterBarValue, layoutSpans, snapSpan, valueLabel, withLabelColumns, type BlockData, type BlockError } from './blocks-view';

type Block = { type: string; title?: string; span?: number; data?: BlockData; error?: BlockError; [k: string]: unknown };
export type ViewResult = { title: string; version: number; view: { key: string; title: string }; params: Record<string, string>; blocks: Block[] };

export interface BenchViewProps {
  result: ViewResult | null;
  loading?: boolean;
  onParams: (params: Record<string, string>) => void;
  /** 人最新选的筛选值（台页面：地址里的；驾驶舱面板：它自己记着的）。给了，筛选栏的值和下一次改动都按它（盖在视图的缺省值上）算，不按上一次取数回来的 params——取数还在路上时连着改第二个，第一个不会被冲掉 */
  filterValue?: Record<string, string>;
  onSubmit: (blockIndex: number, values: Record<string, unknown>) => Promise<unknown>;
  /** 表单现在不能提交的原因；给了，所有表单的按钮都不可点（比如驾驶舱里一律不能交）。没给时按块：取数应答里表单块的 can_submit 是 false，那一块不可点、说明原因 */
  formDisabledReason?: string;
  /** 外框：card（缺省，单独成页）/ none（拼进驾驶舱的面板里：每个块都不带外框） */
  frame?: 'card' | 'none';
  /** 表格用紧凑的行高（拼进面板里用） */
  dense?: boolean;
  /** 不画视图自己的筛选栏：筛选由外面管（驾驶舱顶上那一排），值照样经取数传进来 */
  hideFilters?: boolean;
  /** Only the standalone bench page enables authenticated table download/detail actions. */
  tableBench?: string;
  tableDisabled?: boolean;
  /** 图片列经哪个台代取（台页面给卡片 id，驾驶舱给引用的台）；不给就画「图片取不到」占位 */
  imageBench?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** 表单块的 can_submit 是 false 时的说法 */
export const FORM_DENIED = '你的账号不能在这个台上填表。要填的话，请管理层为你开通这个台的权限。';
export function BenchView({ result, loading, onParams, onSubmit, formDisabledReason, frame, dense, hideFilters, tableBench, tableDisabled, filterValue, imageBench }: BenchViewProps) {
  // 图片的来源视图就是这次取数：台、视图、版本、筛选值（服务端按这一组重渲染、核对引用）
  const imageSource = imageBench && result ? { bench: imageBench, view: result.view.key, version: result.version, params: result.params } : null;
  const blocks = result?.blocks ?? [];
  // 宽度按真正画出来的块排（隐藏的筛选栏不占位）：独占一行又没写 span 的块撑满这一行
  // 不认识的组件类型（比如服务端比页面新）也占位，画一块「要新版页面」的说明，不悄悄不画
  const shown = blocks.map((b, i) => ({ b, i })).filter(({ b }) => !(b.type === 'filter-bar' && hideFilters));
  const laid = layoutSpans(shown.map(({ b }) => b));
  const spanOf = new Map(shown.map(({ i }, k) => [i, laid[k]]));
  return (
    <ImageSourceContext.Provider value={imageSource}>
    <DashGrid top>
      {blocks.map((b, i) => {
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
        // 不认识的组件类型：说一句，不画空白
        return <BlockFrame key={i} frame={frame} title={b.title} span={common.span} kind="unknown" skipEmpty><div className="wm-bb-truncated" data-testid="block-unknown">这个组件（{String(b.type).slice(0, 32)}）要新版页面才能显示，刷新页面或稍后再试。</div></BlockFrame>;
      })}
    </DashGrid>
    </ImageSourceContext.Provider>
  );
}
