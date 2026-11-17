/**
 * 「安排一件事」的附件（只存文件引用，不把内容塞进派工正文）：
 *   PUT /api/work-items/attachments/:name   上传：登录的、启用的人；请求体即文件内容（≤100MB，和现有上传同一个上限），边收边算 sha256 边落盘；
 *                                           带 X-Content-SHA256 就在落库前核对，不符 400、不保存。返回 { id, name, mime, size, sha256 }。
 *                                           还没挂出去的每人最多 PENDING_ATTACHMENTS_PER_PERSON 个、总共最多 PENDING_BYTES_PER_PERSON 字节（429）。可执行文件拒收。
 *                                           上传后 UNBOUND_TTL_MS（24 小时）还没被任何一次安排引用的，自动清掉（每次上传前清一轮，另有每小时一轮，随根上下文一起停）。
 *   GET /api/work-items/:id/attachments/:aid 人读：看得到这件事项的人（canSee，和事项详情同一处）才拿得到；读不到、不属于这件事项的一律 404
 *   GET /api/workbench-events/:id/attachments/:aid  接单节点取件：凭派工时给的回执令牌（请求头 X-Reply-Token），和回写决定同一套认法；
 *                                           令牌只取得到它那次派工（这个事件）挂的附件；认不出、不属于这个事件、任务撤回了、事项已经结束（终态）的一律 404
 * 安排时在请求体里带 attachments: [id…]（只能是本人上传、还没挂出去的，每件最多 ATTACHMENTS_PER_ITEM 个），挂到那一次的事件上。
 */
import type express from 'express';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { dataDir } from '../db.ts';
import { sniff } from '../file-sniff.ts';
import { expectedSha256 } from '../upload-integrity.ts';
import { root } from '../root-context.ts';
import { releaseBlock } from '../workbench-events.ts';
import { itemIdForEvent, type WorkItemService } from '../services/work-item.ts';
import { addAttachment, attachmentById, deliveryByReplyToken, dropUnboundAttachment, pendingAttachmentBytes, pendingAttachmentCount, PENDING_ATTACHMENTS_PER_PERSON, PENDING_BYTES_PER_PERSON,
  staleUnboundAttachments, UNBOUND_TTL_MS, type AttachmentRow } from '../services/work-item-attachments.ts';
import { canSee, TERMINAL_STATES, workItemViewer } from '../work-item-access.ts';
import { peerCanDeliver } from '../services/a2a-peers.ts';

export type AttachmentRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  crossOriginDenied: (req: express.Request) => boolean;
};

/** 单个附件上限：沿用现有上传的 100MB */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
const ITEM_ID = /^wi_[A-Za-z0-9_-]{1,96}$/;
const AID = /^[1-9]\d{0,15}$/;
const uploadRoot = join(dataDir, 'uploads');

/** 和现有上传同规则落盘：uploads/<YYYYMM>/<时间戳>-<随机><原扩展名> */
function storePath(originalName: string): string {
  const now = new Date();
  const dir = join(uploadRoot, `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  const ext = extname(originalName).slice(0, 16).replace(/[^.\w-]/g, '');
  return join(dir, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
}

/** 清掉上传后 UNBOUND_TTL_MS 还没挂出去的附件：先删记录（只删没挂出去的），删成了再删文件。返回清了几个 */
export function sweepUnboundAttachments(now = Date.now()): number {
  let n = 0;
  for (const a of staleUnboundAttachments(new Date(now - UNBOUND_TTL_MS).toISOString())) {
    if (!dropUnboundAttachment(a.id)) continue;
    const abs = resolve(dataDir, a.path);
    if (abs.startsWith(resolve(uploadRoot) + '/')) rmSync(abs, { force: true });
    n++;
  }
  return n;
}

function sendAttachment(res: express.Response, a: AttachmentRow): void {
  const abs = resolve(dataDir, a.path);
  if (!abs.startsWith(resolve(uploadRoot) + '/')) return void res.status(404).json({ error: 'attachment_not_found' });
  let size = 0;
  try { size = statSync(abs).size; } catch { return void res.status(404).json({ error: 'attachment_not_found' }); }
  res.set('Cache-Control', 'private, no-store');
  res.setHeader('content-type', a.mime || 'application/octet-stream');
  res.setHeader('content-length', String(size));
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('etag', `"${a.sha256}"`);
  res.setHeader('x-content-sha256', a.sha256);
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  createReadStream(abs).pipe(res);
}

export function registerWorkItemAttachmentRoutes(app: HttpService, deps: AttachmentRouteDeps): void {
  // 每小时清一轮没挂出去的旧上传：挂在根上下文的 effect 上，卸载时一起停
  root.effect(() => {
    const every = setInterval(() => { try { sweepUnboundAttachments(); } catch (e) { console.error(`[attachments] 清理没挂出去的上传出错：${String((e as Error)?.message ?? e).slice(0, 200)}`); } }, 3600_000);
    every.unref?.();
    return () => { clearInterval(every); };
  }, 'work-item-attachments.sweep(1h)');

  app.put('/api/work-items/attachments/:name', { action: 'work-items.attachment-upload', kind: 'write', statusNotVerdict: '上传的是登录的、启用的人自己（路由内经身份服务认人），不是角色授权' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.setHeader('connection', 'close'); // 提前拒绝时不再读剩余请求体
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const name = String(req.params.name ?? '').trim();
    if (!name || name.length > 255 || name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) return void res.status(400).json({ error: 'attachment_name_invalid' });
    const wantSha = expectedSha256(req.headers['x-content-sha256']);
    if (wantSha === 'bad') return void res.status(400).json({ error: 'x_content_sha256_invalid' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) return void res.status(413).json({ error: 'attachment_too_large', max_bytes: ATTACHMENT_MAX_BYTES });
    (async () => {
      const viewer = await workItemViewer(req, deps);
      if (!viewer.principal) return void res.status(401).json({ error: 'work_items_auth_required' });
      if (!viewer.person) return void res.status(403).json({ error: 'work_items_principal_not_active' });
      // 请求体要是原始字节：按 JSON、表单发来的已经被全局解析器读走了，存下来会是空文件——拒收（415），别存（先认人：匿名照旧 401）
      if ((req as unknown as { _body?: boolean })._body) return void res.status(415).json({ error: 'attachment_raw_body_required', message: '用 Content-Type: application/octet-stream（或文件本身的类型）发原始字节' });
      sweepUnboundAttachments();
      if (pendingAttachmentCount(viewer.principal) >= PENDING_ATTACHMENTS_PER_PERSON) return void res.status(429).json({ error: 'attachments_pending_limit', limit: PENDING_ATTACHMENTS_PER_PERSON });
      const pendingBytes = pendingAttachmentBytes(viewer.principal);
      if (Number.isFinite(declared) && pendingBytes + declared > PENDING_BYTES_PER_PERSON) return void res.status(429).json({ error: 'attachments_pending_bytes_limit', limit_bytes: PENDING_BYTES_PER_PERSON });
      const abs = storePath(name);
      const h = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > ATTACHMENT_MAX_BYTES) return cb(Object.assign(new Error('too large'), { tooLarge: true }));
          h.update(chunk);
          cb(null, chunk);
        },
      });
      try { await pipeline(req, meter, createWriteStream(abs)); } catch (e) {
        rmSync(abs, { force: true });
        if ((e as { tooLarge?: boolean }).tooLarge) return void res.status(413).json({ error: 'attachment_too_large', max_bytes: ATTACHMENT_MAX_BYTES });
        return void res.status(400).json({ error: 'attachment_upload_interrupted' });
      }
      // 没带 content-length（分块发）的，收完再核一次总量
      if (pendingAttachmentBytes(viewer.principal) + size > PENDING_BYTES_PER_PERSON) { rmSync(abs, { force: true }); return void res.status(429).json({ error: 'attachments_pending_bytes_limit', limit_bytes: PENDING_BYTES_PER_PERSON }); }
      const sha = h.digest('hex');
      if (wantSha !== null && wantSha !== sha) { rmSync(abs, { force: true }); return void res.status(400).json({ error: 'sha256_mismatch', sha256: sha }); }
      const head = Buffer.alloc(Math.min(size, 1024 * 1024));
      if (head.length > 0) { const fd = openSync(abs, 'r'); try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); } }
      const kind = sniff(name, head, head.length === size, String(req.headers['content-type'] ?? ''));
      if (kind.verdict === 'executable') { rmSync(abs, { force: true }); return void res.status(400).json({ error: 'attachment_executable_refused', reason: kind.reason }); }
      const id = addAttachment({ uploaded_by: viewer.principal, name, mime: kind.mime || 'application/octet-stream', size, sha256: sha, path: relative(dataDir, abs), at: new Date().toISOString() });
      res.status(201).json({ id, name, mime: kind.mime || 'application/octet-stream', size, sha256: sha, integrity: wantSha !== null ? 'sha256-verified' : 'unverified' });
    })().catch(next);
  });

  app.get('/api/work-items/:id/attachments/:aid', { action: 'work-items.attachment-read', kind: 'read', statusNotVerdict: '看得到这件事项的人才拿得到附件（和事项详情同一处判断），不是角色授权' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? ''), aid = String(req.params.aid ?? '');
    if (!ITEM_ID.test(id) || !AID.test(aid)) return void res.status(404).json({ error: 'attachment_not_found' });
    (async () => {
      const viewer = await workItemViewer(req, deps);
      const item = svc<WorkItemService>('workItems').get(id);
      const a = attachmentById(Number(aid));
      // 读不到事项、不属于这件事项的附件、附件不存在：一律 404，不说是哪一种
      if (!item || !canSee(item, viewer) || !a || a.event_id === '' || itemIdForEvent(a.event_id) !== id) return void res.status(404).json({ error: 'attachment_not_found' });
      sendAttachment(res, a);
    })().catch(next);
  });

  app.get('/api/workbench-events/:id/attachments/:aid', { action: 'work-items.attachment-fetch', kind: 'read', statusNotVerdict: '凭派工时给接单节点的回执令牌取件，不是登录身份的结论' }, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const eventId = String(req.params.id ?? ''), aid = String(req.params.aid ?? '');
    const token = String(req.headers['x-reply-token'] ?? '');
    const a = AID.test(aid) ? attachmentById(Number(aid)) : undefined;
    const dlv = a && a.event_id === eventId ? deliveryByReplyToken(eventId, token) : null;
    if (!a || !dlv) return void res.status(404).json({ error: 'attachment_not_found' });
    // 对端登记表里停用、等确认新键的节点：令牌还在有效期内也和不存在一样答（没登记的照旧，同投递）
    const can = peerCanDeliver(dlv.target_url);
    if (!can.ok && can.reason !== 'peer_unknown') return void res.status(404).json({ error: 'attachment_not_found' });
    // 任务已经结束：任务撤回了（releaseBlock，和放行同一处判断）、事项到了终态（完成、失败、放弃、取消）——不再给取，和不存在一样答
    const item = svc<WorkItemService>('workItems').get(itemIdForEvent(eventId));
    if (releaseBlock(eventId) !== null || !item || TERMINAL_STATES.includes(item.state)) return void res.status(404).json({ error: 'attachment_not_found' });
    sendAttachment(res, a);
  });
}
