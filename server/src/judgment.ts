/**
 * 判定（阶段六 6c）：一个 Cordis 事件 'judgment/judge'，按 bail 派发——第一个给出结论的监听器说了算。
 * 内置监听器照设计 11 第三节第 5 小节的六步判；企业特有的规则（比如按金额加一级审批）是另外的插件，prepend 挂在它前面，不改核心。
 *
 * 六步：
 *   1. 没有身份（匿名），或者主体不是启用的：拒绝。
 *   2. 动作没有声明（不在动作清单里）：拒绝。
 *   3. 动作类别是「决定」，而做的不是人（席位、系统身份、管理口令、本机命令行）：转成提议，先问人（ask）。
 *   4. 有生效的授予覆盖这个动作和范围：允许。主体是席位时，还要求它的责任人也有这项权限。
 *   5. 没有授予，但动作声明了可以申请：先问人。（现在还没有动作声明「可以申请」，这一步不会命中）
 *   6. 其余：拒绝。
 * 范围：这一步还不知道一次请求落在哪个资源上（哪个台、哪个域），所以只有范围是 * 的授予算覆盖；
 * domain:、bench:、sop:、tool:、self、object: 的授予记作「范围不明」，不算覆盖（并行比对里单列）。
 *
 * 内置身份（judgment-builtins.ts）不是主体：管理口令、本机命令行、本机页面、匿名。权限按动作逐条列出（管理口令另照管理员角色算），
 * 列的就是旧守卫今天放行的那些；决定类只有登记为「代属主行事」的放行，别的照第 3 步转提议。
 *
 * 两条补充（都进快照、登记在存量差异清单里）：
 *   · 收窄：少数动作比角色和清单更严，只有列出的几种身份能做（judgment-builtins.ts 的 NARROWED），在第 2 步之后先判；
 *   · 匿名的底：登录认出来的主体判不过时，匿名今天能做的照样允许——匿名能做的，登录的人当然也能做。
 *
 * 这一步只算结论、不生效：现有的守卫照旧决定请求放不放行；结论由并行比对（judgment-compare.ts）记下来和旧结论比。
 */
import { root } from './root-context.ts';
import { svc } from './context.ts';
import type { GrantService, GrantRow } from './services/grant.ts';
import type { PrincipalService } from './services/principal.ts';
import { AREA_SPEC_ACTION, permits, type Kind } from './roles.ts';
import { ANONYMOUS_ACTIONS, builtin, DEPT_AREA_TRANSITIONAL, scopedKind, narrowed, type BuiltinName } from './judgment-builtins.ts';
import type { AreaService } from './services/area.ts';

/** 做这件事的是谁 */
export type JudgedActor =
  | { type: 'builtin'; name: BuiltinName }
  | { type: 'principal'; id: string; kind: string; status: string; owner: string };
export type JudgeInput = { actor: JudgedActor; action: string; kind: Kind; declared: boolean; now?: number };
export type Verdict = 'allow' | 'ask' | 'deny';
export type JudgeResult = { verdict: Verdict; rule: string; grant?: number | null };

declare module '@deepseek-ai/cordis' {
  interface Events {
    'judgment/judge'(input: JudgeInput): JudgeResult | undefined;
  }
}

const grants = () => svc<GrantService>('grants');

/** 一个主体有没有覆盖这个动作的生效授予（只有范围是 * 的授予算覆盖） */
function grantFor(principal: string, action: string, kind: Kind, now: number): { grant: GrantRow | null; scoped: boolean } {
  const views = new Map(grants().roles().map((r) => [r.id, r]));
  let scoped = false;
  for (const g of grants().activeFor(principal, now)) {
    const role = views.get(g.role);
    if (!role) continue;
    const r = permits(role.closure, action, kind);
    if (r.covers && g.scope === '*') return { grant: g, scoped: false };
    if (r.covers || r.scoped) scoped = true;
  }
  return { grant: null, scoped };
}

/** 有没有生效的、范围是 * 的属主授予 */
function isOwner(principal: string, now: number): boolean {
  return grants().activeFor(principal, now).some((g) => g.role === 'owner' && g.scope === '*');
}

/** 内置的六步 */
export function judgeBuiltin(input: JudgeInput): JudgeResult {
  const now = input.now ?? Date.now();
  const { actor, action, kind } = input;
  // 1. 主体不是启用的
  if (actor.type === 'principal' && actor.status !== 'active') return { verdict: 'deny', rule: 'principal-inactive' };
  // 2. 动作没有声明
  if (!input.declared) return { verdict: 'deny', rule: 'action-undeclared' };
  // 收窄：只有列出的几种身份能做
  const narrow = narrowed(action);
  if (narrow) {
    const ok = actor.type === 'builtin' ? narrow.only.includes(actor.name)
      : (narrow.only.includes('person') && actor.kind === 'person') || (narrow.only.includes('owner') && isOwner(actor.id, now));
    return ok ? { verdict: 'allow', rule: `narrowed:${action}` } : { verdict: 'deny', rule: `narrowed:${action}` };
  }
  // 内置身份：按登记的清单
  if (actor.type === 'builtin') {
    const b = builtin(actor.name);
    // 3. 决定类：只有登记为「代属主行事」的放行，别的转提议
    if (kind === 'decide') return b.actsForOwner.includes(action) ? { verdict: 'allow', rule: `acts-for-owner:${b.name}` } : { verdict: 'ask', rule: 'decide-non-person' };
    if (b.actions.includes(action)) return { verdict: 'allow', rule: `builtin:${b.name}` };
    for (const id of b.roles ?? []) {
      const role = grants().roles().find((r) => r.id === id);
      if (role && permits(role.closure, action, kind).covers) return { verdict: 'allow', rule: `builtin:${b.name}:${id}` };
    }
    return { verdict: 'deny', rule: `builtin:${b.name}:not-listed` };
  }
  // 3. 决定类，做的不是人：转提议
  if (kind === 'decide' && actor.kind !== 'person') return { verdict: 'ask', rule: 'decide-non-person' };
  // 4. 有覆盖的授予
  const own = grantFor(actor.id, action, kind, now);
  if (own.grant) {
    if (actor.kind !== 'person') {
      // 席位等：责任人也要有这项权限
      const resp = actor.owner ? grantFor(actor.owner, action, kind, now) : { grant: null, scoped: false };
      if (!resp.grant) return { verdict: 'deny', rule: 'responsible-lacks-permission', grant: own.grant.id };
    }
    return { verdict: 'allow', rule: 'grant', grant: own.grant.id };
  }
  // 5. 可以申请（暂时没有动作这样声明）
  // 匿名的底：匿名今天能做的，登录的人也能做
  if (ANONYMOUS_ACTIONS.includes(action)) return { verdict: 'allow', rule: 'anonymous-floor' };
  // 6. 其余
  return { verdict: 'deny', rule: own.scoped ? 'grant-scope-unknown' : 'no-grant' };
}

/**
 * 部门范围的判定（对象范围接进统一判定之前的过渡，L13 的一部分；将来并进 judge）：
 * 这个主体有没有一条已放行、没过期、没撤销的授予，范围是 * 或者正好是这个部门（dept:<部门标识>），角色展开后的权限盖住这个动作和类别。
 *
 * 数据视图按部门放行台的读写、事项按部门定可见范围，都问这一处。约定：
 *   · 只认授予。部门成员表、部门负责人、团队认领、成员分配这些「关系」（team-relation.ts 的 relationOf）不带来权限，只能用来收窄；
 *     带业务写的授予要管理层或属主放行、带业务拍板的只有属主放行（services/grant.ts 的三档），所以系统管理员一个人造不出这里的 allow。
 *   · 内置身份（管理口令、本机命令行）不是主体，不经这里；调用方按自己的口径处理（数据视图先拒管理口令）。
 *   · 主体停用、待放行的授予、范围是别的部门的授予：deny。决定类只给人；席位的责任人也要有同一项权限（和 judge 第 3、4 步同口径）。
 *   · action、kind 由调用方给登记过的动作和它的类别，这里不查动作清单。
 */
/** exact：只认范围正好是 scope 的授予，不认范围「全部」的（经验库的部门级：人人都有一条范围「全部」的普通员工授予，那条不能让人看到每个部门的） */
export type ScopedInput = { principal: string; action: string; kind: Kind; scope: string; now?: number; exact?: boolean };
export type ScopedResult = { verdict: 'allow' | 'deny'; rule: string; grant: number | null };
const SCOPED_SCOPE = /^(dept|area):([a-z][a-z0-9-]{0,47})$/;

/** scopes：认哪几种范围（正好相等）；exact 为假时另认范围「全部」 */
function grantWithin(principal: string, action: string, kind: Kind, scopes: string | readonly string[], now: number, exact = false): GrantRow | null {
  const views = new Map(grants().roles().map((r) => [r.id, r]));
  const set = typeof scopes === 'string' ? [scopes] : scopes;
  for (const g of grants().activeFor(principal, now)) {
    if (!set.includes(g.scope) && (exact || g.scope !== '*')) continue;
    const role = views.get(g.role);
    if (role && permits(role.closure, action, kind).covers) return g;
  }
  return null;
}

/** 哪些角色的闭包覆盖这个动作（数持有人用：先按角色在库里筛主体，再逐个判） */
export function rolesCovering(action: string, kind: Kind): string[] {
  return grants().roles().filter((r) => permits(r.closure, action, kind).covers).map((r) => r.id);
}

/**
 * 范围 dept:<x> 或 area:<x> 上认哪几种授予范围（docs/domains-step1.md 第三节第 1 小节；第 1 步 PR3b）。台、经验库条目绑的是同一个标识 x：
 *   · 领域 x 在、没撤（active 或 pending-lead）：area:<x> 照认；过渡期 dept:<x> 也认，但只对 DEPT_AREA_TRANSITIONAL 里的动作；
 *   · 领域 x 撤了：一律不认（部门 x 的旧授予也跟着失效——领域撤了，这个组织就收了）；
 *   · 领域 x 不存在（部门还没迁成领域）：问的是 dept:<x> 就照旧只认 dept:<x>（和第 1 步之前一模一样）；问的是 area:<x> 就什么都不认。
 * 回认哪几种；不认回 null 和原因
 */
function scopesFor(scope: string, action: string): { scopes: string[] } | { deny: string } {
  const m = SCOPED_SCOPE.exec(scope);
  if (!m) return { deny: 'scope-unsupported' };
  const [, prefix, id] = m;
  const area = svc<AreaService>('areas').get(id);
  if (area?.status === 'retired') return { deny: 'area-retired' };
  const transitional = DEPT_AREA_TRANSITIONAL.includes(action);
  if (!area) return prefix === 'dept' ? { scopes: [`dept:${id}`] } : { deny: 'area-missing' };
  return { scopes: transitional ? [`area:${id}`, `dept:${id}`] : [`area:${id}`] };
}

export function scopedVerdict(input: ScopedInput): ScopedResult {
  const now = input.now ?? Date.now();
  if (!SCOPED_SCOPE.test(input.scope)) return { verdict: 'deny', rule: 'scope-unsupported', grant: null };
  // 只认登记过按范围问的动作，类别也要对得上（judgment-builtins.ts 的 ASKED）：矩阵照同一张表推「范围内」，没登记的问不出这一档
  if (scopedKind(input.action) !== input.kind) return { verdict: 'deny', rule: 'scope-not-declared', grant: null };
  const p = svc<PrincipalService>('principals').get(input.principal);
  if (!p || p.status !== 'active') return { verdict: 'deny', rule: 'principal-inactive', grant: null };
  if (input.kind === 'decide' && p.kind !== 'person') return { verdict: 'deny', rule: 'decide-non-person', grant: null };
  const which = scopesFor(input.scope, input.action);
  if ('deny' in which) return { verdict: 'deny', rule: which.deny, grant: null };
  const g = grantWithin(p.id, input.action, input.kind, which.scopes, now, input.exact === true);
  if (!g) return { verdict: 'deny', rule: 'no-grant', grant: null };
  if (p.kind !== 'person') {
    const resp = p.owner ? svc<PrincipalService>('principals').get(p.owner) : null;
    if (!resp || resp.status !== 'active' || !grantWithin(resp.id, input.action, input.kind, which.scopes, now, input.exact === true)) return { verdict: 'deny', rule: 'responsible-lacks-permission', grant: g.id };
  }
  return { verdict: 'allow', rule: g.scope === '*' ? 'grant' : g.scope.startsWith('area:') ? 'grant-area' : 'grant-dept', grant: g.id };
}

/**
 * 领域范围的判定（docs/domains-step1.md 第三节第 1 小节）：这个主体对领域 <area> 能不能做这个动作。
 *   · 只认范围正好是 area:<area> 的生效授予：范围「全部」的不算（人人都有一条范围「全部」的普通员工授予，那条不能让人看到每个领域）；
 *     属主、管理层这类看全部的由调用方另认（routes/areas.ts），不经这里；
 *   · 定规范（area.spec-set）是硬规则：只认角色正好是 area-spec 的授予，别的角色哪怕权限覆盖了它也不算；
 *   · 主体停用：deny；决定类只给人；席位的责任人也要有同一项权限（和 scopedVerdict 同口径）。
 * area 不做存在性检查（调用方先查领域在不在、撤没撤）
 */
export type AreaInput = { principal: string; action: string; kind: Kind; area: string; now?: number };
export function areaVerdict(input: AreaInput): ScopedResult {
  const now = input.now ?? Date.now();
  const scope = `area:${input.area}`;
  if (!/^area:[a-z][a-z0-9-]{0,47}$/.test(scope)) return { verdict: 'deny', rule: 'scope-unsupported', grant: null };
  const p = svc<PrincipalService>('principals').get(input.principal);
  if (!p || p.status !== 'active') return { verdict: 'deny', rule: 'principal-inactive', grant: null };
  if (input.kind === 'decide' && p.kind !== 'person') return { verdict: 'deny', rule: 'decide-non-person', grant: null };
  const within = (who: string): GrantRow | null => {
    if (input.action !== AREA_SPEC_ACTION) return grantWithin(who, input.action, input.kind, scope, now, true);
    return grants().activeFor(who, now).find((g) => g.scope === scope && g.role === 'area-spec') ?? null;
  };
  const g = within(p.id);
  if (!g) return { verdict: 'deny', rule: input.action === AREA_SPEC_ACTION ? 'area-spec-required' : 'no-grant', grant: null };
  if (p.kind !== 'person') {
    const resp = p.owner ? svc<PrincipalService>('principals').get(p.owner) : null;
    if (!resp || resp.status !== 'active' || !within(resp.id)) return { verdict: 'deny', rule: 'responsible-lacks-permission', grant: g.id };
  }
  return { verdict: 'allow', rule: 'grant-area', grant: g.id };
}

/** 判一次：按 bail 派发，没有监听器给结论时用内置的六步（内置监听器装上之后不会走到这里） */
export function judge(input: JudgeInput): JudgeResult {
  return (root as unknown as { bail: (name: string, input: JudgeInput) => JudgeResult | undefined }).bail('judgment/judge', input) ?? judgeBuiltin(input);
}

/** 内置监听器：挂在根上下文上（effect，卸载时一起去掉） */
export function installBuiltinJudge(): void {
  root.effect(() => (root as unknown as { on: (name: string, fn: (input: JudgeInput) => JudgeResult) => () => void }).on('judgment/judge', (input) => judgeBuiltin(input)), 'judgment/judge(builtin)');
}
