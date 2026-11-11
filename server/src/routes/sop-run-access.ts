/**
 * SOP run 的私有读授权管理面（#309 phase2）：按主体授权与撤销（read-grants），重签读能力与撤销全部读能力（read-caps），只给管理员。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。四条在 index.ts 里连在一起，在原来最后一条的位置注册。
 * 授权与读能力的存取在 sop-read-auth.ts（经身份服务认人的那一侧也在那里），这里直接引入。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里还在用的经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import type { SopRunRow } from '../db.ts';
import { issueRunReadCap, runReadGrantCreate, runReadGrantRevoke, runReadCapRevokeAll } from '../sop-read-auth.ts';

/** 从 index.ts 传进来的：管理员守卫、按 id 取 run（没有就 404）、400 的快捷写法。 */
export interface SopRunAccessDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  sopRunRow: (id: number) => SopRunRow;
  bad: (msg: string) => never;
}

export function registerSopRunAccessRoutes(app: HttpService, deps: SopRunAccessDeps): void {
  const { adminGuard, sopRunRow, bad } = deps;
  // #309 phase2：run 私有读授权管理面（播种 grant／重签 cap／撤销；adminGuard——运维持权人经权威映射操作，不猜归属）
  app.put('/api/sop/runs/:id(\\d+)/read-grants', { action: 'sop-run.read-grant', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    sopRunRow(id);
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    if (!/^(user|mcp):[A-Za-z0-9_.@-]{1,128}$/.test(subject)) bad('subject 形如 user:<Odoo登录名> 或 mcp:<会话名>');
    const role = typeof req.body?.role === 'string' && req.body.role ? req.body.role.slice(0, 32) : 'reader';
    const expiresAt = typeof req.body?.expires_at === 'string' && req.body.expires_at ? req.body.expires_at.slice(0, 19) : null;
    runReadGrantCreate(id, subject, role, expiresAt, 'admin');
    res.status(201).json({ ok: true, run_id: id, subject, role, expires_at: expiresAt });
  });
  app.post('/api/sop/runs/:id(\\d+)/read-grants/revoke', { action: 'sop-run.read-grant-revoke', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    if (!subject) bad('subject 必填');
    const n = runReadGrantRevoke(id, subject);
    res.json({ ok: true, run_id: id, subject, revoked: n });
  });
  app.post('/api/sop/runs/:id(\\d+)/read-caps', { action: 'sop-run.read-cap', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    sopRunRow(id);
    const cap = issueRunReadCap(id);
    res.status(201).json({ ok: true, run_id: id, read_capability: cap, note: '明文仅此一次出现——请立即分发保管' });
  });
  app.post('/api/sop/runs/:id(\\d+)/read-caps/revoke', { action: 'sop-run.read-cap-revoke', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    const n = runReadCapRevokeAll(id);
    res.json({ ok: true, run_id: id, revoked_caps: n });
  });
}
