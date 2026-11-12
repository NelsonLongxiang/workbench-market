/**
 * 「安排一件事」的附件（只存引用）。上传、挂到事件、按事件列出、按 id 取——SQL 都在这里。
 * 时间由调用方给（代码生成），不在 SQL 里取。表在 db.ts。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../db.ts';
import { REPLY_TTL_DAYS } from '../workbench-events.ts';

export type AttachmentRow = { id: number; uploaded_by: string; name: string; mime: string; size: number; sha256: string; path: string; event_id: string; created_at: string; bound_at: string };

/** 一件事最多挂几个附件；一个人手上还没挂出去的最多几个（防止只传不用） */
export const ATTACHMENTS_PER_ITEM = 5;
export const PENDING_ATTACHMENTS_PER_PERSON = 20;

export function addAttachment(a: { uploaded_by: string; name: string; mime: string; size: number; sha256: string; path: string; at: string }): number {
  return Number(db.prepare('INSERT INTO work_item_attachments (uploaded_by, name, mime, size, sha256, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.uploaded_by, a.name, a.mime, a.size, a.sha256, a.path, a.at).lastInsertRowid);
}

export function attachmentById(id: number): AttachmentRow | undefined {
  return db.prepare('SELECT * FROM work_item_attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
}

export function pendingAttachmentCount(by: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM work_item_attachments WHERE uploaded_by = ? AND event_id = ''").get(by) as { n: number }).n);
}

/** 这些 id 是不是都由这个人上传、还没挂出去（安排前核） */
export function ownUnbound(ids: readonly number[], by: string): AttachmentRow[] | null {
  const rows: AttachmentRow[] = [];
  for (const id of ids) {
    const r = attachmentById(id);
    if (!r || r.uploaded_by !== by || r.event_id !== '') return null;
    rows.push(r);
  }
  return rows;
}

/** 挂到事件上（只挂这个人自己、还没挂出去的）；返回挂上的个数。调用方负责事务 */
export function bindAttachments(ids: readonly number[], by: string, eventId: string, at: string): number {
  const st = db.prepare("UPDATE work_item_attachments SET event_id = ?, bound_at = ? WHERE id = ? AND uploaded_by = ? AND event_id = ''");
  let n = 0;
  for (const id of ids) n += Number(st.run(eventId, at, id, by).changes);
  return n;
}

/**
 * 凭派工时给的回执令牌（reply.token）认出是哪一次投递：和回写决定同一套（sha256 比对、时间恒定、投递已送达、送达后 REPLY_TTL_DAYS 天内；现在几点由代码给）。
 * 认不出返回 null（调用方一律按「不存在」答，不说事件在不在）。接单节点取附件用。
 */
export function deliveryByReplyToken(eventId: string, token: string, now = Date.now()): { id: number } | null {
  if (!/^wbe-[0-9a-f]{16}$/.test(eventId) || token === '') return null;
  const hash = createHash('sha256').update(token, 'utf8').digest();
  const rows = db.prepare("SELECT id, status, reply_token_sha256, (sent_at != '' AND datetime(sent_at, '+' || ? || ' days') > datetime(?)) AS live FROM workbench_event_deliveries WHERE event_id = ? AND reply_token_sha256 != ''").all(REPLY_TTL_DAYS, new Date(now).toISOString(), eventId) as { id: number; status: string; reply_token_sha256: string; live: number }[];
  const row = rows.find((r) => { const h = Buffer.from(r.reply_token_sha256, 'hex'); return h.length === hash.length && timingSafeEqual(h, hash); });
  return row && row.status === 'sent' && row.live === 1 ? { id: row.id } : null;
}

export function attachmentsOfEvent(eventId: string): AttachmentRow[] {
  if (!eventId) return [];
  return db.prepare('SELECT * FROM work_item_attachments WHERE event_id = ? ORDER BY id').all(eventId) as AttachmentRow[];
}
