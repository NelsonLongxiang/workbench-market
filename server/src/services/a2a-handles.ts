/**
 * 市场的 A2A 会话句柄（market/<node8>）的唯一性（阶段七：名片声明 canvasMemberProvenance 的前提）。
 * 句柄必须只指向本节点上的一个 SOP：生成时避开已占用的，出现重复（存量随机撞上）时不上卡、入站不投递（失败关闭）。
 */
import { db } from '../db.ts';

/** 这个 node8 已被某个台占用了吗 */
export function node8Taken(id8: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM apps WHERE a2a_node8 = ? LIMIT 1").get(id8));
}

/** 被不止一个台占用的 node8（存量随机碰撞） */
export function duplicateNode8s(): Set<string> {
  const rows = db.prepare("SELECT a2a_node8 FROM apps WHERE a2a_node8 <> '' GROUP BY a2a_node8 HAVING COUNT(*) > 1").all() as { a2a_node8: string }[];
  return new Set(rows.map((r) => r.a2a_node8));
}
