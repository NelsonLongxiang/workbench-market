/** View-selected numeric keys are published by the saved view, not arbitrary vars-read access. */
import { resolveViewVars } from '../bench-bindings.ts';
import { getVar, workbenchScope } from '../workbench-vars.ts';
import { HttpError } from '../errors.ts';
import { getBench, type BenchEntry } from './bench-registry.ts';
import type { BenchStore } from './bench-store.ts';

/** Caller must authorize this bench before calling. Never accept a card/key from query parameters. */
export async function renderBenchView(bench: BenchEntry, store: BenchStore, opts: Parameters<BenchStore['renderView']>[0], invalidSelectors = false) {
  const out = await store.renderView(opts);
  if (invalidSelectors) return { ...out, blocks: out.blocks.map(({ data: _data, ...block }) => ({ ...block, error: { code: 'invalid', message: '取数只接受视图、版本和筛选参数，不能指定变量' } })) };
  return resolveViewVars(out, async key => {
    const current = getBench(bench.slug);
    if (!current || current.workbench_id === null || current.workbench_id !== bench.workbench_id || current.department_id !== bench.department_id || current.team_host !== bench.team_host || current.team !== bench.team) throw new HttpError(404, '工作台没有关联卡片或关联已改变');
    const hit = await getVar(workbenchScope(current.workbench_id), key);
    const after = getBench(bench.slug);
    if (!after || after.workbench_id !== current.workbench_id || after.department_id !== current.department_id || after.team_host !== current.team_host || after.team !== current.team) throw new HttpError(403, '工作台关联已改变，请重新打开');
    return { value: hit.value, revision: hit.revision };
  });
}
