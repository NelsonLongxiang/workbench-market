/**
 * 经验库第 2 步：拍板时「把这次的取舍记成经验」。「关注」的答复入口（带 remember）和 POST /api/knowledge/remember（答完以后补记）都走这一处。
 *
 *   · 谁能记：答这一条的人本人——登录的、启用的人，并且统一判定说他能对经验库拍板（knowledge.remember，拍板类：管理层、属主）。
 *     系统管理员（预设没有业务的拍板）、管理口令、本机命令行都不能记。
 *   · 记哪一次：他在「关注」的答复账上最近 REMEMBER_WINDOW_HOURS 小时内答成过的这一条（答复入口刚答完的也在账上）。没答过、别人答的，一律当没有。
 *   · 可见范围：明确选「全公司」写 *、「只给管理层」写 restricted、「部门」要推得出部门；不选时取这件事所在团队的部门（事项、席位提问），
 *     推不出（不是事项、团队没认领、对到好几个部门）就只给管理层。全公司只在明确选时写。
 *   · 写到哪：回写 ygl-trees 的 kb（KnowledgeService.remember），市场只留指针和留痕；写不上不挡答复，进待写队列后台重试。
 */
import { svc } from './context.ts';
import { judge, type JudgedActor } from './judgment.ts';
import type { AttentionService } from './services/attention.ts';
import type { KnowledgeService, RememberOutcome } from './services/knowledge.ts';
import { REMEMBER_WINDOW_HOURS } from './services/knowledge.ts';
import type { WorkItemService, WorkItemRow } from './services/work-item.ts';
import type { TeamService } from './services/team.ts';
import type { DepartmentService } from './services/department.ts';
import { itemTeams } from './work-item-access.ts';
import { itemOfAsk } from './attention-answers.ts';

export type RememberRequest = { source: string; sourceId: string; cue?: string; lesson: string; visibility?: 'company' | 'department' | 'restricted' };
export type RememberResult = { ok: true; outcome: RememberOutcome; scope_label: string } | { ok: false; http: 400 | 403 | 404; error: string; message: string };

/** 请求体里的 remember 部分：形状不对返回说法（调用方在答复之前就拒，答复不会生效） */
export function parseRemember(v: unknown): { ok: true; value: Omit<RememberRequest, 'source' | 'sourceId'> } | { ok: false; message: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: 'remember 要是对象：{ lesson, cue?, visibility? }' };
  const o = v as Record<string, unknown>;
  const lesson = typeof o.lesson === 'string' ? o.lesson.trim() : '';
  if (!lesson || lesson.length > 500) return { ok: false, message: 'lesson（以后遇到类似情况怎么办）必填，1～500 字' };
  if (o.cue !== undefined && (typeof o.cue !== 'string' || !o.cue.trim() || o.cue.length > 200)) return { ok: false, message: 'cue（这件事是什么情况）要是 1～200 字' };
  if (o.visibility !== undefined && !['company', 'department', 'restricted'].includes(o.visibility as string)) return { ok: false, message: 'visibility 只能是 company、department、restricted' };
  return { ok: true, value: { lesson, ...(typeof o.cue === 'string' ? { cue: o.cue.trim() } : {}), ...(o.visibility ? { visibility: o.visibility as RememberRequest['visibility'] } : {}) } };
}

/** 这一条对到的事项（事项、停太久的事项、席位提问）；别的来源没有 */
function itemOf(source: string, sourceId: string): WorkItemRow | undefined {
  if (source === 'work-items' || source === 'work-items-stuck') return svc<WorkItemService>('workItems').get(sourceId);
  if (source === 'seat-asks') return itemOfAsk(sourceId);
  return undefined;
}

/** 这件事所在团队的部门（事项、席位提问对到的团队，团队认领了的那个部门）；推不出、对到好几个部门都是 null */
function departmentOf(source: string, sourceId: string): string | null {
  const item = itemOf(source, sourceId);
  if (!item) return null;
  const depts = new Set<string>();
  for (const k of itemTeams(item)) {
    const reg = svc<TeamService>('teams').registration(k);
    if (reg?.claimed && reg.department_id && svc<TeamService>('teams').status(k) !== 'unclaimed') depts.add(reg.department_id);
  }
  return depts.size === 1 ? [...depts][0] : null;
}

const SCOPE_LABEL = (scope: string): string => (scope === '*' ? '全公司' : scope === 'restricted' ? '只给管理层' : '部门');

/** 能不能记成经验（不看是哪一条）：登录的、启用的人，并且统一判定说他能对经验库拍板。/api/auth/me 的 can.remember_knowledge 和记成经验用的都是这一处 */
export function rememberRefusal(actor: JudgedActor): { error: string; message: string } | null {
  if (actor.type !== 'principal' || actor.kind !== 'person' || actor.status !== 'active') return { error: 'remember_not_allowed', message: '只有登录的人能记成经验（管理口令、本机命令行不能）' };
  if (judge({ actor, action: 'knowledge.remember', kind: 'decide', declared: true }).verdict !== 'allow') return { error: 'remember_not_allowed', message: '记成经验要有对经验库拍板的授予（管理层、属主）' };
  return null;
}
/** 账上答这一条的人可能的几种写法：会话登录的管理员记成 odoo:<登录名>，别的记成主体标识 */
const answerersOf = (id: string): string[] => [id, ...(id.startsWith('user:') ? [`odoo:${id.slice(5)}`] : [])];

/** 答法给人看的说法（「关注」各来源的答法）；没列的原样 */
const ANSWER_TEXT: Record<string, string> = { release: '放行', withdraw: '撤回', verify: '验收', return: '退回', approve: '批准', reject: '驳回', answer: '答复', bind: '对接' };
/** 账上的键去掉「:那一轮」「@出现序号」的后缀，得到条目的 id（和「关注」里的 source_id 同一个） */
function baseIdOf(source: string, key: string): string {
  if (source === 'principal-pending') { const at = key.lastIndexOf('@'); return at > 0 ? key.slice(0, at) : key; }
  if (source === 'work-items' || source === 'seat-asks' || source === 'owner-pending') { const c = key.indexOf(':'); return c > 0 ? key.slice(0, c) : key; }
  return key;
}

/**
 * 这个人 48 小时内答过的条目（「我处理过的」，补记成经验的入口）：来源、条目 id、标题（对得到事项的给事项标题，别的 null）、答法和它的说法、
 * 什么时候答的（ISO）、记成经验了没有（没记 null，记了给状态）、缺省会记成哪一档范围
 */
export function recentAnswers(actor: JudgedActor): { source: string; source_id: string; title: string | null; answer: string; answer_text: string; answered_at: string; remembered: RememberOutcome['status'] | null; default_visibility: 'department' | 'restricted'; department_name: string | null }[] {
  if (actor.type !== 'principal') return [];
  const rows = svc<AttentionService>('attention').answersBy(answerersOf(actor.id), REMEMBER_WINDOW_HOURS);
  const keyOf = (r: { source: string; key: string }) => `${r.source}\u0000${r.key}\u0000${actor.id}`;
  const done = svc<KnowledgeService>('knowledge').rememberedOf(rows.map(keyOf));
  return rows.map((r) => {
    const id = baseIdOf(r.source, r.key);
    const d = defaultVisibility(r.source, id);
    return {
      source: r.source, source_id: id, title: itemOf(r.source, id)?.title ?? null, answer: r.answer, answer_text: ANSWER_TEXT[r.answer] ?? r.answer,
      answered_at: new Date(`${r.at.replace(' ', 'T')}Z`).toISOString(), remembered: done.get(keyOf(r)) ?? null, ...d,
    };
  });
}

/** 不选范围时会记成哪一档：推得出部门是「部门」（给部门名），推不出「只给管理层」 */
export function defaultVisibility(source: string, sourceId: string): { default_visibility: 'department' | 'restricted'; department_name: string | null } {
  const d = departmentOf(source, sourceId);
  if (!d) return { default_visibility: 'restricted', department_name: null };
  return { default_visibility: 'department', department_name: svc<DepartmentService>('departments').get(d)?.name ?? null };
}

export async function rememberAnswer(actor: JudgedActor, req: RememberRequest, fallbackCue = ''): Promise<RememberResult> {
  const refused = rememberRefusal(actor);
  if (refused) return { ok: false, http: 403, ...refused };
  if (actor.type !== 'principal') return { ok: false, http: 403, error: 'remember_not_allowed', message: '只有登录的人能记成经验' };
  const bys = answerersOf(actor.id);
  const hit = svc<AttentionService>('attention').answeredRecently(req.source, req.sourceId, bys, REMEMBER_WINDOW_HOURS);
  if (!hit) return { ok: false, http: 404, error: 'remember_answer_not_found', message: `没有找到这个人 ${REMEMBER_WINDOW_HOURS} 小时内答过的这一条` };
  let scope: string;
  if (req.visibility === 'company') scope = '*';
  else if (req.visibility === 'restricted') scope = 'restricted';
  else {
    const d = departmentOf(req.source, req.sourceId);
    if (req.visibility === 'department' && !d) return { ok: false, http: 400, error: 'remember_department_unknown', message: '推不出这件事所在的部门：选「只给管理层」或「全公司」' };
    scope = d ? `dept:${d}` : 'restricted';
  }
  const k = svc<KnowledgeService>('knowledge');
  const answerKey = `${req.source}\u0000${hit.key}\u0000${actor.id}`;
  // 这件事是什么情况：调用方给的；没给就用「关注」条目的标题，再没有用对到的事项的标题
  const cue = req.cue ?? (fallbackCue.trim() || itemOf(req.source, req.sourceId)?.title.trim() || `「关注」里的一次拍板（${hit.answer}）`);
  const outcome = await k.remember({ answerKey, principal: actor.id, scope, cue, lesson: req.lesson, evidence: k.evidenceRef(answerKey) });
  return { ok: true, outcome, scope_label: SCOPE_LABEL(scope) };
}
