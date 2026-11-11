/**
 * 自产台与 SOP 台的登记和生命周期：/api/apps 的列表、单个台、task-center 直接发布、从 GitHub 同步、迁进 LayerFS、切活跃版本（回滚）、删台。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。台的数据与文件（/api/apps/:slug/data、/files）另成一域。
 *
 * 在 index.ts 里分两处注册，各在原来的位置调用：前五条中间只夹着函数和常量，在原来最后一条（GET /api/apps/:slug）的位置注册；
 * 回滚和删台在人审变更请求的路由（registerChangeRequestRoutes）之后，单独一个注册函数，在原来删台的位置注册。路由的挂载顺序不变。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由、MCP 工具也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 * 认人只经 isAdmin、adminGuard、adminTokenCheck（index.ts 里经身份服务实现），这里不碰登录提供方。
 */
import type express from 'express';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { AppRow } from '../db.ts';
import type { AppService } from '../services/app.ts';

type Guard = (req: express.Request, res: express.Response) => boolean;
type Wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
type AppFile = { path: string; content: string };

/** 从 index.ts 传进来的：台的详情和查找、直接发布已关的提示、守卫和认人、60 秒发布锁、发布与同步的执行体（MCP 工具也用）、台文件的根目录、LayerFS 的几个函数。 */
export interface AppDeps {
  appDetail: (a: AppRow) => object;
  getApp: (slug: string) => AppRow;
  DIRECT_PUBLISH_CLOSED: string;
  sameOriginGuard: Guard;
  adminGuard: Guard;
  adminTokenCheck: (provided: string | undefined) => boolean;
  publishLockGuard: (slug: string, who: string, force: boolean) => { ok: true } | { ok: false; hint: string };
  publishAppBody: (b: any, source?: { repo: string; path: string; commit: string }) => { status: number; body: object };
  wrap: Wrap;
  isAdmin: (req: express.Request) => boolean;
  syncAppFromGithub: (slug: string, b: any, who: string) => Promise<{ status: number; body: object }>;
  appsRoot: string;
  layerfsReservedSlug: (slug: string) => boolean;
  layerfsPublish: (project: string, files: AppFile[], message: string, branch?: string) => Promise<{ commit_id: string; changed: boolean } | null>;
  layerfsProjectName: (slug: string) => string;
  layerfsServiceBase: () => { base: string; token: string };
}

/** 回滚和删台用的：守卫、异步包装、400 的快捷写法、回滚和删台的执行体（人审批准和 MCP 也用）。 */
export interface AppLifecycleDeps {
  sameOriginGuard: Guard;
  adminGuard: Guard;
  wrap: Wrap;
  bad: (msg: string) => never;
  activateAppVersion: (slug: string, vRaw: unknown) => Promise<object>;
  deleteAppCascade: (slug: string) => Promise<void>;
}

export function registerAppRoutes(app: HttpService, deps: AppDeps): void {
  const { appDetail, getApp, DIRECT_PUBLISH_CLOSED, sameOriginGuard, adminGuard, adminTokenCheck, publishLockGuard, publishAppBody, wrap, isAdmin, syncAppFromGithub, appsRoot, layerfsReservedSlug, layerfsPublish, layerfsProjectName, layerfsServiceBase } = deps;
  app.get('/api/apps', { action: 'app.list', kind: 'read' }, (_req, res) => {
    // /api/apps = 全部台（app+sop）；/api/sops 才是 kind='sop' 过滤——S2 批量替换期间两口径装反过一次
    const rows = svc<AppService>('app').all() as unknown as AppRow[];
    res.json(rows.map(appDetail));
  });

  app.post('/api/apps', { action: 'app.publish', kind: 'admin' }, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (String(b.slug ?? '').trim().toLowerCase() !== 'task-center') return res.status(410).json({ error: DIRECT_PUBLISH_CLOSED });
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
    // #165 回归修（E2E 红）：锁身份=客户端会话（X-Market-Client/admin 摘要），**不用 created_by**（元数据·同操作者带/不带误判两会话→合法发布 409）
    const who = String(req.headers['x-market-client'] ?? '').trim() || (adminTokenCheck(req.headers['x-admin-token']) ? 'admin-session' : 'loopback-anon');
    const gate = publishLockGuard('task-center', who, b.force === true || b.force === 'true');
    if (!gate.ok) return res.status(409).json({ error: gate.hint });
    const r = publishAppBody(b);
    res.status(r.status).json(r.body);
  });

  // 写总门已把关：本机 CLI 或管理员（口令 / Odoo 管理员），与原 POST /api/apps 同口径
  app.post('/api/apps/:slug/sync', { action: 'app.sync', kind: 'admin', statusNotVerdict: '任务中心元台不从仓库同步时回 403，是台的规则不是授权' }, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // #165：锁身份=客户端会话，不用 created_by（元数据·同操作者带/不带会被当成两个会话误报 409）
    const who = String(req.headers['x-market-client'] ?? '').trim() || (isAdmin(req) ? 'admin-session' : 'loopback-anon');
    const slug = String(req.params.slug ?? '').trim().toLowerCase();
    const gate = publishLockGuard(slug, who, b.force === true);
    if (!gate.ok) return res.status(409).json({ error: gate.hint });
    const r = await syncAppFromGithub(slug, b, who);
    res.status(r.status).json(r.body);
  }));

  // #94 P1 迁移端点：现有版本依次导成该台项目的 Commit（三门禁复验·异常留档·幂等·sha256 对账）
  app.post('/api/apps/:slug/migrate-layerfs', { action: 'app.migrate', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const a = getApp(req.params.slug);
    const vs = svc<AppService>('app').versions(a.id) as any[];
    const results: any[] = [];
    let prevBytes = 0;
    for (const v of vs.sort((x: any, y: any) => x.version - y.version)) {
      const dir = join(appsRoot, a.slug, `v${v.version}`);
      if (!existsSync(dir)) { results.push({ version: v.version, result: 'anomaly', reason: '物化目录缺失' }); continue; }
      // 读物化文件
      const files: { path: string; content: string }[] = [];
      (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(dir);
      // 三门禁复验（评审席复查裁定）
      if (files.some((f) => f.content === '')) { results.push({ version: v.version, result: 'anomaly', reason: '空 content（门禁复验拒迁·留档）' }); prevBytes = v.total_bytes; continue; }
      if (prevBytes > 0 && v.total_bytes < prevBytes * 0.5) { results.push({ version: v.version, result: 'anomaly', reason: `体积骤降（${prevBytes}→${v.total_bytes}·>50%·门禁拒迁）` }); prevBytes = v.total_bytes; continue; }
      const html = files.filter((f) => /\.html?$/.test(f.path));
      for (const h of html) {
        const open = (h.content.match(/<div/g) ?? []).length; const close = (h.content.match(/<\/div>/g) ?? []).length;
        if (open !== close) { results.push({ version: v.version, result: 'anomaly', reason: `div 配对失败（${open}开/${close}闭）` }); break; }
      }
      if (results.at(-1)?.version === v.version && results.at(-1)?.result === 'anomaly') { prevBytes = v.total_bytes; continue; }
      // 幂等：已有 commit_id 跳过
      if (v.commit_id) { results.push({ version: v.version, result: 'skip', commit_id: v.commit_id }); prevBytes = v.total_bytes; continue; }
      if (layerfsReservedSlug(a.slug)) { results.push({ version: v.version, result: 'error', reason: 'slug 是系统保留名，不迁入 LayerFS' }); continue; }
      const out = await layerfsPublish(layerfsProjectName(a.slug), files, `[migrate] v${v.version}`);
      if (!out) { svc<AppService>('app').versionMigrateFailed(v.id); results.push({ version: v.version, result: 'error', reason: 'layerfs 服务不可达（影子失败语义·可重跑）' }); prevBytes = v.total_bytes; continue; }
      svc<AppService>('app').versionMigrated(out.commit_id, v.id);
      svc<AppService>('app').setLayerfsProject(a.slug, a.slug);
      // sha256 对账（物化 vs 服务 commit——经服务回读）
      const { base, token } = layerfsServiceBase();
      let shaMatch = false;
      try {
        const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(a.slug)) + '/branches/release/commits/' + encodeURIComponent(out.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const fj = await fr.json() as { files: { path: string; content: string }[] };
        const { createHash: ch } = await import('node:crypto');
        const h1 = ch('sha256').update(JSON.stringify(files.map((f) => [f.path, ch('sha256').update(f.content, 'utf8').digest('hex')]))).digest('hex');
        const h2 = ch('sha256').update(JSON.stringify(fj.files.map((f) => [f.path, ch('sha256').update(f.content, 'utf8').digest('hex')]))).digest('hex');
        shaMatch = h1 === h2;
      } catch { shaMatch = false; }
      results.push({ version: v.version, result: 'migrated', commit_id: out.commit_id, changed: out.changed, sha256_match: shaMatch });
      prevBytes = v.total_bytes;
    }
    res.json({ slug: a.slug, layerfs_project: a.slug, results });
  }));

  app.get('/api/apps/:slug', { action: 'app.read', kind: 'read' }, (req, res) => {
    res.json(appDetail(getApp(req.params.slug)));
  });
}

export function registerAppLifecycleRoutes(app: HttpService, deps: AppLifecycleDeps): void {
  const { sameOriginGuard, adminGuard, wrap, bad, activateAppVersion, deleteAppCascade } = deps;
  app.post('/api/apps/:slug/activate', { action: 'app.rollback', kind: 'admin', refine: [{ action: 'app.rollback-task-center', kind: 'admin', why: '任务中心元台切版本要管理员（别的台只过写请求总门）', when: (req) => req.params.slug === 'task-center' }] }, wrap(async (req, res) => {
    if (req.params.slug === 'task-center') {
      if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
      if (!adminGuard(req,res)) return;
    }
    // #94 v3 S1（L14）：回滚经人审——一步式=口令+reviewed_by（缺 reviewed_by 不执行）
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('回滚需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
    const out = await activateAppVersion(req.params.slug, req.body?.version);
    res.json({ ...out, reviewed_by: reviewedBy });
  }));

  app.delete('/api/apps/:slug', { action: 'app.delete', kind: 'admin', refine: [{ action: 'app.delete-task-center', kind: 'admin', why: '删任务中心元台要管理员（别的台只过写请求总门）', when: (req) => req.params.slug === 'task-center' }] }, wrap(async (req, res) => {
    if (req.params.slug === 'task-center') {
      if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
      if (!adminGuard(req,res)) return;
    }
    // #94 v3 S1（L14）：删除经人审——一步式=口令+reviewed_by
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('删除需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
    await deleteAppCascade(req.params.slug);
    res.json({ ok: true, deleted: req.params.slug, reviewed_by: reviewedBy });
  }));
}
