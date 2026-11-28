/** 数据集退役与恢复页（/bench-datasets/<台>，#1015 首版）的纯函数：应答整形、阻断的说法、占用、确认前的检查、凭据剩余时间、没成的说法。
 *  不碰网络、不碰 DOM，单测见 scripts/dataset-lifecycle-page-unit.mjs。谁能做、能不能做都由服务端说：页面只照应答显示。 */
import { crossOriginError } from './admin-token.ts';

export type LifecycleAction = 'retire' | 'restore';
export type ActiveDataset = { name: string; title: string; columns: number };
export type RetiredDataset = { name: string; title: string; row_count: number; data_bytes: number; revision: number };
export type Blocker = { kind: string; reason?: string; view?: string; block?: number; dimension?: string };
export type Precheck = { dataset: string; title: string; rows: number; bytes: number; state: string; blockers: Blocker[]; ticket: string | null; ticket_ref: string | null; expires_at: number | null };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** GET /datasets：在用的数据集。应答不像样回 null（当读取出错，不显示成「没有数据集」） */
export function asActive(body: unknown): ActiveDataset[] | null {
  const list = obj(body)?.datasets;
  if (!Array.isArray(list)) return null;
  const out: ActiveDataset[] = [];
  for (const d of list) {
    const o = obj(d);
    if (!o || !str(o.name)) return null;
    out.push({ name: str(o.name), title: str(o.title), columns: Array.isArray(o.columns) ? o.columns.length : 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /retired-datasets：已退役的数据集。应答不像样回 null */
export function asRetired(body: unknown): RetiredDataset[] | null {
  const list = obj(body)?.datasets;
  if (!Array.isArray(list)) return null;
  const out: RetiredDataset[] = [];
  for (const d of list) {
    const o = obj(d);
    const rows = num(o?.row_count), bytes = num(o?.data_bytes), rev = num(o?.revision);
    if (!o || !str(o.name) || rows === null || bytes === null || rev === null) return null;
    out.push({ name: str(o.name), title: str(o.title), row_count: rows, data_bytes: bytes, revision: rev });
  }
  return out;
}

/** 预检应答：有票必须同时有到期时刻；阻断必须是数组。不像样回 null */
export function asPrecheck(body: unknown): Precheck | null {
  const o = obj(body);
  if (!o || !str(o.dataset) || num(o.rows) === null || num(o.bytes) === null || !Array.isArray(o.blockers)) return null;
  const ticket = str(o.ticket) || null, expires = num(o.expires_at);
  if (ticket && expires === null) return null;
  const blockers = o.blockers.map(obj).filter((b): b is Record<string, unknown> => !!b && !!str(b.kind)).map((b) => ({
    kind: str(b.kind), ...(str(b.reason) ? { reason: str(b.reason) } : {}), ...(str(b.view) ? { view: str(b.view) } : {}),
    ...(num(b.block) !== null ? { block: num(b.block)! } : {}), ...(str(b.dimension) ? { dimension: str(b.dimension) } : {}),
  }));
  if (blockers.length !== o.blockers.length) return null;
  if (ticket && blockers.length) return null;
  return { dataset: str(o.dataset), title: str(o.title), rows: num(o.rows)!, bytes: num(o.bytes)!, state: str(o.state), blockers, ticket, ticket_ref: str(o.ticket_ref) || null, expires_at: ticket ? expires : null };
}

/** 一条阻断怎么说：写清在哪、下一步做什么。认不出的照实写，不当成没有阻断 */
export function blockerText(b: Blocker): string {
  if (b.kind === 'view') return `视图「${b.view ?? '？'}」第 ${(b.block ?? 0) + 1} 个块在用它：先在视图里改指别的数据集或删掉这个块，再预检`;
  if (b.kind === 'report' && b.reason === 'unresolvable') return `报告维度「${b.dimension ?? '？'}」的现行绑定解析不了：先改绑或停用生成，再预检`;
  if (b.kind === 'report') return `报告维度「${b.dimension ?? '？'}」的现行绑定用到它：先改绑到别的取数块或停用生成，再预检`;
  if (b.kind === 'state' && b.reason === 'already_retired') return '它已经退役了，不用再退役';
  if (b.kind === 'state' && b.reason === 'not_retired') return '它没有退役，不用恢复';
  if (b.kind === 'public_area') return '公共区的数据集首版不能退役';
  return `还有一项阻断（${b.kind}${b.reason ? '：' + b.reason : ''}），先处理再预检`;
}

/** 占用：字节 → 「12.3 KB」 */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 确认前：复述的名字要一字不差，理由 1～500 字。没问题回空串（服务端也核） */
export function confirmProblem(name: string, typed: string, reason: string): string {
  if (typed !== name) return `请一字不差地输入数据集名「${name}」`;
  if (!reason.trim()) return '请写理由，会留在审计记录里';
  if (reason.trim().length > 500) return '理由最多 500 个字';
  return '';
}

/** 操作号：一次确认一个，16 字节随机十六进制（服务端要 8～64 位字母数字、下划线或连字符） */
export function newOperationId(bytes: Uint8Array): string {
  return 'op-' + Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
}

/** 凭据还剩多久：「4:59」；过期回 null */
export function ticketLeft(expiresAt: number, now: number): string | null {
  const s = Math.floor((expiresAt - now) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 读清单、预检、确认没成时的说法：400、404、409 照服务端说；没登录、没权限、断网各一句；别的不透露原文 */
export function lifecycleError(status: number, body: unknown): string {
  const o = obj(body);
  const msg = str(o?.message);
  if (status === 400) return msg || '填的内容不对';
  if (status === 401) return '请先登录';
  if (status === 403) return crossOriginError(body) ?? '你不能退役或恢复这个台的数据集（要有范围「全部」的专用授予）';
  if (status === 404) return o?.error === 'bench_views_off' ? '这个实例没有开数据视图' : msg || '没有这个台，或者没有这个数据集';
  if (status === 409) return msg || '数据集已经变了，请重新预检';
  if (status === 429) return msg || '未用的确认凭据太多，稍后再试';
  if (status === 0) return '连不上服务，稍后再试';
  return '这次没成，稍后再试';
}

/** 确认时没收到应答：凭据可能已经用掉了，不自动重发，先刷新看结果 */
export const UNKNOWN_RESULT_TEXT = '没收到确认结果，可能已经办成了。已刷新清单，请先核对再决定要不要重新预检';

export const ACTION_TEXT: Record<LifecycleAction, { verb: string; done: string }> = {
  retire: { verb: '退役', done: '已退役' },
  restore: { verb: '恢复', done: '已恢复' },
};
