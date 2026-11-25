/**
 * 报告的维度和模板（docs/report-step1.md 第四节；第 19 篇）的读写接口，报告第 1 步 PR A：
 *
 *   GET  /api/report-dimensions                                   维度清单
 *   GET  /api/report-dimensions/:id                               一个维度，另带 templates（版本清单，不带正文，带复核）
 *   GET  /api/report-dimensions/:id/templates/:version            一版模板（带正文）
 *   POST /api/report-dimensions                                   建 { id, title, area? }：area 不写是跨领域的维度
 *   POST /api/report-dimensions/:id/templates                     发一版 { body, note?, sha256? }：不自动生效；kind 由服务端比出来，请求里写了拒
 *   POST /api/report-dimensions/:id/templates/:version/review     复核一版 { note? }：作者本人不能复核
 *   POST /api/report-dimensions/:id/activate                      移生效指针 { version }：判据类版本没复核过 409
 *   POST /api/report-dimensions/:id/retire                        撤 { reason? }：撤了只读，不删
 *
 * 读：登录的人都能读（模板是协议，不是业务数据；规格第六节评审定的推荐，按推荐实现），另外管理口令、本机命令行能读。
 * 写（定报告维度，report.dimension-set）是硬规则：属主（本机命令行在这里算属主）；领域的维度另认持本领域 area-report 授予的人；
 * 跨领域的维度只有属主。别的角色哪怕覆盖了这个动作也不算（judgment-builtins.ts 的 NARROWED、judgment.ts 的 areaVerdict）。
 * 持 area-report 的人多半不是管理员，所以写不经管理员门（index.ts 的 REMOTE_ALLOW_PREFIX 只放这几条路径），在这里认人、核同源、按对象判，
 * 声明「状态码不代表授权」。认人的做法和领域的接口（routes/areas.ts）一样。
 * 每次写记一行日志（谁、做了什么），不记模板正文。
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
import { DIMENSION_ID_RE, type DimensionActor, type DimensionRefusal, type ReportDimensionService } from '../services/report-dimension.ts';
import { AREA_ID_RE } from '../services/area.ts';
import { personalTokenAuditName, personalTokenOf } from './owner-personal-tokens.ts';

export type ReportDimensionRouteDeps = {
  markAdmin: (req: express.Request) => Promise<void>;
  /** 管理员（口令或管理员登录），浏览器来的要同源；不写应答 */
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  /** 浏览器从别的站点发来的 */
  crossOriginDenied: (req: express.Request) => boolean;
  publicPerson: (req: express.Request) => string | undefined;
};

const dims = () => svc<ReportDimensionService>('reportDimensions');
const principals = () => svc<PrincipalService>('principals');
const grants = () => svc<GrantService>('grants');
const READ_OPEN = '登录的人都能读（模板是协议，不是业务数据）；统一判定按角色问，访客、AI 员工这类没有读类权限的也放行，所以状态码不代表授权';
const SET_SCOPED = '定报告维度认持本领域 area-report 授予的人，领域范围由对象定，统一判定还不认；路由按对象判（services/report-dimension.ts 的 decideSet）';

type Who = { actor: DimensionActor; owner: boolean };

function dimensionId(req: express.Request): string {
  const id = String(req.params.id ?? '');
  if (!DIMENSION_ID_RE.test(id)) throw new HttpError(400, '维度标识要是小写字母开头的字母、数字、连字符，最多 48 个字符', { code: 'report_dimension_id_invalid' });
  return id;
}
/** 版本号：从 1 起的整数。路径里是十进制、不带前导零的字符串；请求体里要是数字（字符串不认） */
function versionOf(v: unknown, from: 'path' | 'body'): number {
  const ok = from === 'body' ? typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 999_999_999 : typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v);
  if (!ok) throw new HttpError(400, '版本号要是从 1 起的整数', { code: 'report_template_version_invalid' });
  return Number(v);
}
const bodyOf = (req: express.Request): Record<string, unknown> => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
/** 请求体只收这几个键 */
function onlyKeys(b: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, `有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`, { code: 'unknown_key' });
}
const noteOf = (b: Record<string, unknown>, key: string): string => {
  if (b[key] === undefined) return '';
  if (typeof b[key] !== 'string') throw new HttpError(400, `${key} 要是一句话的字符串`, { code: 'report_template_note_invalid' });
  return b[key] as string;
};

export function registerReportDimensionRoutes(app: HttpService, deps: ReportDimensionRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };
  const refused = (res: express.Response, r: DimensionRefusal) => res.status(r.http).json({ error: r.code, message: r.message });
  const logged = (event: string, fields: Record<string, unknown>, by: string) =>
    console.log(JSON.stringify({ source: 'report-dimensions', event, ...fields, by, at: new Date().toISOString() }));

  /** 认人：本机命令行（属主）、管理员（同源；只是系统管理员的不算）、登录的人（启用的人）。不过就已经写好应答，返回 null */
  async function who(req: express.Request, res: express.Response): Promise<Who | null> {
    res.set('Cache-Control', 'private, no-store');
    const token = personalTokenOf(req);
    if (token) return { actor: { by: personalTokenAuditName(token), principal: token.principal }, owner: grants().isOwner(token.principal) };
    const publicPrincipal = deps.publicPerson(req);
    if (publicPrincipal) return { actor: { by: publicPrincipal, principal: publicPrincipal }, owner: grants().isOwner(publicPrincipal) };
    if (!browserMarked(req) && rawLoopback(req)) return { actor: { by: 'cli', principal: null }, owner: true };
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'report_dimensions_cross_origin_denied' }); return null; }
    await deps.markAdmin(req);
    const admin = deps.adminHeaderOk(req) && !isSystemAdminOnly(req);
    const cookie = String(req.headers.cookie ?? '');
    const v = cookie ? await identity().resolveViewer(cookie) : null;
    const bound = v && v.ok ? (principals().principalOf(identity().providerName() ?? '', v.viewer.login) ?? v.viewer.sub) : null;
    if (admin) {
      const owner = grants().isOwner(bound);
      return { actor: { by: owner && bound ? bound : deps.adminActor(req), principal: bound }, owner };
    }
    if (!bound) { res.status(401).json({ error: 'report_dimensions_auth_required' }); return null; }
    const p = principals().get(bound);
    if (!p || p.status !== 'active' || p.kind !== 'person') { res.status(403).json({ error: 'report_dimensions_principal_not_active' }); return null; }
    return { actor: { by: bound, principal: bound }, owner: grants().isOwner(bound) };
  }
  const forbidden = (res: express.Response, area: string | null) =>
    res.status(403).json({ error: 'report_dimension_set_forbidden', message: area === null ? '跨领域的报告维度只有属主能定' : '报告维度只有属主和持这个领域「定报告维度」授予的人能定' });
  const maySet = (w: Who, area: string | null) => dims().decideSet({ owner: w.owner, principal: w.actor.principal }, area).verdict === 'allow';
  /** 写一个已有的维度：先认人，维度不存在的回 404（认了人才说），再按维度所属的领域判 */
  async function existingSetter(req: express.Request, res: express.Response): Promise<{ w: Who; id: string } | null> {
    const pre = await who(req, res);
    if (!pre) return null;
    const id = dimensionId(req);
    const d = dims().get(id);
    if (!d) { res.status(404).json({ error: 'report_dimension_missing', message: `维度 ${id} 不存在` }); return null; }
    if (!maySet(pre, d.area_id)) { forbidden(res, d.area_id); return null; }
    return { w: pre, id };
  }
  const missing = (res: express.Response, id: string) => res.status(404).json({ error: 'report_dimension_missing', message: `维度 ${id} 不存在` });

  app.get('/api/report-dimensions', { action: 'report.dimension-list', kind: 'read', statusNotVerdict: READ_OPEN }, route(async (req, res) => {
    if (!await who(req, res)) return;
    res.json({ dimensions: dims().list() });
  }));

  app.get('/api/report-dimensions/:id', { action: 'report.dimension-read', kind: 'read', statusNotVerdict: READ_OPEN }, route(async (req, res) => {
    if (!await who(req, res)) return;
    const id = dimensionId(req);
    const d = dims().get(id);
    if (!d) return void missing(res, id);
    res.json({ dimension: d, templates: dims().templates(id) });
  }));

  app.get('/api/report-dimensions/:id/templates/:version', { action: 'report.dimension-read', kind: 'read', statusNotVerdict: READ_OPEN }, route(async (req, res) => {
    if (!await who(req, res)) return;
    const id = dimensionId(req);
    const version = versionOf(String(req.params.version ?? ''), 'path');
    if (!dims().get(id)) return void missing(res, id);
    const t = dims().template(id, version);
    if (!t) return void res.status(404).json({ error: 'report_template_missing', message: `维度 ${id} 没有第 ${version} 版模板` });
    res.json({ dimension_id: id, template: t });
  }));

  app.post('/api/report-dimensions', { action: 'report.dimension-set', kind: 'decide', statusNotVerdict: SET_SCOPED }, route(async (req, res) => {
    // 先认人，再核写法，最后按要建在哪个领域判（领域在请求体里）
    const w = await who(req, res);
    if (!w) return;
    const b = bodyOf(req);
    onlyKeys(b, ['id', 'title', 'area']);
    if (typeof b.id !== 'string' || !DIMENSION_ID_RE.test(b.id)) throw new HttpError(400, 'id 要是维度标识：小写字母开头的字母、数字、连字符，最多 48 个字符', { code: 'report_dimension_id_invalid' });
    if (typeof b.title !== 'string') throw new HttpError(400, 'title 要是维度名字（1～64 个字符）', { code: 'report_dimension_title_invalid' });
    if (b.area !== undefined && (typeof b.area !== 'string' || !AREA_ID_RE.test(b.area))) throw new HttpError(400, 'area 要是领域标识；跨领域的维度不写', { code: 'area_id_invalid' });
    const area = typeof b.area === 'string' ? b.area : null;
    if (!maySet(w, area)) return void forbidden(res, area);
    const r = dims().create({ id: b.id, title: b.title, area }, w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('create', { id: r.dimension.id, area }, w.actor.by);
    res.status(201).json({ dimension: r.dimension });
  }));

  app.post('/api/report-dimensions/:id/templates', { action: 'report.dimension-set', kind: 'decide', statusNotVerdict: SET_SCOPED }, route(async (req, res) => {
    const x = await existingSetter(req, res);
    if (!x) return;
    const b = bodyOf(req);
    onlyKeys(b, ['body', 'note', 'sha256']);
    if (b.sha256 !== undefined && typeof b.sha256 !== 'string') throw new HttpError(400, 'sha256 要是模板正文的十六进制摘要', { code: 'report_template_sha256_mismatch' });
    const note = noteOf(b, 'note');
    const r = dims().addTemplate(x.id, { body: b.body, note, sha256: typeof b.sha256 === 'string' ? b.sha256 : null }, x.w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('template-add', { id: x.id, version: r.template.version, kind: r.template.kind, sha256: r.template.sha256 }, x.w.actor.by);
    res.status(201).json({ template: r.template });
  }));

  app.post('/api/report-dimensions/:id/templates/:version/review', { action: 'report.dimension-set', kind: 'decide', statusNotVerdict: SET_SCOPED }, route(async (req, res) => {
    const x = await existingSetter(req, res);
    if (!x) return;
    const b = bodyOf(req);
    onlyKeys(b, ['note']);
    const note = noteOf(b, 'note');
    const version = versionOf(String(req.params.version ?? ''), 'path');
    const r = dims().review(x.id, version, note, x.w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('template-review', { id: x.id, version }, x.w.actor.by);
    res.json({ template: r.template });
  }));

  app.post('/api/report-dimensions/:id/activate', { action: 'report.dimension-set', kind: 'decide', statusNotVerdict: SET_SCOPED }, route(async (req, res) => {
    const x = await existingSetter(req, res);
    if (!x) return;
    const b = bodyOf(req);
    onlyKeys(b, ['version']);
    const version = versionOf(b.version, 'body');
    const r = dims().activate(x.id, version, x.w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('activate', { id: x.id, version }, x.w.actor.by);
    res.json({ dimension: r.dimension });
  }));

  app.post('/api/report-dimensions/:id/retire', { action: 'report.dimension-set', kind: 'decide', statusNotVerdict: SET_SCOPED }, route(async (req, res) => {
    const x = await existingSetter(req, res);
    if (!x) return;
    const b = bodyOf(req);
    onlyKeys(b, ['reason']);
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) throw new HttpError(400, 'reason 要是不超过 200 个字符的字符串', { code: 'reason_invalid' });
    const r = dims().retire(x.id, typeof b.reason === 'string' ? b.reason : '', x.w.actor, Date.now());
    if (!r.ok) return void refused(res, r);
    logged('retire', { id: x.id }, x.w.actor.by);
    res.json({ dimension: r.dimension });
  }));
}
