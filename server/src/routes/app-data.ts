/**
 * 自产台的数据与文件：/api/apps/:slug/data（提交、列表、软删）和 /api/apps/:slug/files（上传、列表、改备注、下载、软删）。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。台的登记与生命周期在 apps.ts。
 *
 * 八条在 index.ts 里分七段，中间只夹着分页参数、数据契约、上传落盘与类型核对这些函数和常量，没有别的路由或中间件，
 * 在原来最后一段（下载）的位置注册，路由的挂载顺序不变。
 * 提交数据和上传文件不经写总门（台的匿名提交面）；删数据、改备注、删文件有管理员守卫。
 * 读（数据列表、文件列表、下载）要本台的台令牌（X-App-Token，属于路径里的台）、管理员（口令或管理员登录，同源）或本机命令行；
 * 下载另认登录门签给本台页面的查看凭证（wm_av，沙箱页的下载链接和图片带不了头）。都不满足 403，先于查台，台在不在应答一样。
 * WM_APP_DATA_READ=warn 时照旧放行，只按路由和调用方类别计数、留痕（上线过渡用）。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里还在用的（数据写入核心和文件入库核心也给 MCP 工具用）经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type multer from 'multer';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { dataDir, type AppRow } from '../db.ts';
import type { AppDataService } from '../services/app-data.ts';
import { HttpError } from '../errors.ts';
import { hasLoginCredential } from '../request-person.ts';

/** 读台数据与附件的守卫模式：enforce 拒绝（缺省），warn 只告警计数（上线过渡） */
export type AppDataReadMode = 'enforce' | 'warn';
/** 启动时读一次 WM_APP_DATA_READ：没设或空是 enforce，别的值抛错（装配方拒绝启动） */
export function appDataReadMode(raw: string | undefined): AppDataReadMode {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'enforce') return 'enforce';
  if (v === 'warn') return 'warn';
  throw new Error(`WM_APP_DATA_READ 只能是 enforce 或 warn（缺省 enforce），现在是 ${JSON.stringify(v)}`);
}

/** 读守卫要用的判定，由装配方给（台令牌、管理员认定、本机命令行、登录门的查看凭证都在 index.ts / login-gate.ts） */
export interface AppDataReadDeps {
  mode: AppDataReadMode;
  /** 带来的台令牌是不是这个台的（常量时间比较） */
  appTokenOk: (slug: string, presented: string) => boolean;
  /** 管理员：口令或管理员登录，且同源（会先做管理员认定） */
  adminOk: (req: express.Request) => Promise<boolean>;
  /** 本机命令行：回环直连、不带浏览器标记、没有反代头 */
  cliOk: (req: express.Request) => boolean;
  /** 登录门签给这个台的页面的查看凭证（只认下载） */
  viewCapOk: (slug: string, cap: string) => boolean;
}

/** 告警模式的计数：按路由 × 调用方类别。不记正文、不记凭据 */
const warnCounts = new Map<string, number>();
export function appDataReadWarnCounts(): Record<string, number> { return Object.fromEntries(warnCounts); }

const READ_DENIED = { error: 'app_read_denied', message: '读台的数据和附件要本台的台令牌、管理员或本机命令行' };

type AppFileInput = { path: string; size: number; name: string; reportedMime: string; createdBy: string; note: string; sha256?: string };

/** 从 index.ts 传进来的：台的查找、数据写入核心（MCP app_data_submit 也用）、分页参数、文件容量、上传中间件、文件名修复、文件入库核心（MCP 上传也用）、守卫。 */
export interface AppDataDeps {
  getApp: (slug: string) => AppRow;
  submitAppData: (a: AppRow, input: { data: unknown; createdBy?: unknown; idempotencyKey?: unknown; submitterTicket?: unknown; subject?: string; channel: { name: 'app-data.rest' | 'app-data.tool'; hasCredential: boolean } }) => { status: number; body: Record<string, unknown> };
  pageLimit: (v: unknown, def?: number, max?: number) => number;
  pageBeforeId: (v: unknown) => number;
  appFilesQuota: (slug: string) => { files_used: number; files_max: number; files_left: number; max_file_bytes: number; mcp_max_base64_chars: number };
  APP_FILES_MAX: number;
  upload: multer.Multer;
  fixFileName: (s: string) => string;
  appFileStoreCore: (slug: string, f: AppFileInput) => object;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  bad: (msg: string) => never;
  read: AppDataReadDeps;
}

export function registerAppDataRoutes(app: HttpService, deps: AppDataDeps): void {
  const { getApp, submitAppData, pageLimit, pageBeforeId, appFilesQuota, APP_FILES_MAX, upload, fixFileName, appFileStoreCore, adminGuard, bad, read } = deps;

  /** 读守卫：先于查台。放行返回 true；拒绝时已回 403 */
  async function readAllowed(req: express.Request, res: express.Response, route: string, download: boolean): Promise<boolean> {
    const slug = String(req.params.slug ?? '');
    const presented = req.headers['x-app-token'];
    const token = typeof presented === 'string' ? presented.trim() : '';
    if (token && read.appTokenOk(slug, token)) return true;
    if (read.cliOk(req)) return true;
    if (download && typeof req.query.wm_av === 'string' && read.viewCapOk(slug, req.query.wm_av)) return true;
    if (await read.adminOk(req)) return true;
    // 拒绝或告警：调用方类别只分这几种，不记凭据本身
    const caller = token ? 'other-token' : req.headers['x-admin-token'] !== undefined ? 'admin-token-rejected' : hasLoginCredential(req) ? 'login-not-admin' : 'anonymous';
    if (read.mode === 'warn') {
      const key = `${route}|${caller}`;
      const n = (warnCounts.get(key) ?? 0) + 1;
      warnCounts.set(key, n);
      if (n === 1 || n % 100 === 0) console.warn(JSON.stringify({ source: 'app-data-read', event: 'would-deny', route, caller, count: n, at: new Date().toISOString() }));
      return true;
    }
    res.status(403).set('Cache-Control', 'no-store').json(READ_DENIED);
    return false;
  }
  /** 读路由：先过守卫再执行；处理函数里抛的错交给统一出口 */
  /** 台数据与附件的读：放不放行看台令牌（不是登录身份），401、403、200 都不拿来和统一判定比 */
  const APP_READ_DECIDES = '台数据与附件的读按台令牌或管理员判：带台令牌的匿名也能读，403 不是登录身份的结论';
  const guardedRead = (route: string, download: boolean, fn: express.RequestHandler): express.RequestHandler => (req, res, next) => {
    readAllowed(req, res, route, download).then((ok) => { if (ok) { try { fn(req, res, next); } catch (e) { next(e); } } }, next);
  };
  app.post('/api/apps/:slug/data', { action: 'app-data.submit', kind: 'write' }, (req, res) => {
    const a = getApp(req.params.slug);
    const b = req.body ?? {};
    // 兼容 {data: {...}} 或直接 {...} 两种形态；幂等键只认信封字段或 Idempotency-Key 头（直接形态的字段都算数据）
    const envelope = b.data !== undefined && b.data !== null;
    const out = submitAppData(a, {
      data: envelope ? b.data : b,
      createdBy: b.created_by,
      idempotencyKey: req.get('idempotency-key') ?? (envelope ? b.idempotency_key : undefined),
      // 8f-2：提交人票据只认信封字段（直接形态的字段都算数据）
      submitterTicket: envelope ? b.submitter_ticket : undefined,
      channel: { name: 'app-data.rest', hasCredential: hasLoginCredential(req) },
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/apps/:slug/data', { action: 'app-data.list', kind: 'read', statusNotVerdict: APP_READ_DECIDES }, guardedRead('GET /api/apps/:slug/data', false, (req, res) => {
    const a = getApp(req.params.slug);
    const limit = pageLimit(req.query.limit);
    const beforeId = pageBeforeId(req.query.before_id);
    const rows = beforeId > 0
      ? svc<AppDataService>('appData').dataPage(a.slug, beforeId, limit)
      : svc<AppDataService>('appData').dataPage(a.slug, 0, limit);
    const items = (rows as { id: number; data: string; created_by: string; created_at: string }[]).map((r) => ({
      id: r.id, data: JSON.parse(r.data || '{}'), created_by: r.created_by, created_at: r.created_at,
    }));
    const has_more = rows.length === limit;
    res.json({ slug: a.slug, items, count: items.length, has_more, next_before_id: has_more ? items[items.length - 1].id : null });
  }));

  app.post('/api/apps/:slug/files', { action: 'app-data.upload', kind: 'write' }, (req, res, next) => {
    try { getApp(req.params.slug); } catch (e) { return next(e); }
    // 先查文件数再收文件，满了不落盘
    if (appFilesQuota(req.params.slug).files_left <= 0) return res.status(413).json({ error: `该台文件数已达上限（${APP_FILES_MAX}）`, quota: appFilesQuota(req.params.slug) });
    upload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超 100MB 上限' });
        return res.status(400).json({ error: `上传失败：${err.message}` });
      }
      try {
        const a = getApp(req.params.slug);
        if (!req.file) bad('缺少 file 字段（multipart/form-data）');
        const created_by = typeof req.body?.created_by === 'string' ? req.body.created_by.trim().slice(0, 128) : '';
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
        res.status(201).json(appFileStoreCore(a.slug, { path: req.file.path, size: req.file.size, name: fixFileName(req.file.originalname), reportedMime: req.file.mimetype || '', createdBy: created_by, note }));
      } catch (e) {
        next(e);
      }
    });
  });

  app.get('/api/apps/:slug/files', { action: 'app-data.files', kind: 'read', statusNotVerdict: APP_READ_DECIDES }, guardedRead('GET /api/apps/:slug/files', false, (req, res) => {
    const a = getApp(req.params.slug);
    const limit = pageLimit(req.query.limit);
    const beforeId = pageBeforeId(req.query.before_id);
    const rows = beforeId > 0
      ? svc<AppDataService>('appData').filePage(a.slug, beforeId, limit)
      : svc<AppDataService>('appData').filePage(a.slug, 0, limit);
    const items = (rows as any[]).map((r) => ({ ...r, url: `/api/apps/${a.slug}/files/${r.id}` }));
    res.json({ slug: a.slug, items, count: items.length, has_more: rows.length === limit, next_before_id: rows.length === limit ? items[items.length - 1].id : null, quota: appFilesQuota(a.slug) });
  }));

  // #132 P0①：note 更新面（PATCH）
  app.patch('/api/apps/:slug/files/:id', { action: 'app-data.file-note', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return; // #193 F3：写面人审（读开放·写删人审）
    if (!adminGuard(req, res)) return; // #193 F3：写面人审（读开放·写删人审）
    const a = getApp(req.params.slug);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
    if (note === undefined) bad('note 必填（字符串）');
    const hit = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
    if (!hit) throw new HttpError(404, `file not found: ${req.params.id}`);
    svc<AppDataService>('appData').fileUpdateNote(Number(req.params.id), a.slug, note);
    res.json({ ok: true, id: Number(req.params.id), note });
  });

  // #132 P0③：软删面（deleted_at 置位·原行保审计·列表过滤）
  app.delete('/api/apps/:slug/files/:id', { action: 'app-data.file-delete', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return; // #193 F3
    if (!adminGuard(req, res)) return; // #193 F3
    const a = getApp(req.params.slug);
    const hit = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
    if (!hit) throw new HttpError(404, `file not found: ${req.params.id}`);
    const _fd = svc<AppDataService>('appData').fileSoftDelete(Number(req.params.id), a.slug) as { changes?: number };
    if (Number(_fd?.changes ?? 0) === 0) throw new HttpError(404, `file not found: ${req.params.id}`); // #193 F5：幂等假绿修（不存在→404）
    res.json({ ok: true, id: Number(req.params.id), deleted: 'soft' });
  });

  app.delete('/api/apps/:slug/data/:id', { action: 'app-data.delete', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return; // #193 F3
    if (!adminGuard(req, res)) return; // #193 F3
    const a = getApp(req.params.slug);
    const _dd = svc<AppDataService>('appData').dataSoftDelete(Number(req.params.id), a.slug) as { changes?: number };
    if (Number(_dd?.changes ?? 0) === 0) throw new HttpError(404, `data not found: ${req.params.id}`); // #193 F5
    res.json({ ok: true, id: Number(req.params.id), deleted: 'soft' });
  });

  app.get('/api/apps/:slug/files/:id', { action: 'app-data.download', kind: 'read', statusNotVerdict: APP_READ_DECIDES }, guardedRead('GET /api/apps/:slug/files/:id', true, (req, res) => {
    const a = getApp(req.params.slug);
    const row = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
    if (!row) throw new HttpError(404, `file not found: ${req.params.id}`);
    const abs = join(dataDir, row.storage_path);
    if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
    res.setHeader('content-type', row.mime || 'application/octet-stream');
    res.setHeader('content-length', String(row.size));
    // 附件下载语义（原始文件名）——inline 由 mime 决定，避免 XSS：非白名单 mime 强制 attachment
    const inlineOk = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/(plain|csv|markdown))$/.test(row.mime); // hotfix：effMime 未定义（#134 stash 舞连带残留）
    // #215 族修（属主实测「点下载变新标签页访问二进制」）：存储 mime 存错（xlsx 存 text/plain）时 inline 白名单误放——按扩展名强制 attachment
    // 仅二进制容器/归档扩展名强制 attachment（xlsx 存伪 mime 的 #215 防 XSS 线）；png/jpeg/webp/gif/pdf/csv 是 README 契约白名单 inline 面，不在此列
    const BIN_EXT = /\.(xlsx|xls|docx|doc|zip|rar|7z|gz|tar|7z|bz2|xz)$/i.test(row.original_name || '');
    const disp = (inlineOk && !BIN_EXT) ? 'inline' : 'attachment';
    res.setHeader('content-disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(row.original_name || 'file')}`);
    res.setHeader('x-content-type-options', 'nosniff');
    createReadStream(abs).pipe(res);
  }));
}
