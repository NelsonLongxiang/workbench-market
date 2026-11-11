/**
 * A2A 出站的两条管理面（原 #17 P4 最小面，搬自 index.ts 并收紧）：
 *   GET  /api/a2a/state  本节点的 A2A 身份概况（团队、名片的会话与句柄、密钥在不在、有效绑定数）——只给管理员（L15）。
 *        名片本身照旧经 /.well-known/agent-card.json 公开，不受影响。
 *   POST /api/a2a/send   以市场身份向对端发一条 direct 消息——只给管理员，且目标只许是对端登记表里状态为 active 的对端（L16）：
 *        没登记、待登记、待确认新公钥、停用的一律拒（409：目标不合要求，不是授权结论；管理门的 403 才是），不发；发往登记表里的根地址（不是请求里的原串）。
 *        请求体 { target_url, team, message, context_id? }。
 * 原来这两条注册在前端回落和 404 兜底之后：带前端产物（web/dist）的实例里谁来都是 404，只有不带前端的实例走得到。
 * 现在注册在兜底之前，同时收紧，不出现「先放开再收」的窗口。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { HttpError } from '../errors.ts';
import type { A2aPeerService } from '../services/a2a-peers.ts';

export type A2aOutboundRouteDeps = {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 本节点 A2A 身份概况（index.ts 里拼，依赖名片、密钥、绑定数） */
  state: () => Record<string, unknown>;
  /** 以市场身份发一条 direct 消息 */
  send: (target: { baseUrl: string; team: string }, message: string, contextId: string | undefined) => Promise<unknown>;
};

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

export function registerA2aOutboundRoutes(app: HttpService, deps: A2aOutboundRouteDeps): void {
  app.get('/api/a2a/state', { action: 'a2a.state', kind: 'admin' }, wrap((req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!deps.adminGuard(req, res)) return;
    res.json(deps.state());
  }));

  app.post('/api/a2a/send', { action: 'a2a.send', kind: 'admin' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!deps.adminGuard(req, res)) return;
    const target = String(req.body?.target_url ?? '').trim();
    const team = String(req.body?.team ?? '').trim();
    const message = String(req.body?.message ?? '');
    if (!/^https?:\/\/[^\s]+$/.test(target)) throw new HttpError(400, 'target_url 必须是 http(s):// 对端节点地址');
    if (!/^[a-z][a-z0-9-]*\/[0-9a-f]{8}$/i.test(team)) throw new HttpError(400, 'team 形如 market/<8hex>（对端卡片里的 sessionTeams）');
    if (!message) throw new HttpError(400, 'message 必填');
    // 只发给对端登记表里正常（active）的对端：不是任意地址
    const peer = svc<A2aPeerService>('a2aPeers').byRoot(target);
    if (!peer) return void res.status(409).json({ error: 'a2a_send_peer_not_registered', message: '目标不在对端登记表里；先登记（POST /api/a2a/peers）' });
    if (peer.status !== 'active') return void res.status(409).json({ error: 'a2a_send_peer_not_active', status: peer.status, message: '目标对端不是正常状态（待登记、待确认新公钥或已停用），不发' });
    try {
      // 发往登记表里的根地址，不用请求里的原串：查表用的是规范后的根，发也只发到这个根
      const out = await deps.send({ baseUrl: peer.root_url, team }, message, typeof req.body?.context_id === 'string' ? req.body.context_id : undefined);
      res.json({ ok: true, target: peer.root_url, team, result: out });
    } catch (e) {
      throw new HttpError(502, `出站失败：${String((e as Error)?.message ?? e)}`);
    }
  }));
}
