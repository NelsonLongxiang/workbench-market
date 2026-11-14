/**
 * 健康与就绪：GET /api/health（只回缓存的 LayerFS 结果，不触发探测；带 A2A 的开关、计数和时长；带问身份来源的计数和最近一次耗时；管理口令另带两个守卫告警档的计数）、GET /api/health/ready（配了 LayerFS 就探，不健康 503）。公开。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。两条在 index.ts 里连在一起，在原来的位置注册。
 * 基础字段、LayerFS 探测与缓存、A2A 签名开关留在 index.ts，经参数传进来（探测缓存会在就绪探测时更新，所以传的是取值函数）；
 * A2A 的健康字段（阶段七）由模块直接引入。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { a2aHealth } from '../a2a/health.ts';
import { identity } from '../identity.ts';
import { defineConfig, loadConfig } from '../config.ts';
import { appDataReadWarnCounts } from './app-data.ts';
import { sopRunWriteWarnCounts } from './sop-run-lifecycle.ts';

type ProbeStatus = 'healthy' | 'unhealthy' | 'unreachable';

/** 从 index.ts 传进来的：健康的基础字段（带请求：管理口令才给事项回填的细节）、LayerFS 探测缓存的取值函数与就绪探测、A2A 入站签名的两个开关。 */
export interface HealthDeps {
  healthBase: (req?: express.Request) => Record<string, unknown>;
  layerfsProbeCached: () => { at: number; status: ProbeStatus } | null;
  layerfsReadiness: () => Promise<ProbeStatus>;
  A2A_DIRECT_SIG: Parameters<typeof a2aHealth>[0]['directSig'];
  A2A_DIRECT_SIG_BODY: Parameters<typeof a2aHealth>[0]['directSigBody'] | null;
  /** 带有效管理口令（和健康基础字段里给细节的口径一样）：管理员才看得到的部分用它判 */
  adminRead: (req: express.Request) => boolean;
}

/** 配了 LayerFS 才在健康检查里带它的状态 */
export const Config = defineConfig((env) => ({ layerfs: !!env.LAYERFS_SERVICE_URL }));
const config = loadConfig(Config);

/** 守卫告警档的计数（键是「路由模板|调用方类别」）摊成行：只有路由模板、类别和次数，没有主体、台名、run 号 */
export function warnCountRows(counts: Record<string, number>): { route: string; caller: string; count: number }[] {
  return Object.entries(counts)
    .map(([k, count]) => { const i = k.lastIndexOf('|'); return { route: k.slice(0, i), caller: k.slice(i + 1), count }; })
    .sort((a, b) => a.route.localeCompare(b.route) || a.caller.localeCompare(b.caller));
}

export function registerHealthRoutes(app: HttpService, deps: HealthDeps): void {
  const { healthBase, layerfsProbeCached, layerfsReadiness, A2A_DIRECT_SIG, A2A_DIRECT_SIG_BODY, adminRead } = deps;
  app.get('/api/health', { action: 'health.read', kind: 'read' }, (req, res) => {
    // 应答因人而异（带有效管理口令时多了 a2a.roster、出站计数、回填细节）：不让共享缓存把管理员那份发给匿名
    res.set('Cache-Control', 'private, no-store'); res.vary('X-Admin-Token');
    const result = healthBase(req);
    const probed = layerfsProbeCached();
    if (config.layerfs && probed) result.layerfs = probed.status; // 只回缓存的上次结果，不触发探测
    result.a2a = a2aHealth({ directSig: A2A_DIRECT_SIG, directSigBody: A2A_DIRECT_SIG_BODY!, admin: adminRead(req) }); // 阶段七第 5 步：只出开关、计数和时长；名册一块只给管理员
    // 身份来源慢或不通看得出来：问了几次、到点没回答几次、失败几次、合并和认不出缓存挡下几次、最近一次耗时。只有计数，不带凭据和人
    result.identity_source = identity().sourceStats();
    // 读台数据（WM_APP_DATA_READ）、写 run（WM_SOP_RUN_WRITE）两个守卫在 warn 档下「本会拒」的次数，进程启动以来累计，按路由模板 × 调用方类别。
    // 判什么时候能从 warn 改成 enforce 用；只给管理口令（谁在被放行的规模不对外）。enforce 档下守卫直接拒，不计数，这里是空的
    if (adminRead(req)) result.guard_would_deny = { app_data_read: warnCountRows(appDataReadWarnCounts()), sop_run_write: warnCountRows(sopRunWriteWarnCounts()) };
    res.json(result);
  });
  app.get('/api/health/ready', { action: 'health.ready', kind: 'read' }, async (req, res) => {
    res.set('Cache-Control', 'private, no-store'); res.vary('X-Admin-Token'); // 同上：带管理口令时多了回填细节、出站计数
    const result = healthBase(req);
    if (config.layerfs) {
      result.layerfs = await layerfsReadiness();
      if (result.layerfs !== 'healthy') { result.ok = false; return res.status(503).json(result); }
    }
    res.json(result);
  });
}
