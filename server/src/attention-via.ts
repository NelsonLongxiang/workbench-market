/**
 * 「关注」卡片经 answer_via 直接调来源自己的路由时，也记进「关注」的答复账，并且接受可选的 remember（记成经验）。
 * 这样「关注」的答复账是唯一的一本：「我处理过的」、补记成经验（POST /api/knowledge/remember）对两条路一样。
 *
 *   · 卡片发起的才记：条目的 answer_via 请求体里固定带 from_attention: true（attention-providers.ts 拼的），
 *     并且这一条此刻在这个人的「关注」列表里、列着这种答法（和 POST /api/attention/answer 同一个核法）。
 *     不带标记的（别处直接调接口）照旧：不记账，remember 也不看，行为和原来一样。
 *   · 先动作后记账：原动作成功（2xx）之后补一行已答的账（谁、哪件、答了什么、什么时候）。记账失败不回滚原动作，
 *     留一条告警日志（attention-via-record-failed）。
 *   · remember：形状不对在动作之前就拒（400 remember_invalid，动作不发生）；记不记得上不挡动作。
 *     判定、范围、写入和 POST /api/attention/answer 是同一处（knowledge-remember.ts 的 rememberAnswer）。
 *   · 记账的键和答复入口一样取来源的 key（事项是「编号:那一轮」），在动作之前算好。答的人和答复入口一样取 actorOf。
 */
import type express from 'express';
import { svc } from './context.ts';
import { itemsOf, VIA_MARK, type AttentionService } from './services/attention.ts';
import { actorOf } from './attention-answers.ts';
import { parseRemember, rememberAnswer, type RememberRequest } from './knowledge-remember.ts';
import type { JudgedActor } from './judgment.ts';

export { VIA_MARK };

export type ViaPlan = { source: string; sourceId: string; answer: string; key: string; by: string; title: string; remember: Omit<RememberRequest, 'source' | 'sourceId'> | null };
export type ViaStart = { ok: true; plan: ViaPlan | null } | { ok: false; status: 400; body: { error: string; message: string } };

const bodyOf = (req: express.Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

/**
 * 动作之前调：不是卡片发起的（没带标记）plan 为 null，什么都不做；带了标记的，remember 形状不对回 400（调用方照原样回、不做动作）；
 * 这一条不在这个人的「关注」里、或者没列这种答法：plan 照样给，但不记账（record 为假由 key 为空表示），remember 到时回 404 的说法
 */
export async function viaBegin(req: express.Request, source: string, sourceId: string, answer: string): Promise<ViaStart> {
  const b = bodyOf(req);
  if (b[VIA_MARK] !== true) return { ok: true, plan: null };
  const remember = b.remember === undefined ? null : parseRemember(b.remember);
  if (remember && !remember.ok) return { ok: false, status: 400, body: { error: 'remember_invalid', message: remember.message } };
  const attention = svc<AttentionService>('attention');
  const provider = attention.provider<express.Request>(source);
  const items = provider ? itemsOf(await provider.list(req)) : null;
  const hit = items?.find((x) => x.source_id === sourceId && x.answers.includes(answer));
  const key = hit ? (provider!.key ? await provider!.key(sourceId) : sourceId) : '';
  return { ok: true, plan: { source, sourceId, answer, key, by: hit ? await actorOf(req) : '', title: hit?.title ?? '', remember: remember?.ok ? remember.value : null } };
}

/**
 * 动作之后调：成功（2xx）的记一行账（记不上只告警），再按 remember 记成经验。返回给应答带上的 remember 部分（没要求记的为 undefined）
 * rememberActor：记成经验认人（和答复入口同一个 actorResolver）
 */
export async function viaSettle(req: express.Request, plan: ViaPlan | null, status: number, body: unknown, rememberActor: (req: express.Request) => Promise<{ actor: JudgedActor }>): Promise<Record<string, unknown> | undefined> {
  if (!plan || status < 200 || status >= 300) return undefined;
  if (plan.key) {
    try { svc<AttentionService>('attention').recordAnswered(plan.source, plan.key, plan.answer, plan.by, status, body); }
    catch (e) { console.warn(JSON.stringify({ source: 'attention', event: 'attention-via-record-failed', from: plan.source, answer: plan.answer, error: String((e as Error)?.message ?? e).slice(0, 200), at: new Date().toISOString() })); }
  }
  if (!plan.remember) return undefined;
  const r = await rememberAnswer((await rememberActor(req)).actor, { source: plan.source, sourceId: plan.sourceId, ...plan.remember }, plan.title);
  return r.ok ? { status: r.outcome.status, duplicate: r.outcome.duplicate, scope_label: r.scope_label } : { status: 'refused', error: r.error, message: r.message };
}
