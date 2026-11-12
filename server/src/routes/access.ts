/**
 * 角色预设 ②：以某人的身份看、红线清单、首次安装向导。
 *
 *   GET  /api/principals/:id/access[?action=<动作>&scope=<范围>]   这个人有哪些权限
 *        生效的每条授予（角色、展开后的权限、范围、期限、放行人、来源 manual / migration / wizard，范围不是 * 的标「尚未生效」）；
 *        没生效的（草稿、待核、已撤销、已过期）各自的原因；带 action 时给出判定的结论（允许、先问人、拒绝）和命中的规则。
 *        管理员（口令或管理员登录，同源）、本机命令行能看任何人；登录的人只能看自己的那一份。按对象判（本人），声明「状态码不代表授权」。
 *   GET  /api/access/red-lines                                    红线清单（server/src/red-lines.ts，每条都有对抗例盯着）
 *        登录的人、管理员、本机命令行能读。
 *   GET  /api/setup/wizard                                        向导最近的运行和挂在上面的授予（管理员）
 *   POST /api/setup/wizard { shape, assignments? }                 跑一次：生成一批草稿授予（管理员）
 *   POST /api/setup/wizard/approve { run }                         属主一次放行这一批（只认属主，收窄）
 * 写请求先过 index.ts 的写请求总门。每次跑、放行写一行日志。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import { judge } from '../judgment.ts';
import { RED_LINES } from '../red-lines.ts';
import type { Kind } from '../roles.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { Actor, GrantService } from '../services/grant.ts';
import type { SetupWizardService, WizardAssignments } from '../services/setup-wizard.ts';

export type AccessRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  crossOriginDenied: (req: express.Request) => boolean;
};

const principals = () => svc<PrincipalService>('principals');
const grants = () => svc<GrantService>('grants');
const wizard = () => svc<SetupWizardService>('setupWizard');
const PRINCIPAL_RE = /^[a-z]+:[\x21-\x7e]{1,150}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47}$|^[a-z][a-z0-9_]{0,63}$/;
const SELF_OR_ADMIN = '按对象判：管理员看任何人，登录的人只看自己（本人是对象范围，统一判定还不认，L13）';
const INACTIVE_REASON: Record<string, string> = { draft: '草稿，还没提交', pending: '待核，等放行', revoked: '已撤销', expired: '已过期' };

export function registerAccessRoutes(app: HttpService, deps: AccessRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  /** 认人：本机命令行、管理员（同源）→ admin；登录的人 → person。不过就写好应答返回 null（跨站 403、没登录 401） */
  async function viewer(req: express.Request, res: express.Response): Promise<{ admin: true } | { admin: false; principal: string } | null> {
    res.set('Cache-Control', 'private, no-store');
    if (!browserMarked(req) && rawLoopback(req)) return { admin: true };
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'access_cross_origin_denied' }); return null; }
    await deps.markOdooAdmin(req);
    if (deps.adminHeaderOk(req)) return { admin: true };
    const cookie = String(req.headers.cookie ?? '');
    const who = cookie ? await identity().resolveViewer(cookie) : null;
    if (!who || !who.ok) { res.status(401).json({ error: 'access_auth_required' }); return null; }
    const bound = principals().principalOf(identity().providerName() ?? '', who.viewer.login) ?? who.viewer.sub;
    const p = principals().get(bound);
    if (!p || p.status !== 'active') { res.status(403).json({ error: 'access_principal_not_active' }); return null; }
    return { admin: false, principal: bound };
  }
  /** 管理员（同源）或本机命令行；带上是不是属主。不是就回 403，返回 null */
  async function adminActor(req: express.Request, res: express.Response): Promise<Actor | null> {
    if (!browserMarked(req) && rawLoopback(req)) return { by: 'cli', principal: null, owner: true };
    await deps.markOdooAdmin(req);
    if (!deps.adminGuard(req, res)) return null;
    const by = deps.adminActor(req);
    const principal = by.startsWith('odoo:') ? principals().principalOf(identity().providerName() ?? '', by.slice(5)) : null;
    return { by, principal, owner: grants().isOwner(principal) };
  }

  app.get('/api/principals/:id/access', { action: 'principal.access', kind: 'admin', statusNotVerdict: SELF_OR_ADMIN }, route(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const id = String(req.params.id ?? '');
    if (!PRINCIPAL_RE.test(id)) throw new HttpError(400, '主体标识写法不对（形如 user:<登录名>）', { code: 'principal_id_invalid' });
    if (!v.admin && v.principal !== id) return void res.status(403).json({ error: 'access_not_self', message: '只能看自己的；看别人的要管理员' });
    const p = principals().get(id);
    if (!p) return void res.status(404).json({ error: 'principal_missing', message: `主体 ${id} 不存在` });
    const now = Date.now();
    const views = new Map(grants().roles().map((r) => [r.id, r]));
    const rows = grants().list({ principal: id });
    const active: Record<string, unknown>[] = [], inactive: Record<string, unknown>[] = [];
    for (const g of rows) {
      const role = views.get(g.role);
      const source = wizard().isWizardGrant(g.id) ? 'wizard' : g.source;
      const timeExpired = g.status === 'active' && g.expires_at !== null && g.expires_at <= now;
      if (g.status === 'active' && !timeExpired) {
        active.push({
          id: g.id, role: g.role, role_name: role?.name ?? g.role, permissions: role?.closure ?? [], scope: g.scope,
          // 范围不是 * 的授予，判定这一步还不认（L13）：页面上标「尚未生效」
          effective: g.scope === '*', expires_at: g.expires_at, approved_by: g.approved_by, source,
        });
      } else {
        const last = g.status === 'revoked' ? grants().get(g.id)?.events.filter((e) => e.to_status === 'revoked').pop() : undefined;
        inactive.push({
          id: g.id, role: g.role, role_name: role?.name ?? g.role, scope: g.scope, status: timeExpired ? 'expired' : g.status, source,
          reason: timeExpired ? '已过期（期限过了，还没标记）' : INACTIVE_REASON[g.status] ?? g.status, ...(last ? { revoke_reason: last.reason } : {}),
        });
      }
    }
    let decision: Record<string, unknown> | undefined;
    if (req.query.action !== undefined) {
      const action = String(req.query.action);
      if (!ACTION_RE.test(action)) throw new HttpError(400, 'action 写法不对', { code: 'action_invalid' });
      const known = app.actions().find((a) => a.action === action);
      if (!known) return void res.status(404).json({ error: 'action_unknown', message: `动作 ${action} 没有登记` });
      const scope = req.query.scope === undefined ? null : String(req.query.scope).slice(0, 300);
      const r = judge({ actor: { type: 'principal', id: p.id, kind: p.kind, status: p.status, owner: p.owner }, action, kind: known.kind as Kind, declared: true, now });
      decision = { action, kind: known.kind, verdict: r.verdict, rule: r.rule, grant: r.grant ?? null, ...(scope !== null ? { scope, scope_note: '只回显：带范围的授予在判定这一步还不认（L13）' } : {}) };
    }
    res.json({ principal: { id: p.id, kind: p.kind, status: p.status, display_name: p.display_name }, active, inactive, ...(decision ? { decision } : {}) });
  }));

  app.get('/api/access/red-lines', { action: 'access.red-lines', kind: 'read' }, route(async (req, res) => {
    if (!(await viewer(req, res))) return;
    res.json({ red_lines: RED_LINES.map((r) => ({ ...r })) });
  }));

  app.get('/api/setup/wizard', { action: 'setup.wizard-read', kind: 'admin' }, route(async (req, res) => {
    if (!(await adminActor(req, res))) return;
    res.set('Cache-Control', 'private, no-store');
    res.json({ runs: wizard().runs() });
  }));

  app.post('/api/setup/wizard', { action: 'setup.wizard-run', kind: 'admin' }, route(async (req, res) => {
    const actor = await adminActor(req, res);
    if (!actor) return;
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (b.shape !== 'small' && b.shape !== 'standard') throw new HttpError(400, "shape 只能是 small（只有属主和同事）或 standard", { code: 'shape_invalid' });
    const a = (b.assignments ?? {}) as Record<string, unknown>;
    if (typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'assignments 要是对象', { code: 'assignments_invalid' });
    const management = a.management === undefined ? [] : a.management;
    const deptLeads = a.dept_leads === undefined ? [] : a.dept_leads;
    if (!Array.isArray(management) || management.length > 200 || !management.every((x) => typeof x === 'string' && PRINCIPAL_RE.test(x))) throw new HttpError(400, 'assignments.management 要是主体标识的数组', { code: 'assignments_invalid' });
    if (!Array.isArray(deptLeads) || deptLeads.length > 200 || !deptLeads.every((x) => x && typeof x === 'object' && typeof (x as { principal?: unknown }).principal === 'string' && PRINCIPAL_RE.test((x as { principal: string }).principal)
      && typeof (x as { department?: unknown }).department === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test((x as { department: string }).department))) throw new HttpError(400, 'assignments.dept_leads 要是 { principal, department } 的数组', { code: 'assignments_invalid' });
    if (b.shape === 'small' && (management.length || deptLeads.length)) throw new HttpError(400, 'small 不带 assignments（只给每个人普通员工）', { code: 'assignments_invalid' });
    const out = wizard().run(b.shape, { management: management as string[], dept_leads: deptLeads as WizardAssignments['dept_leads'] }, actor, Date.now());
    console.log(JSON.stringify({ source: 'setup-wizard', event: 'run', run: out.run, shape: b.shape, created: out.created.length, skipped: out.skipped.length, by: actor.by, at: new Date().toISOString() }));
    res.status(201).json(out);
  }));

  app.post('/api/setup/wizard/approve', { action: 'setup.wizard-approve', kind: 'admin' }, route(async (req, res) => {
    const actor = await adminActor(req, res);
    if (!actor) return;
    if (!actor.owner) return void res.status(403).json({ error: 'owner_required', message: '向导这一批只有属主能放行' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (!Number.isSafeInteger(b.run) || (b.run as number) < 1) throw new HttpError(400, 'run 要是向导运行的编号', { code: 'run_invalid' });
    const r = wizard().approve(b.run as number, actor, Date.now());
    if (!r.ok) return void res.status(r.http).json({ error: r.code, message: r.message });
    console.log(JSON.stringify({ source: 'setup-wizard', event: 'approve', run: b.run, approved: r.approved.length, failed: r.failed.length, by: actor.by, at: new Date().toISOString() }));
    res.json(r);
  }));
}
