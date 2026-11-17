/**
 * 测试用：在判定事件上挂一个抛错的监听器（prepend，排在内置的六步前面），验「并行比对时监听器出错只计数、不影响请求」。
 * 只在 scripts/judgment-compare-smoke.mjs 起的隔离实例里用（node --import），只在 NODE_ENV=test 时装。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.NODE_ENV !== 'test') {
  console.error('[judgment-fault-preload] 只能在 NODE_ENV=test 下用');
  process.exit(1);
}
const { root } = await import(pathToFileURL(join(process.cwd(), 'src/root-context.ts')).href);
root.on('judgment/judge', () => { throw new Error('synthetic judgment fault'); }, true);
