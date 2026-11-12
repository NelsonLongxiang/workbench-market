/**
 * 技能市场的路由：/api/skills 的钉装、校验、撤销、角色包、列表、发布、下载、回滚、删除、迁移到 LayerFS、导出、摘要上报、版本列表，
 * 和 /api/admin/rebuild-wm-skills（重建 wm-skills）。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 它们在 index.ts 里分成十几段，中间夹着技能的辅助函数和常量（暂存、打包、签票、发布核心、重建、tar 打包，MCP 和每月的自动重建也用，留在 index.ts），
 * 没有别的路由或中间件；按原来的顺序放进注册函数，在原来最后一段的位置调用，14 条路由彼此的先后、和别的路由的先后都不变。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的代码也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { SkillService } from '../services/skill.ts';
import { HttpError } from '../errors.ts';

/** 从 index.ts 传进来的：管理员守卫、异步处理函数的包装、400 的快捷写法、快照路径、发布核心、下载票和打包、回滚和删除、LayerFS 的推送和地址、重建、tar 打包（MCP、变更请求、每月自动重建也用）。 */
export interface SkillDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  bad: (msg: string) => never;
  resolveSnap: (p: string) => string;
  skillPublishCore: (slugIn: unknown, files: any, changelogIn: unknown, reviewedByIn: unknown, opts?: { refsOnly?: boolean }) => Promise<Record<string, unknown>>;
  skillTicketKey: (ticket: string) => string;
  skillVersionDir: (slugIn: unknown, versionIn: unknown) => { row: any; target: any; dir: string };
  skillPackage: (row: any, target: any, dir: string) => Buffer;
  skillPkgDir: (slug: string) => string;
  SKILL_DL_MAX: number;
  executeSkillRollback: (slug: string, targetVersion: number, reviewedBy: string) => Promise<Record<string, unknown>>;
  executeSkillDelete: (slug: string) => void;
  layerfsPublish: (project: string, files: { path: string; content: string }[], message: string, branch?: string) => Promise<{ commit_id: string; changed: boolean } | null>;
  LAYERFS_SKILLS_PROJECT: string;
  layerfsServiceBase: () => { base: string; token: string };
  rebuildWmSkills: (trigger: string) => Promise<{ ok: boolean; deleted_project: boolean; republished: number; cleared_stale: number }>;
  ustarTar: (files: { path: string; content: string | Buffer }[], opts?: { prefix?: string; mtime?: number }) => Buffer;
}

export function registerSkillRoutes(app: HttpService, deps: SkillDeps): void {
  const { adminGuard, wrap, bad, resolveSnap, skillPublishCore, skillTicketKey, skillVersionDir, skillPackage, skillPkgDir, SKILL_DL_MAX, executeSkillRollback, executeSkillDelete, layerfsPublish, LAYERFS_SKILLS_PROJECT, layerfsServiceBase, rebuildWmSkills, ustarTar } = deps;
  // ---------- 技能市场钉装与审计（P1-b · 方案 §1：市场侧 manifest+校验 API+巡检，不动 DSH catalog）----------
  app.post('/api/skills/:slug/install', { action: 'skill.install', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? '')) as any;
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const vs = S.versionsBySkill(row.id) as any[];
    const target = typeof req.body?.version === 'number' ? vs.find((v) => v.version === req.body.version) : SkillService.currentOf(row, vs); // 缺省当前版本（回滚后即回滚到的版本）
    if (!target) throw new HttpError(404, `无版本`);
    S.ledgerInsert({ skillId: row.id, versionId: target.id, expectedDigest: target.tree_digest, installedPath: String(req.body?.installed_path ?? target.snapshot_path), installedBy: String(req.body?.installed_by ?? '') });
    const ledger = S.ledgerActive() as any[];
    const mine = ledger.find((l) => l.skill_id === row.id && l.version_id === target.id && l.status === 'installed');
    // #94 S0⑤（K8）：钉装响应不回绝对路径（相对化——DB 存真值·响应给安装者自己的输入或相对形态）
    res.status(201).json({ ok: true, slug: row.slug, version: target.version, ledger_id: mine?.id, expected_digest: target.tree_digest, installed_path: `skill-snapshots/${encodeURIComponent(row.slug)}/v${target.version}` }); // 恒相对（不回显绝对）
  }));

  // 装载校验（方案 P1-b 边界：市场侧 API+巡检，不动 DSH catalog）
  app.get('/api/skills/:slug/verify', { action: 'skill.verify', kind: 'read' }, wrap(async (req, res) => {
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? ''));
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const ledger = (S.ledgerActive() as any[]).find((l) => l.skill_id === row.id);
    if (!ledger) return res.json({ ok: null, note: '无钉装记录（未安装）' });
    const [{ readdirSync, readFileSync }, { join }, { createHash }] = await Promise.all([import('node:fs'), import('node:path'), import('node:crypto')]);
    let root = '';
    const files: string[] = [];
    try {
      root = resolveSnap(ledger.installed_path); // #117：S4 起快照路径存 DATA_DIR 相对形
      (function walk(d: string) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(root);
    } catch {
      // #183 P0②：校验失败不回显服务器绝对路径（DATA_DIR 泄露面）
      throw new HttpError(500, '钉装快照不可读（路径已隐藏·请重新安装后再校验）');
    }
    // #94 S0①：与发布面同构 digest（同一 filesDigest——排序/分隔符/utf8 归一消灭「多文件误判篡改」类）
    const actual = SkillService.filesDigest(files.map((p) => ({ path: p.slice(root.length + 1).split('\\').join('/'), content: readFileSync(p) }))).digest; // #105：按原始字节（与导入器 treeDigest 同构，非 UTF-8 文件不误判）
    res.json({ ok: actual === ledger.expected_digest, expected: ledger.expected_digest, actual, checked_files: files.length });
  }));

  app.post('/api/skills/:slug/install/:ledgerId/revoke', { action: 'skill.install-revoke', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? ''));
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const id = Number(req.params.ledgerId);
    const led = (S.ledgerActive() as any[]).find((l) => l.id === id);
    if (!led) throw new HttpError(404, `ledger not found: ${id}`); // #94 S0④：撤销校验（不存在→404）
    if (led.skill_id !== row.id) throw new HttpError(404, `ledger not found: ${id}`); // #94 S0④（K7）：跨技能撤销 404（不泄露他技能 ledger 存在性）
    S.ledgerRevoke(id);
    res.json({ ok: true, ledger_id: id, status: 'revoked' });
  });

  // role-pack 展开清单（bundle→技能清单，上岗即装）
  app.get('/api/skills/role-packs', { action: 'skill.role-packs', kind: 'read' }, (_req, res) => {
    const S = svc<SkillService>('skill');
    const rows = S.bundlesAll() as any[];
    res.json(rows.map((b) => ({ pack_id: b.pack_id, member_name: b.member_name, bundle_version: b.bundle_version, skill_slugs: JSON.parse(b.skill_slugs || '[]'), roster_digest: b.roster_digest })));
  });

  // ---------- 技能市场浏览面（P1-a：/api/skills 只读列表，供管理页） ----------
  app.get('/api/skills', { action: 'skill.list', kind: 'read' }, (_req, res) => {
    const S = svc<SkillService>('skill');
    const rows = S.skillsAll() as any[];
    res.json(rows.map((r) => {
      const led = (S.ledgerActive() as any[]).find((l) => l.skill_id === r.id && l.status === 'installed');
      return { slug: r.slug, name: r.name, layer: r.layer, layer_name: r.layer_name, family_parent: r.family_parent, description: r.description, legacy: r.legacy === 1, versions: (S.versionsBySkill(r.id) as any[]).length, active_version: SkillService.currentOf(r, S.versionsBySkill(r.id) as any[])?.version ?? null, is_installed: !!led, current_version: led ? (S.versionsBySkill(r.id) as any[]).find((v) => v.id === led.version_id)?.version ?? null : null }; // #132 P1⑤；active_version=当前版本（回滚指针），current_version=钉装的版本
    }));
  });

  // ---------- 技能市场发布面（P0-b · 方案 PR#57 §1：口令门+首版人审+N+1 快照+digest 锚）----------
  app.post('/api/skills/:slug/versions', { action: 'skill.publish', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return; // 口令门（方案裁定：复用 X-Admin-Token）
    res.status(201).json(await skillPublishCore(String(req.params.slug ?? ''), req.body?.files, req.body?.changelog, req.body?.reviewed_by));
  }));

  app.get('/api/skills/dl/:ticket', { action: 'skill.download', kind: 'read', statusNotVerdict: '按下载票判：票就是凭据，404 不透露票号是否签发过' }, (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); // 票号在路径里：不随 Referer 外带（404 也带）
    const ticket = String(req.params.ticket ?? '');
    const key = /^[0-9a-f]{64}$/.test(ticket) ? skillTicketKey(ticket) : '';
    const t = key ? svc<SkillService>('skill').ticketByKey(key) as any : undefined;
    if (t && t.expires_at > Date.now() && t.downloads >= SKILL_DL_MAX) {
      svc<SkillService>('skill').ticketDenied(key);
      console.warn(`[skill-download] ${t.slug} v${t.version} issued_to=${t.issued_to} 单票已下载 ${t.downloads} 次（上限 ${SKILL_DL_MAX}），拒绝`);
    }
    // 票不存在、已过期、超过次数上限同一应答：不透露票号是否签发过
    if (!t || t.expires_at <= Date.now() || t.downloads >= SKILL_DL_MAX) throw new HttpError(404, `下载链接无效、已过期（10 分钟有效）或已用满 ${SKILL_DL_MAX} 次，请重新调 skill_download`);
    const { row, target, dir } = skillVersionDir(t.slug, t.version);
    const pkg = skillPackage(row, target, dir);
    svc<SkillService>('skill').ticketDownloaded(key);
    console.log(`[skill-download] ${t.slug} v${t.version} issued_to=${t.issued_to} bytes=${pkg.length}`);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${skillPkgDir(row.slug)}-v${target.version}.tar.gz"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Expected-Digest', target.tree_digest);
    res.setHeader('X-Package-Sha256', createHash('sha256').update(pkg).digest('hex'));
    res.end(pkg);
  });

  // #94 v3 S1/K16：技能一步式回滚/删除（口令+reviewed_by·与 app 同语义）
  app.post('/api/skills/:slug/activate', { action: 'skill.rollback', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('技能回滚需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
    const out = await executeSkillRollback(String(req.params.slug ?? ''), Number(req.body?.version), reviewedBy);
    res.json(out);
  }));
  app.delete('/api/skills/:slug', { action: 'skill.delete', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('技能删除需 reviewed_by（人审门）');
    executeSkillDelete(String(req.params.slug ?? ''));
    res.json({ ok: true, deleted: req.params.slug, reviewed_by: reviewedBy });
  }));

  // #94 S2 全量重导：技能各版依次入 wm-skills 项目 skill/<slug> 分支（幂等 skip+摘要对账）
  app.post('/api/skills/:slug/migrate-layerfs', { action: 'skill.migrate', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? '')) as any;
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const vs = S.versionsBySkill(row.id) as any[];
    const results: any[] = [];
    for (const v of vs.sort((a, b) => a.version - b.version)) {
      if (v.commit_id) { results.push({ version: v.version, result: 'skip', commit_id: v.commit_id }); continue; } // 幂等
      if (!v.snapshot_path || !existsSync(resolveSnap(v.snapshot_path))) { results.push({ version: v.version, result: 'anomaly', reason: '快照目录缺失' }); continue; }
      // 按字节读：LayerFS 契约 v1 的 content 是文本，非 UTF-8（二进制）文件转不了，点名留档不迁，不拿改坏的内容去算摘要
      const raw: { path: string; bytes: Buffer }[] = [];
      (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else raw.push({ path: rel + e.name, bytes: readFileSync(fp) }); } })(resolveSnap(v.snapshot_path));
      const binary = raw.find((f) => !Buffer.from(f.bytes.toString('utf8'), 'utf8').equals(f.bytes));
      if (binary) { results.push({ version: v.version, result: 'anomaly', reason: `含非 UTF-8（二进制）文件 ${binary.path}：LayerFS 契约只收文本，留档不迁` }); continue; }
      const files = raw.map((f) => ({ path: f.path, content: f.bytes.toString('utf8') }));
      // 0 字节文件是合法内容（如 Python 包的 __init__.py），照常迁移；整个快照一个文件都没有才算异常。
      // 判据改为摘要：快照读出的文件集必须与登记的 tree_digest 一致才发布（登记快照不可变，不改它），发布后再从服务读回同一 commit 重算
      if (files.length === 0) { results.push({ version: v.version, result: 'anomaly', reason: '空快照（留档不迁）' }); continue; }
      const pre = SkillService.filesDigest(files).digest;
      if (pre !== v.tree_digest) { results.push({ version: v.version, result: 'anomaly', reason: '快照读出的摘要与登记不符（留档不迁）' }); continue; }
      const out = await layerfsPublish(LAYERFS_SKILLS_PROJECT, files, `[skill-migrate] ${row.slug} v${v.version}`, `skill/${row.slug}`);
      if (!out) { S.versionShadowPublishFailed(v.id); results.push({ version: v.version, result: 'error', reason: 'layerfs 服务不可达（可重跑）' }); continue; }
      // K13 摘要对账：从服务读回这个 commit 的文件集重算，与登记摘要一致才记 commit_id（0 字节文件读回也得是 0 字节、同路径）
      let back = '';
      try {
        const { base, token } = layerfsServiceBase();
        const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(LAYERFS_SKILLS_PROJECT) + '/branches/' + encodeURIComponent(`skill/${row.slug}`) + '/commits/' + encodeURIComponent(out.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
        const fj = await fr.json() as { files?: { path: string; content: string }[] };
        if (fr.ok && Array.isArray(fj.files)) back = SkillService.filesDigest(fj.files).digest;
      } catch { back = ''; }
      if (back !== v.tree_digest) {
        // 这个 commit 已在分支上但不登记（孤立）：记进 shadow_error 便于核对；月度整库重建（rebuildWmSkills）会清掉它
        S.versionShadowFailed(`LayerFS readback digest mismatch; orphan commit ${out.commit_id} (cleared by monthly rebuild); retry migrate-layerfs`, v.id);
        results.push({ version: v.version, result: 'error', reason: back ? '读回摘要与登记不符（不记 commit_id·可重跑）' : '读回失败（不记 commit_id·可重跑）', commit_id_unrecorded: out.commit_id });
        continue;
      }
      S.versionMigrated(out.commit_id, v.id);
      results.push({ version: v.version, result: 'migrated', commit_id: out.commit_id, digest_match: true, readback_digest_match: true });
    }
    res.json({ slug: row.slug, project: LAYERFS_SKILLS_PROJECT, branch: `skill/${row.slug}`, results });
  }));

  app.post('/api/admin/rebuild-wm-skills', { action: 'skill.rebuild', kind: 'admin' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const out = await rebuildWmSkills('manual');
    res.json(out);
  }));

  // #94 S3①：导出面（薄分发——快照文件集打包 ustar·台与技能共契约面）
  app.get('/api/skills/:slug/export', { action: 'skill.export', kind: 'read' }, (req, res) => {
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? '')) as any;
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const vs = S.versionsBySkill(row.id) as any[];
    const v = req.query.version !== undefined ? Number(req.query.version) : SkillService.currentOf(row, vs)?.version; // 缺省当前版本
    const target = vs.find((x) => x.version === v);
    if (!target) throw new HttpError(404, `version not found: ${v}`);
    const dir = resolveSnap(target.snapshot_path);
    if (!dir || !existsSync(dir)) throw new HttpError(404, `snapshot missing: v${v}`);
    const files: { path: string; content: Buffer }[] = []; // 按字节打包：导出的二进制文件与快照一致
    (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp) }); } })(dir);
    const tar = ustarTar(files, { prefix: String(row.slug).split(':').pop() + '/' }); // #601
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', 'attachment; filename="' + row.slug.replace(/[^a-z0-9._-]/gi, '_') + '-v' + v + '.tar"');
    res.setHeader('X-Expected-Digest', target.tree_digest);
    res.end(tar);
  });

  // #94 S3③：agent 端摘要上报（K14 漂移记——match/drift 双态入档）
  app.post('/api/skills/:slug/report-digest', { action: 'skill.report-digest', kind: 'write' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? '')) as any;
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    const v = Number(req.body?.version);
    const digest = String(req.body?.digest ?? '');
    if (!Number.isInteger(v) || !/^[0-9a-f]{64}$/.test(digest)) bad('version 正整数 + digest 64 位十六进制');
    const target = (S.versionsBySkill(row.id) as any[]).find((x) => x.version === v);
    if (!target) throw new HttpError(404, `version not found: ${v}`);
    const match = digest === target.tree_digest;
    S.digestReportInsert(row.id, v, digest, target.tree_digest, match ? 1 : 0, String(req.body?.reported_by ?? '').slice(0, 100));
    res.json({ ok: true, slug: row.slug, version: v, match, drift: !match, expected: target.tree_digest });
  });

  app.get('/api/skills/:slug/versions', { action: 'skill.versions', kind: 'read' }, (req, res) => {
    const S = svc<SkillService>('skill');
    const row = S.skillBySlug(String(req.params.slug ?? '')) as any;
    if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
    // #94 S0⑤（K8）：版本列表 snapshot_path 相对化（不暴露 DATA_DIR）；兼容旧库无状态时推导。
    const vsAll = S.versionsBySkill(row.id) as any[];
    const activeV = SkillService.currentOf(row, vsAll)?.version ?? null;
    res.json({ slug: row.slug, active_version: activeV, versions: vsAll.map((v) => ({ ...v, active: v.version === activeV, shadow_status: v.shadow_status ?? (v.commit_id ? 'succeeded' : 'pending'), shadow_error: v.shadow_error ?? '', snapshot_path: v.snapshot_path ? `skill-snapshots/${encodeURIComponent(row.slug)}/v${v.version}` : v.snapshot_path })) });
  });
}
