/**
 * 健康与就绪：GET /api/health（只回缓存的 LayerFS 结果，不触发探测；带 A2A 的开关、计数和时长；带问身份来源的计数和最近一次耗时）、GET /api/health/ready（配了 LayerFS 就探，不健康 503）。公开。
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

type ProbeStatus = 'healthy' | 'unhealthy' | 'unreachable';

/** 从 index.ts 传进来的：健康的基础字段（带请求：管理口令才给事项回填的细节）、LayerFS 探测缓存的取值函数与就绪探测、A2A 入站签名的两个开关。 */
export interface HealthDeps {
  healthBase: (req?: express.Request) => Record<string, unknown>;
  layerfsProbeCached: () => { at: number; status: ProbeStatus } | null;
  layerfsReadiness: () => Promise<ProbeStatus>;
  A2A_DIRECT_SIG: Parameters<typeof a2aHealth>[0]['directSig'];
  A2A_DIRECT_SIG_BODY: Parameters<typeof a2aHealth>[0]['directSigBody'] | null;
}

export function registerHealthRoutes(app: HttpService, deps: HealthDeps): void {
  const { healthBase, layerfsProbeCached, layerfsReadiness, A2A_DIRECT_SIG, A2A_DIRECT_SIG_BODY } = deps;
  app.get('/api/health', { action: 'health.read', kind: 'read' }, (req, res) => {
    const result = healthBase(req);
    const probed = layerfsProbeCached();
    if (process.env.LAYERFS_SERVICE_URL && probed) result.layerfs = probed.status; // 只回缓存的上次结果，不触发探测
    result.a2a = a2aHealth({ directSig: A2A_DIRECT_SIG, directSigBody: A2A_DIRECT_SIG_BODY! }); // 阶段七第 5 步：只出开关、计数和时长
    // 身份来源慢或不通看得出来：问了几次、到点没回答几次、失败几次、合并和认不出缓存挡下几次、最近一次耗时。只有计数，不带凭据和人
    result.identity_source = identity().sourceStats();
    res.json(result);
  });
  app.get('/api/health/ready', { action: 'health.ready', kind: 'read' }, async (req, res) => {
    const result = healthBase(req);
    if (process.env.LAYERFS_SERVICE_URL) {
      result.layerfs = await layerfsReadiness();
      if (result.layerfs !== 'healthy') { result.ok = false; return res.status(503).json(result); }
    }
    res.json(result);
  });
}
