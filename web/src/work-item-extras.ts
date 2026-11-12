/** 事项的期限和附件（「安排一件事」填的，详情里看的）：纯函数，不引别的文件，scripts/work-item-extras-unit.mjs 直接测。
 *  服务端还没在事项详情里给这两样：字段到了才显示，没到什么都不画（不写「不限」——可能其实有期限，只是没给）。
 *  字段名先按约定的写：期限 due（YYYY-MM-DD，可空），附件 attachments（[{ name, size, url }]）；服务端定了别的名字，只改这里。 */

export type Attachment = { name: string; size: number | null; url: string };

/** 事项上的期限：YYYY-MM-DD 才认，别的（空、null、格式不对）当没有 */
export function dueOf(item: unknown): string | null {
  const d = item && typeof item === 'object' ? (item as { due?: unknown }).due : undefined;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
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
