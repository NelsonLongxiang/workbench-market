/**
 * 把一次视图取数的结果（台库 renderView 的应答）排成一页：照视图描述里的次序，一个组件一个块，放进 12 列栅格。
 * 筛选栏变了就把新的值交给调用方去重新取数；表单提交交给调用方。这里不取数、不判权限。
 */
import { useMemo } from 'react';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { viewResultToSpec } from './jr/to-spec';
import { benchRegistry, BenchBlockContext } from './jr/registry';
import { ImageSourceContext } from './BenchImage';
import { layoutSpans, type BlockData, type BlockError } from './blocks-view';

type Block = { type: string; title?: string; span?: number; data?: BlockData; error?: BlockError; [k: string]: unknown };
/** cursor：变更游标（实时刷新用，见 web/src/bench-change-poll.ts） */
export type ViewResult = { title: string; version: number; view: { key: string; title: string }; params: Record<string, string>; blocks: Block[]; cursor?: string };

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

export { FORM_DENIED } from './jr/render-block';
export function BenchView(props: BenchViewProps) {
  const { result, imageBench, hideFilters } = props;
  const imageSource = imageBench && result ? { bench: imageBench, view: result.view.key, version: result.version, params: result.params } : null;
  const blocks = result?.blocks ?? [];
  const shown = blocks.map((b, i) => ({ b, i })).filter(({ b }) => !(b.type === 'filter-bar' && hideFilters));
  const laid = layoutSpans(shown.map(({ b }) => b));
  const spanOf = new Map(shown.map(({ i }, k) => [i, laid[k]]));
  const spec = useMemo(() => viewResultToSpec(result, hideFilters), [result, hideFilters]);
  return (
    <ImageSourceContext.Provider value={imageSource}>
      <BenchBlockContext.Provider value={{ result, spanOf, props }}>
        <JSONUIProvider registry={benchRegistry}>
          <Renderer spec={spec} registry={benchRegistry} />
        </JSONUIProvider>
      </BenchBlockContext.Provider>
    </ImageSourceContext.Provider>
  );
}
