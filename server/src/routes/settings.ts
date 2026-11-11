/**
 * 设置的路由（/api/settings）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 读出去的设置分两级（settings-view.ts）：管理员（同源）和本机命令行看全部，凭据类的值只说有没有；别人只看白名单（巡检参数和开关），
 * 内网地址、凭据都不给。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SettingService } from '../services/setting.ts';
import { getSettings } from '../db.ts';
import { bad } from '../errors.ts';
import type express from 'express';
import { settingsForAdmin, settingsForPublic } from '../settings-view.ts';

/** 从 index.ts 传进来的：巡检定时器重挂（巡检在 index.ts 里）；管理员认定（口令或管理员登录，同源；会先做管理员认定）。 */
export interface SettingsDeps {
  armPatrol: () => void;
  adminRead: (req: express.Request) => Promise<boolean>;
}

export function registerSettingsRoutes(app: HttpService, deps: SettingsDeps): void {
  const { armPatrol, adminRead } = deps;
  app.get('/api/settings', { action: 'setting.read', kind: 'read' }, (req, res, next) => {
    adminRead(req).then((admin) => {
      res.set('Cache-Control', 'private, no-store');
      res.json(admin ? settingsForAdmin(getSettings()) : settingsForPublic(getSettings()));
    }, next);
  });

  app.put('/api/settings', { action: 'setting.update', kind: 'admin' }, (req, res) => {
    const b = req.body ?? {};
    if (typeof b !== 'object' || b === null) bad('body 必须是 {key: value} 对象');
    const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'a2a_peers', 'mcp_upstreams', 'dispatch_sorting_enabled', 'run_upload_require_token']; // #19 ②a 分拣开关+#150 上传令牌开关
    const upd = svc<SettingService>('setting').upsertStmt();
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k)) continue;
      upd.run(k, String(v));
    }
    armPatrol(); // issue #5：改巡检设置即重挂定时器（幂等 clearTimeout 开头），不必重启服务
    res.json(settingsForAdmin(getSettings()));
  });
}
