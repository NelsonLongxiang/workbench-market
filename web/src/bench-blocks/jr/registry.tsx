/** Register view blocks without adding catalog schemas to the browser bundle. */
import { createContext, useContext, type ReactNode } from 'react';
import type { ComponentRegistry, ComponentRenderProps } from '@json-render/react';
import { DashGrid } from '../../components/Dash';
import { BLOCK_TYPE_LIST } from './block-types.ts';
import { renderBenchBlock, type BlockCtx } from './render-block';

export const BenchBlockContext = createContext<BlockCtx | null>(null);
function BenchGrid({ children }: { children?: ReactNode }) { return <DashGrid top>{children}</DashGrid>; }
function BenchBlockElement({ element }: ComponentRenderProps<{ index?: number }>) {
  const context = useContext(BenchBlockContext);
  const { index } = element.props;
  if (!context || typeof index !== 'number') return null;
  const block = context.result?.blocks[index];
  return block ? renderBenchBlock(block, index, context) : null;
}
export const benchRegistry: ComponentRegistry = {
  BenchGrid: BenchGrid as ComponentRegistry[string],
  UnknownBlock: BenchBlockElement as ComponentRegistry[string],
  ...Object.fromEntries(BLOCK_TYPE_LIST.map((t) => [t, BenchBlockElement as ComponentRegistry[string]])),
};
