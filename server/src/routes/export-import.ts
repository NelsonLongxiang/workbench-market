/**
 * 导出与导入的路由（/api/export、/api/import），连同只有导入用的 importErr。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 导出缺省脱敏；?reveal=1 取真值要求管理员（口令或管理员登录，浏览器来的要同源），不满足 403，不降级成掩码。
 * 导入整批预检全过才进事务（事务语句在 WorkbenchService 里），任一失败整体回滚零写。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import { settingsForAdmin } from '../settings-view.ts';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import type { CockpitService } from '../services/cockpit.ts';
import { getSettings, type CockpitRow, type PanelConfig, type rowToWorkbench } from '../db.ts';
import { HttpError } from '../errors.ts';
import { AdmissionError, auditAllow, checkHealthPath, checkTypeHealthPath, type AllowPolicy, type admitUrl } from '../url-admission.ts';

type WorkbenchView = ReturnType<typeof rowToWorkbench>;

/** 从 index.ts 传进来的：台的列表与脱敏、设置出口的脱敏、地址准入（策略与判定）、写请求的主体、管理员门（别的路由也用）。 */
export interface ExportImportDeps {
  listWorkbenches: () => WorkbenchView[];
  maskForApi: (w: WorkbenchView) => WorkbenchView;
  URL_POLICY: AllowPolicy;
  admitOrDeny: (op: 'register' | 'update' | 'import', url: string) => ReturnType<typeof admitUrl>;
  restSubject: (req: express.Request) => string;
  /** 按需认定管理员登录（GET 不经写门，不会预先认定） */
  markAdmin: (req: express.Request) => Promise<void>;
  /** 管理员门：口令或管理员登录，浏览器来的要同源；不通过时已写好 403 并返回 false */
  adminGuard: (req: express.Request, res: express.Response) => boolean;
}

export function registerExportImportRoutes(app: HttpService, deps: ExportImportDeps): void {
  const { listWorkbenches, maskForApi, URL_POLICY, admitOrDeny, restSubject, markAdmin, adminGuard } = deps;
  app.get('/api/export', { action: 'market.export', kind: 'read', refine: [{ action: 'market.export-reveal', kind: 'admin', why: '带 reveal=1 取真值要管理员', when: (req) => req.query.reveal === '1' }] }, (req, res, next) => { exportHandler(req, res).catch(next); });
  async function exportHandler(req: express.Request, res: express.Response): Promise<void> {
    // compliance 二期首项：导出默认脱敏（compliance 范围 kb ab3279b84a 的「导出面」——
    // 无认证导出曾是最大凭据泄漏向量）。?reveal=1 显式取真值（备份/迁移用途），
    // 导入侧对掩码 url/auth 整批400拒绝（见 import 预检）——失败零写，不跳行报成功。
    const reveal = req.query.reveal === '1';
    if (reveal) {
      // 取真值要求管理员，口径同别的管理读面；不满足 403，不悄悄降级成掩码（备份脚本拿到掩码会以为备份成功）
      await markAdmin(req);
      if (!adminGuard(req, res)) return;
      res.set('Cache-Control', 'no-store');
    }
    res.json({
      format: 'workbench-market/export@1',
      exported_at: new Date().toISOString(),
      masked: reveal ? 0 : 1,
      workbenches: listWorkbenches().map((w) => (reveal ? w : maskForApi(w))),
      types: svc<WorkbenchService>('workbench').types(),
      // 评审 #24：上游 MCP 凭据（headers）与 auth.value 同口径——导出不会带真凭据，
      // 导入侧亦不覆盖 mcp_upstreams（掩码值跳过），凭据需在页面重填。设置里凭据类的值（令牌、密码）同样只说有没有，带 reveal 也一样
      settings: settingsForAdmin(getSettings()),
    });
  }

  // #258 D：import 整批预检（结构 + 掩码 + 同核准入）全过才进事务；replace 的清库、类型、插入、布局修复同一事务，
  // 任一失败整体回滚零写。不再 skip 坏行/掩码行（掩码导出整批拒 masked_import_value，请用 ?reveal=1 的受控备份）。
  const importErr = (status: number, code: string, row_index: number | null, message: string): never => {
    throw new HttpError(status, code, { message, ...(row_index === null ? {} : { row_index }) });
  };
  app.post('/api/import', { action: 'market.import', kind: 'admin', statusNotVerdict: 'URL 准入：导入的行里有不许登记的地址时回 403，是登记规则不是授权' }, (req, res) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.workbenches)) importErr(400, 'invalid_import', null, '导入文件缺少 workbenches 数组');
    if (b.types !== undefined && !Array.isArray(b.types)) importErr(400, 'invalid_import', null, 'types 必须是数组');
    // issue #7：mode 支持 query 优先（README 的 ?mode=replace 写法），body.mode 次之
    const modeRaw = (typeof req.query.mode === 'string' ? req.query.mode : b.mode) ?? 'merge';
    const mode = modeRaw === 'replace' ? 'replace' : 'merge';
    const types: any[] = Array.isArray(b.types) ? b.types : [];
    types.forEach((t) => {
      if (!t || typeof t !== 'object' || typeof t.key !== 'string' || !t.key || typeof t.name !== 'string') importErr(400, 'invalid_import', null, 'types 每项须含字符串 key 与 name');
      try { checkTypeHealthPath(String(t.health_path ?? '/')); } catch (e) { if (e instanceof AdmissionError) importErr(400, e.code, null, `类型 ${t.key}：${e.extra?.message ?? ''}`); throw e; }
    });
    const rows = (b.workbenches as any[]).map((w, i) => {
      if (!w || typeof w !== 'object' || Array.isArray(w)) importErr(400, 'invalid_import', i, '行不是对象');
      if (typeof w.url !== 'string' || !w.url.trim()) importErr(400, 'invalid_import', i, 'url 缺失');
      if (w.name !== undefined && typeof w.name !== 'string') importErr(400, 'invalid_import', i, 'name 须为字符串');
      if (w.tags !== undefined && !Array.isArray(w.tags)) importErr(400, 'invalid_import', i, 'tags 须为数组');
      const url = w.url.trim();
      if (url.includes('=****') || w.auth?.value === '****') importErr(400, 'masked_import_value', i, '含掩码占位（****）——掩码导出不能用来恢复，请用 ?reveal=1 的受控备份或重新录入');
      let authCfg = '';
      if (w.auth !== undefined && w.auth !== null) {
        if (typeof w.auth !== 'object' || (w.auth.type !== 'bearer' && w.auth.type !== 'basic') || typeof w.auth.value !== 'string' || !w.auth.value || w.auth.value.length > 4096) {
          importErr(400, 'invalid_import', i, 'auth 形态：{type:"bearer"|"basic", value:string}');
        }
        authCfg = JSON.stringify({ type: w.auth.type, value: w.auth.value });
      }
      let adm;
      try { adm = admitOrDeny('import', url); checkHealthPath(url, String(w.health_path ?? '')); }
      catch (e) { if (e instanceof AdmissionError) importErr(e.status, e.code, i, String(e.extra?.message ?? '')); throw e; }
      return { w, url, authCfg, adm };
    });
    const svcWb = svc<WorkbenchService>('workbench');
    const inserted: { id: number; key: string | null; allowlisted: boolean }[] = [];
    svcWb.importBegin();
    try {
      if (mode === 'replace') {
        svcWb.deleteAll();
        svcWb.typeDeleteAllExcept('web');
      }
      const insType = svcWb.typeInsertIgnoreStmt();
      for (const t of types) insType.run(t.key, t.name, String(t.icon ?? ''), t.default_port ?? null, t.health_method ?? 'GET', String(t.health_path ?? '/'), t.expect_status ?? null, String(t.description ?? ''));
      const ins = svcWb.importInsertStmt();
      for (const { w, url, authCfg, adm } of rows) {
        const r = ins.run(
          String(w.name ?? '未命名'), url, String(w.type ?? 'web'), String(w.icon ?? ''),
          String(w.description ?? ''), String(w.category ?? ''),
          JSON.stringify(Array.isArray(w.tags) ? w.tags : []), w.enabled === false ? 0 : 1,
          String(w.health_path ?? ''), Number(w.sort) || 0, authCfg
        ) as { lastInsertRowid: number | bigint };
        inserted.push({ id: Number(r.lastInsertRowid), key: adm.key, allowlisted: adm.allowlisted });
      }
      // PR#15 评审吸收的增量思路：replace 重排自增 id 后，驾驶舱面板里指向旧 id 的引用已成悬空
      // （保存布局恒 400）——导入完成后全量剔除不存在引用（比按 id 精确清理更通用，也清历史遗留）
      const wbExists = (id: number) => !!svcWb.exists(id);
      for (const c of svc<CockpitService>('cockpit').all() as unknown as CockpitRow[]) {
        let panels: PanelConfig[];
        try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
        // 待办卡 kind='tasks' 以 workbenchId=0 占位、不引用工作台，不参与悬空剔除
        const kept = panels.filter((p) => p.kind === 'tasks' || wbExists(p.workbenchId));
        if (kept.length !== panels.length) {
          svc<CockpitService>('cockpit').setLayout(c.id, JSON.stringify(kept));
        }
      }
      svcWb.importCommit();
    } catch (e) {
      svcWb.importRollback();
      console.error('[import] 事务回滚：', (e as Error)?.message ?? e);
      throw new HttpError(500, 'import_failed', { message: '导入写入失败，已整体回滚（原数据未变）' });
    }
    // commit 之后才写 allow：每个命中许可的行恰一条
    let auditOk = true;
    for (const x of inserted) if (x.allowlisted && !auditAllow('import', URL_POLICY, x.key!, x.id, restSubject(req))) auditOk = false;
    if (!auditOk) res.setHeader('X-WM-Audit-State', 'degraded');
    res.json({ ok: true, mode, imported: inserted.length, skipped: 0 });
  });
}
