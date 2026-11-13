/**
 * 团队与分配的接口（规范 14 第 1 步）。不改任何现有行为：过目还归管理员，安排还是只交给团队。
 *
 *   GET  /api/teams                  团队页：部门 → 团队（状态、负责人、总工）→ 成员（分配给谁、在办几件）；待认领的单列（只给管理员）。
 *                                    按看的人的可见范围在服务端裁好，页面只渲染。名册部分取自节点名册（services/a2a-roster.ts）。
 *   GET  /api/teams/mine             「我的 AI 员工」：分配给我的成员；我是负责人的，加上我的团队和它的总工。
 *   GET  /api/teams/events?host&team 团队的变更记录（认领、换部门、负责人增减、分配、收回），带显示名。管理员、管理层、这个团队的负责人能看；
 *                                    别人（和不存在的团队）一律 404 team_not_found，不说有没有这个团队。
 *   GET  /api/teams/assignments?principal&from&to  某人各段分配（哪个席位、从什么时候到什么时候）。本人、管理员、管理层看全部；
 *                                    团队负责人只看自己负责的团队里的那几段；什么都看不到的（和不存在的人）一律 404 principal_not_found。
 *   POST /api/teams/claim            认领团队并挂部门（已认领的就是换部门）。管理员发起；属主、管理层直接生效，
 *                                    别的管理员只记成提议（202，规范 14「关系由谁说了算」），由管理层或接收部门的负责人在 /api/relations 确认。
 *   POST /api/teams/release          退回待认领。管理员。
 *   POST /api/teams/leads            另外指定一个负责人。管理员发起；带拍板，属主直接生效，别的管理员只记成提议（202），属主确认。
 *   POST /api/teams/leads/remove     移除负责人（最后一个不能直接移除，409）。管理员。
 *   POST /api/teams/assign           把成员分配给员工。这个团队的负责人，或者管理层（本机命令行也行）；系统管理员、管理口令不能代办。
 *   POST /api/teams/unassign         收回。同上。
 *   POST /api/teams/reassign         改派：一个事务里收回并分给另一个人（现在没人分着就等同于分配；改给同一个人回 changed=false）。同上。
 *
 * 谁能看到哪些团队（读）：
 *   · 管理员（口令或管理员登录，同源）、本机命令行：全部，包括待认领的；
 *   · 持有管理层（或属主）授予的人：全部认领了的；
 *   · 别的登录的人：自己所在部门（成员或负责人）的团队、自己是负责人的团队、有成员分给自己的团队。
 * 读接口只给团队、人和计数，不带事项内容。
 *
 * 页面只渲染、不自己判：GET /api/teams 顶层带 can（认领、退回、增减负责人、管部门，都是管理面），
 * 每个团队带 can_assign / assign_denied_text（和分配、收回接口用同一处判断 assignRefusal），
 * can_assign 为真的团队带 assignable：可以分给谁（所挂部门的成员和负责人、这个团队的负责人，启用的人）。
 * 每个团队（含待认领的）带 node_name：节点在对端登记表里的名字，没有为 null；roster_received_at：最近一次收下这个节点名册的时间。
 * 顶层 roster_stale_minutes 是名册停推的阈值；每个团队带 roster_stale（这个节点的名册停推了没有）、roster_stale_for_minutes（停推时离最近一次收到多少分钟），
 * 和「等你拍板」的名册停推同一个判断（TeamService 的 staleBy）。
 * 每个团队带 lead_pending_grant：所挂部门上写着负责人、但他没有这个部门拍板授予的（待属主放行）——他不算负责人，不带任何权力，页面写「负责人（待属主放行权限）」。
 *
 * 分配、收回由「这个人是不是这个团队的负责人」判，是按对象的范围（统一判定还不认，L13），路由声明「状态码不代表授权」；
 * 写请求总门对这两条放行（index.ts 的 REMOTE_ALLOW_PREFIX），认人、同源、负责人在这里判。认领、负责人的增减是管理面，照写请求总门和管理员门。
 * 每一步在 team_events 里留痕，并写一行日志（谁、做了什么、哪个团队）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { GrantService } from '../services/grant.ts';
import type { DepartmentService } from '../services/department.ts';
import { HOST_RE, SEAT_ID_RE, SEAT_RE, TEAM_RE, type Actor, type SeatKey, type TeamKey, type TeamRefusal, type TeamService, type TeamView } from '../services/team.ts';
import { orgWideManagement, teamName, teamVisibleTo } from '../team-relation.ts';
import { CONFIRM_BY, type RelationProposalService } from '../services/relation-proposal.ts';

export type TeamRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  crossOriginDenied: (req: express.Request) => boolean;
};

const teams = () => svc<TeamService>('teams');
const principals = () => svc<PrincipalService>('principals');
const grants = () => svc<GrantService>('grants');
const departments = () => svc<DepartmentService>('departments');
const proposals = () => svc<RelationProposalService>('relationProposals');
const PRINCIPAL_RE = /^[a-z]+:[\x21-\x7e]{1,150}$/;
const LEAD_DECIDES = '按团队的负责人判：负责人是按对象的范围，统一判定还不认（L13），由团队这个域自己判';
const HISTORY_BY_RELATION = '按关系判：管理员、管理层看全部，团队负责人看自己的团队，本人看自己的分配（按对象的范围，统一判定还不认，L13）；读不到的按不存在回';
const ACTOR_NAME: Record<string, string> = { cli: '本机命令行', 'admin-token': '管理员（口令）' };

type Viewer = { kind: 'admin'; by: string; principal: string | null } | { kind: 'person'; principal: string; management: boolean };

function str(v: unknown, name: string, re: RegExp, max = 200): string {
  if (typeof v !== 'string' || v.length > max || !re.test(v)) throw new HttpError(400, `${name} 写法不对`, { code: `${name}_invalid` });
  return v;
}
function teamKeyOf(b: Record<string, unknown>): TeamKey {
  return { host: str(b.host, 'host', HOST_RE), team: str(b.team ?? '', 'team', TEAM_RE) };
}
function seatKeyOf(b: Record<string, unknown>): SeatKey {
  return { ...teamKeyOf(b), seat: str(b.seat, 'seat', SEAT_RE), seat_id: str(b.seat_id ?? '', 'seat_id', SEAT_ID_RE, 64) };
}
const bodyOf = (req: express.Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};

export function registerTeamRoutes(app: HttpService, deps: TeamRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };
  const refused = (res: express.Response, r: TeamRefusal) => res.status(r.http).json({ error: r.code, message: r.message });
  const logged = (event: string, k: TeamKey, fields: Record<string, unknown>, by: string) =>
    console.log(JSON.stringify({ source: 'teams', event, host: k.host, team: k.team, ...fields, by, at: new Date().toISOString() }));

  /** 认人：管理员（同源）或本机命令行 → admin；登录的人（主体启用）→ person。不过就已经写好应答，返回 null */
  async function viewer(req: express.Request, res: express.Response): Promise<Viewer | null> {
    res.set('Cache-Control', 'private, no-store');
    if (!browserMarked(req) && rawLoopback(req)) return { kind: 'admin', by: 'cli', principal: null };
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'teams_cross_origin_denied' }); return null; }
    await deps.markOdooAdmin(req);
    const admin = deps.adminHeaderOk(req);
    const cookie = String(req.headers.cookie ?? '');
    const who = cookie ? await identity().resolveViewer(cookie) : null;
    const bound = who && who.ok ? (principals().principalOf(identity().providerName() ?? '', who.viewer.login) ?? who.viewer.sub) : null;
    if (admin) return { kind: 'admin', by: deps.adminActor(req), principal: bound };
    if (!bound) { res.status(401).json({ error: 'teams_auth_required' }); return null; }
    const p = principals().get(bound);
    if (!p || p.status !== 'active' || p.kind !== 'person') { res.status(403).json({ error: 'teams_principal_not_active' }); return null; }
    const management = orgWideManagement(bound);
    return { kind: 'person', principal: bound, management };
  }

  /** 这个人能不能分配、收回这个团队的成员：分配接口和团队页的 can_assign 共用这一处。能就返回 null，不能返回说法 */
  function assignRefusal(v: Viewer, t: TeamView | TeamKey): { code: string; message: string } | null {
    if ('status' in t && t.status === 'unclaimed') return { code: 'team_not_claimed', message: '团队还没认领，不能分配成员' };
    if (v.kind === 'admin' && v.by === 'cli') return null; // 本机命令行：授予面上算属主（L1）
    if (v.principal && teams().leads(t).some((l) => l.principal === v.principal)) return null;
    if (grants().isBusinessSide(v.principal)) return null; // 管理层（属主也是）
    // 系统管理员、管理口令不代办：分配会带来成员的主人这层关系（规范 14「关系由谁说了算」）
    return { code: 'not_team_lead', message: '只有这个团队的负责人或管理层能分配、收回成员' };
  }

  /** 可以分给谁：所挂部门的成员和负责人、这个团队的负责人，只要启用的人 */
  function assignableOf(t: TeamView): { principal: string; display_name: string }[] {
    const out = new Map<string, string>();
    if (t.department) for (const m of departments().members(t.department.id)) if (m.kind === 'person' && m.status === 'active') out.set(m.principal, m.display_name);
    for (const l of t.leads) out.set(l.principal, l.display_name);
    return [...out.entries()].map(([principal, display_name]) => ({ principal, display_name })).sort((a, b) => (a.principal < b.principal ? -1 : 1));
  }

  /** 这个人看得到这个团队吗（读） */
  function visible(v: Viewer, t: TeamView): boolean {
    return teamVisibleTo({ admin: v.kind === 'admin', principal: v.principal, management: v.kind === 'person' && v.management }, t);
  }

  /** 管理员（同源）或本机命令行；不是就回 403，返回 null */
  async function admin(req: express.Request, res: express.Response): Promise<(Actor & { owner: boolean }) | null> {
    if (!browserMarked(req) && rawLoopback(req)) return { by: 'cli', principal: null, owner: true };
    await deps.markOdooAdmin(req);
    if (!deps.adminGuard(req, res)) return null;
    const by = deps.adminActor(req);
    const principal = by.startsWith('odoo:') ? principals().principalOf(identity().providerName() ?? '', by.slice(5)) : null;
    return { by, principal, owner: grants().isOwner(principal) };
  }

  app.get('/api/teams', { action: 'team.list', kind: 'read' }, route(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const all = teams().allViews();
    const seen = all.filter((t) => visible(v, t));
    const depts = new Map<string, { id: string; name: string; lead: { principal: string; display_name: string } | null; teams: TeamView[] }>();
    const deptRows = departments().list();
    for (const t of seen) {
      if (t.status === 'unclaimed' || !t.department) continue;
      const d = deptRows.find((x) => x.id === t.department!.id);
      const e = depts.get(t.department.id) ?? { id: t.department.id, name: d?.name ?? t.department.name, lead: d?.lead ?? null, teams: [] };
      e.teams.push(t);
      depts.set(t.department.id, e);
    }
    const nodes = new Map<string, ReturnType<TeamService['nodeInfo']>>();
    const nodeOf = (host: string) => { if (!nodes.has(host)) nodes.set(host, teams().nodeInfo(host)); return nodes.get(host)!; };
    const isAdmin = v.kind === 'admin';
    // 待确认的提议（只给管理员的视图）：页面在那一项上写「待确认，等〈谁〉确认」，不当成已生效
    const pending = isAdmin ? proposals().list().filter((p) => p.status === 'pending') : [];
    const pendingOf = (p: (typeof pending)[number]) => ({ id: p.id, principal: p.principal_id || null, department: p.department_id || null, confirm_by_text: CONFIRM_BY[p.kind] });
    const shape = (t: TeamView) => {
      const no = assignRefusal(v, t);
      const claim = pending.find((p) => p.kind === 'team-claim' && p.host === t.host && p.team === t.team);
      const leads = pending.filter((p) => p.kind === 'team-lead' && p.host === t.host && p.team === t.team);
      return {
        ...t, name: teamName(t.team), ...nodeOf(t.host), can_assign: !no, assign_denied_text: no?.message ?? null, ...(no ? {} : { assignable: assignableOf(t) }),
        ...(isAdmin ? { pending_claim: claim ? pendingOf(claim) : null, pending_leads: leads.map(pendingOf) } : {}),
      };
    };
    const deptPending = (id: string) => { const p = pending.find((x) => x.kind === 'dept-lead' && x.department_id === id); return p ? pendingOf(p) : null; };
    const owner = isAdmin && (v.by === 'cli' || grants().isOwner(v.principal));
    const business = owner || grants().isBusinessSide(v.principal);
    res.json({
      // 名册停推的阈值（分钟，服务端实际生效的 WM_ROSTER_STALE_MINUTES）；每个团队的 roster_stale 和「等你拍板」的名册停推出自同一个判断
      roster_stale_minutes: teams().rosterStaleMinutes(),
      // claim / add_lead：直接生效；propose_claim / propose_lead：只能提议（确认在 /api/relations/proposals）；release、manage_leads（移除）是收紧，管理员一步完成
      can: {
        claim: isAdmin && business, propose_claim: isAdmin && !business, release: isAdmin,
        add_lead: owner, propose_lead: isAdmin && !owner, manage_leads: isAdmin, manage_departments: isAdmin,
      },
      departments: [...depts.values()].sort((a, b) => a.id.localeCompare(b.id)).map((d) => ({ ...d, ...(isAdmin ? { pending_lead: deptPending(d.id) } : {}), teams: d.teams.map(shape) })),
      ...(v.kind === 'admin' ? { unclaimed: seen.filter((t) => t.status === 'unclaimed').map(shape) } : {}),
    });
  }));

  app.get('/api/teams/mine', { action: 'team.mine', kind: 'read' }, route(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const me = v.principal;
    if (!me) return void res.json({ principal: null, members: [], teams: [] });
    const all = teams().allViews();
    const members = all.flatMap((t) => t.members.filter((m) => m.assigned_to?.principal === me).map((m) => ({ host: t.host, team: t.team, team_name: teamName(t.team), status: t.status, ...m })));
    const led = all.filter((t) => t.leads.some((l) => l.principal === me)).map((t) => ({ host: t.host, team: t.team, name: teamName(t.team), status: t.status, router: t.router }));
    res.json({ principal: me, members, teams: led });
  }));

  /** 读历史的人能看全部吗：管理员、管理层 */
  const seesAll = (v: Viewer): boolean => v.kind === 'admin' || v.management;
  const nameOrNull = (principal: string | null | undefined): string | null => (principal ? teams().nameOf(principal) || null : null);

  app.get('/api/teams/events', { action: 'team.events', kind: 'read', statusNotVerdict: HISTORY_BY_RELATION }, route(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const k = teamKeyOf({ host: req.query.host, team: req.query.team ?? '' });
    const t = teams().allViews().find((x) => x.host === k.host && x.team === k.team);
    // 管理层看认领了的；负责人看自己的；管理员全看。别的（含不存在的）一样回 404
    const can = !!t && (v.kind === 'admin' || (t.status !== 'unclaimed' && (v.management || t.leads.some((l) => l.principal === v.principal))));
    if (!can) return void res.status(404).json({ error: 'team_not_found', message: '没有这个团队' });
    const parse = (d: string): unknown => { if (!d) return null; try { return JSON.parse(d); } catch { return d; } };
    res.json({
      host: k.host, team: k.team, name: teamName(k.team),
      events: teams().events(k).map((e) => ({
        seq: e.seq, kind: e.kind, seat: e.seat, seat_id: e.seat_id, principal: e.principal_id || null, principal_name: nameOrNull(e.principal_id),
        detail: parse(e.detail), actor: e.actor, actor_name: nameOrNull(e.actor_principal) ?? ACTOR_NAME[e.actor] ?? (e.actor.startsWith('system:') ? '系统' : '管理员'), at: e.at,
      })),
    });
  }));

  app.get('/api/teams/assignments', { action: 'team.assignment-history', kind: 'read', statusNotVerdict: HISTORY_BY_RELATION }, route(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const who = str(req.query.principal, 'principal', PRINCIPAL_RE, 160);
    const ms = (raw: unknown, name: string): number | undefined => {
      if (raw === undefined) return undefined;
      if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, `${name} 要是毫秒时刻`, { code: `${name}_invalid` });
      return Number(raw);
    };
    const from = ms(req.query.from, 'from'), to = ms(req.query.to, 'to');
    if (from !== undefined && to !== undefined && from >= to) throw new HttpError(400, 'from 要早于 to', { code: 'range_invalid' });
    const exists = !!principals().get(who);
    const all = exists ? teams().assignmentHistory(who, { from, to }) : [];
    let rows = all;
    if (!(seesAll(v) || v.principal === who)) {
      // 团队负责人：只看自己负责的团队里的那几段
      const led = new Set(teams().allViews().filter((t) => t.leads.some((l) => l.principal === v.principal)).map((t) => `${t.host}\u0000${t.team}`));
      const ledAny = exists && teams().assignmentHistory(who).some((r) => led.has(`${r.host}\u0000${r.team}`));
      if (!ledAny) return void res.status(404).json({ error: 'principal_not_found', message: '没有这个人' });
      rows = all.filter((r) => led.has(`${r.host}\u0000${r.team}`));
    } else if (!exists) return void res.status(404).json({ error: 'principal_not_found', message: '没有这个人' });
    res.json({
      principal: who, principal_name: nameOrNull(who),
      assignments: rows.map((r) => ({ host: r.host, team: r.team, team_name: teamName(r.team), seat: r.seat, seat_id: r.seat_id, from: r.from, to: r.to })),
    });
  }));

  app.post('/api/teams/claim', { action: 'team.claim', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const b = bodyOf(req);
    const k = teamKeyOf(b);
    const dept = str(b.department, 'department', /^[a-z][a-z0-9-]{0,47}$/, 48);
    const now = Date.now();
    if (!proposals().direct('team-claim', actor, dept, now)) {
      const check = teams().claimCheck(k, dept);
      if (check === 'unchanged') return void res.json({ ok: true, changed: false });
      if (check) return void refused(res, check);
      const pr = proposals().propose({ kind: 'team-claim', host: k.host, team: k.team, department_id: dept }, actor, now);
      logged('claim-propose', k, { department: dept, proposal: pr.id }, actor.by);
      return void res.status(202).json({ ok: true, proposed: true, proposal: { id: pr.id, status: 'pending', confirm_by_text: CONFIRM_BY['team-claim'] } });
    }
    const r = teams().claim(k, dept, actor, now);
    if (!r.ok) return void refused(res, r);
    if (r.changed) logged('claim', k, { department: dept }, actor.by);
    res.json({ ok: true, changed: r.changed });
  }));

  app.post('/api/teams/release', { action: 'team.release', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const k = teamKeyOf(bodyOf(req));
    const r = teams().release(k, actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('release', k, { leads_ended: r.leads_ended, assignments_ended: r.assignments_ended }, actor.by);
    res.json(r);
  }));

  app.post('/api/teams/leads', { action: 'team.lead-add', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const b = bodyOf(req);
    const k = teamKeyOf(b);
    const principal = str(b.principal, 'principal', PRINCIPAL_RE, 160);
    const now = Date.now();
    if (!actor.owner) {
      const check = teams().leadCheck(k, principal);
      if (check === 'already') return void res.json({ ok: true, added: false });
      if (check) return void refused(res, check);
      const pr = proposals().propose({ kind: 'team-lead', host: k.host, team: k.team, principal_id: principal }, actor, now);
      logged('lead-propose', k, { principal, proposal: pr.id }, actor.by);
      return void res.status(202).json({ ok: true, proposed: true, proposal: { id: pr.id, status: 'pending', confirm_by_text: CONFIRM_BY['team-lead'] } });
    }
    const r = teams().addLead(k, principal, actor, now);
    if (!r.ok) return void refused(res, r);
    if (r.added) logged('lead-add', k, { principal }, actor.by);
    res.status(r.added ? 201 : 200).json(r);
  }));

  app.post('/api/teams/leads/remove', { action: 'team.lead-remove', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const b = bodyOf(req);
    const k = teamKeyOf(b);
    const principal = str(b.principal, 'principal', PRINCIPAL_RE, 160);
    const r = teams().removeLead(k, principal, actor, Date.now());
    if (!r.ok) return void refused(res, r);
    if (r.removed) logged('lead-remove', k, { principal }, actor.by);
    res.json(r);
  }));

  /** 分配、收回：这个团队的负责人，或者管理员（过渡期代办）。不是就写好应答，返回 null */
  async function leadOrAdmin(req: express.Request, res: express.Response, k: TeamKey): Promise<Actor | null> {
    const v = await viewer(req, res);
    if (!v) return null;
    const no = assignRefusal(v, k);
    if (no) { res.status(403).json({ error: no.code, message: no.message }); return null; }
    return v.kind === 'admin' ? { by: v.by, principal: v.principal } : { by: v.principal, principal: v.principal };
  }

  app.post('/api/teams/assign', { action: 'team.assign', kind: 'write', statusNotVerdict: LEAD_DECIDES }, route(async (req, res) => {
    const b = bodyOf(req);
    const k = seatKeyOf(b);
    const principal = str(b.principal, 'principal', PRINCIPAL_RE, 160);
    const actor = await leadOrAdmin(req, res, k);
    if (!actor) return;
    const r = teams().assign(k, principal, actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('assign', k, { seat: k.seat, seat_id: k.seat_id, principal }, actor.by);
    res.status(201).json({ ok: true, id: r.id });
  }));

  app.post('/api/teams/unassign', { action: 'team.unassign', kind: 'write', statusNotVerdict: LEAD_DECIDES }, route(async (req, res) => {
    const k = seatKeyOf(bodyOf(req));
    const actor = await leadOrAdmin(req, res, k);
    if (!actor) return;
    const r = teams().unassign(k, actor, Date.now());
    if (!r.ok) return void refused(res, r);
    if (r.removed) logged('unassign', k, { seat: k.seat, seat_id: k.seat_id }, actor.by);
    res.json(r);
  }));

  app.post('/api/teams/reassign', { action: 'team.reassign', kind: 'write', statusNotVerdict: LEAD_DECIDES }, route(async (req, res) => {
    const b = bodyOf(req);
    const k = seatKeyOf(b);
    const principal = str(b.principal, 'principal', PRINCIPAL_RE, 160);
    const actor = await leadOrAdmin(req, res, k);
    if (!actor) return;
    const r = teams().reassign(k, principal, actor, Date.now());
    if (!r.ok) return void refused(res, r);
    if (r.changed) logged('reassign', k, { seat: k.seat, seat_id: k.seat_id, from: r.from, to: principal }, actor.by);
    res.json({ ok: true, changed: r.changed, id: r.id, from: r.from });
  }));
}
