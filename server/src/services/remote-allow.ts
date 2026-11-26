/** 远程写豁免面的变更（remote_allow_state ×1）：SQL 原文自 index.ts 的 /api/remote-allow/diff 路由搬入——同语句、同参数、同结果形状。
 *  启动时算变更、写快照的那两句（computeAllowDiff）不在路由里，留在 index.ts。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

/** 最近一次记下的豁免面快照原文（JSON）；没有就是 undefined */
export function latestAllowSnapshot(): string | undefined {
  const row = db.prepare('SELECT snapshot FROM remote_allow_state ORDER BY id DESC LIMIT 1').get() as { snapshot: string } | undefined;
  return row?.snapshot;
}

/** 记一份新的豁免面快照（JSON 原文） */
export function insertAllowSnapshot(snapshotJson: string): void {
  db.prepare('INSERT INTO remote_allow_state (snapshot) VALUES (?)').run(snapshotJson);
}

/** 豁免面变更要通知的绑定：notify / both 方向、没撤、填了取卡地址的 */
export function allowNotifyBindings(): { target_slug: string; agent_node: string; notify_url: string }[] {
  return db.prepare("SELECT target_slug, agent_node, notify_url FROM bindings WHERE direction IN ('notify','both') AND revoked_at = '' AND notify_url != ''").all() as { target_slug: string; agent_node: string; notify_url: string }[];
}

export class RemoteAllowService extends Service {
  constructor(ctx: any) {
    super(ctx, 'remoteAllow');
  }

  /** 库里快照的条数 */
  snapshotCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM remote_allow_state').get();
  }
}
