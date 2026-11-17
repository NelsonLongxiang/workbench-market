/**
 * SOP 台的路由：/api/sops 的列表、发布、废弃（状态机），和 SOP 交付空间的定义、治理时间线。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 它们在 index.ts 里分在两处：列表和状态机在「SOP 台」那一节（中间夹着状态机函数 sopTransition，MCP 的 sop_publish 也用，留在 index.ts），
 * 定义和时间线在后面很远的地方（中间隔着别的路由）。所以分两个注册函数，各在原来的位置调用，和别的路由的先后不变。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { AppService } from '../services/app.ts';
import type { SopService } from '../services/sop.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import type { AppRow } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { renderSopRunner } from '../sop-runner.ts';

type SopManifest = Parameters<typeof renderSopRunner>[0];

/** 列表和状态机从 index.ts 传进来的：台的详情、取台、跨源和管理员守卫、状态机（MCP 的 sop_publish 也用）。 */
export interface SopStateDeps {
  appDetail: (a: AppRow) => object;
  getApp: (slug: string) => AppRow;
  sameOriginGuard: (req: express.Request, res: express.Response) => boolean;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  sopTransition: (slug: string, from: string[], to: string, label: string) => AppRow;
}

/** 定义和时间线从 index.ts 传进来的：取台、管理口令的判定、400 的快捷写法、台文件的根目录、解析 sop.yaml。 */
export interface SopSpaceDeps {
  getApp: (slug: string) => AppRow;
  adminHeaderOk: (req: express.Request) => boolean;
  bad: (msg: string) => never;
  appsRoot: string;
  parseSopManifest: (yamlText: string) => SopManifest;
}

export function registerSopStateRoutes(app: HttpService, deps: SopStateDeps): void {
  const { appDetail, getApp, sameOriginGuard, adminGuard, sopTransition } = deps;
  app.get('/api/sops', { action: 'sop.list', kind: 'read' }, (_req, res) => {
    const rows = svc<AppService>('app').sops() as unknown as AppRow[];
    res.json(rows.map(appDetail));
  });

  app.post('/api/sops/:slug/publish', { action: 'sop.publish', kind: 'admin', refine: [{ action: 'sop.publish-task-center', kind: 'admin', why: '任务中心这个 SOP 台的发布要管理员（别的只过写请求总门）', when: (req) => req.params.slug === 'task-center' }] }, (req, res) => {
    if (req.params.slug === 'task-center') {
      if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
      if (!adminGuard(req,res)) return;
    }
    const a = sopTransition(req.params.slug, ['draft', 'deprecated'], 'published', '发布');
    // publish 附带发布说明（可选）记入当前版本 changelog 末尾
    if (typeof req.body?.note === 'string' && req.body.note.trim()) {
      svc<AppService>('app').appendChangelog(a.id, a.active_version, `\n[publish] ${req.body.note.trim()}`);
    }
    res.json(appDetail(getApp(a.slug)));
  });

  app.post('/api/sops/:slug/deprecate', { action: 'sop.deprecate', kind: 'admin', refine: [{ action: 'sop.deprecate-task-center', kind: 'admin', why: '任务中心这个 SOP 台的下架要管理员（别的只过写请求总门）', when: (req) => req.params.slug === 'task-center' }] }, (req, res) => {
    if (req.params.slug === 'task-center') {
      if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
      if (!adminGuard(req,res)) return;
    }
    const a = sopTransition(req.params.slug, ['published'], 'deprecated', '废弃');
    // 废弃不入册删除：历史 run 仍可回放；市场行禁用（enabled=0）
    svc<WorkbenchService>('workbench').setEnabledByUrl(0, `/sop/${a.slug}/`);
    res.json(appDetail(getApp(a.slug)));
  });
}

export function registerSopSpaceRoutes(app: HttpService, deps: SopSpaceDeps): void {
  const { getApp, adminHeaderOk, bad, appsRoot, parseSopManifest } = deps;
  // #19②b 裁 A（direct-2ff2ed21）：治理时间线——版本链+run 历史+验收链三合一面（轻内嵌）
  /** #318 SOP 交付空间「定义」与单次记录的步骤骨架：只回步骤 key / 标题，不回步骤正文 HTML。
   *  可见性同 Runner（issue #11）：published 公开；draft / deprecated 只给管理员。
   *  ?version=N 读该版本（单次记录按 run 的 sop_version 取）；版本目录已冷存时 404，不猜。 */
  app.get('/api/sops/:slug/definition', { action: 'sop.definition', kind: 'read', statusNotVerdict: '按资源状态：草稿、已下架的定义只给管理员看，别人 403' }, (req, res) => {
    const a = getApp(req.params.slug);
    if (a.kind !== 'sop') throw new HttpError(404, `SOP not found: ${req.params.slug}`);
    if (a.status !== 'published' && !adminHeaderOk(req)) return res.status(403).set('Cache-Control', 'no-store').json({ error: `SOP ${a.slug} 状态为 ${a.status}，定义仅管理员可见` });
    const raw = req.query.version;
    const version = raw === undefined || raw === '' ? a.active_version : Number(raw);
    if (!Number.isInteger(version) || version < 1) bad('version 必须是正整数');
    if (!svc<AppService>('app').versionExists(a.id, version)) throw new HttpError(404, `版本不存在: v${version}`);
    const yamlPath = join(appsRoot, a.slug, `v${version}`, 'sop.yaml');
    if (!existsSync(yamlPath)) return res.status(404).json({ error: `v${version} 未物化（冷版本），无法读取步骤定义`, code: 'version_not_materialized' });
    const m = parseSopManifest(readFileSync(yamlPath, 'utf8'));
    res.json({ slug: a.slug, version, active_version: a.active_version, status: a.status, title: m.title, code: m.code ?? a.code ?? '', description: m.description ?? '', steps: m.steps.map(({ key, title }) => ({ key, title })) });
  });

  app.get('/api/sops/:slug/timeline', { action: 'sop.timeline', kind: 'read' }, (req, res) => {
    const a = getApp(req.params.slug);
    if (a.kind !== 'sop') throw new HttpError(404, `SOP not found: ${req.params.slug}`);
    const versions = (svc<AppService>('app').versionLog(a.id) as Array<{ version: number; changelog: string; created_by: string; created_at: string }>).map(v => ({ ...v, changelog: (v.changelog || '').slice(0, 200) }));
    const runs = (svc<SopService>('sop').runsBySlug(a.slug) as unknown as Array<{ id: number; status: string; started_by: string; started_at: string; finished_at: string }>).slice(0, 50).map(r => ({ id: r.id, status: r.status, started_by: r.started_by, started_at: r.started_at, finished_at: r.finished_at }));
    const receipts = (svc<SopService>('sop').receiptsBySlug(a.slug) as Array<{ task_id: string; caller: string; receipt_status: string; run_id: number }>).map(r => ({ task_id: r.task_id, caller: r.caller, receipt_status: r.receipt_status || 'pending', run_id: r.run_id }));
    res.json({ slug: a.slug, versions, runs, receipts });
  });
}
