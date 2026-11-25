/** Register view blocks without adding catalog schemas to the browser bundle. */
import { Component, createContext, useContext, type ReactNode } from 'react';
import type { ComponentRegistry, ComponentRenderProps } from '@json-render/react';
import { DashGrid } from '../../components/Dash';
import { BlockFrame } from '../Frame';
import { snapSpan } from '../blocks-view';
import { BLOCK_TYPE_LIST } from './block-types.ts';
import { renderBenchBlock, type BlockCtx } from './render-block';

export const BenchBlockContext = createContext<BlockCtx | null>(null);
function BenchGrid({ children }: { children?: ReactNode }) { return <DashGrid top>{children}</DashGrid>; }

type Block = NonNullable<BlockCtx['result']>['blocks'][number];
type BlockProps = { block: Block; index: number; context: BlockCtx };
type BoundaryState = { block: Block; failed: boolean };
const renderError = { code: 'block_render_failed' };

// Retry a failed block on a new response without remounting healthy blocks on refresh.
class BlockBoundary extends Component<BlockProps, BoundaryState> {
  state: BoundaryState = { block: this.props.block, failed: false };

  static getDerivedStateFromProps({ block }: BlockProps, state: BoundaryState): BoundaryState | null {
    return block === state.block ? null : { block, failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    const { block, index, context } = this.props;
    if (!this.state.failed) return <RenderBlock {...this.props} />;
    return <BlockFrame
      kind="render-error"
      frame={context.props.frame}
      title={typeof block.title === 'string' ? block.title : undefined}
      span={context.spanOf.get(index) ?? snapSpan(block.span, block.type)}
      error={renderError}
      errorMessage={() => '这一块暂时无法显示。刷新数据后会重新尝试。'}
    />;
  }
}

function RenderBlock({ block, index, context }: BlockProps) {
  return renderBenchBlock(block, index, context);
}

function BenchBlockElement({ element }: ComponentRenderProps<{ index?: number }>) {
  const context = useContext(BenchBlockContext);
  const { index } = element.props;
  if (!context || typeof index !== 'number') return null;
  const block = context.result?.blocks[index];
  return block ? <BlockBoundary block={block} index={index} context={context} /> : null;
}
export const benchRegistry: ComponentRegistry = {
  BenchGrid: BenchGrid as ComponentRegistry[string],
  UnknownBlock: BenchBlockElement as ComponentRegistry[string],
  ...Object.fromEntries(BLOCK_TYPE_LIST.map((t) => [t, BenchBlockElement as ComponentRegistry[string]])),
};
