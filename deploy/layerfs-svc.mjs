#!/usr/bin/env node
// layerfs 服务 HTTP 包装（P0 契约 v0 参考实现）：生产实装随 P1 接入 @layerfs/agent。
import { startSubstitute } from '../scripts/layerfs-substitute.mjs';
const s = startSubstitute({ token: process.env.LAYERFS_SERVICE_TOKEN ?? 'change-me' });
await s.listen(Number(process.env.LAYERFS_SERVICE_PORT ?? 8067));
console.log('[layerfs-svc] v0 契约面（P0 参考实现）:', s.url());
