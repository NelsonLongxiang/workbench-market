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
import type { Kind, Permission } from './roles.ts';
import { ANONYMOUS_ACTIONS, builtin, narrowed, type BuiltinName } from './judgment-builtins.ts';

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

/** 一个角色（展开之后的权限）覆不覆盖这个动作 */
function permits(closure: Permission[], action: string, kind: Kind): { covers: boolean; scoped: boolean } {
  let scoped = false;
  for (const p of closure) {
    const hit = (p.kinds ?? []).includes(kind) || (p.actions ?? []).includes(action);
    if (!hit) continue;
    if (p.scope === undefined || p.scope === '*') return { covers: true, scoped: false };
    scoped = true;
  }
  return { covers: false, scoped };
}

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
    const ok = actor.type === 'builtin' ? narrow.only.includes(actor.name) : narrow.only.includes('owner') && isOwner(actor.id, now);
    return ok ? { verdict: 'allow', rule: `narrowed:${action}` } : { verdict: 'deny', rule: `narrowed:${action}` };
  }
  // 内置身份：按登记的清单
  if (actor.type === 'builtin') {
    const b = builtin(actor.name);
    // 3. 决定类：只有登记为「代属主行事」的放行，别的转提议
    if (kind === 'decide') return b.actsForOwner.includes(action) ? { verdict: 'allow', rule: `acts-for-owner:${b.name}` } : { verdict: 'ask', rule: 'decide-non-person' };
    if (b.actions.includes(action)) return { verdict: 'allow', rule: `builtin:${b.name}` };
    const role = b.role ? grants().roles().find((r) => r.id === b.role) : undefined;
    if (role && permits(role.closure, action, kind).covers) return { verdict: 'allow', rule: `builtin:${b.name}:${b.role}` };
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

/** 判一次：按 bail 派发，没有监听器给结论时用内置的六步（内置监听器装上之后不会走到这里） */
export function judge(input: JudgeInput): JudgeResult {
  return (root as unknown as { bail: (name: string, input: JudgeInput) => JudgeResult | undefined }).bail('judgment/judge', input) ?? judgeBuiltin(input);
}

/** 内置监听器：挂在根上下文上（effect，卸载时一起去掉） */
export function installBuiltinJudge(): void {
  root.effect(() => (root as unknown as { on: (name: string, fn: (input: JudgeInput) => JudgeResult) => () => void }).on('judgment/judge', (input) => judgeBuiltin(input)), 'judgment/judge(builtin)');
}
