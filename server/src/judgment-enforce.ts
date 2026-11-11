/**
 * 判定切换的开关（阶段六 6d 第 0 步）。WM_JUDGMENT_ENFORCE：
 *   · 缺省空：一个域都不切。路由不加任何东西，行为和以前逐字一样。
 *   · 域名列表（逗号分隔，比如 `stats,summary`）或 `all`：这些域按域切到新判定。
 * 启动时读一次；写法不对、域不存在、并行比对没开（WM_JUDGMENT_COMPARE=on），都拒绝启动。切换要比对开着：
 * 迁移授予和反向比对都靠它。
 *
 * 切了的域，每条报了动作的路由在自己的处理函数前面多一道门：
 *   · 新判定放行：交给原来的处理函数。旧守卫照旧再判一遍，并行比对照旧拿它的结论比（反向比对）。
 *     新的放、旧的拒，记成不一致：说明旧守卫还不能拿掉。
 *   · 新判定拒绝或转提议（ask）：在这里回 403，原来的处理函数不跑。这一次记进 judgment_enforced（路由模式、身份类别、
 *     结论、命中的规则），不和旧结论比。应答体是统一的 { error: 'judgment_denied' | 'judgment_ask', action }，
 *     旧守卫各自的写法不再出现。
 *   · 不受开关影响、照旧按各自规则的：声明了「状态码不代表授权」的路由、没报动作的存量路由、「暂不切」清单里的动作。
 * 回退：把域从 WM_JUDGMENT_ENFORCE 里去掉，重启。判定只读授予，不写业务数据，回退不用迁移。
 */
import type express from 'express';
import type { ActionSpec, RegisteredAction, RequestFacts } from './http.ts';
import { judge } from './judgment.ts';
import { domainOf } from './roles.ts';
import { svc } from './context.ts';
import { enforcedDenials, migrateOnSight, type ActorOf } from './judgment-compare.ts';
import type { JudgmentCompareService } from './services/judgment-compare.ts';
import { NOT_SWITCHED } from './judgment-builtins.ts';

export type EnforceConfig = { domains: ReadonlySet<string> | 'all' | null };


const DOMAIN_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 读开关。写法不对、比对没开：抛错（调用方拒绝启动） */
export function enforceConfig(env: NodeJS.ProcessEnv, compareOn: boolean): EnforceConfig {
  const raw = String(env.WM_JUDGMENT_ENFORCE ?? '').trim();
  if (raw === '') return { domains: null };
  if (!compareOn) throw new Error('WM_JUDGMENT_ENFORCE 要和 WM_JUDGMENT_COMPARE=on 一起开（迁移授予和反向比对都靠它）');
  if (raw === 'all') return { domains: 'all' };
  const parts = raw.split(',').map((p) => p.trim());
  const bad = parts.filter((p) => !DOMAIN_RE.test(p));
  if (bad.length) throw new Error(`WM_JUDGMENT_ENFORCE 的域名写法不对：${bad.map((b) => JSON.stringify(b)).join('、')}（小写字母开头，字母、数字、连字符；或者写 all）`);
  return { domains: new Set(parts) };
}

/** 这个动作在切了的域里、又不在「暂不切」里 */
export function enforced(config: EnforceConfig, action: string): boolean {
  if (!config.domains) return false;
  if (NOT_SWITCHED.some((n) => n.action === action)) return false;
  return config.domains === 'all' || config.domains.has(domainOf(action));
}

/** 全部路由注册完之后核一遍：开关里写的域都要有登记的动作，「暂不切」里的动作都要存在。返回问题列表（空就是没问题） */
export function checkEnforce(config: EnforceConfig, actions: readonly RegisteredAction[]): string[] {
  const problems: string[] = [];
  const known = new Set(actions.map((a) => a.action));
  const domains = new Set(actions.map((a) => domainOf(a.action)));
  if (config.domains && config.domains !== 'all') for (const d of config.domains) if (!domains.has(d)) problems.push(`WM_JUDGMENT_ENFORCE 里的域 ${d} 没有登记的动作`);
  for (const n of NOT_SWITCHED) if (!known.has(n.action)) problems.push(`「暂不切」里的动作 ${n.action} 没有登记`);
  return problems;
}

/** 给 HTTP 服务装的门：按路由报的动作造一个处理函数，放在原来的处理函数前面 */
export function enforceGate(config: EnforceConfig, actorOf: ActorOf, facts: () => RequestFacts): (spec: ActionSpec) => express.RequestHandler {
  const compare = () => svc<JudgmentCompareService>('judgmentCompare');
  return (declared) => (req, res, next) => {
    let f: RequestFacts;
    try { f = facts(); } catch { f = { adminTokenSet: true }; }
    const refined = declared.refine?.find((r) => { try { return r.when(req, f); } catch { return false; } });
    const spec = refined ? { ...declared, action: refined.action, kind: refined.kind } : declared;
    if (declared.statusNotVerdict || !enforced(config, spec.action)) return next();
    actorOf(req).then(({ actor, admin }) => {
      migrateOnSight(actor, admin);
      const result = judge({ actor, action: spec.action, kind: spec.kind, declared: true });
      if (result.verdict === 'allow') return next();
      enforcedDenials.add(req);
      const route = (req as express.Request & { route?: { path: unknown } }).route;
      try {
        compare().enforced({ route: `${req.method} ${String(route?.path ?? '')}`, action: spec.action, actorKind: actor.type === 'builtin' ? actor.name : actor.kind, verdict: result.verdict, rule: result.rule });
      } catch { /* 记不了也照样拒 */ }
      res.set('Cache-Control', 'no-store');
      res.status(403).json({ error: result.verdict === 'ask' ? 'judgment_ask' : 'judgment_denied', action: spec.action });
    }).catch(next);
  };
}
