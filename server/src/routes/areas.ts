/**
 * 领域（docs/domains-step1.md 第三节；规范 15 两层组织）的读写接口，第 1 步 PR1：
 *
 *   GET  /api/areas                          领域清单（看得到的才列；看不到的人是空数组），另带 can: { create, migrate, assign_lead }（都只有属主为真）
 *   GET  /api/areas/:id                      一个领域，另带 leads: [{ grant, principal, display_name, status: active | pending | disabled }]：
 *                                            属主看全部；别的看得到这个领域的人只看生效的，外加本人那一条；看不到这个领域的照旧 404
 *   POST /api/areas                          建 { id, name }：只有属主（本机命令行在这里算属主）
 *   POST /api/areas/migrate                  部门迁成领域：只有属主；回 { created: [{id,name}], drafted: [{department,grant,principal}], skipped: [{department,reason}] }；幂等
 *   POST /api/areas/:id/retire               撤 { reason? }：只有属主；范围是 area:<标识> 的没结束的授予同一个事务里一并撤销（应答带 grants_revoked）；撤了只读、不删
 *   GET  /api/areas/:id/specs                规范的版本清单（不带正文）
 *   GET  /api/areas/:id/specs/:version       一版规范（带正文、sha256）
 *   POST /api/areas/:id/specs                新加一版 { body, note?, sha256? } 并让它生效：属主，或持本领域 area-spec 授予的人（硬规则）
 *   POST /api/areas/:id/specs/activate       把生效指针移到已有的一版 { version }（回退也是它，不新增版本）
 *
 * 谁看得到：属主、管理层（持范围 * 的业务侧授予）、管理口令、本机命令行看全部；别人看持有范围正好是 area:<领域>、覆盖这个读动作的授予的那些领域
 * （judgment.ts 的 areaVerdict；范围「全部」的普通员工授予不算）。
 * 别人列表是空的、单条按不存在回 404——范围由对象定，统一判定还不认，所以读的四条声明「状态码不代表授权」。
 * 系统管理员不看业务：领域是业务域（规范决定 AI 在领域里怎么干活），只是系统管理员的不算管理员，按他本人看。
 * 建、撤在动作清单里收窄到属主和本机命令行（judgment-builtins.ts 的 NARROWED），这里的守卫和它同一个口径；写请求先过 index.ts 的写请求总门
 * （管理员才过），属主登录着按管理员认，管理口令、系统管理员过了总门也在这里拒。
 * 定规范（area.spec-set）是硬规则：属主，或持本领域 area-spec 授予（范围正好是 area:<领域>）的人；别的角色覆盖了也不算。
 * 持 area-spec 的人多半不是管理员，所以这两条写不经管理员门（index.ts 的 REMOTE_ALLOW_PREFIX 只放这两条子路径），在这里认人、核同源、按对象判，
 * 声明「状态码不代表授权」。
 * 每次写记一行日志（谁、做了什么），不记规范正文。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import { isSystemAdminOnly } from '../admin-tier.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { GrantService } from '../services/grant.ts';
import { AREA_ID_RE, type AreaActor, type AreaRefusal, type AreaService } from '../services/area.ts';
import { AREA_LEAD_ACTIONS, AREA_SPEC_ACTION } from '../roles.ts';

export type AreaRouteDeps = {
  markAdmin: (req: express.Request) => Promise<void>;
  /** 管理员（口令或管理员登录），浏览器来的要同源；不写应答 */
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  /** 浏览器从别的站点发来的 */
  crossOriginDenied: (req: express.Request) => boolean;
  publicPerson: (req: express.Request) => string | undefined;
};

const areas = () => svc<AreaService>('areas');
const principals = () => svc<PrincipalService>('principals');
const grants = () => svc<GrantService>('grants');
const OBJECT_SCOPED = '按领域看的范围由对象定，统一判定还不认；看不到的按不存在回 404';
const SPEC_SCOPED = '定规范认持本领域 area-spec 授予的人，领域范围由对象定，统一判定还不认；路由按对象判（judgment.ts 的 areaVerdict）';

type Who = { actor: AreaActor; owner: boolean; seesAll: boolean };

function areaId(req: express.Request): string {
  const id = String(req.params.id ?? '');
  if (!AREA_ID_RE.test(id)) throw new HttpError(400, '领域标识要是小写字母开头的字母、数字、连字符，最多 48 个字符', { code: 'area_id_invalid' });
  return id;
}
/** 版本号：从 1 起的整数。路径里是十进制、不带前导零的字符串；请求体里要是数字（字符串不认） */
function versionOf(v: unknown, from: 'path' | 'body'): number {
  const ok = from === 'body' ? typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 999_999_999 : typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v);
  if (!ok) throw new HttpError(400, '版本号要是从 1 起的整数', { code: 'area_spec_version_invalid' });
  return Number(v);
}
const bodyOf = (req: express.Request): Record<string, unknown> => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};

export function registerAreaRoutes(app: HttpService, deps: AreaRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };
  const refused = (res: express.Response, r: AreaRefusal) => res.status(r.http).json({ error: r.code, message: r.message });
  const logged = (event: string, fields: Record<string, unknown>, by: string) =>
    console.log(JSON.stringify({ source: 'areas', event, ...fields, by, at: new Date().toISOString() }));

  /** 认人：本机命令行（属主）、管理员（同源；只是系统管理员的不算）、登录的人（启用的人）。不过就已经写好应答，返回 null */
  async function who(req: express.Request, res: express.Response): Promise<Who | null> {
    res.set('Cache-Control', 'private, no-store');
    const publicPrincipal = deps.publicPerson(req);
    if (publicPrincipal) {
      const owner = grants().isOwner(publicPrincipal);
      return { actor: { by: publicPrincipal, principal: publicPrincipal }, owner, seesAll: owner || grants().isBusinessSide(publicPrincipal) };
    }
    if (!browserMarked(req) && rawLoopback(req)) return { actor: { by: 'cli', principal: null }, owner: true, seesAll: true };
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'areas_cross_origin_denied' }); return null; }
    await deps.markAdmin(req);
    const admin = deps.adminHeaderOk(req) && !isSystemAdminOnly(req);
    const cookie = String(req.headers.cookie ?? '');
    const v = cookie ? await identity().resolveViewer(cookie) : null;
    const bound = v && v.ok ? (principals().principalOf(identity().providerName() ?? '', v.viewer.login) ?? v.viewer.sub) : null;
    if (admin) {
      const owner = grants().isOwner(bound);
      return { actor: { by: owner && bound ? bound : deps.adminActor(req), principal: bound }, owner, seesAll: true };
    }
    if (!bound) { res.status(401).json({ error: 'areas_auth_required' }); return null; }
    const p = principals().get(bound);
    if (!p || p.status !== 'active' || p.kind !== 'person') { res.status(403).json({ error: 'areas_principal_not_active' }); return null; }
    const owner = grants().isOwner(bound);
    return { actor: { by: bound, principal: bound }, owner, seesAll: owner || grants().isBusinessSide(bound) };
  }
  // 谁能做什么只问 AreaService.decide（access 接口问同一处）
  const subjectOf = (w: Who) => ({ owner: w.owner, seesAll: w.seesAll, principal: w.actor.principal });
  /** 建、撤、迁移：只有属主（本机命令行算属主）。不是就回 403，返回 null */
  async function ownerOnly(req: express.Request, res: express.Response, action: 'area.create' | 'area.retire' | 'area.migrate'): Promise<Who | null> {
    const w = await who(req, res);
    if (!w) return null;
    if (areas().decide(subjectOf(w), action, null).verdict !== 'allow') { res.status(403).json({ error: 'areas_owner_only', message: '建领域、撤领域只有属主能做' }); return null; }
    return w;
  }
  /** 这个人看得到这个领域（这个读动作） */
  const sees = (w: Who, id: string, action: string): boolean => areas().decide(subjectOf(w), action, id).verdict === 'allow';
  /** 定规范：属主（本机命令行在这里算属主），或持本领域 area-spec 授予的人（硬规则）。不是就回 403，返回 null */
  async function specSetter(req: express.Request, res: express.Response, id: string): Promise<Who | null> {
    const w = await who(req, res);
    if (!w) return null;
    if (areas().decide(subjectOf(w), AREA_SPEC_ACTION, id).verdict === 'allow') return w;
    res.status(403).json({ error: 'areas_spec_holder_only', message: '定规范只有属主和持这个领域「定规范」授予的人能做' });
    return null;
  }
  const missing = (res: express.Response, id: string) => res.status(404).json({ error: 'area_missing', message: `领域 ${id} 不存在` });

  app.get('/api/areas', { action: 'area.list', kind: 'read', statusNotVerdict: OBJECT_SCOPED }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    // can：页面照服务端给的「能做什么」出按钮（建领域、迁移、指定负责人都只有属主）
    res.json({ areas: areas().list().filter((a) => sees(w, a.id, 'area.list')), can: { create: w.owner, migrate: w.owner, assign_lead: w.owner } });
  }));

  app.get('/api/areas/:id', { action: 'area.read', kind: 'read', statusNotVerdict: OBJECT_SCOPED }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    const id = areaId(req);
    const a = sees(w, id, 'area.read') ? areas().get(id) : null;
    if (!a) return void missing(res, id);
    // leads：这个领域的负责人。等放行的、已停用的是人员信息：只有属主（含本机命令行）看得全；
    // 别的看得到这个领域的人（管理层、管理口令、持这个领域授予的人）只看生效的，外加他本人那一条（不论状态）
    const all = grants().leadsOf(id);
    res.json({ area: a, leads: w.owner ? all : all.filter((l) => l.status === 'active' || (!!w.actor.principal && l.principal === w.actor.principal)) });
  }));

  app.get('/api/areas/:id/specs', { action: 'area.spec-list', kind: 'read', statusNotVerdict: OBJECT_SCOPED }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    const id = areaId(req);
    const a = sees(w, id, 'area.spec-list') ? areas().get(id) : null;
    if (!a) return void missing(res, id);
    res.json({ area_id: id, spec_version: a.spec_version, specs: areas().specs(id) });
  }));

  app.get('/api/areas/:id/specs/:version', { action: 'area.spec-read', kind: 'read', statusNotVerdict: OBJECT_SCOPED }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    const id = areaId(req);
    const version = versionOf(String(req.params.version ?? ''), 'path');
    const a = sees(w, id, 'area.spec-read') ? areas().get(id) : null;
    if (!a) return void missing(res, id);
    const s = areas().spec(id, version);
    if (!s) return void res.status(404).json({ error: 'area_spec_missing', message: `领域 ${id} 没有第 ${version} 版规范` });
    res.json({ area_id: id, spec: s });
  }));

  app.post('/api/areas', { action: 'area.create', kind: 'decide' }, route(async (req, res) => {
    const w = await ownerOnly(req, res, 'area.create');
    if (!w) return;
    const b = bodyOf(req);
    if (typeof b.id !== 'string' || !AREA_ID_RE.test(b.id)) throw new HttpError(400, 'id 要是领域标识：小写字母开头的字母、数字、连字符，最多 48 个字符', { code: 'area_id_invalid' });
    if (typeof b.name !== 'string') throw new HttpError(400, 'name 要是领域名字（1～64 个字符）', { code: 'area_name_invalid' });
    const r = areas().create({ id: b.id, name: b.name }, w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('create', { id: r.area.id }, w.actor.by);
    res.status(201).json({ area: r.area });
  }));

  app.post('/api/areas/migrate', { action: 'area.migrate', kind: 'decide' }, route(async (req, res) => {
    const w = await ownerOnly(req, res, 'area.migrate');
    if (!w) return;
    const r = areas().migrateDepartments({ ...w.actor, owner: w.owner }, Date.now());
    logged('migrate', { created: r.created.map((x) => x.id), drafted: r.drafted.map((x) => x.grant), skipped: r.skipped.length }, w.actor.by);
    res.json(r);
  }));

  app.post('/api/areas/:id/retire', {
    action: 'area.retire', kind: 'decide',
    // 负责人专有的动作（过目放行、改派、批接入）第 1 步只登记、走不到（docs/domains-step1.md 第七节第 8 条）：when 恒为假，先让 area-lead 能引用
    refine: AREA_LEAD_ACTIONS.filter((action) => action !== 'area.access-approve').map((action) => ({ action, kind: 'decide' as const, why: '负责人专有的动作，第 1 步只登记（恒为假），挂在领域的写路由下', when: () => false })),
  }, route(async (req, res) => {
    const w = await ownerOnly(req, res, 'area.retire');
    if (!w) return;
    const id = areaId(req);
    const b = bodyOf(req);
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) throw new HttpError(400, 'reason 要是不超过 200 个字符的字符串', { code: 'reason_invalid' });
    const r = areas().retire(id, typeof b.reason === 'string' ? b.reason : '', { ...w.actor, owner: w.owner }, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('retire', { id, grants_revoked: r.grants_revoked }, w.actor.by);
    res.json({ area: r.area, grants_revoked: r.grants_revoked });
  }));

  // 移指针登记在新加一版前面：路径更具体，免得被 /:id/specs 之外的写法误配
  app.post('/api/areas/:id/specs/activate', { action: 'area.spec-set', kind: 'decide', statusNotVerdict: SPEC_SCOPED }, route(async (req, res) => {
    const id = areaId(req);
    const w = await specSetter(req, res, id);
    if (!w) return;
    const version = versionOf(bodyOf(req).version, 'body');
    const r = areas().activate(id, version, w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('spec-activate', { id, version }, w.actor.by);
    res.json({ area: r.area });
  }));

  app.post('/api/areas/:id/specs', { action: 'area.spec-set', kind: 'decide', statusNotVerdict: SPEC_SCOPED }, route(async (req, res) => {
    const id = areaId(req);
    const w = await specSetter(req, res, id);
    if (!w) return;
    const b = bodyOf(req);
    if (typeof b.body !== 'string') throw new HttpError(400, 'body 要是规范正文（Markdown，1 字节～64 KB）', { code: 'area_spec_body_invalid' });
    if (b.note !== undefined && typeof b.note !== 'string') throw new HttpError(400, 'note 要是一句话的字符串', { code: 'area_spec_note_invalid' });
    if (b.sha256 !== undefined && typeof b.sha256 !== 'string') throw new HttpError(400, 'sha256 要是正文的十六进制摘要', { code: 'area_spec_sha256_mismatch' });
    const r = areas().addSpec(id, { body: b.body, note: typeof b.note === 'string' ? b.note : '', sha256: typeof b.sha256 === 'string' ? b.sha256 : null }, w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('spec-add', { id, version: r.spec.version, sha256: r.spec.sha256 }, w.actor.by);
    res.status(201).json({ spec: r.spec, area: r.area });
  }));
}
