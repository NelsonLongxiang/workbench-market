import type { Spec } from '@json-render/core';
import type { ViewResult } from '../BenchView';
import { BLOCK_TYPE_LIST } from './block-types.ts';

const knownTypes: ReadonlySet<string> = new Set(BLOCK_TYPE_LIST);

/** Only component names and indices enter the spec. React context carries the server response. */
export function viewResultToSpec(result: ViewResult | null, hideFilters = false): Spec {
  const grid = { type: 'BenchGrid', props: {}, children: [] as string[] };
  const elements: Spec['elements'] = { grid };
  (result?.blocks ?? []).forEach((block, index) => {
    if (hideFilters && block.type === 'filter-bar') return;
    const id = 'b' + index;
    grid.children.push(id);
    elements[id] = { type: knownTypes.has(block.type) ? block.type : 'UnknownBlock', props: { index }, children: [] };
  });
  return { root: 'grid', elements };
}
