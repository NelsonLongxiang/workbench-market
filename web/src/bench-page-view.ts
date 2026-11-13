/** 视图台页面（/use/<卡片 id>）的纯函数：入口应答怎么走、地址里的视图和筛选、表单交不上时说什么。
 *  打开一张卡片先问入口（GET /api/bench-views/<卡片 id>/entry）：
 *  200 是视图台、读得到，画数据视图；404 一律照原来的方式打开卡片（读不到的、不存在的、没开台库的、没有视图的应答逐字一样，这里也不分）；
 *  401 去登录；403 是只带管理口令或跨站；别的（5xx、断网）读不到，给「再试一次」。 */
import type { BenchEntry } from './api';

export type EntryOutcome =
  | { kind: 'bench'; entry: BenchEntry }
  | { kind: 'card' }
  | { kind: 'login' }
  | { kind: 'forbidden' }
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
  return { bench: b.bench, version: b.version, title: isStr(b.title) ? b.title : b.bench.title, default_view: isStr(b.default_view) && keys.has(b.default_view) ? b.default_view : b.views[0].key, views: b.views };
}

export function entryOutcome(status: number, body: unknown): EntryOutcome {
  if (status === 200) { const entry = asEntry(body); return entry ? { kind: 'bench', entry } : { kind: 'error' }; }
  if (status === 404) return { kind: 'card' };
  if (status === 401) return { kind: 'login' };
  if (status === 403) return { kind: 'forbidden' };
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

/** 表单没交上去：换成表单块认的 { code, message }（Form.tsx：invalid 带原因写「没交上去：原因」，conflict 写「这个页面过期了」）。
 *  服务端的 invalid、conflict 照原样；没登录、不让交、断网、别的都给一句人话，不露代号 */
export function formError(status: number, body: unknown): { code: string; message?: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const message = typeof b.message === 'string' && b.message ? b.message : undefined;
  if (status === 409 || code === 'conflict') return { code: 'conflict' };
  if (status === 401) return { code: 'invalid', message: '请先登录' };
  if (status === 403) return { code: 'invalid', message: '你的账号不能在这个台上填表' };
  if (status === 400 && code === 'invalid') return { code: 'invalid', message: message ?? '有的内容填得不对' };
  if (status === 0) return { code: 'invalid', message: '连不上服务器，稍后再交' };
  return { code: 'invalid', message: '这次没交上去，稍后再试' };
}

export const ENTRY_TEXT = {
  login: '请先登录',
  loginSub: '登录之后再打开这个台。',
  forbidden: '这个台要用你自己的账号打开',
  forbiddenSub: '只带管理口令、或者从别的网站跳过来，都看不到台里的数据。请登录之后从工作台市场打开。',
  error: '读不到这个台',
  errorSub: '稍后再试；一直读不到，请找负责这个台的人。',
} as const;
