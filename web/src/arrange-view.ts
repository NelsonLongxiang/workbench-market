/** 「安排一件事」的纯函数（不碰 React，scripts/arrange-ui-unit.mjs 直接测）。
 *  接口：GET /api/work-items/teams（可派的团队）、POST /api/work-items（建一件事，#577）。 */

export type Team = { team: string; name: string };
export type ArrangeForm = { title: string; intent: string; deliverable: string; team: string; object: string; phase: string; review: boolean; due: string };
export const EMPTY_FORM: ArrangeForm = { title: '', intent: '', deliverable: '', team: '', object: '', phase: '', review: true, due: '' };
export const LIMITS = { title: 200, intent: 4000, deliverable: 2000, object: 200, phase: 200 } as const;

/** 团队怎么显示：有名字就写名字；名册落地前 name 就等于 team，这时按 people.ts 的 teamLabel 同一规则：
 *  画布团队（<区>/canvas/<名字>）显示名字，进程团队没有名字显示句柄。（这里不 import people.ts：单测由 Node 直接加载，只能引类型） */
export const teamOption = (t: Team): string => {
  if (t.name && t.name !== t.team) return t.name;
  const m = /^[^/]+\/canvas\/(.+)$/.exec(t.team || '');
  return m ? m[1] : t.team;
};

/** 提交前在页面上先挡一遍（服务端照样会验）：键是表单字段，值是一句人话 */
export function validate(f: ArrangeForm, teams: Team[]): Partial<Record<keyof ArrangeForm, string>> {
  const e: Partial<Record<keyof ArrangeForm, string>> = {};
  const len = (s: string) => [...s.trim()].length;
  if (!f.title.trim()) e.title = '写一个标题'; else if (len(f.title) > LIMITS.title) e.title = `标题最多 ${LIMITS.title} 字`;
  if (!f.intent.trim()) e.intent = '写一下要做什么'; else if (len(f.intent) > LIMITS.intent) e.intent = `最多 ${LIMITS.intent} 字`;
  if (!f.deliverable.trim()) e.deliverable = '写一下要交什么'; else if (len(f.deliverable) > LIMITS.deliverable) e.deliverable = `最多 ${LIMITS.deliverable} 字`;
  if (!f.team) e.team = '选一个团队'; else if (!teams.some((t) => t.team === f.team)) e.team = '这个团队现在不能派';
  if (len(f.object) > LIMITS.object) e.object = `最多 ${LIMITS.object} 字`;
  if (len(f.phase) > LIMITS.phase) e.phase = `最多 ${LIMITS.phase} 字`;
  if (f.due && !/^\d{4}-\d{2}-\d{2}$/.test(f.due)) e.due = '日期写成 2026-11-30 这样';
  return e;
}

/** 请求体：去掉首尾空白；可选的空着就不带 */
export function buildBody(f: ArrangeForm, key: string): Record<string, unknown> {
  const b: Record<string, unknown> = { title: f.title.trim(), intent: f.intent.trim(), deliverable: f.deliverable.trim(), team: f.team, review: f.review, idempotency_key: key };
  if (f.object.trim()) b.object = f.object.trim();
  if (f.phase.trim()) b.phase = f.phase.trim();
  if (f.due) b.due = f.due;
  return b;
}

/** 幂等键：每次点「安排」生成一个；同一份内容的重试（网络断了、超时）用同一个，内容改了就换新的 */
export function newKey(rand: () => number = Math.random): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'wm_';
  for (let i = 0; i < 29; i++) s += a[Math.floor(rand() * a.length) % a.length];
  return s;
}
export function keyFor(prev: { body: string; key: string } | null, form: ArrangeForm, make: () => string = newKey): { body: string; key: string } {
  const body = JSON.stringify(buildBody(form, ''));
  return prev && prev.body === body ? prev : { body, key: make() };
}

export type Created = { item_id?: string; held?: boolean; duplicate?: boolean; reason?: string };
/** 建好之后的一句话 */
export function resultText(r: Created): string {
  if (r.reason === 'review_required_by_policy') return '已安排。你选了不先过目，但现在还不能直接派出去，会先给管理员过目。';
  if (r.held) return '已安排，等管理员放行后派出去。';
  return r.duplicate ? '这件事刚才已经安排过了。' : '已安排，已经派出去了。';
}

/** 没建成的一句话：按状态码和 error 说人话 */
const ERR: Record<string, string> = {
  title_required: '写一个标题', title_too_long: `标题最多 ${LIMITS.title} 字`, intent_required: '写一下要做什么', deliverable_required: '写一下要交什么',
  team_required: '选一个团队', team_not_assignable: '这个团队现在不能派，换一个', object_invalid: '「挂在哪条线」写得不对', phase_invalid: '「哪一步」写得不对',
  due_invalid: '期限的日期不对', review_invalid: '「先给我过目」的值不对', idempotency_key_invalid: '页面出了点问题，刷新后再试',
};
export function errorText(status: number, body: { error?: string; window?: string; limit?: number } | null): string {
  if (status === 0) return '连不上服务器，检查网络后再点一次（不会重复安排）';
  if (status === 401) return '请先登录';
  if (status === 403) return '你的账号现在不能安排事情';
  if (status === 404) return '「安排一件事」的服务还没上线';
  if (status === 409) return '这次提交和刚才那次内容不一样，请再点一次';
  if (status === 429) return body?.window === 'day' ? `今天安排得太多了（每天最多 ${body.limit ?? '若干'} 件），明天再来` : '安排得太快了，过一分钟再试';
  if (status === 400 && body?.error && ERR[body.error]) return ERR[body.error];
  return '没安排成，稍后再试';
}

/** 读可派团队没读到时的一句话。接口没上线时，旧的 /api/work-items/:id 会把 teams 当事项 id，答 400；所以 400、404 都算「还没上线」 */
export function teamsBlockedText(status: number): { text: string; type: 'info' | 'warning' } {
  if (status === 401) return { text: '请先登录', type: 'warning' };
  if (status === 403) return { text: '你的账号现在不能安排事情', type: 'warning' };
  if (status === 400 || status === 404 || status === 405) return { text: '「安排一件事」的服务还没上线', type: 'info' };
  if (status === 0) return { text: '连不上服务器，读不到可以派的团队', type: 'warning' };
  return { text: '读不到可以派的团队，稍后再试', type: 'warning' };
}
