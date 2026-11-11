/** 远程写豁免面的变更（remote_allow_state ×1）：SQL 原文自 index.ts 的 /api/remote-allow/diff 路由搬入——同语句、同参数、同结果形状。
 *  启动时算变更、写快照的那两句（computeAllowDiff）不在路由里，留在 index.ts。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class RemoteAllowService extends Service {
  constructor(ctx: any) {
    super(ctx, 'remoteAllow');
  }

  /** 库里快照的条数 */
  snapshotCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM remote_allow_state').get();
  }
}
