/**
 * 事项上「这个人能做什么、是不是轮到他」——事项详情（GET /api/work-items/:id 的 can、turn、creator）和「关注」（每条的 mine、creator）用。
 *
 * can 的每一项和对应动作接口用同一处判断，不另写规则：
 *   release  管理员（adminGuard，和 POST /api/workbench-events/:id/release 同一个守卫）、事项在 held、releaseBlock 放行（事件在、任务没撤回）
 *   verify   事项在 ready，并且：管理员（「关注」里答 verify），或者建立人本人（writerVerdict 是 ok，和 POST /api/work-items/:id/decision 同一处）
 *   reply    事项不在终态，有可回复的席位消息（replyableMessages，和回复接口同一个判断），并且 writerVerdict 是 admin 或 ok（和回复接口的认人同一处）
 *   answer   事项不在终态，有在等答复的提问（pendingAsksOfEvent，和「关注」里答席位提问同一个定义），并且是管理员
 *            （建立人答提问的入口在阶段七 #567，合并后这里改成 writerVerdict，另一个小 PR）
 *
 * turn（是不是轮到这个人）只有两句：answer、verify 轮到的是建立人；release 轮到的是有放行权限的人。
 * can 为真而 turn 为假，就是「能代办」。
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { isCreator, type WorkItemRow, type WorkItemService } from './services/work-item.ts';
import type { PrincipalService } from './services/principal.ts';
import { pendingAsksOfEvent } from './services/attention-sources.ts';
import { eventOfItem, replyableMessages } from './seat-messages.ts';
import { releaseBlock } from './workbench-events.ts';

/** 终态：事项不再往下走，不能再回复、答复、验收 */
export const TERMINAL_STATES: readonly string[] = ['done', 'failed', 'dropped', 'cancelled'];

export type WorkItemViewer = { admin: boolean; principal: string | null; person: boolean; actor: string };

/** 不落地的应答：管理门判不过时写的 403 写到这里 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return res as unknown as express.Response;
}

/** 看的人是谁：管理员（和各动作接口同一个管理门）、登录认出来的主体、是不是启用的人 */
export async function workItemViewer(req: express.Request, deps: { markOdooAdmin: (req: express.Request) => Promise<void>; adminGuard: (req: express.Request, res: express.Response) => boolean; adminActor?: (req: express.Request) => string }): Promise<WorkItemViewer> {
  await deps.markOdooAdmin(req);
  const admin = deps.adminGuard(req, silentRes());
  let principal: string | null = null, person = false;
  const cookie = String(req.headers.cookie ?? '');
  if (cookie) {
    const who = await identity().resolveViewer(cookie);
    if (who.ok) {
      principal = who.viewer.sub;
      const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | undefined;
      person = !!p && p.kind === 'person' && p.status === 'active';
    }
  }
  return { admin, principal, person, actor: admin ? (deps.adminActor?.(req) ?? 'admin') : principal ?? 'anonymous' };
}

/**
 * 写事项对话、验收的人是谁（只有这一处）：管理员 → admin；没登录 → unauthenticated；不是建立人 → not_found；
 * 主体不是启用的人 → inactive；建立人但事项不能由建立人处理 → not_eligible；ok。
 */
export type WriterVerdict = 'admin' | 'unauthenticated' | 'inactive' | 'not_found' | 'not_eligible' | 'ok';
export function writerVerdict(viewer: WorkItemViewer, itemId: string, allowAdmin = true): WriterVerdict {
  if (allowAdmin && viewer.admin) return 'admin';
  if (!viewer.principal) return 'unauthenticated';
  // 顺序和对话写入口原来一样：不是建立人先 404（不说有没有这件），再看主体启用没有，再看能不能由建立人处理
  const verdict = svc<WorkItemService>('workItems').creatorCheck(itemId, viewer.principal);
  if (verdict === 'not_found') return 'not_found';
  if (!viewer.person) return 'inactive';
  return verdict;
}

export type Can = { release: boolean; answer: boolean; verify: boolean; reply: boolean };
export type Turn = { release: boolean; answer: boolean; verify: boolean };

const pendingAsks = (item: WorkItemRow): number => { const ev = eventOfItem(item); return ev ? pendingAsksOfEvent(ev).length : 0; };
const releasable = (item: WorkItemRow): boolean => { const ev = eventOfItem(item); return item.state === 'held' && !!ev && releaseBlock(ev) === null; };

export function canOf(item: WorkItemRow, viewer: WorkItemViewer): Can {
  const live = !TERMINAL_STATES.includes(item.state);
  const creatorOk = writerVerdict(viewer, item.id, false) === 'ok';
  return {
    release: viewer.admin && releasable(item),
    answer: live && viewer.admin && pendingAsks(item) > 0,
    verify: item.state === 'ready' && (viewer.admin || creatorOk),
    reply: live && (viewer.admin || creatorOk) && replyableMessages(item).length > 0,
  };
}

/** 是不是轮到这个人：answer、verify 轮到建立人；release 轮到有放行权限的人（管理员）。只在事情确实在等的时候为真 */
export function turnOf(item: WorkItemRow, viewer: WorkItemViewer): Turn {
  const live = !TERMINAL_STATES.includes(item.state);
  const mine = viewer.principal !== null && isCreator(item, viewer.principal);
  return {
    release: viewer.admin && releasable(item),
    answer: live && mine && pendingAsks(item) > 0,
    verify: item.state === 'ready' && mine,
  };
}

/** 建立人：主体和显示名（主体表里的显示名，认人时从登录提供方写进去的；没有就是 null，前端退回显示登录名）。建立人空着是 null */
export function creatorOf(item: Pick<WorkItemRow, 'creator_principal'>): { principal: string; display_name: string | null } | null {
  const p = item.creator_principal;
  if (!p) return null;
  const row = svc<PrincipalService>('principals').get(p) as { display_name?: string } | undefined;
  const name = typeof row?.display_name === 'string' && row.display_name.trim() !== '' ? row.display_name : null;
  return { principal: p, display_name: name };
}
