/**
 * SOP run 的交付文件：上传、列表、下载、引用已有文件。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。四条在 index.ts 里连在一起，在原来最后一条（下载）的位置注册。
 * 读授权（authorizeRunRead）在 sop-read-auth.ts，这里直接引入；写入门、配额、上传中间件、文件 sha 补算留在 index.ts（MCP 也用），经参数传进来。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里还在用的经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type multer from 'multer';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join, sep as pathSep } from 'node:path';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { dataDir, type SopRunRow } from '../db.ts';
import type { SopService } from '../services/sop.ts';
import { HttpError } from '../errors.ts';
import { authorizeRunRead } from '../sop-read-auth.ts';
import type { Sniff } from '../file-sniff.ts';

type RunFileQuota = { upload_count: number; upload_bytes: number; upload_max_count: number; upload_max_bytes: number; upload_left_count: number; upload_left_bytes: number; ref_count: number; ref_max_count: number; ref_left_count: number };

/** 从 index.ts 传进来的：异步包装、Odoo 管理员认定、写入门、按 id 取 run、管理员头、读能力头、400 的快捷写法、几个上限、配额、上传中间件、文件名修复、按内容核类型、sha256、旧文件补算 sha。 */
export interface SopRunFilesDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  markOdooAdmin: (req: express.Request) => Promise<void>;
  runFileWriteGate: (req: express.Request, runId: number) => void;
  sopRunRow: (id: number) => SopRunRow;
  adminHeaderOk: (req: express.Request) => boolean;
  runReadCapHeader: (req: express.Request) => string | undefined;
  bad: (msg: string) => never;
  RUN_REF_BATCH_MAX: number;
  RUN_REF_MAX_COUNT: number;
  RUN_UPLOAD_MAX_COUNT: number;
  RUN_UPLOAD_MAX_BYTES: number;
  runFileQuota: (runId: number) => RunFileQuota;
  runUpload: multer.Multer;
  fixFileName: (s: string) => string;
  checkUploadKind: (res: express.Response, file: Express.Multer.File, name: string) => Sniff | null;
  sha256Hex: (s: string) => string;
  ensureRunFileSha: (f: { storage_path: string; sha256?: string }) => Promise<string>;
}

export function registerSopRunFileRoutes(app: HttpService, deps: SopRunFilesDeps): void {
  const { wrap, markOdooAdmin, runFileWriteGate, sopRunRow, adminHeaderOk, runReadCapHeader, bad, RUN_REF_BATCH_MAX, RUN_REF_MAX_COUNT, RUN_UPLOAD_MAX_COUNT, RUN_UPLOAD_MAX_BYTES, runFileQuota, runUpload, fixFileName, checkUploadKind, sha256Hex, ensureRunFileSha } = deps;
  /** 引用已有文件：同一 SOP 其他 run 的文件（按 run_id+file_id，要带源 run 的读凭证；管理员免），或按 sha256 找同 SOP 里已上传的同内容文件（只限管理员）。
   *  逐条给结果（linked / duplicate / failed + 原因），失败的不影响已成功的；引用行与源文件共用一份存储，不占上传配额。 */
  app.post('/api/sop/runs/:id(\\d+)/files/refs', { action: 'sop-run.file-refs', kind: 'write' }, wrap(async (req, res) => {
    const runId = Number(req.params.id);
    await markOdooAdmin(req);
    runFileWriteGate(req, runId);
    const target = sopRunRow(runId);
    // 先核目标 run 的读授权：结果会回显文件名（duplicate / linked），没有读权的人不能借引用逐个试出本 run 的文件（执行页本就持有自己 run 的读能力）
    const admin = adminHeaderOk(req);
    const targetAuth = await authorizeRunRead({ adminOk: admin, cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, runId);
    if (!targetAuth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required', hint: '带上本 run 的 X-Run-Read-Capability，或已授权会话、管理员' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) bad('items 必须是非空数组：[{ run_id, file_id, read_capability? } | { sha256 }]');
    if (items.length > RUN_REF_BATCH_MAX) bad(`单次最多 ${RUN_REF_BATCH_MAX} 条，请分批关联`);
    const createdBy = typeof req.body?.created_by === 'string' ? req.body.created_by.trim().slice(0, 128) : '';
    const results: { index: number; status: 'linked' | 'duplicate' | 'failed'; id?: number; source_file_id?: number; name?: string; reason?: string }[] = [];
    for (const [index, it] of items.entries()) {
      try {
        let src: any;
        if (it && typeof it.sha256 === 'string') {
          if (!admin) throw new HttpError(403, '按 sha256 引用只限管理员');
          if (!/^[0-9a-f]{64}$/.test(it.sha256)) throw new HttpError(400, 'sha256 须为 64 位小写十六进制');
          src = svc<SopService>('sop').runFileBySha(target.sop_slug, it.sha256);
          if (!src) throw new HttpError(404, '同一 SOP 里没有这个 sha256 的已上传文件');
        } else {
          const sr = Number(it?.run_id), sf = Number(it?.file_id);
          if (!Number.isInteger(sr) || !Number.isInteger(sf) || sr <= 0 || sf <= 0) throw new HttpError(400, '需要 run_id 与 file_id（正整数），或 sha256');
          // 先核源 run 读授权，再查文件：不让无权者借 404 / 403 判断某文件属不属于那个 run（本 run 已在请求开头核过）
          if (sr !== runId) {
            const auth = await authorizeRunRead({ adminOk: admin, cap: typeof it.read_capability === 'string' ? it.read_capability : '', cookieHeader: req.headers.cookie }, sr);
            if (!auth.authorized) throw new HttpError(403, `没有 run ${sr} 的读授权（带上它的 read_capability）`);
          }
          src = svc<SopService>('sop').runFileWithRun(sf);
          if (!src || src.run_id !== sr) throw new HttpError(404, `run ${sr} 里没有文件 ${sf}`);
          if (src.sop_slug !== target.sop_slug) throw new HttpError(403, '只能引用同一 SOP 的文件');
        }
        const rootId = Number(src.ref_of) || Number(src.id);
        const have = (svc<SopService>('sop').runFiles(runId) as { id: number; ref_of: number }[]).find((f) => f.id === rootId || f.ref_of === rootId);
        if (have) { results.push({ index, status: 'duplicate', id: have.id, source_file_id: rootId, name: src.original_name }); continue; }
        if (runFileQuota(runId).ref_left_count <= 0) throw new HttpError(413, `该 run 引用数已达上限（${RUN_REF_MAX_COUNT}）`);
        if (!existsSync(join(dataDir, src.storage_path))) throw new HttpError(410, '源文件已不在存储里');
        const r = svc<SopService>('sop').runFileInsert({ runId, name: src.original_name, mime: src.mime, size: src.size, storagePath: src.storage_path, createdBy, sha256: src.sha256 || '', refOf: rootId }) as unknown as { lastInsertRowid: number | bigint };
        try { svc<SopService>('sop').runFileAudit(runId, src.original_name, src.size, src.sha256 || '', `ref:${rootId}`); } catch { /* 审计失败不阻 */ }
        results.push({ index, status: 'linked', id: Number(r.lastInsertRowid), source_file_id: rootId, name: src.original_name });
      } catch (e) {
        results.push({ index, status: 'failed', reason: e instanceof HttpError ? e.message : '关联失败' });
      }
    }
    const linked = results.filter((x) => x.status !== 'failed').length;
    res.status(linked ? 200 : 422).json({ run_id: runId, results, linked, failed: results.length - linked, quota: runFileQuota(runId) });
  }));

  app.post('/api/sop/runs/:id/files', { action: 'sop-run.file-upload', kind: 'write' }, (req, res, next) => {
    // ── P0 安全（总工 direct-c2b55f91）：上传面鉴权三件 ──
    // ①run-scoped upload token（header X-Run-Upload-Token；admin 口令=人工作业一步式）
    // ②配额（数≤20·单≤100MB[multer]·总量≤200MB→413）③写审计（sop_run_file_audit 同链）
    try {
      if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
      const row = sopRunRow(Number(req.params.id));
      if (row.status !== 'running') throw new HttpError(409, `run ${req.params.id} 已 ${row.status}，不可再上传`);
      // #150 开关（属主反馈·业务直传恢复）：settings run_upload_require_token='1' 才要令牌；缺省关闭=旧 T1 直传语义
      const strict = (() => { try { const r = svc<SopService>('sop').runUploadRequireToken() as { value?: string } | undefined; return String(r?.value ?? '') === '1'; } catch { return false; } })();
      const adminOk = adminHeaderOk(req);
      if (strict && !adminOk) { // #150 开关：严格模式才要令牌（缺省=旧 T1 直传）
        const presented = String(req.headers['x-run-upload-token'] ?? '').trim();
        const expected = String((row as any).upload_token ?? '');
        if (!expected) throw new HttpError(403, '该 run 无上传令牌（旧 run 上传面已关闭）');
        if (!presented) throw new HttpError(401, '缺少 X-Run-Upload-Token（Runner 页内嵌令牌·人工作业用 admin 口令）');   // T023 修订签 A1：缺令牌=401（错令牌=403·白名单外=400）
        if (presented !== expected) throw new HttpError(403, '上传令牌不符（run 不匹配或已过期）');
      }
      // 配额只算本 run 自己上传的；引用已有文件（ref_of）不另占存储，单独限数
      const q = runFileQuota(Number(req.params.id));
      if (q.upload_count >= RUN_UPLOAD_MAX_COUNT) throw new HttpError(413, `该 run 文件数已达上限（${RUN_UPLOAD_MAX_COUNT}）；历史资料可以引用已有文件，不必重传`);
      if (q.upload_bytes >= RUN_UPLOAD_MAX_BYTES) throw new HttpError(413, '该 run 文件总量已达上限（200MB）；历史资料可以引用已有文件，不必重传');
    } catch (e) { return next(e); }
    runUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超 100MB 上限' });
        return res.status(400).json({ error: `上传失败：${err.message}` });
      }
      try {
        const runId = Number(req.params.id);
        if (!req.file) bad('缺少 file 字段（multipart/form-data）');
        const createdBy = typeof req.body?.created_by === 'string' ? req.body.created_by.trim().slice(0, 128) : '';
        const rel = req.file.path.replace(dataDir, '').split(pathSep).join('/').replace(/^\/+/, '');
        const originalName = fixFileName(req.file.originalname);
        const kind = checkUploadKind(res, req.file, originalName);
        if (!kind) return;
        const sha = sha256Hex(readFileSync(req.file.path) as unknown as string);
        const r = svc<SopService>('sop').runFileInsert({ runId, name: originalName, mime: kind.mime, size: req.file.size, storagePath: rel, createdBy, sha256: sha }) as unknown as { lastInsertRowid: number | bigint };
        try { svc<SopService>('sop').runFileAudit(runId, originalName, req.file.size, sha, String(req.headers['x-run-upload-token'] ? 'token' : 'admin')); } catch { /* 审计失败不阻 */ }
        res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), run_id: runId, name: originalName, mime: kind.mime, size: req.file.size, sha256: sha, url: `/api/sop/runs/${runId}/files/${Number(r.lastInsertRowid)}`, quota: runFileQuota(runId) });
      } catch (e) { next(e); }
    });
  });
  app.get('/api/sop/runs/:id/files', { action: 'sop-run.files', kind: 'read' }, wrap(async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
    const runId = Number(req.params.id);
    sopRunRow(runId); // 404 语义与 run 一致
    const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, runId);
    if (!auth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required', hint: '创建响应的 read_capability（X-Run-Read-Capability 头）或已授权会话' });
    // 旧文件没记 sha256 的先补算（流式、按存储路径一次补齐），执行页文件清单选上就带 sha，第一次完成不会因缺 sha 失败
    const rows = svc<SopService>('sop').runFiles(runId) as any[];
    for (const f of rows.filter((x) => !x.sha256)) f.sha256 = await ensureRunFileSha({ storage_path: (svc<SopService>('sop').runFileById(runId, f.id) as any)?.storage_path ?? '', sha256: '' });
    const items = rows.map((f) => ({ ...f, url: `/api/sop/runs/${runId}/files/${f.id}` }));
    res.json({ run_id: runId, items, count: items.length, quota: runFileQuota(runId) });
  }));
  app.get('/api/sop/runs/:id/files/:fileId', { action: 'sop-run.file-download', kind: 'read' }, wrap(async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id)) || !/^\d+$/.test(String(req.params.fileId))) throw new HttpError(404, 'file not found');
    const runId = Number(req.params.id);
    const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, runId);
    if (!auth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required', hint: '创建响应的 read_capability（X-Run-Read-Capability 头）或已授权会话' });
    const row = svc<SopService>('sop').runFileById(runId, Number(req.params.fileId)) as any;
    if (!row) throw new HttpError(404, `file not found: ${req.params.fileId}`);
    const abs = join(dataDir, row.storage_path);
    if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
    res.setHeader('content-type', row.mime || 'application/octet-stream');
    res.setHeader('content-length', String(row.size));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name || 'file')}`);
    res.setHeader('x-content-type-options', 'nosniff');
    createReadStream(abs).pipe(res);
  }));
}
