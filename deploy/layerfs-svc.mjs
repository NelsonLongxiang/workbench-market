#!/usr/bin/env node
// layerfs 服务 HTTP 包装（P0 契约 v0 参考实现）：生产实装随 P1 接入 @layerfs/agent。
import { startSubstitute } from '../scripts/layerfs-substitute.mjs';
// P1-2（#147）：token 未设/弱值 fail-fast（change-me 不再静默生效）
const _tok = String(process.env.LAYERFS_SERVICE_TOKEN ?? '');
if (_tok === '' || _tok === 'change-me') {
  console.error('[layerfs-svc] LAYERFS_SERVICE_TOKEN 必设且不可为 change-me——拒启（fail-fast）');
  process.exit(1);
}
const s = startSubstitute({ token: process.env.LAYERFS_SERVICE_TOKEN ?? 'change-me' });
await s.listen(Number(process.env.LAYERFS_SERVICE_PORT ?? 8067));
console.log('[layerfs-svc] v0 契约面（P0 参考实现）:', s.url());
