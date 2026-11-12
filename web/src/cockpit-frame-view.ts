/** 驾驶舱骨架的纯函数（不碰 React、不引别的文件，scripts/cockpit-frame-unit.mjs 直接测）。
 *  骨架照产品化原型的驾驶舱那一屏：上面一排「看的是…」和右边的操作；下面三栏——左、中（上下两块）、右，
 *  栏之间可以拖宽窄，每一块可以放大到占满、再还原。 */

/** 三栏的尺寸：左栏宽、右栏宽、中间下面那块的高（像素）；中间上面那块吃剩下的 */
export type Sizes = { left: number; right: number; bottom: number };
/** 中间栏是正身：两边按原型的比例给，剩下的都归中间 */
export const DEFAULT_SIZES: Sizes = { left: 280, right: 300, bottom: 260 };
const RANGE: Record<keyof Sizes, [number, number]> = { left: [220, 480], right: [260, 520], bottom: [140, 520] };

/** 尺寸夹在各自的范围里；不是数字的退回缺省 */
export function clampSizes(s: Partial<Record<keyof Sizes, unknown>> | null | undefined): Sizes {
  const out = { ...DEFAULT_SIZES };
  for (const k of Object.keys(RANGE) as (keyof Sizes)[]) {
    const v = s?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(Math.min(RANGE[k][1], Math.max(RANGE[k][0], v)));
  }
  return out;
}

/** 拖分隔条：left 往右拖变宽；right、bottom 的分隔条在它们的左边 / 上边，往右 / 往下拖是变窄 / 变矮 */
export function dragSizes(start: Sizes, which: keyof Sizes, dx: number, dy: number): Sizes {
  const next = { ...start };
  if (which === 'left') next.left = start.left + dx;
  else if (which === 'right') next.right = start.right - dx;
  else next.bottom = start.bottom - dy;
  return clampSizes(next);
}

/** 存在本机的尺寸（每个驾驶舱一份）：读坏了、形状不对都退回缺省 */
export function parseSizes(raw: string | null | undefined): Sizes {
  if (!raw) return { ...DEFAULT_SIZES };
  try { return clampSizes(JSON.parse(raw) as Partial<Sizes>); } catch { return { ...DEFAULT_SIZES }; }
}

/** 放大 / 还原：点已经放大的那一块就还原；点别的块换成放大那一块 */
export const toggleMax = (cur: string | null, id: string): string | null => (cur === id ? null : id);

/** 「看的是」那一排的胶囊：只列有值的；没有任何筛选时返回空（那一排就不写「看的是」） */
export type Ctx = { label: string; value: string };
export function ctxChips(fields: { name: string; label: string }[], value: Record<string, unknown> | null | undefined): Ctx[] {
  return fields.map((f) => ({ label: f.label, value: value?.[f.name] })).filter((c): c is Ctx => typeof c.value === 'string' && c.value.trim() !== '').map((c) => ({ label: c.label, value: c.value.trim() }));
}

/** 页签：当前选的不在列表里（页签变了）就落到第一个 */
export const activeTab = (tabs: { key: string }[], cur: string | null | undefined): string => (tabs.some((t) => t.key === cur) ? String(cur) : tabs[0]?.key ?? '');

/** 驾驶舱里对数据视图的引用（协调裁定）：驾驶舱不存查询和画法，只存「哪个台的哪一份视图、放在哪个页签、次序」。
 *  取数走台的视图入口，拿回来是排好的块。bench 是视图台自己的标识（slug），不是工作台的数字 id。 */
export type BenchViewRef = { i: string; kind: 'bench-view'; bench: string; view: string; tab: 'board' | 'detail'; order: number };
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 视图的 key：和服务端存面板时的校验同一个写法 */
const VIEW_KEY = /^[a-z][a-z0-9-]{0,31}$/;

/** 从驾驶舱的 panels 里挑出数据视图的引用：只认写法对的（bench 是 slug、view 非空、tab 是 board / detail），别的丢掉 */
export function benchViewRefs(panels: unknown): BenchViewRef[] {
  if (!Array.isArray(panels)) return [];
  const out: BenchViewRef[] = [];
  for (const p of panels) {
    const o = p as Record<string, unknown> | null;
    if (!o || o.kind !== 'bench-view' || typeof o.bench !== 'string' || !SLUG.test(o.bench) || typeof o.view !== 'string' || !VIEW_KEY.test(o.view)) continue;
    if (o.tab !== 'board' && o.tab !== 'detail') continue;
    out.push({ i: typeof o.i === 'string' && o.i ? o.i : `bv-${o.bench}-${o.view}`, kind: 'bench-view', bench: o.bench, view: o.view, tab: o.tab, order: typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : 0 });
  }
  return out;
}
/** 是不是数据视图的引用（面板栅格里不画它；存布局时要原样带回去） */
export const isBenchViewPanel = (p: unknown): boolean => !!p && typeof p === 'object' && (p as { kind?: unknown }).kind === 'bench-view';

/** 一个页签上的引用，按次序排；次序相同保持原来的先后 */
export function refsOfTab(refs: BenchViewRef[], tab: 'board' | 'detail'): BenchViewRef[] {
  return refs.map((r, i) => ({ r, i })).filter((x) => x.r.tab === tab).sort((a, b) => a.r.order - b.r.order || a.i - b.i).map((x) => x.r);
}

/** 中间一栏有哪些页签、按什么顺序：配了数据视图才有「看板」「明细」，排在前面（缺省落在第一个）；
 *  「工作台」（内嵌的面板）有面板、或者别的页签一个都没有时出现 */
export function mainTabKeys(refs: BenchViewRef[], benchPanels: number): ('board' | 'detail' | 'benches')[] {
  const keys: ('board' | 'detail' | 'benches')[] = [];
  if (refs.some((r) => r.tab === 'board')) keys.push('board');
  if (refs.some((r) => r.tab === 'detail')) keys.push('detail');
  if (benchPanels > 0 || keys.length === 0) keys.push('benches');
  return keys;
}

/** 取数的地址：GET /api/bench-views/<台>/render?view=<视图>&p.<筛选项>=<值>；空的筛选值不带 */
export function benchViewUrl(ref: Pick<BenchViewRef, 'bench' | 'view'>, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ view: ref.view });
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v !== '') q.set(`p.${k}`, v);
  return `/api/bench-views/${encodeURIComponent(ref.bench)}/render?${q}`;
}

/** 整份视图没取到时的一句话（单个块的问题由块自己说）。403 一律说看不到：没权限的人打不存在的台也是 403 */
export function benchViewError(status: number, code?: string): string {
  if (status === 401) return '请先登录';
  if (status === 403) return '你看不到这个台的数据';
  if (status === 404 && code === 'bench_views_off') return '数据视图还没开放';
  if (status === 404) return '这份视图不在了';
  if (status === 504) return '取数太慢，这次没取到，稍后再试';
  if (status === 503) return '现在取数的人太多，稍后再试';
  if (status === 0) return '连不上服务器';
  return '读不到这份视图，稍后再试';
}

/** 右栏「事项」列的是哪个视角（列表接口应答里的 view，#626）：页签照它写。
 *  服务端还没给 view 的（旧的应答）：看的人只拿得到自己建立的就写「我安排的事项」，否则只写「事项」 */
const VIEW_LABEL: Record<string, string> = { mine: '我安排的事项', seats: '我的 AI 员工手上的事项', team: '我团队的事项', all: '全部事项' };
export function itemsTabLabel(view: unknown, seesAll: boolean): string {
  if (typeof view === 'string' && VIEW_LABEL[view]) return VIEW_LABEL[view];
  return seesAll ? '事项' : '我安排的事项';
}

