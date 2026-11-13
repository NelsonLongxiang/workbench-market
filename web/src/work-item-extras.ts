/** 事项的期限和附件（「安排一件事」填的，详情里看的、建立人能改的）：纯函数，不引别的文件，scripts/work-item-extras-unit.mjs 直接测。
 *  接口（阶段七 claude/stage7-arrange-due-attach）：
 *    · 列表每行、详情都带 due（YYYY-MM-DD 或 null）和 overdue（有期限、没到终态、过了那天）；没有 due 这个键的是旧服务端——什么都不画，不写「不限」；
 *    · 改期限 POST /api/work-items/<id>/due { due | null }，只有建立人；
 *    · 附件先传 PUT /api/work-items/attachments/<文件名>（原始字节），拿回 id，安排时带 attachments:[id…]（≤5）；
 *      详情 attachments:[{ id, name, size, mime, sha256, url }]，url 是 /api/work-items/<事项>/attachments/<附件>。 */

export type Attachment = { name: string; size: number | null; url: string };

/** 事项上的期限：YYYY-MM-DD 才认，别的（空、null、格式不对）当没有 */
export function dueOf(item: unknown): string | null {
  const d = item && typeof item === 'object' ? (item as { due?: unknown }).due : undefined;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
}

/** 服务端给没给期限这个字段（新服务端没有期限时给 null）：给了，没有期限才能说「不限」 */
export function hasDueField(item: unknown): boolean {
  return !!item && typeof item === 'object' && Object.hasOwn(item, 'due');
}
/** 过期了没有：照服务端给的 overdue（它知道终态），不自己算 */
export function overdueOf(item: unknown): boolean {
  return !!item && typeof item === 'object' && (item as { overdue?: unknown }).overdue === true;
}

/** 期限怎么说：日期加一句离今天多远。today 是本地日期 YYYY-MM-DD（页面传进来，测试好钉） */
export function dueLabel(due: string, today: string): string {
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days)) return due;
  if (days === 0) return `${due}（今天到期）`;
  return days > 0 ? `${due}（还有 ${days} 天）` : `${due}（过了 ${-days} 天）`;
}

/** 取件链接只认本站的 /api/ 地址（相对路径）：外链、带协议的、// 开头的都不给链接，免得点到别处 */
export function safeFileUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  return /^\/api\/[^\s]*$/.test(u) && !u.startsWith('//') && !/(^|\/)\.\.?(\/|$)/.test(u) ? u : null;
}

/** 事项上的附件：名字必须有；大小不是非负整数的当不知道；链接不安全的整条不要 */
export function attachmentsOf(item: unknown): Attachment[] {
  const a = item && typeof item === 'object' ? (item as { attachments?: unknown }).attachments : undefined;
  if (!Array.isArray(a)) return [];
  return a.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const r = x as { name?: unknown; size?: unknown; url?: unknown };
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const url = safeFileUrl(r.url);
    if (!name || !url) return [];
    const size = typeof r.size === 'number' && Number.isInteger(r.size) && r.size >= 0 ? r.size : null;
    return [{ name, size, url }];
  });
}

/** 文件大小：B / KB / MB / GB，一位小数；不知道写空串 */
export function sizeLabel(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = size / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** 一件事最多挂几个附件、单个多大（和服务端一样；先在页面上挡，服务端照样会验） */
export const ATTACH_MAX_FILES = 5;
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
/** 选了一个文件，传之前先挡：太大、超过个数。不挡的返回 null */
export function attachProblem(size: number, already: number): string | null {
  if (already >= ATTACH_MAX_FILES) return `最多挂 ${ATTACH_MAX_FILES} 个附件`;
  if (size > ATTACH_MAX_BYTES) return '单个附件不能超过 100 MB';
  if (size === 0) return '这个文件是空的';
  return null;
}
/** 传附件没传成时怎么说（状态码 + 服务端的 error 代号） */
export function uploadErrorText(status: number, code?: string): string {
  if (status === 0) return '连不上服务器，没传上';
  if (status === 401) return '请先登录';
  if (status === 404) return '附件的服务还没上线';
  if (status === 413) return '单个附件不能超过 100 MB';
  if (status === 415) return '这个文件的类型传不了';
  if (status === 429) return code === 'attachments_pending_bytes_limit' ? '你还没挂出去的附件太大了（合计不能超过 500 MB），先把这件事安排出去' : '你还没挂出去的附件太多了（最多 20 个），先把这件事安排出去';
  if (code === 'sha256_mismatch') return '文件在路上出了问题，请重传';
  if (status === 400) return '这种文件不能传（例如可执行文件）';
  return '没传上，稍后再试';
}
/** 改期限没改成时怎么说 */
export function dueErrorText(status: number, code?: string): string {
  if (status === 0) return '连不上服务器，没改成';
  if (status === 401) return '请先登录';
  if (status === 404) return '只有建立人能改期限';
  if (status === 409 || code === 'work_item_ended') return '这件事已经结束，不能再改期限';
  if (code === 'due_invalid') return '日期不对';
  return '没改成，稍后再试';
}

/** 期限能不能在这里改：照服务端给的 can.due（建立人本人、事项没到终态；和 POST /due 同一处判断，管理员不能代改）。
 *  没给 can.due（旧服务端）就不给「改」，页面不自己比是不是建立人 */
export function dueEditable(d: { can?: unknown } | null | undefined): boolean {
  const c = d?.can && typeof d.can === 'object' ? (d.can as Record<string, unknown>).due : undefined;
  return c === true;
}
