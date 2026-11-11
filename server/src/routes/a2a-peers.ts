/**
 * 对端登记表的管理接口（/api/a2a/peers），都只给管理员：
 *   GET  /api/a2a/peers                       列出全部对端和各自的健康（可按 registered_by、status 筛：上线后过目升级回填出来的）
 *   POST /api/a2a/peers                       登记 { root_url }：取一次名片、验签、钉住公钥
 *   POST /api/a2a/peers/:id/refresh           再取一次名片（排查、重试待登记的；公钥变了改成 key_changed，不自动接受）
 *   POST /api/a2a/peers/:id/confirm-key       确认新公钥 { fingerprint }：带上看到的指纹，和待确认的对得上才换
 *   POST /api/a2a/peers/:id/disable           停用 { reason }（粘住：只有 enable 能解；对投递的拦截由阶段七接上 canDeliver 后生效）
 *   POST /api/a2a/peers/:id/enable            重新启用
 * SQL 在 services/a2a-peers.ts。app 是 HTTP 服务，不是 Express 应用本身。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { HttpError, bad } from '../errors.ts';
import { PeerRegisterError, type A2aPeerService, type PeerRow, type PeerStatus } from '../services/a2a-peers.ts';

export interface A2aPeerDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 留痕里的写法：口令记 admin-token，Odoo 管理员记 odoo:<登录名> */
  adminActor: (req: express.Request) => string;
}

const ID = /^peer_[0-9a-f]{12}$/;
const STATUSES: readonly PeerStatus[] = ['active', 'pending_registration', 'key_changed', 'disabled'];
const peers = () => svc<A2aPeerService>('a2aPeers');
/** 对外的一行：公钥只给指纹（完整公钥在库里），其余照登记表 */
function view(p: PeerRow) {
  const { public_key: _k, pending_public_key: _pk, card_capabilities, ...rest } = p;
  let capabilities: unknown = {};
  try { capabilities = JSON.parse(card_capabilities || '{}'); } catch { capabilities = {}; }
  return { ...rest, card_capabilities: capabilities, health: peers().health(p) };
}
const peerOf = (req: express.Request): PeerRow => {
  const id = String(req.params.id ?? '');
  if (!ID.test(id)) throw new HttpError(404, 'peer not found');
  const p = peers().byId(id);
  if (!p) throw new HttpError(404, 'peer not found');
  return p;
};
const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

export function registerA2aPeerRoutes(app: HttpService, deps: A2aPeerDeps): void {
  const { adminGuard, adminActor } = deps;

  app.get('/api/a2a/peers', { action: 'a2a-peer.list', kind: 'admin' }, wrap((req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && !STATUSES.includes(status as PeerStatus)) bad('status 只能是 active / pending_registration / key_changed / disabled');
    const registeredBy = typeof req.query.registered_by === 'string' ? req.query.registered_by.slice(0, 200) : '';
    res.json(peers().list({ status: (status || undefined) as PeerStatus | undefined, registered_by: registeredBy || undefined }).map(view));
  }));

  app.post('/api/a2a/peers', { action: 'a2a-peer.register', kind: 'admin' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const root = typeof req.body?.root_url === 'string' ? req.body.root_url : '';
    try {
      const out = await peers().register(root, adminActor(req));
      res.status(out.created ? 201 : 200).json({ ok: true, created: out.created, peer: view(out.peer) });
    } catch (e) {
      if (e instanceof PeerRegisterError) return void res.status(e.reason === 'bad_root' ? 400 : 422).json({ error: e.message, reason: e.reason });
      throw e;
    }
  }));

  app.post('/api/a2a/peers/:id/refresh', { action: 'a2a-peer.refresh', kind: 'admin' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const p = await peers().refresh(peerOf(req).id);
    res.json({ ok: true, peer: view(p!) });
  }));

  app.post('/api/a2a/peers/:id/confirm-key', { action: 'a2a-peer.confirm-key', kind: 'admin' }, wrap((req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const p = peerOf(req);
    const fp = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint.trim() : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(fp)) bad('fingerprint 必须是页面上看到的新指纹（sha256:<64 位十六进制>）');
    const out = peers().confirmKey(p.id, fp, adminActor(req));
    if (!out.ok) {
      const [status, message] = out.reason === 'not_pending' ? [409, '这个对端没有待确认的新公钥'] : out.reason === 'fingerprint_mismatch' ? [409, '指纹和待确认的新公钥对不上（可能又变了，先刷新再看）'] : [404, 'peer not found'];
      return void res.status(status).json({ error: message, reason: out.reason });
    }
    res.json({ ok: true, peer: view(out.peer) });
  }));

  app.post('/api/a2a/peers/:id/disable', { action: 'a2a-peer.disable', kind: 'admin' }, wrap((req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const p = peerOf(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 500) bad('reason 必填（停用要写理由），不超过 500 字');
    res.json({ ok: true, peer: view(peers().disable(p.id, adminActor(req), reason)!) });
  }));

  app.post('/api/a2a/peers/:id/enable', { action: 'a2a-peer.enable', kind: 'admin' }, wrap((req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!adminGuard(req, res)) return;
    const p = peerOf(req);
    res.json({ ok: true, peer: view(peers().enable(p.id, adminActor(req))!) });
  }));
}
