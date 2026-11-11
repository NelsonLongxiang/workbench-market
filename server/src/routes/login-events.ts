/**
 * 离职即时失效：登录方式推来的失效通知（POST /login/<方式>/events，比如飞书通讯录变更），和每天一次的对账。
 *
 * 失效通知
 *   · 验签、解密、核对来源是插件的事（identity().flowEvent）；核心只认插件交回的「该停用的外部身份」。
 *   · 没有这个登录方式、或者它不收失效通知：一律 401，和验签不过同一个应答，不透露配了什么。
 *   · 验过签的事件按事件号去重（多个实例共用一张表）：同一个事件重放只处理一次。
 *     记事件号和停用在同一个事务里：停用出错，事件号一起撤回，对方重推时照常处理。
 *   · 停用是本地动作：主体一停用，每个入口立即不认（认人时现查）；这个人的市场会话一并注销。
 *   · 出错只回一个固定的 503（对方会重推），内部原因只进日志，不回给对方。
 * 对账
 *   · 每天一次，把绑在启用的人身上的外部身份交给插件去对方那边查（identity().flowCheckMembers），
 *     只按确切的证据停用（离职、被停用）；对方出错、查不清的一个也不停用，只计数留痕。
 *   · 定时器挂在根上下文的 effect 上，模块卸载时一起停掉。管理员也可以手动触发（routes/principals.ts）。
 *
 * 事件这条路不在 /api/ 下：写请求总门只管 /api/，这里由插件验签。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { root } from '../root-context.ts';
import { identity } from '../identity.ts';
import type { LoginSessionService } from '../services/login-session.ts';
import type { PrincipalService } from '../services/principal.ts';

const FLOW_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RECONCILE_EVERY_MS = 24 * 3600_000;
const RECONCILE_FIRST_MS = 10 * 60_000;
const BATCH = 200;

const sessions = () => svc<LoginSessionService>('loginSessions');
const principals = () => svc<PrincipalService>('principals');

/** 停用一条外部身份绑着的主体，并注销这个人的会话（只写库，不留痕）。返回停用了谁（没绑定或已停用为 null） */
function disable(flow: string, externalId: string, by: string, reason: string): string | null {
  const id = principals().offboard(flow, externalId, by, reason);
  if (id) sessions().revokeAllFor(id);
  return id;
}
/** 停用留一行痕：写库成功（事务提交）之后才记 */
function logOffboard(flow: string, externalId: string, id: string, by: string): void {
  console.log(JSON.stringify({ source: 'principals', event: 'offboard', provider: flow, external_id: externalId, id, by, at: new Date().toISOString() }));
}
function offboard(flow: string, externalId: string, by: string, reason: string): string | null {
  const id = disable(flow, externalId, by, reason);
  if (id) logOffboard(flow, externalId, id, by);
  return id;
}

/** 对一个登录方式跑一次对账。这个方式不能对账就返回 null */
export async function reconcileFlow(flow: string, by: string): Promise<{ checked: number; disabled: string[]; unknown: number } | null> {
  if (!identity().flowCapabilities(flow).reconcile) return null;
  const ids = principals().activeIdentities(flow);
  const disabled: string[] = [];
  const unknownIds: string[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const answer = await identity().flowCheckMembers(flow, batch);
    unknownIds.push(...answer.unknown);
    for (const externalId of answer.gone) {
      const id = offboard(flow, externalId, by, '离职或停用（对账）');
      if (id) disabled.push(id);
    }
  }
  // 查不清的外部身份列在留痕里（最多 100 个），给人工复核用：对方直接删掉、删除事件也丢了的人，对账永远补不上
  console.log(JSON.stringify({ source: 'login', event: 'reconcile', flow, checked: ids.length, disabled: disabled.length, unknown: unknownIds.length, unknown_ids: unknownIds.slice(0, 100), by, at: new Date().toISOString() }));
  return { checked: ids.length, disabled, unknown: unknownIds.length };
}

/** 每个能对账的登录方式各跑一次；一个出错不影响别的 */
async function reconcileAll(): Promise<void> {
  for (const f of identity().flows()) {
    try { await reconcileFlow(f.name, 'reconcile:daily'); } catch (e) { console.error(`[login] 对账出错（${f.name}）：${String((e as Error)?.message ?? e).slice(0, 200)}`); }
  }
}

const headersOf = (req: express.Request): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
};

export function registerLoginEventRoutes(app: HttpService): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  app.post('/login/:flow/events', { action: 'login.event', kind: 'write' }, route(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const flow = String(req.params.flow);
    if (!FLOW_RE.test(flow) || !identity().flowCapabilities(flow).events) return res.status(401).json({ error: 'event_unauthorized' });
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    try {
      const ev = await identity().flowEvent(flow, { headers: headersOf(req), rawBody });
      if (ev.http === 200 && ev.eventId) {
        const by = `event:${flow}`;
        const done = sessions().once(flow, ev.eventId, () =>
          (ev.offboard ?? []).map((externalId) => [externalId, disable(flow, externalId, by, '离职或停用（通讯录事件）')] as const));
        // 见过的事件（重放）：验签过了，但处理过了。照样回 200（对方会重推没收到 200 的事件），不再处理
        if (!done.seen) for (const [externalId, id] of done.result) if (id) logOffboard(flow, externalId, id, by);
        return res.status(200).json(ev.body);
      }
      if (ev.http === 200) for (const externalId of ev.offboard ?? []) offboard(flow, externalId, `event:${flow}`, '离职或停用（通讯录事件）');
      res.status(ev.http).json(ev.body);
    } catch (e) {
      // 内部原因（比如库锁着）只进日志；对方只看到固定的 503，会重推
      console.error(`[login] 处理失效通知出错（${flow}）：${String((e as Error)?.message ?? e).slice(0, 200)}`);
      res.status(503).json({ error: 'event_unavailable' });
    }
  }));

  // 每天一次对账：挂在根上下文的 effect 上，卸载时一起停掉
  root.effect(() => {
    const first = setTimeout(() => { void reconcileAll(); }, RECONCILE_FIRST_MS);
    const every = setInterval(() => { void reconcileAll(); }, RECONCILE_EVERY_MS);
    first.unref?.(); every.unref?.();
    return () => { clearTimeout(first); clearInterval(every); };
  }, 'login.reconcile(daily)');
}
