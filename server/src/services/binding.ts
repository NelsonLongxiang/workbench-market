/** A2A 人工绑定域（bindings ×6）：SQL 原文自 index.ts 的 /api/bindings 路由搬入——同语句、同参数、同结果形状。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class BindingService extends Service {
  constructor(ctx: any) {
    super(ctx, 'binding');
  }

  /** 一个台的全部绑定（含撤销的），新的在前 */
  listFor(targetType: string, slug: string) {
    return db.prepare("SELECT id, target_type, target_slug, agent_node, direction, mode, notify_url, remote_api_key, revoked_at, created_by, created_at FROM bindings WHERE target_type = ? AND target_slug = ? ORDER BY id DESC").all(targetType, slug);
  }
  /** 自然键（台型、台、节点、方向）命中的那一行，含撤销的 */
  idByNaturalKey(targetType: string, slug: string, node: string, direction: string) {
    return db.prepare("SELECT id FROM bindings WHERE target_type = ? AND target_slug = ? AND agent_node = ? AND direction = ?").get(targetType, slug, node, direction);
  }
  /** 重绑：刷新字段并复活撤销态 */
  refresh(mode: string, notifyUrl: string, remoteKey: string, id: number) {
    return db.prepare("UPDATE bindings SET mode = ?, notify_url = ?, remote_api_key = ?, revoked_at = '', created_by = 'admin', created_at = datetime('now') WHERE id = ?").run(mode, notifyUrl, remoteKey, id);
  }
  insert(targetType: string, slug: string, node: string, direction: string, mode: string, notifyUrl: string, remoteKey: string, createdBy: string) {
    return db.prepare('INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, remote_api_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(targetType, slug, node, direction, mode, notifyUrl, remoteKey, createdBy);
  }
  /** 没撤销的那一行 */
  activeId(id: number) {
    return db.prepare("SELECT id FROM bindings WHERE id = ? AND revoked_at = ''").get(id);
  }
  revoke(id: number) {
    return db.prepare("UPDATE bindings SET revoked_at = datetime('now') WHERE id = ?").run(id);
  }
}
