/**
 * 谁能建、改、删驾驶舱（统筹 2026-11-12 定，身份线定机制）。写驾驶舱的三条路由、读应答里的 can.edit、/api/auth/me 的
 * can.create_cockpit 都问这一处，说法只有一份。
 *
 *   · 本机命令行、过了管理员门的（有效口令或 Odoo 管理员，且同源）：照旧什么都能做。
 *   · 浏览器从别的站点来：403。
 *   · 其余按会话认人：身份来源不可达 502；没认出来 401；不是启用的人 403。
 *   · 认出来的人：交给判定——动作 cockpit.create / cockpit.update / cockpit.delete，类别是「管理」。
 *     管理层的预设里点名了这三个动作（roles.ts），属主、系统管理员本来就有管理类；部门负责人、部门成员、AI 员工只有读写，通不过。
 *
 * 驾驶舱是布局，不是业务数据：改它不带来看数据的权力，面板里的内容仍按看的人各自判。
 * 建立人这次只记下来（cockpits.created_by），不单独给改的权力：现在只有管理层能建，所有驾驶舱都是共享的；
 * 撤掉管理层授予之后，这个人当场就改不了（「撤掉授予，权力当场没」）。以后有了个人驾驶舱再让建立人改自己的。
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity, IDENTITY_UNAVAILABLE, sourceDown } from './identity.ts';
import { judge } from './judgment.ts';
import type { PrincipalService } from './services/principal.ts';

export type CockpitAction = 'cockpit.create' | 'cockpit.update' | 'cockpit.delete';
export type CockpitAccessDeps = {
  /** 本机命令行，或过了管理员门（有效口令、Odoo 管理员，且同源）：和写请求总门对管理写的判断是同一个 */
  adminOk: (req: express.Request) => Promise<boolean>;
  /** 浏览器从别的站点来 */
  crossOriginDenied: (req: express.Request) => boolean;
};
export type CockpitDecision =
  | { ok: true; principal: string | null }
  | { ok: false; http: number; error: string; message: string };

const principals = () => svc<PrincipalService>('principals');

export function cockpitAccess(deps: CockpitAccessDeps) {
  async function decide(req: express.Request, action: CockpitAction): Promise<CockpitDecision> {
    if (await deps.adminOk(req)) return { ok: true, principal: null };
    if (deps.crossOriginDenied(req)) return { ok: false, http: 403, error: 'cockpit_cross_origin_denied', message: '跨站来的改动不收' };
    const cookie = String(req.headers.cookie ?? '');
    const who = cookie ? await identity().resolveViewer(cookie) : null;
    if (who && sourceDown(who)) return { ok: false, http: 502, error: IDENTITY_UNAVAILABLE, message: '登录服务暂时联系不上，稍后再试' };
    if (!who || !who.ok) return { ok: false, http: 401, error: 'cockpit_auth_required', message: '要先登录' };
    const id = principals().principalOf(identity().providerName() ?? '', who.viewer.login) ?? who.viewer.sub;
    const p = principals().get(id) as { kind?: string; status?: string; owner?: string } | null;
    if (!p || p.kind !== 'person' || p.status !== 'active') return { ok: false, http: 403, error: 'cockpit_principal_not_active', message: '这个账号现在不能改驾驶舱' };
    const r = judge({ actor: { type: 'principal', id, kind: p.kind, status: p.status, owner: p.owner ?? '' }, action, kind: 'admin', declared: true });
    if (r.verdict === 'allow') return { ok: true, principal: id };
    return { ok: false, http: 403, error: 'cockpit_forbidden', message: '建、改驾驶舱要有管理层授予，或者是管理员' };
  }
  /** 只要结论（读应答里的 can）：拒绝的原因不往外说；身份来源不可达也只当「不能」 */
  async function can(req: express.Request, action: CockpitAction): Promise<boolean> {
    try { return (await decide(req, action)).ok; } catch { return false; }
  }
  /** 写路由用：不能就写好应答、返回 null */
  async function gate(req: express.Request, res: express.Response, action: CockpitAction): Promise<{ principal: string | null } | null> {
    const d = await decide(req, action);
    if (d.ok) return { principal: d.principal };
    res.status(d.http).json({ error: d.error, message: d.message });
    return null;
  }
  return { decide, can, gate };
}
