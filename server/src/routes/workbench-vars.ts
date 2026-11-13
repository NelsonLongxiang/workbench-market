/**
 * 工作台变量与常量的五条路由：列表、读一个键、读留痕、写、删（#336）。
 * 原样搬自 workbench-vars.ts 的 mount()，一个字没改，只少了四格缩进、多了报给 HTTP 服务的动作。
 * 查台、判权（本机命令行、本台令牌、管理员）、no-store 在外壳 handle 里，读写的规则（乐观锁、常量的作者、留痕）在 workbench-vars.ts，都经参数和引用传进来。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 类别都报 admin：不带台令牌时读也要管理员（和凭据库同一个读门），员工、管理层的预设是不分块的读写，报成 read、write 会放宽。
 * 本台令牌这一支（自产台、SOP 台的页面读写本台变量）不在判定里，所以列表、读、写、删声明「状态码不代表授权」；留痕只给管理员，令牌也是 403，不用声明。
 */
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { WorkbenchVarsService } from '../services/workbench-vars.ts';
import { checkKey, deleteVar, expectedRevision, getVar, listVars, setVar, truthy, type createWorkbenchVars } from '../workbench-vars.ts';

const vars = () => svc<WorkbenchVarsService>('workbenchVars');
const TOKEN = '自产台、SOP 台的页面凭本台令牌读写本台变量：200 还是 403 看令牌对不对，不是授权的结论';

export function registerWorkbenchVarsRoutes(app: HttpService, handle: ReturnType<typeof createWorkbenchVars>['handle']): void {
  app.get('/api/workbenches/:id/vars', { action: 'workbench.vars-list', kind: 'admin', statusNotVerdict: TOKEN }, handle(false, async (req, res, scope) => {
    res.json(await listVars(scope, typeof req.query.prefix === 'string' ? req.query.prefix : ''));
  }));
  app.get('/api/workbenches/:id/vars/:key', { action: 'workbench.vars-read', kind: 'admin', statusNotVerdict: TOKEN }, handle(false, async (req, res, scope) => {
    const out = await getVar(scope, req.params.key);
    res.set('ETag', `"${out.revision}"`).json(out);
  }));
  // 审计只给管理员（本机命令行同）
  app.get('/api/workbenches/:id/vars/:key/audit', { action: 'workbench.vars-audit', kind: 'admin' }, handle(false, (req, res, scope, caller) => {
    if (!caller.admin) return void res.status(403).json({ error: '审计只限管理员' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({ workbench_id: scope.id, key: checkKey(req.params.key), items: vars().auditList(scope.id, req.params.key, limit) });
  }));
  app.put('/api/workbenches/:id/vars/:key', { action: 'workbench.vars-set', kind: 'admin', statusNotVerdict: TOKEN }, handle(true, async (req, res, scope, caller) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const out = await setVar(scope, req.params.key, {
      value: b.value, hasValue: Object.prototype.hasOwnProperty.call(b, 'value'), kind: b.kind,
      expected: expectedRevision(req.headers['if-match'], b.revision ?? req.query.revision),
      override: truthy(b.override) || truthy(req.query.override), reason: b.reason, owner: b.owner,
    }, caller);
    res.status(out.created ? 201 : 200).set('ETag', `"${out.revision}"`).json(out);
  }));
  app.delete('/api/workbenches/:id/vars/:key', { action: 'workbench.vars-delete', kind: 'admin', statusNotVerdict: TOKEN }, handle(true, async (req, res, scope, caller) => {
    res.json(await deleteVar(scope, req.params.key, {
      expected: expectedRevision(req.headers['if-match'], req.query.revision),
      override: truthy(req.query.override), reason: req.query.reason,
    }, caller));
  }));
}
