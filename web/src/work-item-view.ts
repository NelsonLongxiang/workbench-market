/** 事项详情页的纯函数：不碰 React，scripts/work-item-detail-ui-unit.mjs 直接测。 */
import type { AttentionItem } from './attention-view';

/** 一句话说清事项现在卡在哪、该谁动：页面顶上的提示条。终态和正常进行中不出提示。 */
export function stateHint(state: string, seat: string, askAnswered = false): { type: 'info' | 'warning' | 'success'; text: string } | null {
  switch (state) {
    case 'draft': return { type: 'info', text: '这件事项还没提交，没有派给任何团队。' };
    case 'held': return { type: 'warning', text: '在等放行：管理员在「关注」里放行之后，才会派给团队。' };
    case 'delivered': return { type: 'info', text: '已经转交，在等团队接手。' };
    case 'accepted': return seat ? null : { type: 'info', text: '团队已经接手，还没说是哪个席位在做。' };
    case 'blocked': return askAnswered ? { type: 'info', text: '你已经答复，在等席位接着做。' } : { type: 'warning', text: '席位在问你：答复之后它才能接着做。' };
    case 'ready': return { type: 'success', text: '做完了，等建立人验收：通过就办完，退回就接着改。' };
    default: return null;
  }
}

/** 最近一个提问答过没有：日志里最后一条「答复」在最后一条「提问」之后（日志按 seq 递增） */
export function lastAskAnswered(log: { fact: string; rejected?: string }[]): boolean {
  let ask = -1, answer = -1;
  log.forEach((r, i) => { if (r.rejected) return; if (r.fact === 'ask') ask = i; if (r.fact === 'answer') answer = i; });
  return ask >= 0 && answer > ask;
}

/** 进展回执的步骤状态（阶段七 #551） */
export const PROGRESS_STATE: Record<string, string> = { queued: '排队中', working: '正在处理', waiting: '在等', blocked: '卡住了' };

export type Ticket = { id: string; title: string; seat?: string; state: string; outcome?: string };
export type SeatProgress = { n: number; state: string; summary: string; at: string; ahead?: number; by?: string; tickets: Ticket[]; received_at: string };

/** 进展一行字：第几步 · 状态 · 前面还有几个 */
export function progressLine(p: SeatProgress): string {
  return [`第 ${p.n} 步`, PROGRESS_STATE[p.state] ?? p.state, typeof p.ahead === 'number' && p.ahead > 0 ? `前面还有 ${p.ahead} 件` : ''].filter(Boolean).join(' · ');
}

export type Artifact = { kind: string; id: string; title?: string; url?: string };

/** 结果和依据（item.outputs / item.evidence）：服务端存的是字符串，多半是 JSON 数组。
 *  认得出的数组逐项取 kind / id / title / url；单个字符串项当一条；不是 JSON 的非空字符串整体当一条；空的返回空数组。 */
export function parseArtifacts(raw: string | null | undefined): Artifact[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  let v: unknown;
  try { v = JSON.parse(s); } catch { return [{ kind: 'text', id: s }]; }
  const list = Array.isArray(v) ? v : [v];
  const out: Artifact[] = [];
  for (const x of list) {
    if (typeof x === 'string' && x.trim()) out.push({ kind: 'text', id: x.trim() });
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '';
      const url = typeof o.url === 'string' ? o.url : undefined;
      if (!id && !url) continue;
      out.push({ kind: typeof o.kind === 'string' ? o.kind : 'item', id, ...(typeof o.title === 'string' ? { title: o.title } : {}), ...(url ? { url } : {}) });
    }
  }
  return out;
}

/** 产出能点的链接：只认同源路径（/ 开头、不是 //）和 http(s)；别的协议一律不给链接，只显示文字 */
export function artifactHref(a: Artifact): string | null {
  const u = a.url ?? '';
  if (/^\/(?!\/)/.test(u) || /^https?:\/\//i.test(u)) return u;
  return null;
}

/** 「关注」里属于这件事项的条目（席位提问、等验收、过目放行……）：按条目的 link 对上事项页 */
export function pendingFor(items: AttentionItem[], itemId: string): AttentionItem[] {
  const link = `/work-items/${itemId}`;
  return items.filter((x) => x.link === link || x.link === `/work-items/${encodeURIComponent(itemId)}`);
}
