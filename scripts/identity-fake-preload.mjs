/**
 * 预加载（测试夹具）：node --import <本文件> src/index.ts，在真实的 index.ts 开始装配之前把登录提供方换成假的。
 * 要测的目录树由 IDENTITY_SEAM_ROOT 指定，缺省是本仓库。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swapInFake } from './identity-fake-provider.mjs';

await swapInFake(process.env.IDENTITY_SEAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
