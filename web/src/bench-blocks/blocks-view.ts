/**
 * 数据视图组件（bench-blocks）里的判断：数字怎么写、表格的格子按什么画、图表的系列怎么拼、出错时说什么。
 * 纯函数，不碰 React，也不引用别的文件（单测直接用 Node 加载这个文件）。
 *
 * 数据的形状就是台库查询的应答：{ columns, rows, truncated }。驾驶舱用这些组件时，把自己的数据转成这个形状递进来。
 */
export type BlockColType = 'text' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean';
/** 表格里这一列按什么画；不给就按列的类型推（数字 → number，时间 → time，其余 → text） */
export type CellKind = 'text' | 'number' | 'time' | 'date' | 'bool' | 'person' | 'seat' | 'status';
export type BlockColumn = { name: string; type: BlockColType; label?: string; role?: string; display?: CellKind };
export type BlockData = { columns: BlockColumn[]; rows: Record<string, unknown>[]; truncated?: boolean };
export type BlockError = { code: string; message?: string };

/** 一个系列最多几个：再多就看不清了，后面的并成「其他」（和现有看板的规则一致） */
export const MAX_SERIES = 5;
export const OTHER = '其他';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 数字的写法：千分位；小数最多两位，整数不带小数点；不是数字的给「-」 */
export function fmtNumber(v: unknown): string {
  if (!isNum(v)) return '-';
  const neg = v < 0, abs = Math.abs(v);
  const fixed = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.?0+$/, '');
  const [int, frac] = fixed.split('.');
  return `${neg ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

export function cellKind(col: BlockColumn): CellKind {
  if (col.display) return col.display;
  if (col.type === 'integer' || col.type === 'decimal') return 'number';
  if (col.type === 'datetime') return 'time';
  if (col.type === 'date') return 'date';
  if (col.type === 'boolean') return 'bool';
  return 'text';
}

/** 格子里的文字（人、席位、状态、时间由组件自己画，这里给不出的返回原文） */
export function cellText(v: unknown, kind: CellKind): string {
  if (v === null || v === undefined || v === '') return '-';
  if (kind === 'number') return fmtNumber(v);
  if (kind === 'bool') return v === true ? '是' : v === false ? '否' : '-';
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '-';
}

export const colLabel = (data: BlockData | null | undefined, name: string): string => {
  const c = data?.columns.find((x) => x.name === name);
  return c?.label || name;
};

/** 统计卡：取第一行的那一列 */
export function statOf(data: BlockData | null | undefined, value: string): number | null {
  const v = data?.rows[0]?.[value];
  return isNum(v) ? v : null;
}

/** 进度：值和总数都取第一行；总数可以是写死的数字。比例夹在 0～1 之间；总数不是正数时没有比例 */
export function progressOf(data: BlockData | null | undefined, value: string, total: string | number): { value: number; total: number; ratio: number | null } | null {
  const row = data?.rows[0];
  if (!row) return null;
  const v = row[value], t = typeof total === 'number' ? total : row[total];
  if (!isNum(v) || !isNum(t)) return null;
  return { value: v, total: t, ratio: t > 0 ? Math.min(1, Math.max(0, v / t)) : null };
}

export type SeriesModel = {
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  /** 系列超过上限、后面的并成了「其他」 */
  merged: boolean;
  /** 每个类目对应的原始行（点了图上的一格，把它交给调用方） */
  rowsAt: Record<string, unknown>[][];
};
const text = (v: unknown) => (v === null || v === undefined || v === '' ? '（空）' : String(v));

/**
 * 柱和线的系列。两种写法：给多个 y（每个 y 一个系列），或者给一个 y 加 series 列（按那一列的取值分系列）。
 * 类目按数据里出现的先后排；同一个类目、同一个系列出现多行时相加。
 */
export function toSeries(data: BlockData | null | undefined, x: string, y: string | string[], seriesCol?: string): SeriesModel {
  const rows = data?.rows ?? [], ys = Array.isArray(y) ? y : [y];
  const categories: string[] = [], catIndex = new Map<string, number>(), rowsAt: Record<string, unknown>[][] = [];
  for (const r of rows) {
    const c = text(r[x]);
    if (!catIndex.has(c)) { catIndex.set(c, categories.length); categories.push(c); rowsAt.push([]); }
    rowsAt[catIndex.get(c) as number].push(r);
  }
  const acc = new Map<string, (number | null)[]>();
  const add = (name: string, cat: string, v: unknown) => {
    if (!acc.has(name)) acc.set(name, categories.map(() => null));
    if (!isNum(v)) return;
    const arr = acc.get(name) as (number | null)[], i = catIndex.get(cat) as number;
    arr[i] = (arr[i] ?? 0) + v;
  };
  if (seriesCol) for (const r of rows) add(text(r[seriesCol]), text(r[x]), r[ys[0]]);
  else for (const name of ys) { const label = colLabel(data, name); for (const r of rows) add(label, text(r[x]), r[name]); }
  let series = [...acc.entries()].map(([name, values]) => ({ name, values }));
  const merged = series.length > MAX_SERIES;
  if (merged) {
    const rest = series.slice(MAX_SERIES - 1);
    const other = categories.map((_, i) => { const vs = rest.map((s) => s.values[i]).filter(isNum); return vs.length ? vs.reduce((a, b) => a + b, 0) : null; });
    series = [...series.slice(0, MAX_SERIES - 1), { name: OTHER, values: other }];
  }
  return { categories, series, merged, rowsAt };
}

export type Slice = { name: string; value: number; rows: Record<string, unknown>[] };
/** 饼：按标签合并，从大到小；超过上限的并成「其他」；不是正数的不画 */
export function toSlices(data: BlockData | null | undefined, label: string, value: string): { slices: Slice[]; merged: boolean; total: number } {
  const by = new Map<string, Slice>();
  for (const r of data?.rows ?? []) {
    const v = r[value];
    if (!isNum(v) || v <= 0) continue;
    const name = text(r[label]);
    const s = by.get(name) ?? { name, value: 0, rows: [] };
    s.value += v; s.rows.push(r);
    by.set(name, s);
  }
  let slices = [...by.values()].sort((a, b) => b.value - a.value);
  const total = slices.reduce((a, s) => a + s.value, 0), merged = slices.length > MAX_SERIES;
  if (merged) {
    const rest = slices.slice(MAX_SERIES - 1);
    slices = [...slices.slice(0, MAX_SERIES - 1), { name: OTHER, value: rest.reduce((a, s) => a + s.value, 0), rows: rest.flatMap((s) => s.rows) }];
  }
  return { slices, merged, total };
}

/** 出错时对人说的话（调用方可以整个换掉）。不把服务端的原话和代号直接给人看 */
export function errorText(e: BlockError): string {
  if (e.code === 'timeout') return '这块数据算得太久，已经停下了。把筛选范围缩小一点再试。';
  if (e.code === 'limit') return '数据太多，一次取不回来。把筛选范围缩小一点；还不行就请负责这个台的人减少列或行数。';
  if (e.code === 'invalid') return '这一块的设置和现在的数据对不上（可能有列被改过）。请负责这个台的人看一下。';
  if (e.code === 'not_found') return '这一块要的数据已经不在了。请负责这个台的人看一下。';
  if (e.code === 'busy') return '现在读写的人太多，稍后再试。';
  if (e.code === 'forbidden') return '你的账号现在不能看这块数据。';
  return '读不到这块数据，稍后再试。';
}

export type Tone = 'danger' | 'warning' | 'success';
/** 按值着色的一条规则：某一列的值满足条件，就用这种语气的颜色。颜色只有三种语义色，不能给任意色值 */
export type ToneRule = { col: string; op: '<' | '<=' | '>' | '>=' | '=' | '!='; value: number; tone: Tone };
export const MAX_TONE_RULES = 2;
const TONE_OPS: Record<string, (a: number, b: number) => boolean> = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
const TONES = ['danger', 'warning', 'success'];
/** 只留写得对的规则，最多两条（保存视图描述时服务端核对过；这里再守一道，写错的当作没有） */
export function toneRules(v: unknown): ToneRule[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is ToneRule => !!r && typeof r === 'object' && typeof r.col === 'string' && Object.hasOwn(TONE_OPS, r.op) && isNum(r.value) && TONES.includes(r.tone)).slice(0, MAX_TONE_RULES);
}
/** 这一行按规则该用什么语气：按先后，第一条满足的算；都不满足、或者那一列不是数字，就没有 */
export function toneOf(row: Record<string, unknown> | undefined, rules: ToneRule[]): Tone | null {
  if (!row) return null;
  for (const r of rules) { const v = Object.hasOwn(row, r.col) ? row[r.col] : undefined; if (isNum(v) && TONE_OPS[r.op](v, r.value)) return r.tone; }
  return null;
}
const TONE_WORD: Record<Tone, string> = { danger: '红', warning: '黄', success: '绿' };
const OP_WORD: Record<string, string> = { '<': '低于', '<=': '不高于', '>': '高于', '>=': '不低于', '=': '等于', '!=': '不等于' };
/** 图下那一行说明：「红 = 毛利率低于 20；黄 = …」。只有一列在算的时候可以不写列名 */
export function toneNote(rules: ToneRule[], data: BlockData | null | undefined, unit = ''): string {
  return rules.map((r) => `${TONE_WORD[r.tone]} = ${colLabel(data, r.col)}${OP_WORD[r.op]} ${fmtNumber(r.value)}${unit}`).join('；');
}

export type ValueLabel = { text: string; tone?: 'success' | 'warning' | 'danger' | 'default' };
/**
 * 视图描述里表格的「取值 → 说法」对照（value_labels：列名 → 取值 → 说法，说法可以只写文字，也可以带颜色）。
 * 返回这个取值该怎么说；没给对照的返回 null（表格把它显示成灰色的原文，不报错）。只认对照自己带的键。
 */
export function valueLabel(labels: unknown, column: string, value: unknown): ValueLabel | null {
  if (!labels || typeof labels !== 'object' || !Object.hasOwn(labels, column)) return null;
  const map = (labels as Record<string, unknown>)[column], key = String(value);
  if (!map || typeof map !== 'object' || !Object.hasOwn(map, key)) return null;
  const hit = (map as Record<string, unknown>)[key];
  if (typeof hit === 'string' && hit) return { text: hit };
  if (hit && typeof hit === 'object' && typeof (hit as ValueLabel).text === 'string' && (hit as ValueLabel).text) {
    const tone = (hit as ValueLabel).tone;
    return { text: (hit as ValueLabel).text, tone: tone === 'success' || tone === 'warning' || tone === 'danger' ? tone : 'default' };
  }
  return null;
}
/** 有对照的列按「状态」画（标签），别的列不动 */
export function withLabelColumns(data: BlockData | null | undefined, labels: unknown): BlockData | null {
  if (!data) return null;
  if (!labels || typeof labels !== 'object') return data;
  return { ...data, columns: data.columns.map((c) => (Object.hasOwn(labels, c.name) && !c.display ? { ...c, display: 'status' as const } : c)) };
}

/** 一个块是不是「空」：没有数据，或者一行也没有 */
export const isEmptyData = (data: BlockData | null | undefined): boolean => !data || !Array.isArray(data.rows) || data.rows.length === 0;

/**
 * 一页里各块的宽度：先按 snapSpan 取，再按 12 栏从左往右排行。视图描述没给 span 的块要是一个人占了一整行（前面一行放不下它），
 * 就撑满这一行，不留半边空白（统计卡一行放满之后，后面的图独占下一行时原来只有 6 栏宽）。给了 span 的照给的来。
 * blocks 是真正要画出来的块（隐藏的筛选栏、不认识的类型不在里面）
 */
export function layoutSpans(blocks: { type: string; span?: unknown }[]): (3 | 4 | 6 | 12)[] {
  const spans = blocks.map((b) => snapSpan(b.span, b.type));
  const rows: number[][] = [];
  let used = 12;
  spans.forEach((s, i) => {
    if (used + s > 12) { rows.push([i]); used = s; } else { (rows[rows.length - 1] as number[]).push(i); used += s; }
  });
  for (const r of rows) if (r.length === 1 && typeof blocks[r[0] as number]?.span !== 'number') spans[r[0] as number] = 12;
  return spans;
}

/**
 * 短值列不折行：数字、日期、时间、是否、状态这几类按这一页里最长的值（和列标题）估一个像素宽度，表格据此给列宽；
 * 文本列给 undefined，分剩下的宽度、超长省略。中日韩字符按两个单位算
 */
export function nowrapWidth(kind: CellKind, title: string, values: string[]): number | undefined {
  if (kind === 'text' || kind === 'person' || kind === 'seat') return undefined;
  const units = (s: string) => [...s].reduce((n, ch) => n + (/[\u2E80-\uFFFF]/.test(ch) ? 2 : 1), 0);
  const longest = Math.max(units(title), kind === 'time' ? 10 : 0, ...values.map(units));
  return Math.min(240, Math.max(64, Math.ceil(longest * 7.5) + 32));
}

/** 视图描述里的 span（1～12）落到看板只认的四种宽度上；不给时按组件类型取 */
export function snapSpan(span: unknown, type: string): 3 | 4 | 6 | 12 {
  if (typeof span === 'number') return span <= 3 ? 3 : span <= 4 ? 4 : span <= 6 ? 6 : 12;
  if (type === 'stat' || type === 'progress') return 3;
  if (type === 'table' || type === 'filter-bar') return 12;
  return 6;
}
