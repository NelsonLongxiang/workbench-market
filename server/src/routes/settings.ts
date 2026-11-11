/**
 * 设置的路由（/api/settings）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 读出去的设置：上游的 headers 值掩成 ****，管理口令的哈希剔除（maskUpstreamsSetting）。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SettingService } from '../services/setting.ts';
import { getSettings } from '../db.ts';
import { bad } from '../errors.ts';

/** 从 index.ts 传进来的：设置出口的脱敏（导出也用）；巡检定时器重挂（巡检在 index.ts 里）。 */
export interface SettingsDeps {
  maskUpstreamsSetting: (settings: Record<string, string>) => Record<string, string>;
  armPatrol: () => void;
}

export function registerSettingsRoutes(app: HttpService, deps: SettingsDeps): void {
  const { maskUpstreamsSetting, armPatrol } = deps;
  app.get('/api/settings', (_req, res) => { res.json(maskUpstreamsSetting(getSettings())); });

  app.put('/api/settings', (req, res) => {
    const b = req.body ?? {};
    if (typeof b !== 'object' || b === null) bad('body 必须是 {key: value} 对象');
    const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'a2a_peers', 'mcp_upstreams', 'dispatch_sorting_enabled', 'run_upload_require_token']; // #19 ②a 分拣开关+#150 上传令牌开关
    const upd = svc<SettingService>('setting').upsertStmt();
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k)) continue;
      upd.run(k, String(v));
    }
    armPatrol(); // issue #5：改巡检设置即重挂定时器（幂等 clearTimeout 开头），不必重启服务
    res.json(maskUpstreamsSetting(getSettings()));
  });
}
