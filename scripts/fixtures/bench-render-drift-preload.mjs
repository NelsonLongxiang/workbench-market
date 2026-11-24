/** Real HTTP publication race: run only in tests, no production hooks. */
import { registerHooks } from 'node:module';
if (process.env.NODE_ENV !== 'test') throw new Error('bench-render-drift fixture is test-only');
// 取数（bench-render.ts）与变更游标（bench-store.ts 的 changeCursor）：读完之后、路由发布之前，在微任务里改绑
const PATCHES = [
  ['/server/src/services/bench-render.ts', '  return result;', '  queueMicrotask(() => globalThis.__benchRenderDrift(bench.slug));\n  return result;'],
  ['/server/src/services/bench-store.ts', "  changeCursor(): ReturnType<Core['changeCursor']> { return this.rpc('changeCursor', []); }",
    "  changeCursor(): ReturnType<Core['changeCursor']> { return this.rpc('changeCursor', []).then((v) => { queueMicrotask(() => globalThis.__benchRenderDrift(this.slug)); return v; }) as ReturnType<Core['changeCursor']>; }"],
];
registerHooks({
  load(url, context, next) {
    const out = next(url, context);
    const hit = PATCHES.find(([file]) => url.endsWith(file));
    if (!hit) return out;
    const source = String(out.source);
    if (!source.includes(hit[1])) throw new Error('publication fixture target missing: ' + hit[0]);
    return { ...out, source: source.replace(hit[1], hit[2]) };
  },
});
// 先挂钩再加载：bench-registry.ts 会连带加载 bench-store.ts，晚挂就改不到它
const { linkWorkbench } = await import('../../server/src/services/bench-registry.ts');
globalThis.__benchRenderDrift = (slug) => {
  if (slug === 'binding-race') linkWorkbench(slug, { workbench_id: null }, 'race-test', Date.now());
};
