/**
 * 远程写豁免面的变更：GET /api/remote-allow/diff。原样搬自 index.ts，一个字没改，只多了两格缩进（注册时报上动作 remote-allow.diff）。
 * 只给管理员：回启动时算的那一份变更（added、removed、current），和库里快照的条数。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的代码也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { RemoteAllowService } from '../services/remote-allow.ts';

/** 从 index.ts 传进来的：管理员守卫（别的路由也用）、启动时算好的那一份变更。 */
export interface RemoteAllowDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 启动时算一次（index.ts 的 announceAllowDiff，在扩展加载之后、注册这条路由之前），注册之后不变，所以传值。
   *  要是以后加了运行时重算（重载配置、定时重查之类），这里得改成取值函数，不然接口会一直回注册那一刻的旧值。 */
  lastAllowDiff: { added: string[]; removed: string[]; current: string[] };
}

export function registerRemoteAllowRoutes(app: HttpService, deps: RemoteAllowDeps): void {
  const { adminGuard, lastAllowDiff } = deps;
  app.get('/api/remote-allow/diff', { action: 'remote-allow.diff', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    res.json({ ...lastAllowDiff, snapshot_count: (svc<RemoteAllowService>('remoteAllow').snapshotCount() as { n: number }).n });
  });
}
