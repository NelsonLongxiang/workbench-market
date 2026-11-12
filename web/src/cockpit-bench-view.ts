/** 驾驶舱里「数据视图」这一部分的纯函数（不碰 React；scripts/cockpit-bench-view-unit.mjs 直接测）：
 *  一个页签里几份视图共用的筛选、把视图挂进驾驶舱（加、移、删）时面板清单怎么变、选台选视图时各种取不到的说法。 */
import type { BenchViewRef } from './cockpit-frame-view';
// 这个文件要能被 node 直接加载来测，所以不从别的模块引入值（只引类型）：引用的解析由调用的人传进来（cockpit-frame-view 的 benchViewRefs）。
export type ParseRefs = (panels: unknown) => BenchViewRef[];
const isBenchViewPanel = (p: unknown): boolean => !!p && typeof p === 'object' && (p as { kind?: unknown }).kind === 'bench-view';

export type Tab = 'board' | 'detail';
export const TAB_LABEL: Record<Tab, string> = { board: '看板', detail: '明细' };
/** 一个驾驶舱最多放这么多份数据视图（和服务端存面板时的上限一样） */
export const MAX_VIEW_PANELS = 24;

/** 一份视图认的筛选项（取数应答里的 filters）；options 是下拉的选项，视图描述里写了才有 */
export type ViewFilter = { name: string; kind: 'month' | 'date' | 'select' | 'search'; label?: string; options?: (string | { value: string; label: string })[] };
const KINDS = new Set(['month', 'date', 'select', 'search']);

/** 一份取数应答认哪些筛选项：从它的筛选栏块里取（带着下拉的选项）；应答里另有一份 filters（只有名字、种类、显示名），块里没有的从那里补。
 *  只留写法对的（有名字、种类认识），同名只留先出现的 */
export function filtersOf(result: unknown): ViewFilter[] {
  const r = result as { filters?: unknown; blocks?: unknown } | null;
  const raw: unknown[] = [];
  if (Array.isArray(r?.blocks)) for (const b of r.blocks) { const o = b as { type?: unknown; fields?: unknown } | null; if (o?.type === 'filter-bar' && Array.isArray(o.fields)) raw.push(...o.fields); }
  if (Array.isArray(r?.filters)) raw.push(...r.filters);
  const out: ViewFilter[] = [], seen = new Set<string>();
  for (const f of raw) {
    const o = f as Record<string, unknown> | null;
    if (!o || typeof o.name !== 'string' || !o.name || typeof o.kind !== 'string' || !KINDS.has(o.kind) || seen.has(o.name)) continue;
    seen.add(o.name);
    out.push({ name: o.name, kind: o.kind as ViewFilter['kind'], ...(typeof o.label === 'string' && o.label ? { label: o.label } : {}), ...(Array.isArray(o.options) ? { options: o.options as ViewFilter['options'] } : {}) });
  }
  return out;
}

/** 共用筛选那一排显示的值：各份视图实际生效的值（带着视图描述里的缺省值；同名先出现的说了算），上面盖人选的 */
export function shownParams(perView: Record<string, string>[], chosen: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of perView) for (const [k, v] of Object.entries(p ?? {})) if (!(k in out) && typeof v === 'string' && v !== '') out[k] = v;
  return { ...out, ...chosen };
}

/**
 * 一个页签顶上那一排共用的筛选：把这个页签里每份视图认的筛选项按名字合起来，同名的只留一个（先出现的那份说了算），
 * 次序照视图的次序、再照各自筛选栏里的次序。按名字传值：视图里有同名的字段就生效，没有就忽略。
 */
export function mergeFilters(perView: ViewFilter[][]): ViewFilter[] {
  const seen = new Set<string>();
  const out: ViewFilter[] = [];
  for (const list of perView) for (const f of list) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

/** 传给一份视图的筛选值：只带这份视图认的那几项、非空的。页签里传的是那一排显示的值（不只是人选过的）：
 *  一份视图带缺省值的筛选项，别的视图里同名的也照这个值筛——看到的和生效的是一回事。
 *  （不能因为「和这份视图已经生效的值一样」就不传：那个值可能正是上一次传进去的，一省掉它就变回去，来回取个不停。） */
export function paramsFor(filters: ViewFilter[], value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters) { const v = value[f.name]; if (typeof v === 'string' && v !== '') out[f.name] = v; }
  return out;
}

/** 共用筛选的值变了之后留哪些：已经没有任何视图认的名字去掉 */
export function pruneParams(merged: ViewFilter[], value: Record<string, string>): Record<string, string> {
  const names = new Set(merged.map((f) => f.name));
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => names.has(k) && typeof v === 'string' && v !== ''));
}

/** 人在这个页签的那一排改了值之后，整个驾驶舱记着的选择变成什么：这个页签认的名字照新的值（清空的去掉），
 *  别的页签认的名字原样留着——「看板」上选的月份，切到「明细」还在；「明细」独有的筛选项不会因为在「看板」上动了一下就丢 */
export function nextChosen(chosen: Record<string, string>, merged: ViewFilter[], next: Record<string, string>): Record<string, string> {
  const names = new Set(merged.map((f) => f.name));
  return { ...Object.fromEntries(Object.entries(chosen).filter(([k]) => !names.has(k))), ...pruneParams(merged, next) };
}

// —— 把视图挂进驾驶舱 ——
type Panel = Record<string, unknown>;
const refKey = (r: Pick<BenchViewRef, 'bench' | 'view'>): string => `bv-${r.bench}-${r.view}`;
/** 面板清单 = 别的面板原样在前 + 数据视图的引用（次序按页签重排成 0、1、2…） */
function rebuild(panels: unknown, refs: BenchViewRef[]): Panel[] {
  const others = Array.isArray(panels) ? (panels as Panel[]).filter((p) => !isBenchViewPanel(p)) : [];
  const out: Panel[] = [...others];
  for (const tab of ['board', 'detail'] as const) {
    refs.filter((r) => r.tab === tab).forEach((r, n) => out.push({ i: refKey(r), kind: 'bench-view', bench: r.bench, view: r.view, tab, order: n }));
  }
  return out;
}
/** 现有的引用，按页签、次序排好 */
export function orderedRefs(parse: ParseRefs, panels: unknown): BenchViewRef[] {
  const refs = parse(panels).map((r, n) => ({ r, n }));
  return (['board', 'detail'] as const).flatMap((tab) => refs.filter((x) => x.r.tab === tab).sort((a, b) => a.r.order - b.r.order || a.n - b.n).map((x) => x.r));
}

export type AddResult = { ok: true; panels: Panel[] } | { ok: false; reason: string };
/** 加一份视图：同一份（同台同视图）不能放两次；总数有上限。加在所选页签的最后 */
export function addRef(parse: ParseRefs, panels: unknown, add: { bench: string; view: string; tab: Tab }): AddResult {
  const refs = orderedRefs(parse, panels);
  if (refs.some((r) => r.bench === add.bench && r.view === add.view)) return { ok: false, reason: '这份视图已经在这个驾驶舱里了' };
  if (refs.length >= MAX_VIEW_PANELS) return { ok: false, reason: `一个驾驶舱最多放 ${MAX_VIEW_PANELS} 份数据视图` };
  return { ok: true, panels: rebuild(panels, [...refs, { i: refKey(add), kind: 'bench-view', bench: add.bench, view: add.view, tab: add.tab, order: Number.MAX_SAFE_INTEGER }]) };
}
/** 移除一份 */
export function removeRef(parse: ParseRefs, panels: unknown, i: string): Panel[] {
  return rebuild(panels, orderedRefs(parse, panels).filter((r) => r.i !== i));
}
/** 在自己的页签里往前（-1）或往后（1）挪一位；已经在头或尾就不动 */
export function moveRef(parse: ParseRefs, panels: unknown, i: string, dir: -1 | 1): Panel[] {
  const refs = orderedRefs(parse, panels);
  const me = refs.find((r) => r.i === i);
  if (!me) return rebuild(panels, refs);
  const mine = refs.filter((r) => r.tab === me.tab);
  const at = mine.indexOf(me), to = at + dir;
  if (to < 0 || to >= mine.length) return rebuild(panels, refs);
  [mine[at], mine[to]] = [mine[to], mine[at]];
  return rebuild(panels, [...refs.filter((r) => r.tab !== me.tab), ...mine]);
}
/** 换页签：挪到另一个页签的最后 */
export function retabRef(parse: ParseRefs, panels: unknown, i: string, tab: Tab): Panel[] {
  const refs = orderedRefs(parse, panels);
  const me = refs.find((r) => r.i === i);
  if (!me || me.tab === tab) return rebuild(panels, refs);
  return rebuild(panels, [...refs.filter((r) => r.i !== i), { ...me, tab, order: Number.MAX_SAFE_INTEGER }]);
}

// —— 选台、选视图 ——
/** 一个台都看不到时的说法（清单是空的、或者入口回 403）：管理驾驶舱的权限和看台里数据的权限是两回事 */
export const NO_BENCH = '你现在没有可以看的台，所以没有能挂的视图。挂视图要先有这个台的读权限。';
export type BenchChoice = { slug: string; title: string };
/** 台的清单（GET /api/bench-views）取回来是什么情况。取不到的几种各有各的说法，都不是报错的口气 */
export type BenchListState = { kind: 'ok'; benches: BenchChoice[] } | { kind: 'off' | 'forbidden' | 'login' | 'error'; text: string };
export function benchListState(status: number, body: unknown): BenchListState {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 200) {
    const list = (body as { benches?: unknown } | null)?.benches;
    const benches = Array.isArray(list) ? list.flatMap((b) => { const o = b as Record<string, unknown> | null; return o && typeof o.slug === 'string' ? [{ slug: o.slug, title: typeof o.title === 'string' && o.title ? o.title : o.slug }] : []; }) : [];
    return { kind: 'ok', benches };
  }
  if (status === 404 && code === 'bench_views_off') return { kind: 'off', text: '数据视图还没有开启，现在挂不了。开启之后再来。' };
  if (status === 401) return { kind: 'login', text: '要先登录，才看得到你能用的台。' };
  if (status === 403 && code === 'bench_views_admin_token_denied') return { kind: 'forbidden', text: '台里是业务数据，凭管理口令看不到。请用有这个台权限的账号登录。' };
  if (status === 403) return { kind: 'forbidden', text: NO_BENCH };
  return { kind: 'error', text: status === 0 ? '连不上服务器，稍后再试。' : '台的清单没取到，稍后再试。' };
}

export type ViewChoice = { key: string; title: string };
/** 一个台有哪些视图（GET /api/bench-views/<台>/view 的应答）：还没有视图描述、没权限、取不到，都是空清单加一句话 */
export function viewChoices(status: number, body: unknown): { views: ViewChoice[]; text: string } {
  if (status === 200) {
    const views = ((body as { view?: { content?: { views?: unknown } } | null } | null)?.view?.content?.views);
    const list = Array.isArray(views) ? views.flatMap((v) => { const o = v as Record<string, unknown> | null; return o && typeof o.key === 'string' ? [{ key: o.key, title: typeof o.title === 'string' && o.title ? o.title : o.key }] : []; }) : [];
    return { views: list, text: list.length ? '' : '这个台还没有视图。' };
  }
  if (status === 403) return { views: [], text: '你看不到这个台。' };
  if (status === 404) return { views: [], text: '这个台不在了。' };
  return { views: [], text: status === 0 ? '连不上服务器，稍后再试。' : '这个台的视图没取到，稍后再试。' };
}

/** 一份视图上面那行小标题：视图名 · 台名（两样一样就只写一个）。没取到（没权限、没开启、出错）时只写「一份数据视图」：
 *  台标识和视图键是代号，不往页面上露——没权限的人尤其不该从这里看到 */
export const ANON_VIEW = '一份数据视图';
export function panelHeading(result: unknown): string {
  const r = result as { title?: unknown; view?: { title?: unknown } } | null;
  const view = typeof r?.view?.title === 'string' && r.view.title ? r.view.title : '';
  const bench = typeof r?.title === 'string' && r.title ? r.title : '';
  if (!view && !bench) return ANON_VIEW;
  return !view || !bench || view === bench ? view || bench : `${view} · ${bench}`;
}

/** 配置对话框里一行的名字：视图名 · 台名；哪样没取到就不写哪样，都没取到写「一份数据视图」（不拿标识顶替） */
export function rowName(viewTitle: string | undefined, benchTitle: string | undefined): string {
  return panelHeading({ title: benchTitle, view: { title: viewTitle } });
}
