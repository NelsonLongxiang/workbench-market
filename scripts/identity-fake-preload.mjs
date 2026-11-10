/**
 * 预加载（测试夹具）：node --import <本文件> src/index.ts，在真实的 index.ts 开始装配之前把登录提供方换成假的。
 * 要测的目录树由 IDENTITY_SEAM_ROOT 指定，缺省是本仓库。
 *
 * 只在 NODE_ENV=test 下干活。这个文件会随镜像一起发出去：在别的环境里被 --import 或 NODE_OPTIONS 带进来，
 * 进程直接退出，不会带着假的提供方起来。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'test') {
  console.error('[identity-fake-preload] 拒绝加载：这是测试夹具，只在 NODE_ENV=test 下可用');
  process.exit(1);
}
const { swapInFake } = await import('./identity-fake-provider.mjs');
await swapInFake(process.env.IDENTITY_SEAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
