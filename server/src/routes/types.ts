/**
 * 类型管理的路由（/api/types）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 这一组路由没有自己的守卫：写请求由 index.ts 里的写请求总门把关，读开放。
 */
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import type { TypeRow } from '../db.ts';
import { HttpError, bad } from '../errors.ts';
import { checkTypeHealthPath } from '../url-admission.ts';

export function registerTypeRoutes(app: HttpService): void {
  app.get('/api/types', { action: 'type.list', kind: 'read' }, (_req, res) => {
    res.json(svc<WorkbenchService>('workbench').types());
  });

  app.post('/api/types', { action: 'type.create', kind: 'admin' }, (req, res) => {
    const b = req.body ?? {};
    if (typeof b.key !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(b.key)) bad('key 必须是小写字母/数字/连字符');
    if (typeof b.name !== 'string' || !b.name.trim()) bad('name 不能为空');
    if (b.key === 'web') bad('内置类型 web 不允许覆盖');
    checkTypeHealthPath(String(b.health_path ?? '/'));
    const exists = svc<WorkbenchService>('workbench').typeIdByKey(b.key);
    if (exists) bad(`类型已存在: ${b.key}`);
    const r = svc<WorkbenchService>('workbench').typeInsertStmt().run(
      b.key, b.name.trim(), String(b.icon ?? ''), b.default_port ?? null,
      b.health_method === 'HEAD' ? 'HEAD' : 'GET',
      String(b.health_path ?? '/'), b.expect_status == null ? null : Number(b.expect_status), String(b.description ?? '')
    );
    res.status(201).json(svc<WorkbenchService>('workbench').typeById(Number(r.lastInsertRowid)));
  });

  app.put('/api/types/:id', { action: 'type.update', kind: 'admin' }, (req, res) => {
    const id = Number(req.params.id);
    const cur = svc<WorkbenchService>('workbench').typeById(id) as unknown as TypeRow | undefined;
    if (!cur) throw new HttpError(404, `type not found: ${id}`);
    const b = req.body ?? {};
    const next = {
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : cur.name,
      icon: b.icon !== undefined ? String(b.icon) : cur.icon,
      default_port: b.default_port !== undefined ? (b.default_port ?? null) : cur.default_port,
      health_method: b.health_method ? (b.health_method === 'HEAD' ? 'HEAD' : 'GET') : cur.health_method,
      health_path: b.health_path !== undefined ? String(b.health_path) : cur.health_path,
      expect_status: b.expect_status !== undefined ? (b.expect_status == null ? null : Number(b.expect_status)) : cur.expect_status,
      description: b.description !== undefined ? String(b.description) : cur.description,
    };
    if (next.health_path !== cur.health_path) checkTypeHealthPath(next.health_path);
    if (cur.key === 'web' && (next.health_path !== cur.health_path || next.expect_status !== cur.expect_status)) {
      bad('内置类型 web 不允许修改探测语义');
    }
    svc<WorkbenchService>('workbench').typeUpdate({ ...next, id });
    res.json(svc<WorkbenchService>('workbench').typeById(id));
  });

  app.delete('/api/types/:id', { action: 'type.delete', kind: 'admin' }, (req, res) => {
    const id = Number(req.params.id);
    const cur = svc<WorkbenchService>('workbench').typeById(id) as unknown as TypeRow | undefined;
    if (!cur) throw new HttpError(404, `type not found: ${id}`);
    if (cur.key === 'web' || cur.key === 'market-app') bad(`内置类型 ${cur.key} 不允许删除`);
    const used = svc<WorkbenchService>('workbench').typeUsageCount(cur.key) as { n: number };
    if (used.n > 0) throw new HttpError(409, `类型 ${cur.key} 仍被 ${used.n} 个工作台使用，先改挂其他类型`);
    svc<WorkbenchService>('workbench').typeDelete(id);
    res.json({ ok: true, deleted: id });
  });
}
