/**
 * 管理口令的路由（/api/admin/whoami、/api/admin-token），连同只有它们用的两个判断（isLoopbackReq、adminTokenWritable）。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。库里只存加盐哈希，任何应答都不带口令或哈希。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { ADMIN_TOKEN_KEY, type SettingService } from '../services/setting.ts';
import { browserMarked, originIsThisSurface, rawLoopback } from '../surfaces.ts';

/** 从 index.ts 传进来的：口令的存取与校验、本次请求是不是 Odoo 管理员、同源判断（别的路由和中间件也用）。 */
export interface AdminTokenDeps {
  adminTokenCheck: (provided: string | undefined) => boolean;
  odooAdminReqs: WeakMap<express.Request, string>;
  dbAdminTokenSet: () => boolean;
  dbAdminTokenOk: (provided: string | undefined) => boolean;
  hashAdminToken: (token: string, salt?: string) => string;
  browserSameSite: (req: express.Request) => boolean;
  devOriginOk: (req: express.Request) => boolean;
}

export function registerAdminTokenRoutes(app: HttpService, deps: AdminTokenDeps): void {
  const { adminTokenCheck, odooAdminReqs, dbAdminTokenSet, dbAdminTokenOk, hashAdminToken, browserSameSite, devOriginOk } = deps;
  function isLoopbackReq(req: express.Request): boolean {
    return rawLoopback(req) && (!browserMarked(req) || originIsThisSurface(req));
  }
  function adminTokenWritable(req: express.Request, requireCurrent: boolean): boolean {
    if (!browserSameSite(req) || (req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req))) return false;
    if (odooAdminReqs.has(req)) return true;
    return requireCurrent ? dbAdminTokenOk(req.headers['x-admin-token']) : isLoopbackReq(req);
  }

  app.get('/api/admin/whoami', { action: 'admin.whoami', kind: 'read' }, (req, res) => {
    const viaToken = adminTokenCheck(req.headers['x-admin-token']);
    const odoo = odooAdminReqs.get(req) ?? null;
    res.set('Cache-Control', 'no-store').json({ admin: viaToken || !!odoo, via: viaToken ? 'token' : odoo ? 'odoo' : null, login: viaToken ? null : odoo });
  });

  app.get('/api/admin-token/state', { action: 'admin-token.state', kind: 'read' }, (req, res) => {
    res.json({
      source: process.env.ADMIN_TOKEN ? 'env' : (dbAdminTokenSet() ? 'db' : 'none'),
      settable: !process.env.ADMIN_TOKEN && (dbAdminTokenSet() || isLoopbackReq(req) || odooAdminReqs.has(req)), // env 未设时：已有口令可凭旧口令改；首次由本机或 Odoo 管理员设
    });
  });

  app.put('/api/admin-token', { action: 'admin-token.set', kind: 'admin', refine: [{ action: 'admin-token.first-set', kind: 'admin', why: '还没设过口令时的首次设置（只限本机，见存量差异清单）', when: (_req, facts) => !facts.adminTokenSet }] }, (req, res) => {
    if (process.env.ADMIN_TOKEN) return res.status(400).json({ error: '口令由启动环境 ADMIN_TOKEN 提供，页面不可改（改环境变量并重启）' });
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (token.length < 4 || token.length > 128) return res.status(400).json({ error: '口令长度 4–128' });
    const hasExisting = dbAdminTokenSet();
    if (!adminTokenWritable(req, hasExisting)) {
      return res.status(403).json({ error: hasExisting ? '修改口令需先在请求头带上当前口令（X-Admin-Token），或用 Odoo 管理员登录' : '首次设置口令仅限本机命令行/本机页面，或 Odoo 管理员' });
    }
    svc<SettingService>('setting').put(ADMIN_TOKEN_KEY, hashAdminToken(token));
    res.json({ ok: true, source: 'db', note: '口令已设置并立即生效（库存 sha256，不可取回）' });
  });

  app.delete('/api/admin-token', { action: 'admin-token.clear', kind: 'admin' }, (req, res) => {
    if (process.env.ADMIN_TOKEN) return res.status(400).json({ error: '口令来自启动环境，需清环境变量并重启' });
    if (!adminTokenWritable(req, true)) return res.status(403).json({ error: '需当前口令或 Odoo 管理员登录' });
    svc<SettingService>('setting').delete(ADMIN_TOKEN_KEY);
    res.json({ ok: true, source: 'none' });
  });
}
