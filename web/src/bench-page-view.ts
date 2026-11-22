/** 视图台页面（/use/<卡片 id>）的纯函数：入口应答怎么走、地址里的视图和筛选、表单交不上时说什么。
 *  打开一张卡片先问入口（GET /api/bench-views/<卡片 id>/entry）：
 *  200 是视图台、读得到，画数据视图；404 一律照原来的方式打开卡片（读不到的、不存在的、没开台库的、没有视图的应答逐字一样，这里也不分）；
 *  401 去登录；403 是只带管理口令或跨站；别的（5xx、断网）读不到，给「再试一次」。 */
import type { BenchEntry } from './api';

export type EntryOutcome =
  | { kind: 'bench'; entry: BenchEntry }
  | { kind: 'card' }
  | { kind: 'error' };

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** 入口应答的形状核一遍：视图至少一份、键和标题都是文字，键不重复；对不上当读不到（不猜） */
export function asEntry(body: unknown): BenchEntry | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<BenchEntry>;
  if (!b.bench || typeof b.bench !== 'object' || !isStr(b.bench.title)) return null;
  if (typeof b.version !== 'number' || !Array.isArray(b.views) || b.views.length === 0) return null;
  const keys = new Set<string>();
  for (const v of b.views) {
    if (!v || !isStr(v.key) || !isStr(v.title) || keys.has(v.key)) return null;
    keys.add(v.key);
  }
  const rename = (b.can as { rename?: unknown } | undefined)?.rename === true;
  // 卡片名只在能改名时留着（「跟卡片同名」用），写法不对当没有
  const { card_title: card, ...bench } = b.bench as BenchEntry['bench'];
  if (rename && (typeof card === 'string' || card === null)) (bench as BenchEntry['bench']).card_title = card;
  return { bench, version: b.version, title: isStr(b.title) ? b.title : b.bench.title, default_view: isStr(b.default_view) && keys.has(b.default_view) ? b.default_view : b.views[0].key, views: b.views,
    // 能不能改台名：服务端说是 true 才算（缺了、写法不对都当不能，按钮不出）
    // MCP 管理页（#904）、报告（PR D）：同样只认 true
    can: { rename, mcp: (b.can as { mcp?: unknown } | undefined)?.mcp === true, mcp_decide: (b.can as { mcp_decide?: unknown } | undefined)?.mcp_decide === true,
      reports: (b.can as { reports?: unknown } | undefined)?.reports === true, respond: (b.can as { respond?: unknown } | undefined)?.respond === true } };
}

export function entryOutcome(status: number, body: unknown): EntryOutcome {
  if (status === 200) { const entry = asEntry(body); return entry ? { kind: 'bench', entry } : { kind: 'error' }; }
  // 404（不是视图台、不存在）、401（没登录）、403（只带管理口令、跨站）都照原来打开卡片：入口缺省开着以后，
  // 普通卡片不能因为问了一下入口就被拦成「去登录」。入口先判权、不透露哪张卡片是视图台，这一点不变（属主 2026-11-16 选的兜底）
  if (status === 404 || status === 401 || status === 403) return { kind: 'card' };
  return { kind: 'error' };
}

/** 地址里的视图：?v=<键>；认不出、没写的用默认那一份 */
export function viewFromQuery(entry: BenchEntry, q: URLSearchParams): string {
  const v = q.get('v');
  return v && entry.views.some((x) => x.key === v) ? v : entry.default_view;
}

/** 地址里的筛选：p.<字段>=<值>，空值不算 */
export function paramsFromQuery(q: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of q) if (k.startsWith('p.') && k.length > 2 && v !== '') out[k.slice(2)] = v;
  return out;
}

/** 写回地址：默认视图不写 v；换视图时筛选清掉（各份视图的筛选项不一定一样） */
export function toQuery(entry: BenchEntry, view: string, params: Record<string, string>): string {
  const q = new URLSearchParams();
  if (view !== entry.default_view) q.set('v', view);
  for (const [k, v] of Object.entries(params)) if (v !== '') q.set(`p.${k}`, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 浏览器标签页的标题：视图描述的标题；和台名不同时带上台名 */
export function pageTitle(entry: BenchEntry): string {
  return entry.title === entry.bench.title ? entry.title : `${entry.title} · ${entry.bench.title}`;
}

/** 表单没交上去：换成表单块认的 { code, message }（Form.tsx：invalid 带原因写「没交上去：原因」，conflict 写「这个页面过期了」，forbidden 写不能在这个台上填表）。
 *  服务端的 invalid、conflict 照原样；不让交给 forbidden；没登录、断网、别的都给一句人话，不露代号 */
export function formError(status: number, body: unknown): { code: string; message?: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const message = typeof b.message === 'string' && b.message ? b.message : undefined;
  if (status === 409 || code === 'conflict') return { code: 'conflict' };
  if (status === 401) return { code: 'invalid', message: '请先登录' };
  if (status === 403) return { code: 'forbidden' };
  if (status === 400 && code === 'invalid') return { code: 'invalid', message: message ?? '有的内容填得不对' };
  if (status === 0) return { code: 'invalid', message: '连不上服务器，稍后再交' };
  return { code: 'invalid', message: '这次没交上去，稍后再试' };
}

/** 改台名的结果（PUT /title 的应答）：成了（变没变、新名字）；409 照服务端的说法、给「重新读一次」；别的给一句人话 */
export type RenameOutcome = { kind: 'ok'; changed: boolean; title: string } | { kind: 'conflict'; text: string } | { kind: 'error'; text: string };
export function renameOutcome(status: number, body: unknown): RenameOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; changed?: unknown; bench?: { title?: unknown } };
  const message = typeof b.message === 'string' && b.message ? b.message : '';
  if (status === 200 && typeof b.bench?.title === 'string') return { kind: 'ok', changed: b.changed === true, title: b.bench.title };
  if (status === 409) return { kind: 'conflict', text: message || '台的名字已经被改过了，先重新读一次再改' };
  if (status === 400) return { kind: 'error', text: message || '名字写得不对' };
  if (status === 401) return { kind: 'error', text: '请先登录' };
  if (status === 403) return { kind: 'error', text: '你不能改这个台的名字' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，稍后再试' };
  return { kind: 'error', text: '这次没改成，稍后再试' };
}

/** 改名对话框里点了「重新读一次」之后：取到了新入口，输入框和 base 换成现在的名字；没取到（读不到、断网），名字给 null——输入框和 base 都不动，说一句，还能再点 */
export function reloadOutcome(next: BenchEntry | null): { title: string | null; type: 'info' | 'warning'; text: string } {
  if (!next) return { title: null, type: 'warning', text: '这会儿读不到现在的名字，输入框没动，稍后再点「重新读一次」' };
  return { title: next.bench.title, type: 'info', text: `现在的名字是「${next.bench.title}」` };
}

/** 改名对话框里出不出「跟卡片同名」（#927）：能改名、服务端给了卡片名（有对应卡片、名字不空）、并且和台现在的名字不同才出；
 *  同名时点了也是「名字没变」，不出这个按钮 */
export function showFromCard(entry: BenchEntry): boolean {
  const card = entry.bench.card_title;
  return entry.can.rename && typeof card === 'string' && card !== '' && card !== entry.bench.title;
}

/** 标签页切回前台时要不要重新问一次入口（别人改了台名，切回来看到的是新名字）：离上一次至少 30 秒才问，免得来回切换一直发请求 */
export const ENTRY_REFRESH_MIN_MS = 30_000;
export const shouldRefreshEntry = (lastAt: number, now: number, minMs = ENTRY_REFRESH_MIN_MS): boolean => now - lastAt >= minMs;

/** 入口读不到时的说法：不提「这个台」，不让人从说法里猜出这张卡片背后有没有台 */
export const ENTRY_TEXT = {
  error: '这会儿打不开',
  errorSub: '稍后再试；一直打不开，请找管理员。',
} as const;
