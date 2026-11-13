/**
 * 数据视图的查询描述（docs/data-views.md 第五节）：台的作者和 agent 不写 SQL，只给一份描述；这里把它核对并翻成参数化语句。
 *
 * 纯函数，不碰库：数据集的定义由调用方给。两处用它——台库读数据（services/bench-store.ts），和保存视图描述时核对里面的查询（bench-views.ts）。
 *
 * 安全口径：
 *   · 数据集名、列名、别名只认白名单写法，而且必须是已定义的；拼进语句的只有这些核对过的名字（加固定前缀或双引号），值一律走参数。
 *   · 没有连表、没有子查询、没有任意表达式。
 *   · 行数有硬上限；数据集本身的行数也有上限（见 BENCH_LIMITS），所以一次查询的代价有界。
 * 两种库都认的写法：排序写明 NULLS LAST。「包含」随库不同，这里不写：由调用方把 db.ts 台库一段里的写法递进来（opts.contains）。
 * 这个文件运行时不引用 db.ts（只引用类型），所以引用它不会顺带打开主库。
 */
import type { BenchColumnType } from './db.ts';

export const BENCH_LIMITS = {
  datasets: 50, columns: 60, keyColumns: 8, rows: 50_000, rowsPerWrite: 5_000, textChars: 10_000,
  snapshots: 5, viewVersions: 100, viewBytes: 200_000, queryLimit: 5_000, queryDefault: 200,
  noteChars: 200, writeLog: 5_000, changeLog: 2_000, filters: 20, measures: 12, inValues: 200,
  // 数据量（UTF-8 字节：文本按字节数，数字和布尔算 8，空算 1）：单个数据集、一个台的在用数据合计、一次写入（整份替换可以到数据集的上限）。
  // 数据集的上限同时保证一份快照序列化得下来、内存撑得住；快照另算，每个数据集最多留 snapshots 份
  datasetBytes: 32_000_000, storeBytes: 256_000_000, writeBytes: 16_000_000,
  // 列定义的历史版本每个数据集留最近多少版
  datasetVersions: 100,
  // 一次查询取回的内容（各格的字符数加起来）的上限：再大就不该一次取
  resultChars: 8_000_000,
  // 时限（毫秒）：读、写各一个；到了时限加宽限还没停下来，才强行终止工作线程
  queryMs: 3_000, writeMs: 15_000, killGraceMs: 2_000,
  // 排着队等工作线程的读写个数的上限
  queue: 200,
} as const;

export const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const COLUMN_TYPES: readonly BenchColumnType[] = ['text', 'integer', 'decimal', 'date', 'datetime', 'boolean'];

/**
 * 列定义。values：这一列各个取值是什么意思（业务口径，比如 { ok: '正常', bad: '异常' }），由定义数据集的人写，dataset_list 原样给出；
 * auto：主键由服务端分配（只用于唯一的整数主键列；追加时没给这一列的行，按现有最大值往上数）
 */
export type ColumnDef = { name: string; type: BenchColumnType; label: string; required: boolean; values?: Record<string, string>; auto?: true };
export type DatasetDef = {
  name: string; title: string; version: number; columns: ColumnDef[]; key: string[];
  row_count: number; data_bytes: number; created_at: number; updated_at: number; updated_by: string;
};
/** labeled：这一列有人起过说明名（数据集列定义的 label、聚合的 label）；没有时 label 退回列名。只在服务端内部用，不进应答 */
export type OutColumn = { name: string; type: BenchColumnType; label: string; role: 'dimension' | 'measure'; labeled?: boolean };
/** 应答里的列：去掉内部用的 labeled */
export const publicColumn = ({ labeled: _l, ...c }: OutColumn): OutColumn => c;
export type QueryPlan = { dataset: string; columns: OutColumn[]; params: string[]; sql: string; args: unknown[]; limit: number };

export class BenchError extends Error {
  /**
   * internal：库或运行环境报了意料之外的错。说明文字是固定的一句，原始的错只放在 cause 里，不对外。
   * timeout：超过时限被中止。busy：排队的读写太多，这一次没有受理。
   */
  code: 'invalid' | 'not_found' | 'conflict' | 'limit' | 'unsupported' | 'internal' | 'timeout' | 'busy';
  http: number;
  details: string[];
  constructor(code: BenchError['code'], message: string, details: string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.http = code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'limit' ? 413 : code === 'internal' ? 500 : code === 'timeout' ? 504 : code === 'busy' ? 503 : 400;
    this.details = details;
  }
}
const invalid = (m: string): never => { throw new BenchError('invalid', m); };

/** 数据集的表名、列名在库里的写法：加固定前缀，避开保留字；名字先过 NAME_RE */
export const physTable = (dataset: string) => `ds_${dataset}`;
export const physCol = (col: string) => `c_${col}`;
const quoted = (alias: string) => `"${alias}"`; // 别名过了 NAME_RE，不含引号

const realDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const t = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));
  t.setUTCFullYear(Number(m[1]));
  return t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
};
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/**
 * 把一个值按列类型核对并转成入库的形态；不合格返回说明文字（{ error }）。
 * null / undefined 一律算空。lenient=true 时接受文本形态的数字和布尔（筛选栏传来的参数都是文本）。
 */
export function coerceValue(type: BenchColumnType, v: unknown, lenient = false): { value: string | number | null } | { error: string } {
  if (v === null || v === undefined) return { value: null };
  if (type === 'text') {
    if (typeof v !== 'string') return { error: '须为文本' };
    if (v.length > BENCH_LIMITS.textChars) return { error: `文本超过 ${BENCH_LIMITS.textChars} 个字符` };
    return { value: v };
  }
  if (type === 'integer') {
    if (lenient && typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) v = Number(v.trim());
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { error: '须为整数' };
    return { value: v };
  }
  if (type === 'decimal') {
    if (lenient && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v.trim());
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: '须为数字' };
    return { value: v };
  }
  if (type === 'boolean') {
    if (lenient && typeof v === 'string') v = v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v;
    if (typeof v !== 'boolean') return { error: '须为 true 或 false' };
    return { value: v ? 1 : 0 };
  }
  if (typeof v !== 'string') return { error: type === 'date' ? '日期须为 YYYY-MM-DD 的文本' : '时间须为带时区的 ISO 文本' };
  if (type === 'date') return realDate(v) ? { value: v } : { error: '日期须为 YYYY-MM-DD，且是日历上存在的一天' };
  const m = DATETIME_RE.exec(v);
  if (!m || !realDate(m[1])) return { error: '时间须为带时区的 ISO 写法，如 2026-01-31T08:00:00+08:00' };
  const t = Date.parse(v);
  return Number.isNaN(t) ? { error: '时间无法解析' } : { value: new Date(t).toISOString() };
}

/** 库里取出来的值转回给调用方的形态（布尔从 0/1 转回） */
export function decodeValue(type: BenchColumnType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'boolean') return Number(v) !== 0;
  if (type === 'integer' || type === 'decimal') return Number(v);
  return String(v);
}

// 用 Map 查，不用对象下标：对象下标会把 constructor、toString 这些原型上的名字也当成「有」
const OPS = new Map<string, string>([
  ['=', 'eq'], ['eq', 'eq'], ['!=', 'ne'], ['ne', 'ne'], ['>', 'gt'], ['gt', 'gt'], ['>=', 'gte'], ['gte', 'gte'], ['<', 'lt'], ['lt', 'lt'], ['<=', 'lte'], ['lte', 'lte'],
  ['in', 'in'], ['is_null', 'is_null'], ['not_null', 'not_null'], ['contains', 'contains'], ['prefix', 'prefix'],
]);
const CMP = new Map<string, string>([['eq', '='], ['ne', '<>'], ['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<=']]);
const FNS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'];
/** 没给「包含」的写法时占位用：这样的语句只用来核对，拿去执行会被库拒绝，不会悄悄算出别的结果 */
const CONTAINS_UNSET = (col: string) => `bench_contains_unset(${col}, ?)`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[], where: string) => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) invalid(`${where} 有不认识的键：${extra.join('、')}。能用的键：${allowed.join('、')}`);
};

/**
 * 核对一份查询描述并翻成语句。
 * params：筛选栏当前的值（$名字 引用它）；某个参数没给或为空，这条筛选就不生效（相当于「全部」）。
 * 不给 params（保存视图描述时核对用）：所有 $ 引用都当作没给，只收集引用了哪些名字。
 * contains：「包含」在所用的库上怎么写（db.ts 的 benchSqlKit）；要执行语句就必须给，只核对可以不给。
 * guard：把整段筛选条件包一层（扫描守卫，同样出自 benchSqlKit）；参数是条件（没有筛选时是 null），返回包好的条件。
 */
export type PlanOpts = { params?: Record<string, unknown>; contains?: (col: string) => string; guard?: (cond: string | null) => string | null };
export function planQuery(spec: unknown, datasets: Map<string, DatasetDef>, opts: PlanOpts = {}): QueryPlan {
  if (!isObj(spec)) invalid('查询描述须为对象');
  const q = spec as Record<string, unknown>;
  onlyKeys(q, ['dataset', 'select', 'filter', 'group', 'measures', 'sort', 'limit', 'offset'], '查询描述');
  if (typeof q.dataset !== 'string' || !NAME_RE.test(q.dataset)) invalid('dataset 须为数据集名');
  const ds = datasets.get(q.dataset as string);
  if (!ds) throw new BenchError('not_found', `没有数据集 ${String(q.dataset)}`);
  const colOf = (name: unknown, where: string): ColumnDef => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) invalid(`${where}：列名写法不对`);
    const c = ds.columns.find((x) => x.name === name);
    if (!c) invalid(`${where}：数据集 ${ds.name} 没有列 ${String(name)}`);
    return c as ColumnDef;
  };
  const strList = (v: unknown, where: string, max: number): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) invalid(`${where} 须为数组（最多 ${max} 项）`);
    return v as string[];
  };

  // 筛选
  const where: string[] = [], args: unknown[] = [], paramNames: string[] = [];
  const filters = q.filter === undefined ? [] : q.filter;
  if (!Array.isArray(filters) || filters.length > BENCH_LIMITS.filters) invalid(`filter 须为数组（最多 ${BENCH_LIMITS.filters} 条）`);
  (filters as unknown[]).forEach((f, i) => {
    const at = `filter 第 ${i + 1} 条`;
    if (!isObj(f)) invalid(`${at} 须为对象`);
    const fo = f as Record<string, unknown>;
    onlyKeys(fo, ['col', 'op', 'value', 'values'], at);
    const c = colOf(fo.col, at), col = physCol(c.name);
    const op = typeof fo.op === 'string' ? OPS.get(fo.op) : undefined;
    if (!op) return invalid(`${at}：不认识的比较符 ${String(fo.op).slice(0, 40)}`);
    if (op === 'is_null' || op === 'not_null') { where.push(`${col} IS ${op === 'is_null' ? '' : 'NOT '}NULL`); return; }
    // 取值：字面值，或 $名字 引用筛选栏
    let raw: unknown = op === 'in' && fo.values !== undefined ? fo.values : fo.value, fromParam = false;
    if (typeof raw === 'string' && raw.startsWith('$')) {
      const name = raw.slice(1);
      if (!NAME_RE.test(name)) invalid(`${at}：参数名写法不对`);
      if (!paramNames.includes(name)) paramNames.push(name);
      raw = opts.params && Object.hasOwn(opts.params, name) ? opts.params[name] : undefined; // 只认参数自己带的键
      fromParam = true;
      if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return; // 没给：这条筛选不生效
    } else if (raw === undefined) invalid(`${at}：缺 value`);
    const one = (v: unknown): string | number => {
      const r = coerceValue(c.type, v, fromParam);
      if ('error' in r) return invalid(`${at}（列 ${c.name}）：${r.error}`);
      if (r.value === null) return invalid(`${at}：值不能为空（判空用 is_null）`);
      return r.value;
    };
    if (op === 'in') {
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.length || list.length > BENCH_LIMITS.inValues) invalid(`${at}：in 的取值须为 1～${BENCH_LIMITS.inValues} 个`);
      where.push(`${col} IN (${list.map(() => '?').join(', ')})`);
      args.push(...list.map(one));
    } else if (op === 'contains' || op === 'prefix') {
      if (!['text', 'date', 'datetime'].includes(c.type) || (op === 'contains' && c.type !== 'text')) invalid(`${at}：${op} 只用于文本列${op === 'prefix' ? '、日期列和时间列' : ''}`);
      if (typeof raw !== 'string' || !raw || raw.length > 200) invalid(`${at}：取值须为 1～200 个字符的文本`);
      if (op === 'contains') { where.push((opts.contains ?? CONTAINS_UNSET)(col)); args.push(raw); }
      else { where.push(`substr(${col}, 1, ?) = ?`); args.push((raw as string).length, raw); }
    } else {
      const cmp = CMP.get(op);
      if (!cmp) return invalid(`${at}：不认识的比较符 ${String(fo.op).slice(0, 40)}`);
      where.push(`${col} ${cmp} ?`);
      args.push(one(raw));
    }
  });

  // 输出列：有分组或聚合就是聚合查询，否则是明细
  const group = strList(q.group, 'group', BENCH_LIMITS.columns).map((g) => colOf(g, 'group'));
  if (new Set(group.map((g) => g.name)).size !== group.length) invalid('group 里有重复的列');
  const measuresRaw = q.measures === undefined ? [] : q.measures;
  if (!Array.isArray(measuresRaw) || measuresRaw.length > BENCH_LIMITS.measures) invalid(`measures 须为数组（最多 ${BENCH_LIMITS.measures} 项）`);
  const measures = measuresRaw as unknown[];
  const columns: OutColumn[] = [], selects: string[] = [];
  const aggregate = group.length > 0 || measures.length > 0;
  if (aggregate) {
    if (q.select !== undefined) invalid('有 group 或 measures 时不能再写 select');
    for (const g of group) { columns.push({ name: g.name, type: g.type, label: g.label || g.name, role: 'dimension', labeled: !!g.label }); selects.push(`${physCol(g.name)} AS ${quoted(g.name)}`); }
    measures.forEach((m, i) => {
      const at = `measures 第 ${i + 1} 项`;
      if (!isObj(m)) invalid(`${at} 须为对象`);
      const mo = m as Record<string, unknown>;
      onlyKeys(mo, ['as', 'fn', 'col', 'label'], at);
      if (typeof mo.as !== 'string' || !NAME_RE.test(mo.as)) invalid(`${at}：as 须为别名（小写字母开头，字母、数字、下划线）`);
      if (columns.some((c) => c.name === mo.as)) invalid(`${at}：别名 ${String(mo.as)} 和别的输出列重名`);
      if (typeof mo.fn !== 'string' || !FNS.includes(mo.fn)) invalid(`${at}：fn 须为 ${FNS.join(' / ')}`);
      if (mo.label !== undefined && (typeof mo.label !== 'string' || mo.label.length > 64)) invalid(`${at}：label 须为 64 个字符以内的文本`);
      const fn = mo.fn as string, label = (mo.label as string) || (mo.as as string), labeled = !!mo.label;
      if (fn === 'count' && mo.col === undefined) { selects.push(`COUNT(*) AS ${quoted(mo.as as string)}`); columns.push({ name: mo.as as string, type: 'integer', label, role: 'measure', labeled }); return; }
      const c = colOf(mo.col, at), col = physCol(c.name);
      if ((fn === 'sum' || fn === 'avg') && c.type !== 'integer' && c.type !== 'decimal') invalid(`${at}：${fn} 只用于整数列和小数列`);
      if ((fn === 'min' || fn === 'max') && c.type === 'boolean') invalid(`${at}：${fn} 不用于布尔列`);
      const expr = fn === 'count' ? `COUNT(${col})` : fn === 'count_distinct' ? `COUNT(DISTINCT ${col})` : `${fn.toUpperCase()}(${col})`;
      const type: BenchColumnType = fn === 'count' || fn === 'count_distinct' ? 'integer' : fn === 'avg' ? 'decimal' : c.type;
      selects.push(`${expr} AS ${quoted(mo.as as string)}`);
      columns.push({ name: mo.as as string, type, label, role: 'measure', labeled });
    });
  } else {
    const picked = q.select === undefined ? ds.columns : strList(q.select, 'select', BENCH_LIMITS.columns).map((s) => colOf(s, 'select'));
    if (!picked.length) invalid('select 不能为空');
    if (new Set(picked.map((c) => c.name)).size !== picked.length) invalid('select 里有重复的列');
    for (const c of picked) {
      columns.push({ name: c.name, type: c.type, label: c.label || c.name, role: (c.type === 'integer' || c.type === 'decimal') && !ds.key.includes(c.name) ? 'measure' : 'dimension', labeled: !!c.label });
      selects.push(`${physCol(c.name)} AS ${quoted(c.name)}`);
    }
  }

  // 排序：聚合查询只能按输出列排；明细可以按数据集的任何列排。末尾补一个确定的次序
  const order: string[] = [];
  const sort = q.sort === undefined ? [] : q.sort;
  if (!Array.isArray(sort) || sort.length > 8) invalid('sort 须为数组（最多 8 项）');
  (sort as unknown[]).forEach((s, i) => {
    const at = `sort 第 ${i + 1} 项`;
    if (!isObj(s)) invalid(`${at} 须为对象`);
    const so = s as Record<string, unknown>;
    onlyKeys(so, ['col', 'dir'], at);
    const dir = so.dir === undefined || so.dir === 'asc' ? 'ASC' : so.dir === 'desc' ? 'DESC' : invalid(`${at}：dir 须为 asc 或 desc`);
    if (typeof so.col !== 'string' || !NAME_RE.test(so.col)) invalid(`${at}：列名写法不对`);
    if (aggregate) {
      if (!columns.some((c) => c.name === so.col)) invalid(`${at}：聚合查询只能按输出列排序，没有 ${String(so.col)}`);
      order.push(`${quoted(so.col as string)} ${dir} NULLS LAST`);
    } else order.push(`${physCol(colOf(so.col, at).name)} ${dir} NULLS LAST`);
  });
  if (aggregate) for (const g of group) order.push(`${quoted(g.name)} ASC NULLS LAST`);
  else order.push('rid ASC');

  const int = (v: unknown, def: number, min: number, max: number, name: string): number => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(`${name} 须为 ${min}～${max} 的整数`);
    return v as number;
  };
  const limit = int(q.limit, BENCH_LIMITS.queryDefault, 1, BENCH_LIMITS.queryLimit, 'limit');
  const offset = int(q.offset, 0, 0, BENCH_LIMITS.rows, 'offset');
  const cond = where.length ? where.join(' AND ') : null, guarded = opts.guard ? opts.guard(cond) : cond;
  const sql = `SELECT ${selects.join(', ')} FROM ${physTable(ds.name)}`
    + (guarded ? ` WHERE ${guarded}` : '')
    + (group.length ? ` GROUP BY ${group.map((g) => physCol(g.name)).join(', ')}` : '')
    + (order.length ? ` ORDER BY ${order.join(', ')}` : '')
    + ` LIMIT ? OFFSET ?`;
  return { dataset: ds.name, columns, params: paramNames, sql, args: [...args, limit + 1, offset], limit };
}
