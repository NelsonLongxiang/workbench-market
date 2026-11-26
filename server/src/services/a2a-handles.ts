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

/** 一个台已持久化的 node8（没有就是空或缺省），sopNode8 先查这里 */
export function storedNode8(slug: string): string | undefined {
  const row = db.prepare('SELECT a2a_node8 FROM apps WHERE slug = ?').get(slug) as { a2a_node8?: string } | undefined;
  return row?.a2a_node8;
}

/** 把生成好的 node8 写到台上（只在还没有时由 sopNode8 调） */
export function saveNode8(slug: string, id8: string): void {
  db.prepare('UPDATE apps SET a2a_node8 = ? WHERE slug = ?').run(id8, slug);
}

/** 上卡的 SOP：已发布、且至少有一条 admits 方向（admits / both）的有效绑定，按 slug 排 */
export function cardSops(): { slug: string; title: string; description: string; a2a_node8: string }[] {
  return db.prepare(
    `SELECT DISTINCT a.slug, a.title, a.description, a.a2a_node8
       FROM apps a
       JOIN bindings b ON b.target_type = 'sop' AND b.target_slug = a.slug AND b.revoked_at = ''
        AND b.direction IN ('admits','both')
      WHERE a.kind = 'sop' AND a.status = 'published'
      ORDER BY a.slug`
  ).all() as { slug: string; title: string; description: string; a2a_node8: string }[];
}

/** 按 node8 找 SOP 台（入站 team = market/<node8> 时用） */
export function sopByNode8(id8: string): { slug: string; status: string } | undefined {
  return db.prepare('SELECT slug, status FROM apps WHERE kind = ? AND a2a_node8 = ?').get('sop', id8) as { slug: string; status: string } | undefined;
}
