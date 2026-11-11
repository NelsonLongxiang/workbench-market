/**
 * MCP 内嵌的 REST：OpenAPI 文档（/openapi.json 与 /api/mcp-rest/openapi.json）、工具调用、台文件的上传列表下载、台数据、SOP run 与附件。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。十一条在 index.ts 里分三段，中间只夹着资源接口用的常量和函数
 * （MCP_REST_BASE、会话与授权、审计、sha 缓存、二进制下载、run 读授权、id 参数），在原来最后一段（SOP run）的位置注册，路由的挂载顺序不变。
 * 认证是 MCP 会话令牌，授权映射到工具 grants；会话认定、工具执行、审计都留在 index.ts（/mcp 也用），经参数传进来。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type express from 'express';
import type multer from 'multer';
import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { dataDir, type AppRow, type SopRunRow } from '../db.ts';
import type { AppDataService } from '../services/app-data.ts';
import type { SopService } from '../services/sop.ts';
import { HttpError } from '../errors.ts';

type McpSess = { id: number; name: string; grants: string[] };
type McpChannel = 'mcp' | 'rest';
type AppFileInput = { path: string; size: number; name: string; reportedMime: string; createdBy: string; note: string; sha256?: string };

/** 从 index.ts 传进来的：异步包装、OpenAPI 的处理函数、会话认定与审计、工具名单与执行、入口地址、资源接口的会话授权与执行、
 *  台的查找与文件配额、上传的落盘位置与中间件、文件入库核心、sha256、二进制下载、run 的读授权、id 参数与读能力头。 */
export interface McpRestDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  serveMcpOpenApi: express.RequestHandler;
  mcpGatewaySession: (req: express.Request, res: express.Response) => McpSess | null | undefined;
  mcpAudit: (sess: McpSess | null, channel: McpChannel, method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown) => void;
  mcpRegisteredNames: () => Promise<Set<string>>;
  MCP_REST_DENIED_HINT: string;
  mcpInvokeTool: (sess: McpSess | null, toolName: string, args: any, channel: McpChannel, origin: string, t0?: number) => Promise<any>;
  mcpPublicOrigin: (req: express.Request) => string;
  mcpRestSession: (req: express.Request, res: express.Response, tool: string, op: string) => McpSess | null | undefined;
  mcpRestRun: (sess: McpSess | null, tool: string, op: string, auditArgs: unknown, fn: () => Promise<void> | void) => Promise<void>;
  bad: (msg: string) => never;
  getApp: (slug: string) => AppRow;
  appFilesQuota: (slug: string) => object & { files_left: number };
  APP_FILES_MAX: number;
  UPLOAD_MAX: number;
  uploadMonthDir: () => string;
  uploadFileName: (originalName: string) => string;
  appFileStoreCore: (slug: string, f: AppFileInput) => { id: number; url: string } & Record<string, unknown>;
  MCP_REST_BASE: string;
  upload: multer.Multer;
  fixFileName: (s: string) => string;
  fileSha256: (abs: string) => Promise<string>;
  sendStoredFile: (req: express.Request, res: express.Response, f: { abs: string; size: number; mime: string; name: string; sha256?: string; onSha?: (sha: string) => void }) => Promise<void>;
  restFileItem: (slug: string, r: any) => any;
  mcpRestRunReadable: (req: express.Request, sess: McpSess | null, runId: number) => Promise<boolean>;
  runIdParam: (v: unknown) => number;
  runReadCapHeader: (req: express.Request) => string | undefined;
  sopRunRow: (id: number) => SopRunRow;
}

export function registerMcpRestRoutes(app: HttpService, deps: McpRestDeps): void {
  const { wrap, serveMcpOpenApi, mcpGatewaySession, mcpAudit, mcpRegisteredNames, MCP_REST_DENIED_HINT, mcpInvokeTool, mcpPublicOrigin, mcpRestSession, mcpRestRun, bad, getApp, appFilesQuota, APP_FILES_MAX, UPLOAD_MAX, uploadMonthDir, uploadFileName, appFileStoreCore, MCP_REST_BASE, upload, fixFileName, fileSha256, sendStoredFile, restFileItem, mcpRestRunReadable, runIdParam, sopRunRow, runReadCapHeader } = deps;
  app.get('/openapi.json', { action: 'mcp-rest.openapi', kind: 'read' }, serveMcpOpenApi);
  app.get('/api/mcp-rest/openapi.json', { action: 'mcp-rest.openapi', kind: 'read' }, serveMcpOpenApi);
  app.post('/api/mcp-rest/tools/:name', { action: 'mcp-rest.tool-call', kind: 'write' }, wrap(async (req, res) => {
    const t0 = Date.now();
    const sess = mcpGatewaySession(req, res);
    if (sess === undefined) return;
    const toolName = req.params.name;
    const args = req.body === undefined ? {} : req.body;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      mcpAudit(sess, 'rest', 'tools/call', toolName, false, '请求体须为 JSON 对象', Date.now() - t0, null);
      throw new HttpError(400, '请求体须为 JSON 对象（即工具参数）');
    }
    if (!(await mcpRegisteredNames()).has(toolName)) {
      mcpAudit(sess, 'rest', 'tools/call', toolName, false, 'unknown tool', Date.now() - t0, args);
      throw new HttpError(404, `未知工具: ${toolName}`, { hint: MCP_REST_DENIED_HINT });
    }
    const r = await mcpInvokeTool(sess, toolName, args, 'rest', mcpPublicOrigin(req), t0);
    if (r.kind === 'not_granted') throw new HttpError(403, `会话未获授权调用 ${toolName}`, { hint: MCP_REST_DENIED_HINT });
    if (r.kind === 'ok') {
      // 上游工具自报 isError：工具级失败，按上游错误回 502，结果原样附上
      if (r.upstream && r.out && typeof r.out === 'object' && (r.out as any).isError === true) return res.status(502).json({ error: `上游工具 ${toolName} 执行失败`, result: r.out });
      return res.json(r.out ?? null);
    }
    // 本地工具错误走统一错误出口（HttpError 状态码 + 具名字段如 violations；校验类普通 Error → 400）；上游传输失败 → 502
    if (r.upstream && !(r.error instanceof HttpError)) return res.status(502).json({ error: String(r.error?.message ?? r.error).slice(0, 200) });
    throw r.error;
  }));

  // 上传（原始字节）：PUT /api/mcp-rest/apps/<slug>/files/<文件名>，请求体即文件内容，边收边算 sha256 边落盘，不整包进内存
  app.put('/api/mcp-rest/apps/:slug/files/:name', { action: 'mcp-rest.file-upload', kind: 'write' }, wrap(async (req, res) => {
    res.setHeader('connection', 'close'); // 提前拒绝（401/403/404/413）时不再读剩余请求体
    const sess = mcpRestSession(req, res, 'app_files_upload', 'file_upload');
    if (sess === undefined) return;
    const name = String(req.params.name ?? '').trim();
    const note = typeof req.query.note === 'string' ? req.query.note.trim().slice(0, 500) : '';
    const createdBy = typeof req.query.created_by === 'string' && req.query.created_by.trim() ? req.query.created_by.trim().slice(0, 128) : (sess ? `mcp:${sess.name}` : '');
    await mcpRestRun(sess, 'app_files_upload', 'file_upload', { slug: req.params.slug, name }, async () => {
      if (!name || name.length > 255 || name === '.' || name === '..' || /[\/\\\x00-\x1f]/.test(name)) bad('文件名不合法（≤255 字符，不含路径分隔符与控制字符）');
      const a = getApp(req.params.slug);
      if (appFilesQuota(a.slug).files_left <= 0) throw new HttpError(413, `该台文件数已达上限（${APP_FILES_MAX}）`, { quota: appFilesQuota(a.slug) });
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > UPLOAD_MAX) throw new HttpError(413, '文件超 100MB 上限');
      const abs = join(uploadMonthDir(), uploadFileName(name));
      const h = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > UPLOAD_MAX) return cb(new HttpError(413, '文件超 100MB 上限'));
          h.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(req, meter, createWriteStream(abs));
      } catch (e) {
        rmSync(abs, { force: true });
        if (e instanceof HttpError) throw e; // 超限
        throw new HttpError(400, `上传中断：${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      if (size === 0) { rmSync(abs, { force: true }); bad('请求体为空'); }
      const reported = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      const sha256 = h.digest('hex');
      const out = appFileStoreCore(a.slug, { path: abs, size, name, reportedMime: reported === 'application/octet-stream' ? '' : reported, createdBy, note, sha256 });
      res.status(201).json({ ...out, sha256, url: `${MCP_REST_BASE}/apps/${a.slug}/files/${out.id}`, download_url: out.url });
    });
  }));
  // 上传（multipart）：POST /api/mcp-rest/apps/<slug>/files，字段 file + 可选 note/created_by——与浏览器上传同一个 multer 与入库核心
  app.post('/api/mcp-rest/apps/:slug/files', { action: 'mcp-rest.file-upload', kind: 'write' }, wrap(async (req, res) => {
    res.setHeader('connection', 'close'); // 同上
    const sess = mcpRestSession(req, res, 'app_files_upload', 'file_upload');
    if (sess === undefined) return;
    await mcpRestRun(sess, 'app_files_upload', 'file_upload', { slug: req.params.slug }, async () => {
      const a = getApp(req.params.slug);
      if (appFilesQuota(a.slug).files_left <= 0) throw new HttpError(413, `该台文件数已达上限（${APP_FILES_MAX}）`, { quota: appFilesQuota(a.slug) });
      await new Promise<void>((resolve, reject) => upload.single('file')(req, res, (err: any) => {
        if (!err) return resolve();
        reject(err.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, '文件超 100MB 上限') : new HttpError(400, `上传失败：${err.message}`));
      }));
      if (!req.file) bad('缺少 file 字段（multipart/form-data）');
      const file = req.file!;
      const createdBy = typeof req.body?.created_by === 'string' && req.body.created_by.trim() ? req.body.created_by.trim().slice(0, 128) : (sess ? `mcp:${sess.name}` : '');
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      const sha256 = await fileSha256(file.path);
      const out = appFileStoreCore(a.slug, { path: file.path, size: file.size, name: fixFileName(file.originalname), reportedMime: file.mimetype || '', createdBy, note, sha256 });
      res.status(201).json({ ...out, sha256, url: `${MCP_REST_BASE}/apps/${a.slug}/files/${out.id}`, download_url: out.url });
    });
  }));
  // 列文件（倒序游标分页 + quota）：与 app_files_list 工具同一结果，url 指向 REST 下载
  app.get('/api/mcp-rest/apps/:slug/files', { action: 'mcp-rest.files', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'app_files_list', 'files_list');
    if (sess === undefined) return;
    const r = await mcpInvokeTool(sess, 'app_files_list', { slug: req.params.slug, limit: req.query.limit, before_id: req.query.before_id }, 'rest', mcpPublicOrigin(req));
    if (r.kind !== 'ok') throw (r as any).error ?? new HttpError(403, MCP_REST_DENIED_HINT);
    const out = r.out as { slug: string; items: any[] };
    res.json({ ...out, items: out.items.map((it) => ({ ...restFileItem(out.slug, it), download_url: it.url })) });
  }));
  // 下载：二进制 + Range + ETag(sha256)
  app.get('/api/mcp-rest/apps/:slug/files/:id', { action: 'mcp-rest.file-download', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'app_files_list', 'file_download');
    if (sess === undefined) return;
    await mcpRestRun(sess, 'app_files_list', 'file_download', { slug: req.params.slug, id: req.params.id }, async () => {
      const a = getApp(req.params.slug);
      const row = /^\d+$/.test(String(req.params.id)) ? svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any : null;
      if (!row) throw new HttpError(404, `file not found: ${req.params.id}`);
      await sendStoredFile(req, res, { abs: join(dataDir, row.storage_path), size: row.size, mime: row.mime, name: row.original_name, sha256: row.sha256,
        onSha: (sha) => svc<AppDataService>('appData').fileSetSha256(row.id, a.slug, sha) });
    });
  }));
  // 读台数据（倒序游标分页）：与 app_data_list 工具同一结果
  app.get('/api/mcp-rest/apps/:slug/data', { action: 'mcp-rest.data', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'app_data_list', 'data_list');
    if (sess === undefined) return;
    const r = await mcpInvokeTool(sess, 'app_data_list', { slug: req.params.slug, limit: req.query.limit, before_id: req.query.before_id }, 'rest', mcpPublicOrigin(req));
    if (r.kind !== 'ok') throw (r as any).error ?? new HttpError(403, MCP_REST_DENIED_HINT);
    res.json(r.out);
  }));

  // SOP run 元数据：与 sop_run_get 工具同一结果（未获 run 读授权时只有元数据）
  app.get('/api/mcp-rest/sop/runs/:id', { action: 'mcp-rest.sop-run', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'sop_run_get', 'sop_run_get');
    if (sess === undefined) return;
    const runId = runIdParam(req.params.id);
    const cap = runReadCapHeader(req);
    const r = await mcpInvokeTool(sess, 'sop_run_get', { run_id: runId, ...(cap ? { read_capability: cap } : {}) }, 'rest', mcpPublicOrigin(req));
    if (r.kind !== 'ok') throw (r as any).error ?? new HttpError(403, MCP_REST_DENIED_HINT);
    res.json(r.out);
  }));
  app.get('/api/mcp-rest/sop/runs/:id/files', { action: 'mcp-rest.sop-run-files', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'sop_run_get', 'sop_run_files');
    if (sess === undefined) return;
    const runId = runIdParam(req.params.id);
    await mcpRestRun(sess, 'sop_run_get', 'sop_run_files', { run_id: runId }, async () => {
      sopRunRow(runId); // 404 语义与 run 一致
      if (!(await mcpRestRunReadable(req, sess, runId))) throw new HttpError(403, 'run read authorization required', { hint: '会话需有该 run 的读授权（run grant），或带 X-Run-Read-Capability' });
      const items = (svc<SopService>('sop').runFiles(runId) as any[]).map((f) => ({ ...f, url: `${MCP_REST_BASE}/sop/runs/${runId}/files/${f.id}` }));
      res.json({ run_id: runId, items, count: items.length });
    });
  }));
  app.get('/api/mcp-rest/sop/runs/:id/files/:fileId', { action: 'mcp-rest.sop-run-file-download', kind: 'read' }, wrap(async (req, res) => {
    const sess = mcpRestSession(req, res, 'sop_run_get', 'sop_run_file_download');
    if (sess === undefined) return;
    const runId = runIdParam(req.params.id);
    await mcpRestRun(sess, 'sop_run_get', 'sop_run_file_download', { run_id: runId, file_id: req.params.fileId }, async () => {
      if (!(await mcpRestRunReadable(req, sess, runId))) throw new HttpError(403, 'run read authorization required', { hint: '会话需有该 run 的读授权（run grant），或带 X-Run-Read-Capability' });
      const row = /^\d+$/.test(String(req.params.fileId)) ? svc<SopService>('sop').runFileById(runId, Number(req.params.fileId)) as any : null;
      if (!row) throw new HttpError(404, `file not found: ${req.params.fileId}`);
      await sendStoredFile(req, res, { abs: join(dataDir, row.storage_path), size: row.size, mime: row.mime, name: row.original_name });
    });
  }));
}
