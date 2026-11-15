/** Real HTTP publication race: run only in tests, no production hooks. */
import { registerHooks } from 'node:module';
import { linkWorkbench } from '../../server/src/services/bench-registry.ts';
if (process.env.NODE_ENV !== 'test') throw new Error('bench-render-drift fixture is test-only');
globalThis.__benchRenderDrift = (slug) => {
  if (slug === 'binding-race') linkWorkbench(slug, { workbench_id: null }, 'race-test', Date.now());
};
registerHooks({
  load(url, context, next) {
    const out = next(url, context);
    if (!url.endsWith('/server/src/services/bench-render.ts')) return out;
    const source = String(out.source);
    const target = '  return result;';
    if (!source.includes(target)) throw new Error('bench-render publication fixture target missing');
    return { ...out, source: source.replace(target, '  queueMicrotask(() => globalThis.__benchRenderDrift(bench.slug));\n' + target) };
  },
});
