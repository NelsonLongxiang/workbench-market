/**
 * SOP 执行页的路由：GET /sop/<slug>/（这一条正则路由）。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 根路径出内置执行页（服务端渲染活跃版本的 sop.yaml，没上架 403）；别的路径出活跃版本目录里的附件，HTML 附件注入台令牌。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SopService } from '../services/sop.ts';
import type { AppRow } from '../db.ts';
import type { renderSopRunner as renderSopRunnerRaw } from '../sop-runner.ts';
import { isInsideRoot } from '../path-inside.ts';

type SopManifest = Parameters<typeof renderSopRunnerRaw>[0];

/** 从 index.ts 传进来的：读活跃版本的清单、执行页的渲染（带设计 token）、台文件的根目录、台令牌、台在市场里的卡片编号（门户和自产台也用）。 */
export interface SopPageDeps {
  readActiveManifest: (slug: string) => { manifest: SopManifest; app: AppRow } | null;
  renderSopRunner: (manifest: SopManifest, app: AppRow) => string;
  appsRoot: string;
  wmAppToken: (slug: string) => string;
  wmWorkbenchIdFor: (url: string) => number | null;
}

export function registerSopPageRoutes(app: HttpService, deps: SopPageDeps): void {
  const { readActiveManifest, renderSopRunner, appsRoot, wmAppToken, wmWorkbenchIdFor } = deps;
  // /sop/:slug/ 根 → Runner；/sop/:slug/<path> → 版本目录静态文件（附件）
  app.get(/^\/sop\/[a-z0-9][a-z0-9-]*(\/.*)?$/, { action: 'sop.page', kind: 'read', statusNotVerdict: '按资源状态：已下架的执行页 403' }, (req, res) => {
    const m = /^\/sop\/([a-z0-9][a-z0-9-]*)\/?(.*)$/.exec(req.path ?? '');
    if (!m) return res.status(404).json({ error: 'not found' });
    const rest = m[2] || '';
    const hit = readActiveManifest(m[1]);
    if (!hit) return res.status(404).json({ error: `SOP not found: ${m[1]}` });
    res.setHeader('X-App-Version', `v${hit.app.active_version}`);
    const runParamRaw = typeof req.query?.run === 'string' && /^\d+$/.test(req.query.run) ? Number(req.query.run) : null;
    if (rest === '' || rest === '/' || rest === 'index.html') {
      // issue #11：非 published 不再渲染下发完整 Runner 页面（信息泄漏面）——403 瘦身为一行
      if (hit.app.status !== 'published') {
        return res.status(403).type('text').send(`SOP ${m[1]} 状态为 ${hit.app.status}，未上架不可执行\n`);
      }
      // #263 页面整链：?run=<id> 精确定位既有执行记录（不新开 run）；归属不匹配时 404，不静默换记录
      if (runParamRaw !== null) {
        const runRow = svc<SopService>('sop').runById(runParamRaw) as unknown as { sop_slug?: string } | undefined;
        if (!runRow || runRow.sop_slug !== m[1]) return res.status(404).json({ error: `run ${runParamRaw} 不属于 SOP ${m[1]}` });
        (globalThis as any).__wmSopPinRun = runParamRaw;
        try { return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app)); } finally { delete (globalThis as any).__wmSopPinRun; }
      }
      return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app));
    }
    // 附件：从活跃版本目录读（与 serveApp 同款防穿越）
    const root = join(appsRoot, m[1], `v${hit.app.active_version}`);
    let rel = posix.normalize(rest);
    if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
    const abs = join(root, rel);
    if (!isInsideRoot(root, abs)) return res.status(400).json({ error: '路径非法' });
    if (!existsSync(abs)) return res.status(404).json({ error: `file not found: ${rel}` });
    // #198（裁 A）：自产台入口/子页面注入按台令牌——sandbox 页面凭它调本台 data/files
    if (/\.html?$/i.test(rel)) {
      try {
        const tok = wmAppToken(m[1]);
        const raw = readFileSync(abs, 'utf8');
        const inject = `<meta name="wm-app-token" content="${tok}"><script>window.WM_APP_TOKEN="${tok}";window.WM_APP_SLUG="${m[1]}";window.WM_WORKBENCH_ID=${wmWorkbenchIdFor(`/sop/${m[1]}/`)};</script>`;
        const out = /<head[^>]*>/i.test(raw) ? raw.replace(/<head([^>]*)>/i, (mm) => mm + inject) : inject + raw;
        return res.type('html').send(out);
      } catch { /* 读取失败回落原样 */ }
    }
    return res.sendFile(abs);
  });
}
