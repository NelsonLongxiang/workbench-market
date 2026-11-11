/**
 * 判定的并行比对（阶段六 6c）。开关 WM_JUDGMENT_COMPARE：缺省 off，on 打开，别的值拒绝启动。只在 CI 和出报告用的实例里开。
 *
 * 打开时，每个请求应答结束之后（res 的 finish，不拖慢请求、不改应答）：
 *   · 旧结论从应答取：401/403 = 拒绝；2xx/3xx = 允许；404 不判（有的路由用 404 藏「没权限」）；
 *     其余（400/409/422 这类、5xx）= 不确定——校验排在守卫前面的路由分不清，按路由计数，不算一致也不算不一致。
 *   · 只比报了动作的路由（经 HTTP 服务注册的，路由对象上有动作）；没报动作的按路由计「没报动作，不比」。
 *   · 路由声明了「状态码不代表授权」（statusNotVerdict）的，不拿状态码当旧结论比，单列「状态码不代表授权」。
 *   · 被完整性门拦下的不比，单列：请求带着跨站或别的站的标记（Sec-Fetch-Site 不是 same-origin/none，或 Origin 不是本站），
 *     旧结论又是拒绝——同源门是请求完整性的门，在判定之外、判定之前，切换时原样保留。
 *   · 谁在请求（先后）：有效的管理口令 → 内置身份 admin-token；市场会话或登录提供方认出来的 → 对到的主体；
 *     本机命令行（回环直连、没有浏览器标记）→ 内置身份 local-cli；本机页面（回环直连、带浏览器标记、Origin 是本站）→ local-page；其余 → anonymous。
 *   · 迁移（只在比对打开的实例上）：第一次见到一个启用的人，给他一条 member；身份来源说他是管理员，给一条 admin。
 *     来源都记 migration，同一个人同一个角色只迁一次（撤了不会补回来）。
 *   · 新结论由判定事件给（judgment.ts）。新结论是 ask 或 deny 都算「不允许」。两边不一样就记一条不一致。
 * 判定出错只计数（error），不影响请求。比对记录不记请求体、查询串、凭据和路径里的 id；路由记模式。
 * 记账攒批、在应答之后异步写，写在单独的库文件里（不和业务库抢锁），写失败只计数。
 *
 * WM_JUDGMENT_COMPARE_OUT（可选，绝对路径）：每比一次往这个文件追加一行 JSON（同样不含 id 和凭据），出报告的脚本汇总用。
 * 测试环境（NODE_ENV=test）里，请求带的 x-replay-step（回放给的「域/场景/请求」）也写进去，报告里每类不一致能指到一条录制。
 */
import type express from 'express';
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { browserMarked, rawLoopback } from './surfaces.ts';
import { ACTION_KEY, type ActionSpec, type RequestFacts } from './http.ts';
import { judge, type JudgedActor } from './judgment.ts';
import type { GrantService } from './services/grant.ts';
import type { PrincipalService } from './services/principal.ts';
import type { JudgmentCompareService, Outcome } from './services/judgment-compare.ts';

export type CompareConfig = { on: boolean; out: string | null; tagSteps: boolean };

/** 启动时读一次：WM_JUDGMENT_COMPARE（on/off，缺省 off）、WM_JUDGMENT_COMPARE_OUT（绝对路径，可选）。不合法拒绝启动 */
export function compareConfig(env: NodeJS.ProcessEnv = process.env): CompareConfig {
  const raw = String(env.WM_JUDGMENT_COMPARE ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`WM_JUDGMENT_COMPARE 只接受 on 或 off，现在是 ${JSON.stringify(raw)}`);
  const out = String(env.WM_JUDGMENT_COMPARE_OUT ?? '').trim();
  if (out && !isAbsolute(out)) throw new Error('WM_JUDGMENT_COMPARE_OUT 要是绝对路径');
  // 出报告时回放的每条请求带 x-replay-step（哪条录制的哪个请求），只在测试环境里写进输出文件
  return { on: raw === 'on', out: out || null, tagSteps: env.NODE_ENV === 'test' };
}

export type CompareDeps = {
  /** 请求带的管理口令有效 */
  adminTokenOk: (req: express.Request) => boolean;
  /** 不比的请求（启动自检自己的探针） */
  skip: (req: express.Request) => boolean;
  /** 请求进来时的事实（路由细分动作时用，请求本身可能改掉它们） */
  facts: () => RequestFacts;
};

const grants = () => svc<GrantService>('grants');
const principals = () => svc<PrincipalService>('principals');
const compare = () => svc<JudgmentCompareService>('judgmentCompare');

/** 请求带的 Origin 是本站 */
function sameSiteOrigin(req: express.Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  try { return new URL(origin).host === String(req.headers.host ?? ''); } catch { return false; }
}

/** 请求带着跨站或别的站的标记（完整性门看的就是这些） */
function crossMarked(req: express.Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) { try { return new URL(origin).host !== String(req.headers.host ?? ''); } catch { return true; } }
  return false;
}

/** 旧结论：应答的状态码 */
function oldVerdict(status: number): 'allow' | 'deny' | 'skip-404' | 'uncertain' {
  if (status === 401 || status === 403) return 'deny';
  if (status >= 200 && status < 400) return 'allow';
  if (status === 404) return 'skip-404';
  return 'uncertain';
}

/** 谁在请求（比对和切换开关共用一个口径）：先后顺序见文件头 */
export type ActorOf = (req: express.Request) => Promise<{ actor: JudgedActor; admin: boolean }>;
export function actorResolver(deps: Pick<CompareDeps, 'adminTokenOk'>): ActorOf {
  const resolve = identity().cachedResolver({ ttlMs: 60_000, max: 1000 });
  return async function actorOf(req: express.Request): Promise<{ actor: JudgedActor; admin: boolean }> {
    if (deps.adminTokenOk(req)) return { actor: { type: 'builtin', name: 'admin-token' }, admin: false };
    const cookie = String(req.headers.cookie ?? '');
    if (cookie) {
      let who: { ok: boolean; viewer?: { sub?: unknown; admin?: unknown } };
      try { who = await resolve(cookie) as typeof who; } catch { who = { ok: false }; }
      const id = who.ok && typeof who.viewer?.sub === 'string' ? who.viewer.sub : '';
      const p = id ? principals().get(id) : null;
      if (p) return { actor: { type: 'principal', id: p.id, kind: p.kind, status: p.status, owner: p.owner }, admin: who.viewer?.admin === true };
    }
    if (rawLoopback(req)) {
      if (!browserMarked(req)) return { actor: { type: 'builtin', name: 'local-cli' }, admin: false };
      // 本机页面：和管理口令设置那里的「本机」同一个口径——带浏览器标记的，Origin 要是本站；没有 Origin 或别的站按匿名
      if (sameSiteOrigin(req)) return { actor: { type: 'builtin', name: 'local-page' }, admin: false };
    }
    return { actor: { type: 'builtin', name: 'anonymous' }, admin: false };
  };
}

/** 迁移：第一次见到一个启用的人，给他一条 member；身份来源说他是管理员，再给 admin（同一个人同一个角色只迁一次） */
export function migrateOnSight(actor: JudgedActor, admin: boolean): void {
  if (actor.type === 'principal' && actor.kind === 'person' && actor.status === 'active') {
    grants().migrate(actor.id, 'member', '迁移：首次见到的人，默认成员');
    // 身份来源说是管理员的：今天什么都能看、能管，迁成系统管理员加管理层两条（等于今天的原样，各自能撤）；
    // 6d 之前由属主决定每个人留哪条（存量差异清单 F）
    if (admin) {
      grants().migrate(actor.id, 'admin', '迁移：身份来源说是管理员（系统管理）');
      grants().migrate(actor.id, 'management', '迁移：身份来源说是管理员（今天也看、改、拍板全公司的业务）');
    }
  }
}

/** 切换开关拒掉的请求（旧守卫没跑）：开关自己记进 judgment_enforced，这里不再比 */
export const enforcedDenials = new WeakSet<express.Request>();

export function mountJudgmentCompare(app: express.Express, config: CompareConfig, deps: CompareDeps, actorOf: ActorOf = actorResolver(deps)): void {
  if (!config.on) return;

  const stepOf = (req: express.Request): string | undefined => {
    if (!config.tagSteps) return undefined;
    const v = req.headers['x-replay-step'];
    return typeof v === 'string' && /^[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}\/[A-Za-z0-9_-]{1,80}$/.test(v) ? v : undefined;
  };
  function write(line: Record<string, unknown>): void {
    if (!config.out) return;
    try { appendFileSync(config.out, `${JSON.stringify(line)}\n`); } catch { /* 写不了文件不影响比对 */ }
  }

  async function compareOne(req: express.Request, res: express.Response, actorAtStart: Promise<{ actor: JudgedActor; admin: boolean }>, facts: RequestFacts): Promise<void> {
    const route = (req as express.Request & { route?: { path: unknown; [ACTION_KEY]?: ActionSpec } }).route;
    if (!route) return; // 没进路由（登录门、写请求总门、兜底）：不比
    const pattern = `${req.method} ${String(route.path)}`;
    const declared = route[ACTION_KEY];
    // 路由按请求细分的动作：取第一个 when 成立的（拿请求进来时的事实判）
    const refined = declared?.refine?.find((r) => { try { return r.when(req, facts); } catch { return false; } });
    const spec = declared && refined ? { ...declared, action: refined.action, kind: refined.kind } : declared;
    if (!spec) { compare().tally(pattern, '', 'unregistered'); write({ route: pattern, outcome: 'unregistered' , step: stepOf(req) }); return; }
    if (enforcedDenials.has(req)) { write({ route: pattern, action: spec.action, outcome: 'enforced-deny', status: res.statusCode, step: stepOf(req) }); return; }
    if (spec.statusNotVerdict) { compare().tally(pattern, spec.action, 'not-verdict'); write({ route: pattern, action: spec.action, outcome: 'not-verdict', status: res.statusCode, step: stepOf(req) }); return; }
    const old = oldVerdict(res.statusCode);
    if (old === 'deny' && crossMarked(req)) { compare().tally(pattern, spec.action, 'integrity-blocked'); write({ route: pattern, action: spec.action, outcome: 'integrity-blocked', status: res.statusCode, step: stepOf(req) }); return; }
    if (old === 'skip-404' || old === 'uncertain') {
      compare().tally(pattern, spec.action, old);
      write({ route: pattern, action: spec.action, outcome: old, status: res.statusCode , step: stepOf(req) });
      return;
    }
    // 身份在请求进来时就开始认（这里才等结果）：请求本身可能改了口令、注销了会话，事后再认会认错人
    const { actor, admin } = await actorAtStart;
    migrateOnSight(actor, admin);
    const result = judge({ actor, action: spec.action, kind: spec.kind, declared: true });
    const now = result.verdict === 'allow' ? 'allow' : 'deny';
    const actorKind = actor.type === 'builtin' ? actor.name : actor.kind;
    const outcome: Outcome = now === old ? 'agree' : 'mismatch';
    if (outcome === 'agree') compare().tally(pattern, spec.action, 'agree');
    else compare().mismatch({ route: pattern, action: spec.action, actorKind, old, new: result.verdict, rule: result.rule, status: res.statusCode, principal: actor.type === 'principal' ? actor.id : '', grant: result.grant ?? null });
    write({ route: pattern, action: spec.action, kind: spec.kind, outcome, actor: actorKind, old, new: result.verdict, rule: result.rule, status: res.statusCode , step: stepOf(req) });
  }

  app.use((req, res, next) => {
    if (deps.skip(req)) return next();
    const actorAtStart = actorOf(req).catch(() => ({ actor: { type: 'builtin', name: 'anonymous' } as JudgedActor, admin: false }));
    let facts: RequestFacts;
    try { facts = deps.facts(); } catch { facts = { adminTokenSet: true }; }
    res.on('finish', () => {
      compareOne(req, res, actorAtStart, facts).catch(() => {
        try { compare().tally(`${req.method} ${String((req as express.Request & { route?: { path: unknown } }).route?.path ?? '(没进路由)')}`, '', 'error'); } catch { /* 记不了也不影响请求 */ }
        write({ route: `${req.method} ${String((req as express.Request & { route?: { path: unknown } }).route?.path ?? '')}`, outcome: 'error' });
      });
    });
    next();
  });
}
