/**
 * 台库的数据访问（数据视图，docs/data-views.md 第二、四、五、七节）——逻辑本体。
 *
 * 每个视图台一份自己的库，在数据目录的 bench-stores/ 下，一台一个文件。这个台的全部内容都在里面：
 * 数据集和行、列定义的历史版本、视图描述的历史版本和生效指针、快照、写入记录、变更记录。
 *
 * 这个文件在工作线程里跑（入口是 bench-store-worker.ts），市场进程经 bench-store.ts 调它，自己不直接用。
 * 它运行时不引用 db.ts（只引类型）：引用就会在线程里再开一次主库。建表语句和随库不同的写法由调用方递进来（BenchSqlKit）。
 *
 * 和主库的数据库规划守同一条纪律（产品化文档 13）：
 *   · 对外接口全部是异步的；后面是哪种库，由下面的 Conn 定（现在只有 SQLite 一种实现）。
 *   · 时间由调用方给（毫秒），不在语句里取。
 *   · 只用两种库都认的写法；随库不同的收在 Conn 和 db.ts 的台库那一段里。
 *   · 别的代码不直接打开台库的文件，只经这里。
 *   · 表结构登记在 db.ts；这里只执行。
 *
 * 一个台的所有读写排成一队，一次只跑一个：单连接上写到一半的内容不会被别的读看见，两个写也不会交错。
 * 这一层不判权限：谁能调，由上面的入口判。现在还没有对外的入口。
 *
 * 时限：每次读写可以带一个时限（withBudget），从轮到它开始跑的那一刻算。到时限就中止——
 * 查询靠语句里的扫描守卫当场停下，写入在行与行之间和提交之前各看一次——整批回滚，报 timeout。这种超时是确定的：没有生效。
 *
 * 出错只有一种形态：BenchError。库或运行环境报了意料之外的错，对外是固定的一句「内部错误」，原始的错放在 cause 里给日志用——
 * 库的报错原文里有表名、列名和语句片段，不往外带。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchDialect, BenchSqlKit } from '../db.ts';
import { isInsideRoot } from '../path-inside.ts';
import {
  BENCH_LIMITS, BenchError, COLUMN_TYPES, NAME_RE, coerceValue, decodeValue, physCol, physTable, planQuery, publicColumn,
  type ColumnDef, type DatasetDef, type OutColumn,
} from '../bench-query.ts';
import { diffJson, validateViewDoc, type JsonDiff } from '../bench-views.ts';
import { DB_BUSY_TIMEOUT_MS } from '../db-busy.ts';

export const BENCH_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEM_RE = /^[\x21-\x7e]{8,128}$/;

/** 这一层对外开放的操作，和各自算读还是写（时限不同）。工作线程只认这张表里的名字 */
export const BENCH_METHODS = new Map<string, 'read' | 'write'>([
  ['datasets', 'read'], ['datasetVersions', 'read'], ['snapshots', 'read'], ['query', 'read'], ['getView', 'read'],
  ['viewVersions', 'read'], ['diffViews', 'read'], ['changes', 'read'], ['writes', 'read'], ['renderView', 'read'],
  ['defineDataset', 'write'], ['replace', 'write'], ['append', 'write'], ['upsert', 'write'], ['deleteRows', 'write'],
  ['snapshot', 'write'], ['restore', 'write'], ['putView', 'write'], ['rollbackView', 'write'], ['backupTo', 'write'], ['submitForm', 'write'],
  ['varsList', 'read'], ['varGet', 'read'], ['varCount', 'read'], ['varsDigest', 'read'],
  ['varsSyncGet', 'read'],
  ['varInsert', 'write'], ['varUpdate', 'write'], ['varDelete', 'write'], ['varsImport', 'write'], ['varForce', 'write'], ['varsSynced', 'write'], ['varsReplace', 'write'],
]);

/** 卡片的一个常量或变量（和主库 workbench_vars 的一行同形，只是不带 workbench_id） */
/** 一组常量、变量行的摘要（主库和台库算法一样，才比得上） */
export function varsDigestOf(rows: { key: string; kind: string; value: string; revision: number; owner: string }[]): string {
  const h = createHash('sha256');
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) h.update(`${r.key}\u0000${r.kind}\u0000${r.revision}\u0000${r.owner}\u0000${createHash('sha256').update(r.value).digest('hex')}\n`);
  return h.digest('hex');
}
export type BenchVarRow = { key: string; kind: 'var' | 'const'; value: string; revision: number; updated_by: string; owner: string; created_at: string; updated_at: string };

export type WriteCtx = { actor: string; at: number; idemKey?: string; note?: string };
export type WriteResult = { dataset: string; op: string; rows: number; row_count: number; data_bytes?: number; snapshot_id?: number; inserted?: number; updated?: number; deleted?: number; duplicate?: boolean; ids?: number[] };
export type DatasetInput = { name: string; title?: string; columns: { name: string; type: string; label?: string; required?: boolean; values?: Record<string, string>; auto?: boolean }[]; key?: string[] };
export type ViewVersion = { version: number; sha256: string; author: string; note: string; at: number; active: boolean };
export type BenchChange = { kind: string; bench: string; target: string; from: number; to: number; actor: string; at: number };

// —— 库连接：随库不同的写法只在这里 ——
interface Conn {
  readonly dialect: BenchDialect;
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** 逐行取，取到一行调一次 onRow：结果可能很大的地方用它，边取边数，超了就停，不先整个装进内存 */
  scan(sql: string, params: unknown[], onRow: (row: Record<string, unknown>) => void): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<number>;
  /** 定这一次读写的时限：at 是到期的时刻（performance.now 的刻度，Infinity 是不限），budget 是给了多少毫秒（报错时用） */
  setDeadline(at: number, budget: number): void;
  /** 过了时限就抛 timeout；没过什么都不做。where 是停在哪一步，放进报错的细目里（调用方排查用，也让「停在了哪」可验） */
  check(where: string): void;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  backupTo(file: string): Promise<void>;
  close(): void;
}
class SqliteConn implements Conn {
  readonly dialect: BenchDialect = 'sqlite';
  private db: DatabaseSync;
  private cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private deadline = Infinity;
  private budget = 0;
  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS });
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      // 扫描守卫（db.ts 的 scanGuard 模板引用它）：库每扫过若干行回到这里看一眼时限，过了就抛错，语句当场停下
      this.db.function('bench_tick', { deterministic: false }, () => { this.check('扫描数据的中途'); return 1; });
    } catch (e) {
      try { this.db.close(); } catch { /* 没开成 */ }
      throw e;
    }
  }
  setDeadline(at: number, budget: number) {
    this.deadline = at; this.budget = budget;
    // 等写锁最多等多久：DB_BUSY_TIMEOUT_MS 和这一次的时限取小的（等锁的时候扫描守卫看不到时限，等过了会被看门狗强行中止）
    const wait = budget > 0 ? Math.max(1, Math.min(DB_BUSY_TIMEOUT_MS, Math.floor(budget))) : DB_BUSY_TIMEOUT_MS;
    if (wait !== this.busyWait) { this.db.exec(`PRAGMA busy_timeout = ${wait}`); this.busyWait = wait; }
  }
  private busyWait = DB_BUSY_TIMEOUT_MS;
  check(where: string) {
    if (performance.now() > this.deadline) throw new BenchError('timeout', `台库操作超过时限（${this.budget} 毫秒），已中止；这一次没有生效`, [`停在：${where}`]);
  }
  /**
   * 出过错的语句不再复用：逐行取到一半被打断（超时、结果太大）的语句，下一次再用会先报一次上回的错。
   * 实测只有逐行取有这个问题；三种用法一律这样处理，省得记哪种有哪种没有。
   */
  private use<T>(sql: string, fn: (s: ReturnType<DatabaseSync['prepare']>) => T): T {
    try { return fn(this.stmt(sql)); } catch (e) { this.cache.delete(sql); throw e; }
  }
  async scan(sql: string, params: unknown[], onRow: (row: Record<string, unknown>) => void) {
    this.use(sql, (s) => { for (const row of s.iterate(...(params as never[]))) onRow(row as Record<string, unknown>); });
  }
  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 200) this.cache.clear();
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  async all(sql: string, params: unknown[] = []) { return this.use(sql, (s) => s.all(...(params as never[])) as Record<string, unknown>[]); }
  async run(sql: string, params: unknown[] = []) { return this.use(sql, (s) => Number(s.run(...(params as never[])).changes)); }
  async begin() { this.db.exec('BEGIN IMMEDIATE'); }
  async commit() { this.db.exec('COMMIT'); }
  async rollback() { try { this.db.exec('ROLLBACK'); } catch { /* 没有开着的事务 */ } }
  async backupTo(file: string) { this.cache.clear(); this.db.prepare('VACUUM INTO ?').run(file); }
  close() { this.cache.clear(); this.db.close(); }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** 键按字典序排好再序列化：同一份内容，键的先后不同也是同一个摘要 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const asBenchError = (e: unknown): BenchError => (e instanceof BenchError ? e : new BenchError('internal', '台库内部错误', [], e));
/** 填模板里的 {名字}；模板出自 db.ts 的 benchSqlKit，填进去的名字都已经核对过 */
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{([a-z]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k] : m));

function checkCtx(ctx: WriteCtx, noteRequired = false): { actor: string; at: number; note: string } {
  if (!ctx || typeof ctx.actor !== 'string' || !ctx.actor.trim() || ctx.actor.length > 128) throw new BenchError('invalid', '缺操作者（actor，128 个字符以内）');
  if (!Number.isSafeInteger(ctx.at) || ctx.at <= 0) throw new BenchError('invalid', '缺时间（at，毫秒）');
  const note = typeof ctx.note === 'string' ? ctx.note.trim() : '';
  if (note.length > BENCH_LIMITS.noteChars) throw new BenchError('invalid', `说明最多 ${BENCH_LIMITS.noteChars} 个字符`);
  if (noteRequired && !note) throw new BenchError('invalid', '要写一句说明（note）');
  if (ctx.idemKey !== undefined && (typeof ctx.idemKey !== 'string' || !IDEM_RE.test(ctx.idemKey))) throw new BenchError('invalid', '幂等键须为 8～128 个可见 ASCII 字符');
  return { actor: ctx.actor.trim(), at: ctx.at, note };
}

/** 把一份数据集定义核对并规范化（列名、类型、主键）；主键列一律必填 */
function normalizeDataset(input: DatasetInput): { name: string; title: string; columns: ColumnDef[]; key: string[] } {
  if (!isObj(input)) throw new BenchError('invalid', '数据集定义须为对象');
  const extra = Object.keys(input).filter((k) => !['name', 'title', 'columns', 'key'].includes(k));
  if (extra.length) throw new BenchError('invalid', `数据集定义有不认识的键：${extra.join('、')}`);
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) throw new BenchError('invalid', '数据集名须为小写字母开头，只含小写字母、数字、下划线，最多 48 个字符');
  const title = input.title === undefined ? input.name : input.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 64) throw new BenchError('invalid', '标题须为 1～64 个字符');
  if (!Array.isArray(input.columns) || !input.columns.length) throw new BenchError('invalid', '至少要有一列');
  if (input.columns.length > BENCH_LIMITS.columns) throw new BenchError('limit', `列数超过上限 ${BENCH_LIMITS.columns}`);
  const key = input.key ?? [];
  if (!Array.isArray(key) || key.length > BENCH_LIMITS.keyColumns || key.some((k) => typeof k !== 'string') || new Set(key).size !== key.length) throw new BenchError('invalid', `主键须为不重复的列名数组（最多 ${BENCH_LIMITS.keyColumns} 列）`);
  const seen = new Set<string>();
  const columns = input.columns.map((c, i) => {
    const at = `第 ${i + 1} 列`;
    if (!isObj(c)) throw new BenchError('invalid', `${at} 须为对象`);
    const ex = Object.keys(c).filter((k) => !['name', 'type', 'label', 'required', 'values', 'auto'].includes(k));
    if (ex.length) throw new BenchError('invalid', `${at} 有不认识的键：${ex.join('、')}`);
    if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) throw new BenchError('invalid', `${at}：列名须为小写字母开头，只含小写字母、数字、下划线，最多 48 个字符`);
    if (seen.has(c.name)) throw new BenchError('invalid', `列名重复：${c.name}`);
    seen.add(c.name);
    if (!COLUMN_TYPES.includes(c.type as never)) throw new BenchError('invalid', `${at}（${c.name}）：类型须为 ${COLUMN_TYPES.join(' / ')}`);
    if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 64)) throw new BenchError('invalid', `${at}（${c.name}）：显示名须为 64 个字符以内的文本`);
    if (c.required !== undefined && typeof c.required !== 'boolean') throw new BenchError('invalid', `${at}（${c.name}）：required 须为 true 或 false`);
    // 取值说明：{ 取值: 意思 }，最多 100 项；取值、意思都是文本（取值最多 200 个字符，意思最多 64 个字符）
    let values: Record<string, string> | undefined;
    if (c.values !== undefined) {
      if (!isObj(c.values)) throw new BenchError('invalid', `${at}（${c.name}）：values 须为对象，写「取值: 意思」，比如 { "bad": "异常" }`);
      const ents = Object.entries(c.values as Record<string, unknown>);
      if (ents.length > 100) throw new BenchError('limit', `${at}（${c.name}）：values 最多 100 项`);
      for (const [v, m] of ents) if (v.length > 200 || typeof m !== 'string' || !m.trim() || m.length > 64) throw new BenchError('invalid', `${at}（${c.name}）：values 里每一项都要写「取值: 意思」，意思是 1～64 个字符的文本`);
      if (ents.length) values = Object.fromEntries(ents.map(([v, m]) => [v, (m as string).trim()]));
    }
    if (c.auto !== undefined && typeof c.auto !== 'boolean') throw new BenchError('invalid', `${at}（${c.name}）：auto 须为 true 或 false`);
    if (c.auto === true && !(c.type === 'integer' && key.length === 1 && key[0] === c.name)) throw new BenchError('invalid', `${at}（${c.name}）：auto 只用于唯一的整数主键列`);
    return { name: c.name, type: c.type as ColumnDef['type'], label: c.label ?? '', required: c.required === true || key.includes(c.name), ...(values ? { values } : {}), ...(c.auto === true ? { auto: true as const } : {}) };
  });
  for (const k of key) {
    const c = columns.find((x) => x.name === k);
    if (!c) throw new BenchError('invalid', `主键里的列 ${k} 不在列定义里`);
    if (c.type === 'decimal' || c.type === 'boolean') throw new BenchError('invalid', `主键列 ${k} 不能是小数或布尔`);
  }
  return { name: input.name, title: title.trim(), columns, key: [...key] };
}

type CheckedRow = { cols: string[]; vals: (string | number | null)[] };
/** 存下来的视图描述（保存时已经由 bench-views.ts 核对过，这里只取用到的形状） */
type FilterField = { name: string; kind: string; label?: string; default?: string; options?: string[] | { dataset: string; col: string } };
type ViewBlock = { type: string; [k: string]: unknown };
type ViewDoc = { title: string; views: { key: string; title: string; blocks: ViewBlock[] }[] };
/** 三道数据量上限（字节）；默认取 BENCH_LIMITS，测试可以给小的 */
export type BenchCaps = { datasetBytes: number; storeBytes: number; writeBytes: number };
const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 0)} MB`;
/** 一格占多少字节：文本按 UTF-8 字节数，数字和布尔算 8，空算 1。和 measure() 里库那一侧的算法是同一个 */
const cellBytes = (v: string | number | null) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : v === null ? 1 : 8);

/**
 * 写入的行可以是已经解析好的数组，也可以是原始字节（JSON 文本，UTF-8）。
 * 给字节的好处：大的请求体不用在市场进程里解析，原样递过来在这里解析；大小也在解析之前就能卡住。
 */
function decodeInput(input: unknown, maxBytes: number): unknown {
  if (!(input instanceof Uint8Array)) return input;
  if (input.byteLength > maxBytes) throw new BenchError('limit', `这次写入有 ${mb(input.byteLength)}，超过一次写入的上限 ${mb(maxBytes)}`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { throw new BenchError('invalid', '写入的内容不是合法的 UTF-8 文本'); }
  try { return JSON.parse(text) as unknown; } catch { throw new BenchError('invalid', '写入的内容不是合法的 JSON'); }
}
/**
 * 逐行按列定义核对。full：每行都落全部列（没给的可空列记空）；partial：只落给了的列，但主键列和必填列必须给。
 * 不合格整批拒收，逐条说明（最多列 50 条）。
 */
function checkRows(ds: DatasetDef, rows: unknown, mode: 'full' | 'partial', max: number, maxBytes: number): CheckedRow[] {
  if (!Array.isArray(rows)) throw new BenchError('invalid', 'rows 须为数组');
  if (rows.length > max) throw new BenchError('limit', `一次最多 ${max} 行（收到 ${rows.length} 行）`);
  const byName = new Map(ds.columns.map((c) => [c.name, c]));
  const errs: string[] = [], out: CheckedRow[] = [];
  let total = 0, bytes = 0;
  const push = (m: string) => { total++; if (errs.length < 50) errs.push(m); };
  rows.forEach((row, i) => {
    const at = `第 ${i + 1} 行`;
    if (!isObj(row)) { push(`${at}：须为对象`); return; }
    for (const k of Object.keys(row)) if (!byName.has(k)) push(`${at}：数据集 ${ds.name} 没有列 ${k.slice(0, 60)}`);
    const cols: string[] = [], vals: (string | number | null)[] = [];
    for (const c of ds.columns) {
      const given = Object.prototype.hasOwnProperty.call(row, c.name);
      if (!given && mode === 'partial' && !c.required) continue;
      const r = coerceValue(c.type, given ? row[c.name] : null);
      if ('error' in r) { push(`${at} 列 ${c.name}：${r.error}`); continue; }
      if (r.value === null && c.required) { push(`${at} 列 ${c.name}：必填`); continue; }
      cols.push(c.name); vals.push(r.value);
      bytes += cellBytes(r.value);
    }
    out.push({ cols, vals });
  });
  if (ds.key.length) {
    const seen = new Map<string, number>();
    out.forEach((r, i) => {
      const k = JSON.stringify(ds.key.map((kc) => r.vals[r.cols.indexOf(kc)]));
      if (seen.has(k)) push(`第 ${i + 1} 行：主键和第 ${seen.get(k)! + 1} 行重复`);
      else seen.set(k, i);
    });
  }
  if (total) throw new BenchError('invalid', `有 ${total} 处不合格，整批未写入`, total > errs.length ? [...errs, `……只列前 ${errs.length} 条`] : errs);
  if (bytes > maxBytes) throw new BenchError('limit', `这次写入有 ${mb(bytes)}，超过一次写入的上限 ${mb(maxBytes)}，整批未写入`);
  return out;
}

export class BenchStoreCore {
  readonly slug: string;
  private conn: Conn;
  private kit: BenchSqlKit;
  private emit: (c: BenchChange) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private pending: BenchChange[] = [];
  private closed = false;
  private budgetMs = 0;
  private caps: BenchCaps;

  constructor(slug: string, conn: Conn, kit: BenchSqlKit, emit: (c: BenchChange) => void, caps: BenchCaps) { this.slug = slug; this.conn = conn; this.kit = kit; this.emit = emit; this.caps = caps; }

  private sqlType(t: string): string {
    const hit = this.kit.types.find(([k]) => k === t);
    if (!hit) throw new BenchError('invalid', `不认识的列类型 ${String(t).slice(0, 40)}`);
    return hit[1];
  }
  /** 扫描守卫：把筛选条件包一层，让长时间的扫描中途能停（见 db.ts 的 scanGuard） */
  private guard = (cond: string | null): string | null => (this.kit.scanGuard ? fill(this.kit.scanGuard, { cond: cond ?? '1' }) : cond);

  /**
   * 给 fn 里发起的那一次读写定时限（毫秒；0 是不限）。时限从轮到它开始跑的那一刻算，排队的时间不算。
   * fn 要同步地调到这个台的某个操作（它们都是一进来就排队），时限就是在排队的那一刻记下的。
   */
  withBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    this.budgetMs = ms;
    try { return fn(); } finally { this.budgetMs = 0; }
  }

  /** 这个台的读写排成一队。已经关掉的句柄一律拒绝：台被删了或库被关了之后，手里还拿着旧句柄的调用方要重新取 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BenchError('conflict', `台库 ${this.slug} 已经关闭，重新取一次再用`));
    const budget = this.budgetMs;
    const run = async () => {
      this.conn.setDeadline(budget > 0 ? performance.now() + budget : Infinity, budget);
      try { return await fn(); } catch (e) { throw asBenchError(e); } finally { this.conn.setDeadline(Infinity, 0); }
    };
    const r = this.chain.then(run, run);
    this.chain = r.catch(() => undefined);
    return r;
  }
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.conn.begin();
      this.pending = [];
      let r: T;
      // 提交之前再看一次时限：过了就不提交。这样「报了超时」和「没有生效」是同一回事
      try { r = await fn(); this.conn.check('提交之前'); await this.conn.commit(); } catch (e) {
        await this.conn.rollback();
        this.pending = [];
        if (!(e instanceof BenchError) && /unique|duplicate/i.test(String((e as Error)?.message ?? ''))) throw new BenchError('conflict', '主键重复：已有同主键的行');
        throw e;
      }
      const fired = this.pending; this.pending = [];
      for (const c of fired) { try { this.emit(c); } catch { /* 通知失败不影响已提交的写入 */ } }
      return r;
    });
  }

  /** 建好固定的几张表；库比这份代码新就拒绝打开（旧代码不认识新结构，不碰它） */
  async init(): Promise<void> {
    await this.serial(async () => {
      const mine = this.kit.schemaVersion;
      for (const sql of this.kit.schema) await this.conn.run(sql);
      const v = await this.meta('schema_version');
      if (v === null) await this.setMeta('schema_version', String(mine));
      else if (Number(v) > mine) throw new BenchError('unsupported', `台库 ${this.slug} 的结构是第 ${v} 版，比这份代码认识的第 ${mine} 版新，不打开`);
      // bs_vars 是附加的表：开库不建（main 档下台库和原来一样），有没有由 hasVars 现查，第一次写由 ensureVars 建
      // 版本号对得上，结构也要对得上：固定的几张表各试读一遍该有的列
      for (const probe of this.kit.probes) {
        try { await this.conn.all(probe); } catch (e) { throw new BenchError('unsupported', `台库 ${this.slug} 的结构和这份代码不符，不打开`, [], e); }
      }
    });
  }
  private async meta(k: string): Promise<string | null> {
    const r = await this.conn.all('SELECT v FROM bs_meta WHERE k = ?', [k]);
    return r.length ? String(r[0].v) : null;
  }
  private async setMeta(k: string, v: string): Promise<void> {
    if (!(await this.conn.run('UPDATE bs_meta SET v = ? WHERE k = ?', [v, k]))) await this.conn.run('INSERT INTO bs_meta (k, v) VALUES (?, ?)', [k, v]);
  }
  private async change(kind: string, target: string, from: number, to: number, c: { actor: string; at: number; note: string }): Promise<void> {
    await this.conn.run('INSERT INTO bs_changes (kind, target, from_version, to_version, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, target, from, to, c.actor, c.note, c.at]);
    const max = await this.conn.all('SELECT MAX(id) AS m FROM bs_changes');
    await this.conn.run('DELETE FROM bs_changes WHERE id <= ?', [Number(max[0].m ?? 0) - BENCH_LIMITS.changeLog]);
    this.pending.push({ kind, bench: this.slug, target, from, to, actor: c.actor, at: c.at });
  }

  // —— 数据集 ——
  private async load(): Promise<Map<string, DatasetDef>> {
    const rows = await this.conn.all('SELECT name, title, version, columns, key_cols, row_count, data_bytes, created_at, updated_at, updated_by FROM bs_datasets ORDER BY name');
    return new Map(rows.map((r) => [String(r.name), {
      name: String(r.name), title: String(r.title), version: Number(r.version), columns: JSON.parse(String(r.columns)), key: JSON.parse(String(r.key_cols)),
      row_count: Number(r.row_count), data_bytes: Number(r.data_bytes), created_at: Number(r.created_at), updated_at: Number(r.updated_at), updated_by: String(r.updated_by),
    } as DatasetDef]));
  }
  private async need(name: string): Promise<DatasetDef> {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new BenchError('invalid', '数据集名写法不对');
    const ds = (await this.load()).get(name);
    if (!ds) throw new BenchError('not_found', `没有数据集 ${name}`);
    return ds;
  }
  datasets(): Promise<DatasetDef[]> { return this.serial(async () => [...(await this.load()).values()]); }

  /**
   * 建数据集，或改已有数据集的列定义。
   * 加列、改显示名、改必填随时可以（改成必填或设主键前核对现有行）；删列是破坏性的，先自动留快照；改列的类型不支持（新建一列，由写入方重写数据）。
   */
  defineDataset(input: DatasetInput, ctx: WriteCtx) {
    return this.tx(async () => {
      const c = checkCtx(ctx), def = normalizeDataset(input);
      const all = await this.load(), old = all.get(def.name), tbl = physTable(def.name), idx = `ux_${tbl}`;
      if (!old) {
        if (all.size >= BENCH_LIMITS.datasets) throw new BenchError('limit', `数据集个数已到上限 ${BENCH_LIMITS.datasets}`);
        await this.conn.run(fill(this.kit.createTable, { table: tbl, columns: def.columns.map((x) => `, ${physCol(x.name)} ${this.sqlType(x.type)}`).join('') }));
        if (def.key.length) await this.conn.run(fill(this.kit.keyIndex, { index: idx, table: tbl, cols: def.key.map(physCol).join(', ') }));
        await this.conn.run('INSERT INTO bs_datasets (name, title, version, columns, key_cols, row_count, data_bytes, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, 0, 0, ?, ?, ?)',
          [def.name, def.title, JSON.stringify(def.columns), JSON.stringify(def.key), c.at, c.at, c.actor]);
        await this.conn.run('INSERT INTO bs_dataset_versions (dataset, version, title, columns, key_cols, author, note, at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
          [def.name, def.title, JSON.stringify(def.columns), JSON.stringify(def.key), c.actor, c.note, c.at]);
        await this.change('dataset.define', def.name, 0, 1, c);
        return { name: def.name, version: 1, created: true, unchanged: false, added: def.columns.map((x) => x.name), removed: [] as string[], snapshot_id: undefined as number | undefined };
      }
      const oldBy = new Map(old.columns.map((x) => [x.name, x])), newBy = new Map(def.columns.map((x) => [x.name, x]));
      for (const x of def.columns) { const o = oldBy.get(x.name); if (o && o.type !== x.type) throw new BenchError('unsupported', `列 ${x.name} 的类型不能从 ${o.type} 改成 ${x.type}：新建一列，由写入方重写数据`); }
      const added = def.columns.filter((x) => !oldBy.has(x.name)), removed = old.columns.filter((x) => !newBy.has(x.name));
      const keyChanged = JSON.stringify(old.key) !== JSON.stringify(def.key);
      if (!added.length && !removed.length && !keyChanged && old.title === def.title && JSON.stringify(old.columns) === JSON.stringify(def.columns)) {
        return { name: def.name, version: old.version, created: false, unchanged: true, added: [], removed: [], snapshot_id: undefined };
      }
      if (old.row_count > 0) {
        for (const x of added) if (x.required) throw new BenchError('invalid', `已有 ${old.row_count} 行数据，不能加必填列 ${x.name}：先加成可空，写完数据再改必填`);
        for (const x of def.columns) {
          const o = oldBy.get(x.name);
          if (o && x.required && !o.required) {
            const n = await this.conn.all(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${physCol(x.name)} IS NULL`);
            if (Number(n[0].n) > 0) throw new BenchError('invalid', `列 ${x.name} 有 ${Number(n[0].n)} 行是空的，不能改成必填`);
          }
        }
      }
      let snapshotId: number | undefined;
      if (removed.length && old.row_count > 0) snapshotId = (await this.takeSnapshot(old, 'before-drop-column', c)).id;
      if (keyChanged) await this.conn.run(fill(this.kit.dropIndex, { index: idx }));
      for (const x of removed) await this.conn.run(fill(this.kit.dropColumn, { table: tbl, col: physCol(x.name) }));
      for (const x of added) await this.conn.run(fill(this.kit.addColumn, { table: tbl, col: physCol(x.name), type: this.sqlType(x.type) }));
      if (keyChanged && def.key.length) {
        const cols = def.key.map(physCol).join(', ');
        const dup = await this.conn.all(`SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM ${tbl} GROUP BY ${cols} HAVING COUNT(*) > 1) t`);
        if (Number(dup[0].n) > 0) throw new BenchError('conflict', `现有数据里有 ${Number(dup[0].n)} 组主键重复，不能把主键设成 ${def.key.join('、')}`);
        await this.conn.run(fill(this.kit.keyIndex, { index: idx, table: tbl, cols: def.key.map(physCol).join(', ') }));
      }
      const version = old.version + 1;
      await this.conn.run('UPDATE bs_datasets SET title = ?, version = ?, columns = ?, key_cols = ?, updated_at = ?, updated_by = ? WHERE name = ?',
        [def.title, version, JSON.stringify(def.columns), JSON.stringify(def.key), c.at, c.actor, def.name]);
      await this.conn.run('INSERT INTO bs_dataset_versions (dataset, version, title, columns, key_cols, author, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [def.name, version, def.title, JSON.stringify(def.columns), JSON.stringify(def.key), c.actor, c.note, c.at]);
      // 列定义的历史只留最近若干版
      await this.conn.run('DELETE FROM bs_dataset_versions WHERE dataset = ? AND version <= ?', [def.name, version - BENCH_LIMITS.datasetVersions]);
      // 加了列、删了列，数据量跟着变：重量一遍
      if (added.length || removed.length) {
        const bytes = await this.account({ ...old, columns: def.columns });
        await this.conn.run('UPDATE bs_datasets SET data_bytes = ? WHERE name = ?', [bytes, def.name]);
      }
      await this.change('dataset.define', def.name, old.version, version, c);
      return { name: def.name, version, created: false, unchanged: false, added: added.map((x) => x.name), removed: removed.map((x) => x.name), snapshot_id: snapshotId };
    });
  }
  /** 列定义的历史版本（新的在前） */
  datasetVersions(name: string) {
    return this.serial(async () => {
      await this.need(name);
      const rows = await this.conn.all('SELECT version, title, columns, key_cols, author, note, at FROM bs_dataset_versions WHERE dataset = ? ORDER BY version DESC', [name]);
      return rows.map((r) => ({ version: Number(r.version), title: String(r.title), columns: JSON.parse(String(r.columns)) as ColumnDef[], key: JSON.parse(String(r.key_cols)) as string[], author: String(r.author), note: String(r.note), at: Number(r.at) }));
    });
  }

  // —— 写入 ——
  /**
   * 幂等和写入记录：同一个人、同键同内容返回原结果，同键不同内容拒绝；记录只存摘要。
   * 键按写的人隔开：别人用过的键，对这个人等于没用过——不会拿到别人那次写入的结果，也不会从「键已用在另一份内容上」看出别人写过什么。
   * 存进 idem_key 列的是「写的人 + 换行 + 键」（键只收可见 ASCII，不含换行，拼出来不会和别人的撞）。
   */
  private async logged(ds: DatasetDef, op: string, payload: unknown, ctx: WriteCtx, fn: (c: { actor: string; at: number; note: string }) => Promise<WriteResult>): Promise<WriteResult> {
    const c = checkCtx(ctx), body = sha256(canonical([ds.name, op, payload]));
    const scopedKey = ctx.idemKey ? `${c.actor}\n${ctx.idemKey}` : null;
    if (scopedKey) {
      const prev = await this.conn.all('SELECT dataset, op, body_sha256, result FROM bs_writes WHERE idem_key = ?', [scopedKey]);
      if (prev.length) {
        if (prev[0].body_sha256 !== body) throw new BenchError('conflict', '这个幂等键已经用在另一份内容上');
        // 重放：什么都没再写。插入、更新、删除的行数都是 0（不能一边说 inserted 1 一边说 duplicate）；第一次分配的主键照旧带回
        const first = JSON.parse(String(prev[0].result)) as WriteResult;
        return { ...first, ...(first.inserted !== undefined ? { inserted: 0 } : {}), ...(first.updated !== undefined ? { updated: 0 } : {}), ...(first.deleted !== undefined ? { deleted: 0 } : {}), duplicate: true };
      }
    }
    const res = await fn(c);
    const n = await this.conn.all(`SELECT COUNT(*) AS n FROM ${physTable(ds.name)}`);
    res.row_count = Number(n[0].n);
    if (res.row_count > BENCH_LIMITS.rows) throw new BenchError('limit', `数据集 ${ds.name} 写入后有 ${res.row_count} 行，超过上限 ${BENCH_LIMITS.rows}，整批未写入`);
    res.data_bytes = await this.account(ds);
    await this.conn.run('UPDATE bs_datasets SET row_count = ?, data_bytes = ?, updated_at = ?, updated_by = ? WHERE name = ?', [res.row_count, res.data_bytes, c.at, c.actor, ds.name]);
    await this.conn.run('INSERT INTO bs_writes (dataset, op, idem_key, body_sha256, row_count, actor, at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ds.name, op, scopedKey, body, res.rows, c.actor, c.at, JSON.stringify(res)]);
    const max = await this.conn.all('SELECT MAX(id) AS m FROM bs_writes');
    await this.conn.run('DELETE FROM bs_writes WHERE id <= ?', [Number(max[0].m ?? 0) - BENCH_LIMITS.writeLog]);
    this.pending.push({ kind: `data.${op}`, bench: this.slug, target: ds.name, from: ds.version, to: ds.version, actor: c.actor, at: c.at });
    return res;
  }
  /** 量这个数据集现在占多少字节（一次扫描；算法和 cellBytes 是同一个，octet_length 两种库都有） */
  private async measure(ds: Pick<DatasetDef, 'name' | 'columns'>): Promise<number> {
    const parts = ds.columns.map((c) => {
      const col = physCol(c.name);
      return c.type === 'text' || c.type === 'date' || c.type === 'datetime' ? `COALESCE(octet_length(${col}), 1)` : `CASE WHEN ${col} IS NULL THEN 1 ELSE 8 END`;
    });
    const r = await this.conn.all(`SELECT COALESCE(SUM(${parts.join(' + ')}), 0) AS n FROM ${physTable(ds.name)}`);
    return Number(r[0].n);
  }
  /**
   * 写完之后量一遍并卡上限：单个数据集、这个台的在用数据合计。超了抛错，由事务整批回滚。
   * 只拦「变大」的写入：已经超了的（上限后来调小了）还能删行、换成更小的一份，不会被卡死。
   */
  private async account(ds: Pick<DatasetDef, 'name' | 'columns' | 'data_bytes'>): Promise<number> {
    const bytes = await this.measure(ds);
    if (bytes <= ds.data_bytes) return bytes;
    if (bytes > this.caps.datasetBytes) throw new BenchError('limit', `数据集 ${ds.name} 写入后有 ${mb(bytes)}，超过单个数据集的上限 ${mb(this.caps.datasetBytes)}，整批未写入`);
    const others = Number((await this.conn.all('SELECT COALESCE(SUM(data_bytes), 0) AS n FROM bs_datasets WHERE name <> ?', [ds.name]))[0].n);
    if (others + bytes > this.caps.storeBytes) throw new BenchError('limit', `这个台的数据写入后合计 ${mb(others + bytes)}，超过单台的上限 ${mb(this.caps.storeBytes)}，整批未写入`);
    return bytes;
  }
  private async insert(ds: DatasetDef, rows: CheckedRow[]): Promise<void> {
    const tbl = physTable(ds.name);
    let n = 0;
    for (const r of rows) {
      if ((n++ & 63) === 0) this.conn.check(`写第 ${n} 行之前`); // 行与行之间看时限
      await this.conn.run(`INSERT INTO ${tbl} (${r.cols.map(physCol).join(', ')}) VALUES (${r.cols.map(() => '?').join(', ')})`, r.vals);
    }
  }
  /**
   * 给数据集留一份快照。内容和这个数据集最近的一份快照一样就不再存，返回那一份的编号（reused）：
   * 快照个数有上限、旧的先清，不改变数据的操作不该把还用得上的那几份挤掉。
   * 最近一次整份替换留下的那一份（上一代）不参与淘汰：替换之后又删了多少次行，替换前的数据都还退得回去，直到下一次整份替换。
   *
   * 行不读进服务的内存：先逐行扫一遍只算摘要（过一行丢一行），不重复才在库里直接从数据集的表复制到快照的表。
   * 每行存成按列次序排的 JSON 数组；列定义和主键放在快照的头里。
   */
  private async takeSnapshot(ds: DatasetDef, reason: string, c: { actor: string; at: number }): Promise<{ id: number; reused: boolean }> {
    const tbl = physTable(ds.name), rowExpr = fill(this.kit.snapshotRow, { cols: ds.columns.map((x) => physCol(x.name)).join(', ') });
    const head = JSON.stringify({ columns: ds.columns, key: ds.key });
    const h = createHash('sha256').update(head, 'utf8');
    let n = 0;
    await this.conn.scan(`SELECT ${rowExpr} AS r FROM ${tbl} ORDER BY rid`, [], (r) => {
      if ((n++ & 1023) === 0) this.conn.check('留快照的中途');
      h.update('\n').update(String(r.r), 'utf8');
    });
    const sum = h.digest('hex');
    const last = await this.conn.all('SELECT id, reason, content_sha256 FROM bs_snapshots WHERE dataset = ? ORDER BY id DESC LIMIT 1', [ds.name]);
    if (last.length && last[0].content_sha256 === sum) {
      // 沿用的这一份现在是「替换前的上一代」了：改记成替换留下的，它才受上面那条保护
      if (reason === 'replace' && last[0].reason !== 'replace') await this.conn.run('UPDATE bs_snapshots SET reason = ? WHERE id = ?', ['replace', Number(last[0].id)]);
      return { id: Number(last[0].id), reused: true };
    }
    const r = await this.conn.all('INSERT INTO bs_snapshots (dataset, dataset_version, reason, row_count, content, content_sha256, author, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [ds.name, ds.version, reason, n, head, sum, c.actor, c.at]);
    const id = Number(r[0].id);
    await this.conn.run(`INSERT INTO bs_snapshot_rows (snapshot_id, seq, row) SELECT ?, rid, ${rowExpr} FROM ${tbl}`, [id]);
    const all = await this.conn.all('SELECT id, reason FROM bs_snapshots WHERE dataset = ? ORDER BY id DESC', [ds.name]);
    const pinned = all.find((x) => x.reason === 'replace');
    const others = all.filter((x) => x !== pinned);
    for (const x of others.slice(BENCH_LIMITS.snapshots - (pinned ? 1 : 0))) {
      await this.conn.run('DELETE FROM bs_snapshot_rows WHERE snapshot_id = ?', [Number(x.id)]);
      await this.conn.run('DELETE FROM bs_snapshots WHERE id = ?', [Number(x.id)]);
    }
    return { id, reused: false };
  }

  /** 整份替换：给全部行，原子切换；原来有数据就先留一份快照（上一代）。行可以给数组，也可以给原始字节（见 decodeInput） */
  replace(name: string, input: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name), rows = decodeInput(input, this.caps.datasetBytes), checked = checkRows(ds, rows, 'full', BENCH_LIMITS.rows, this.caps.datasetBytes);
      return this.logged(ds, 'replace', rows, ctx, async (c) => {
        const snapshot_id = ds.row_count > 0 ? (await this.takeSnapshot(ds, 'replace', c)).id : undefined;
        await this.conn.run(`DELETE FROM ${physTable(ds.name)}`);
        await this.insert(ds, checked);
        return { dataset: ds.name, op: 'replace', rows: checked.length, row_count: 0, snapshot_id };
      });
    });
  }
  /** 只追加；有主键时和已有的行撞了就整批拒收 */
  append(name: string, input: unknown, ctx: WriteCtx) {
    return this.tx(() => this.appendIn(name, input, ctx));
  }
  /** 追加的本体；要在事务里调（append 和表单提交共用）。op 是写入记录里记的操作名：表单提交记成 form，和直接追加分得开 */
  private async appendIn(name: string, input: unknown, ctx: WriteCtx, op: 'append' | 'form' = 'append'): Promise<WriteResult> {
    const ds = await this.need(name), rows = decodeInput(input, this.caps.writeBytes);
    // 主键由服务端分配的数据集：没给主键的行，按现有最大值往上数（写入是一个接一个排队做的，两个席位同时追加也不会撞号）。
    // 幂等核对用的是调用方给的原样（没分配之前的），重放时带回第一次分配的号
    const auto = ds.columns.find((c) => c.auto);
    let filled: unknown = rows, ids: number[] | undefined;
    if (auto && Array.isArray(rows)) {
      const max = Number((await this.conn.all(`SELECT MAX(${physCol(auto.name)}) AS m FROM ${physTable(ds.name)}`))[0].m ?? 0);
      // 同一批里手填了的号跳过，免得分到的号正好撞上这批手填的
      // （表单那条路宽松，号可以写成字符串，也认）
      const given = new Set(rows.map((r) => { const v = isObj(r) ? r[auto.name] : undefined; return typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : v; }).filter((v): v is number => Number.isSafeInteger(v)));
      let next = max;
      ids = [];
      filled = rows.map((r) => {
        if (!isObj(r) || (Object.prototype.hasOwnProperty.call(r, auto.name) && r[auto.name] !== null)) return r;
        do next++; while (given.has(next));
        ids!.push(next);
        return { ...r, [auto.name]: next };
      });
    }
    const checked = checkRows(ds, filled, 'full', BENCH_LIMITS.rowsPerWrite, this.caps.writeBytes);
    return this.logged(ds, op, rows, ctx, async () => {
      await this.insert(ds, checked);
      return { dataset: ds.name, op, rows: checked.length, row_count: 0, inserted: checked.length, ...(ids && ids.length ? { ids } : {}) };
    });
  }
  /** 按主键有则改、无则加；每行给主键列和必填列，其余给了哪些列就改哪些列 */
  upsert(name: string, input: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name);
      if (!ds.key.length) throw new BenchError('invalid', `数据集 ${ds.name} 没有主键，不能按主键更新`);
      const rows = decodeInput(input, this.caps.writeBytes), checked = checkRows(ds, rows, 'partial', BENCH_LIMITS.rowsPerWrite, this.caps.writeBytes);
      return this.logged(ds, 'upsert', rows, ctx, async () => {
        const tbl = physTable(ds.name), keyCols = ds.key.map(physCol).join(', ');
        const before = Number((await this.conn.all(`SELECT COUNT(*) AS n FROM ${tbl}`))[0].n);
        let n = 0;
        for (const r of checked) {
          if ((n++ & 63) === 0) this.conn.check(`写第 ${n} 行之前`);
          const rest = r.cols.filter((x) => !ds.key.includes(x));
          await this.conn.run(`INSERT INTO ${tbl} (${r.cols.map(physCol).join(', ')}) VALUES (${r.cols.map(() => '?').join(', ')}) ON CONFLICT (${keyCols}) DO `
            + (rest.length ? `UPDATE SET ${rest.map((x) => `${physCol(x)} = excluded.${physCol(x)}`).join(', ')}` : 'NOTHING'), r.vals);
        }
        const after = Number((await this.conn.all(`SELECT COUNT(*) AS n FROM ${tbl}`))[0].n);
        return { dataset: ds.name, op: 'upsert', rows: checked.length, row_count: 0, inserted: after - before, updated: checked.length - (after - before) };
      });
    });
  }
  /** 按主键删行；破坏性操作，删之前先留快照。给的主键一行也没对上：什么都不删，也不留快照 */
  deleteRows(name: string, input: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name), keys = decodeInput(input, this.caps.writeBytes);
      if (!ds.key.length) throw new BenchError('invalid', `数据集 ${ds.name} 没有主键，不能按主键删行`);
      if (!Array.isArray(keys) || !keys.length) throw new BenchError('invalid', 'keys 须为非空数组');
      if (keys.length > BENCH_LIMITS.rowsPerWrite) throw new BenchError('limit', `一次最多 ${BENCH_LIMITS.rowsPerWrite} 行`);
      const errs: string[] = [];
      const vals = keys.map((k, i) => {
        if (!isObj(k) || Object.keys(k).length !== ds.key.length) { errs.push(`第 ${i + 1} 项：须为只含主键列（${ds.key.join('、')}）的对象`); return []; }
        return ds.key.map((kc) => {
          const r = coerceValue(ds.columns.find((x) => x.name === kc)!.type, (k as Record<string, unknown>)[kc]);
          if ('error' in r || r.value === null) { errs.push(`第 ${i + 1} 项 列 ${kc}：${'error' in r ? r.error : '必填'}`); return null; }
          return r.value;
        });
      });
      if (errs.length) throw new BenchError('invalid', `有 ${errs.length} 处不合格，未删除`, errs.slice(0, 50));
      return this.logged(ds, 'delete', keys, ctx, async (c) => {
        const tbl = physTable(ds.name), cond = ds.key.map((kc) => `${physCol(kc)} = ?`).join(' AND ');
        let hit = false, n = 0;
        for (const v of vals) {
          if ((n++ & 63) === 0) this.conn.check('核对要删的行');
          if ((await this.conn.all(`SELECT 1 AS x FROM ${tbl} WHERE ${cond} LIMIT 1`, v)).length) { hit = true; break; }
        }
        if (!hit) return { dataset: ds.name, op: 'delete', rows: keys.length, row_count: 0, deleted: 0 };
        const snapshot_id = (await this.takeSnapshot(ds, 'before-delete', c)).id;
        let deleted = 0;
        for (const v of vals) {
          if ((n++ & 63) === 0) this.conn.check('删行的中途');
          deleted += await this.conn.run(`DELETE FROM ${tbl} WHERE ${cond}`, v);
        }
        return { dataset: ds.name, op: 'delete', rows: keys.length, row_count: 0, deleted, snapshot_id };
      });
    });
  }

  // —— 快照 ——
  snapshot(name: string, ctx: WriteCtx) {
    return this.tx(async () => {
      const c = checkCtx(ctx), ds = await this.need(name);
      const { id, reused } = await this.takeSnapshot(ds, 'manual', c);
      if (!reused) await this.change('dataset.snapshot', ds.name, ds.version, ds.version, { ...c, note: c.note || `快照 #${id}` });
      return { id, dataset: ds.name, row_count: ds.row_count, unchanged: reused };
    });
  }
  snapshots(name: string) {
    return this.serial(async () => {
      await this.need(name);
      const rows = await this.conn.all('SELECT id, dataset_version, reason, row_count, author, at FROM bs_snapshots WHERE dataset = ? ORDER BY id DESC', [name]);
      return rows.map((r) => ({ id: Number(r.id), dataset_version: Number(r.dataset_version), reason: String(r.reason), row_count: Number(r.row_count), author: String(r.author), at: Number(r.at) }));
    });
  }
  /** 把数据退回某一份快照：现在的数据先留一份快照（所以退错了能再退回来）；快照里已经不存在的列丢掉并在结果里说明 */
  restore(snapshotId: number, ctx: WriteCtx) {
    return this.tx(async () => {
      const c = checkCtx(ctx);
      const s = Number.isSafeInteger(snapshotId) ? await this.conn.all('SELECT id, dataset, content FROM bs_snapshots WHERE id = ?', [snapshotId]) : [];
      if (!s.length) throw new BenchError('not_found', `没有快照 #${String(snapshotId)}`);
      const ds = await this.need(String(s[0].dataset));
      const snap = JSON.parse(String(s[0].content)) as { columns: ColumnDef[] };
      // 快照里的行是数组，次序是留快照时的列定义；现在还在、类型没变的列才放回去
      const cols = snap.columns.map((x, i) => ({ name: x.name, type: x.type, i, usable: ds.columns.some((y) => y.name === x.name && y.type === x.type) }));
      const usable = cols.filter((x) => x.usable), dropped = cols.filter((x) => !x.usable).map((x) => x.name);
      const backup = ds.row_count > 0 ? (await this.takeSnapshot(ds, 'before-restore', c)).id : undefined;
      await this.conn.run(`DELETE FROM ${physTable(ds.name)}`);
      // 一批一批放回去，不把整份快照读进内存；中途出错由事务整个回滚
      let after = -1, restored = 0;
      for (;;) {
        this.conn.check('退回快照的中途');
        const page = await this.conn.all('SELECT seq, row FROM bs_snapshot_rows WHERE snapshot_id = ? AND seq > ? ORDER BY seq LIMIT 500', [snapshotId, after]);
        if (!page.length) break;
        after = Number(page[page.length - 1].seq);
        const rows = page.map((p) => { const arr = JSON.parse(String(p.row)) as unknown[]; return Object.fromEntries(usable.map((u) => [u.name, decodeValue(u.type, arr[u.i])])); });
        await this.insert(ds, checkRows(ds, rows, 'full', 500, Infinity));
        restored += rows.length;
      }
      const checked = { length: restored };
      const bytes = await this.account(ds);
      await this.conn.run('UPDATE bs_datasets SET row_count = ?, data_bytes = ?, updated_at = ?, updated_by = ? WHERE name = ?', [checked.length, bytes, c.at, c.actor, ds.name]);
      await this.change('dataset.restore', ds.name, ds.version, ds.version, { ...c, note: c.note || `退回快照 #${snapshotId}` });
      return { dataset: ds.name, restored_from: snapshotId, row_count: checked.length, dropped_columns: dropped, snapshot_id: backup };
    });
  }

  // —— 读 ——
  /** 按查询描述读；params 是筛选栏当前的值 */
  query(spec: unknown, params: Record<string, unknown> = {}) {
    return this.serial(async () => {
      const { chars: _chars, ...out } = await this.runQuery(await this.load(), spec, params, BENCH_LIMITS.resultChars);
      return { ...out, columns: out.columns.map(publicColumn) };
    });
  }
  /** 查询的本体；要在排着队的那一格里调。room 是还能取回多少个字符，chars 是这次取了多少 */
  private async runQuery(defs: Map<string, DatasetDef>, spec: unknown, params: Record<string, unknown>, room: number) {
    const plan = planQuery(spec, defs, { params, contains: (col) => fill(this.kit.contains, { col }), guard: this.guard });
    const rows: Record<string, unknown>[] = [];
    let truncated = false, chars = 0;
    // 边取边数：取回的内容太大就停，不先整个装进内存再说
    await this.conn.scan(plan.sql, plan.args, (r) => {
      if (rows.length >= plan.limit) { truncated = true; return; }
      rows.push(Object.fromEntries(plan.columns.map((c) => {
        const v = decodeValue(c.type, r[c.name]);
        chars += typeof v === 'string' ? v.length : 8;
        return [c.name, v];
      })));
      if (chars > room) throw new BenchError('limit', `取回的内容超过 ${BENCH_LIMITS.resultChars} 个字符：少取几列，或者把行数上限调小`);
    });
    return { dataset: plan.dataset, columns: plan.columns as OutColumn[], truncated, rows, chars };
  }

  // —— 视图取数与表单提交 ——
  private async viewDoc(version: number | undefined): Promise<{ version: number; active: number; doc: ViewDoc }> {
    const active = await this.activeVersion(), v = version ?? active;
    if (!v) throw new BenchError('not_found', '这个台还没有视图');
    const r = Number.isSafeInteger(v) ? await this.conn.all('SELECT content FROM bs_view_versions WHERE version = ?', [v]) : [];
    if (!r.length) throw new BenchError('not_found', `没有视图第 ${String(version)} 版`);
    return { version: v, active, doc: JSON.parse(String(r[0].content)) as ViewDoc };
  }
  /**
   * 把一个视图要的数据一次取齐：页面和 view_get 工具都用它。
   * opts.view 是哪个视图（不给取第一个）；opts.params 是筛选栏当前的值，只认这个视图的筛选栏里声明过的字段，没给的用字段的默认值；
   * opts.version 看指定的一版（预览旧版用），不给就是生效的那一版。
   * 一个组件的查询出了错（参数的写法不对、取回的太多、引用的列后来被删了），只这一个组件带 error，别的照常；超时是整个这一次的，照常抛。
   * 整个视图取回的内容合计不超过一次查询的上限。全部在同一格里做完：各组件看到的是同一时刻的数据。
   */
  renderView(opts: { view?: string; params?: Record<string, unknown>; version?: number } = {}) {
    return this.serial(async () => {
      if (!isObj(opts)) throw new BenchError('invalid', '参数须为对象');
      const { version, active, doc } = await this.viewDoc(opts.version);
      const view = opts.view === undefined ? doc.views[0] : doc.views.find((x) => x.key === opts.view);
      if (!view) throw new BenchError('not_found', `没有视图 ${String(opts.view).slice(0, 40)}`);
      const defs = await this.load(), given = isObj(opts.params) ? opts.params : {};
      // 筛选栏的值：只认声明过的字段；值只收文本
      const params: Record<string, string> = {};
      // 这份视图认哪些筛选项（名字、类型、显示名）：驾驶舱把顶上那一排选中的值按名字传进来，认的就生效，不认的忽略
      const filters: { name: string; kind: string; label: string }[] = [];
      for (const b of view.blocks) {
        if (b.type !== 'filter-bar') continue;
        for (const f of b.fields as FilterField[]) {
          filters.push({ name: f.name, kind: f.kind, label: f.label ?? f.name });
          const v = Object.hasOwn(given, f.name) ? given[f.name] : undefined;
          if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200)) throw new BenchError('invalid', `筛选字段 ${f.name} 的值须为 200 个字符以内的文本`);
          const val = typeof v === 'string' && v !== '' ? v : (f.default ?? '');
          if (val !== '') params[f.name] = val;
        }
      }
      let room: number = BENCH_LIMITS.resultChars;
      const run = async (spec: unknown) => {
        try {
          const { chars, dataset: _d, ...data } = await this.runQuery(defs, spec, params, room);
          room -= chars;
          return { data, error: undefined };
        } catch (e) {
          if (!(e instanceof BenchError) || e.code === 'timeout' || e.code === 'internal') throw e;
          return { data: undefined, error: { code: e.code as string, message: e.message } };
        }
      };
      const blocks: Record<string, unknown>[] = [];
      for (const b of view.blocks) {
        if (b.type === 'filter-bar') {
          const fields: Record<string, unknown>[] = [];
          for (const f of b.fields as FilterField[]) {
            let options: unknown = f.options, error: unknown;
            if (isObj(f.options)) {
              const r = await run({ dataset: f.options.dataset, group: [f.options.col], sort: [{ col: f.options.col }], limit: 100 });
              if (r.data) options = r.data.rows.map((x) => x[String((f.options as { col: string }).col)]).filter((x) => x !== null).map(String);
              else { options = []; error = r.error; }
            }
            fields.push({ ...f, options, value: params[f.name] ?? '', ...(error ? { error } : {}) });
          }
          blocks.push({ ...b, fields });
        } else if (b.type === 'form') {
          const ds = defs.get(String(b.dataset));
          const cols = ds ? (b.fields as string[]).map((n) => ds.columns.find((c) => c.name === n)).filter((c): c is ColumnDef => !!c) : [];
          blocks.push(ds && cols.length === (b.fields as string[]).length ? { ...b, columns: cols } : { ...b, columns: [], error: { code: 'invalid', message: '表单引用的数据集或列现在已经不在了' } });
        } else {
          const r = await run(b.query);
          if (!r.data) { blocks.push({ ...b, error: r.error }); continue; }
          // 表格的表头：视图里给的 column_labels，其次是数据集、聚合里起的说明名；都没有就给空，由页面写「第 N 列」——不拿列名（键名）当表头
          const given = b.type === 'table' && isObj(b.column_labels) ? b.column_labels as Record<string, string> : {};
          const columns = r.data.columns.map((c) => (b.type === 'table' ? publicColumn({ ...c, label: Object.hasOwn(given, c.name) ? given[c.name] : c.labeled ? c.label : '' }) : publicColumn(c)));
          blocks.push({ ...b, data: { ...r.data, columns } });
        }
      }
      return { title: doc.title, version, active_version: active, views: doc.views.map((x) => ({ key: x.key, title: x.title })), view: { key: view.key, title: view.title }, filters, params, blocks };
    });
  }
  /**
   * 表单提交：往表单绑定的数据集追加一行。只收表单里列出的字段，多给的拒收；校验、幂等键、上限都和 append 一样。
   * version 是页面取数时拿到的视图版本：这期间视图换了版，表单可能已经不是原来那个，拒绝，由页面刷新后再提交。
   */
  submitForm(target: { view: string; block: number; version: number }, values: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      if (!isObj(target) || typeof target.view !== 'string' || !Number.isInteger(target.block) || !Number.isInteger(target.version)) throw new BenchError('invalid', '要写明是哪个视图（view）的第几个组件（block，从 0 数）和页面拿到的视图版本（version）');
      const { active, doc } = await this.viewDoc(undefined);
      if (target.version !== active) throw new BenchError('conflict', `页面是第 ${target.version} 版的，现在生效的是第 ${active} 版：刷新之后再提交`, [`active_version=${active}`]);
      const block = doc.views.find((x) => x.key === target.view)?.blocks[target.block];
      if (!block || block.type !== 'form') throw new BenchError('not_found', '这个位置不是表单');
      if (!isObj(values)) throw new BenchError('invalid', '表单的内容须为对象');
      const fields = block.fields as string[];
      const extra = Object.keys(values).filter((k) => !fields.includes(k));
      if (extra.length) throw new BenchError('invalid', `表单里没有这些字段：${extra.map((k) => k.slice(0, 48)).join('、')}`);
      // 表单引用的数据集或列后来被删了：取数时说这个表单坏了，提交也一样拒，不收剩下的那部分字段
      const ds = (await this.load()).get(String(block.dataset));
      if (!ds || fields.some((f) => !ds.columns.some((c) => c.name === f))) throw new BenchError('invalid', '表单引用的数据集或列现在已经不在了');
      const res = await this.appendIn(ds.name, [values], ctx, 'form');
      return { ...res, form: { view: target.view, block: target.block } };
    });
  }

  // —— 视图描述与版本 ——
  private async activeVersion(): Promise<number> { return Number((await this.meta('active_view')) ?? 0); }
  /** 读当前生效的视图描述，或指定的某一版；还没有任何版本时返回 null */
  getView(version?: number) {
    return this.serial(async () => {
      const active = await this.activeVersion(), v = version ?? active;
      if (!v) return null;
      const r = Number.isSafeInteger(v) ? await this.conn.all('SELECT version, content, sha256, author, note, at FROM bs_view_versions WHERE version = ?', [v]) : [];
      if (!r.length) throw new BenchError('not_found', `没有视图第 ${String(version)} 版`);
      return { version: Number(r[0].version), active_version: active, content: JSON.parse(String(r[0].content)) as unknown, sha256: String(r[0].sha256), author: String(r[0].author), note: String(r[0].note), at: Number(r[0].at) };
    });
  }
  /**
   * 保存一份新的视图描述：成为新版本并生效。base 是「我是基于第几版改的」（还没有版本时给 0）；
   * 这期间生效版本变了就拒绝，由改的人看过最新版再存。内容和生效版本一样就不产生新版本。
   */
  putView(doc: unknown, ctx: WriteCtx & { base: number }) {
    return this.tx(async () => {
      const c = checkCtx(ctx, true), active = await this.activeVersion();
      if (ctx.base !== active) throw new BenchError('conflict', `你是基于第 ${String(ctx.base)} 版改的，现在生效的是第 ${active} 版：看过最新版再保存`, [`active_version=${active}`]);
      const text = canonical(doc);
      if (Buffer.byteLength(text, 'utf8') > BENCH_LIMITS.viewBytes) throw new BenchError('limit', `视图描述超过 ${BENCH_LIMITS.viewBytes} 字节`);
      const errs = validateViewDoc(doc, await this.load());
      if (errs.length) throw new BenchError('invalid', `视图描述有 ${errs.length} 处不合格，未保存`, errs.slice(0, 50));
      const sum = sha256(text);
      if (active) {
        const cur = await this.conn.all('SELECT sha256 FROM bs_view_versions WHERE version = ?', [active]);
        if (cur.length && cur[0].sha256 === sum) return { version: active, active_version: active, unchanged: true, sha256: sum };
      }
      const version = Number((await this.conn.all('SELECT MAX(version) AS m FROM bs_view_versions'))[0].m ?? 0) + 1;
      await this.conn.run('INSERT INTO bs_view_versions (version, content, sha256, author, note, at) VALUES (?, ?, ?, ?, ?, ?)', [version, text, sum, c.actor, c.note, c.at]);
      await this.setMeta('active_view', String(version));
      // 只留最近若干版；生效的那一版不清
      await this.conn.run('DELETE FROM bs_view_versions WHERE version <= ? AND version <> ?', [version - BENCH_LIMITS.viewVersions, version]);
      await this.change('view.put', 'views', active, version, c);
      return { version, active_version: version, unchanged: false, sha256: sum };
    });
  }
  /** 让某个旧版本重新生效：只移指针，不产生新版本、不删版本。旧版本引用的数据集或列已经不在了就拒绝 */
  rollbackView(to: number, ctx: WriteCtx & { base: number }) {
    return this.tx(async () => {
      const c = checkCtx(ctx, true), active = await this.activeVersion();
      if (ctx.base !== active) throw new BenchError('conflict', `你看到的生效版本是第 ${String(ctx.base)} 版，现在是第 ${active} 版`, [`active_version=${active}`]);
      const r = Number.isSafeInteger(to) ? await this.conn.all('SELECT content FROM bs_view_versions WHERE version = ?', [to]) : [];
      if (!r.length) throw new BenchError('not_found', `没有视图第 ${String(to)} 版`);
      if (to === active) return { active_version: active, unchanged: true };
      const errs = validateViewDoc(JSON.parse(String(r[0].content)), await this.load());
      if (errs.length) throw new BenchError('invalid', `第 ${to} 版引用的数据集或列现在已经不在了，不能生效`, errs.slice(0, 50));
      await this.setMeta('active_view', String(to));
      await this.change('view.rollback', 'views', active, to, c);
      return { active_version: to, unchanged: false };
    });
  }
  // —— 卡片的常量、变量（第 5 步：从主库 workbench_vars 搬过来）——
  /** 这个库里已经有（并试读过）bs_vars 了 */
  private varsReady = false;
  /**
   * 第一次写常量、变量时建 bs_vars（附加的表，不升版本号）。只有 WM_VARS_STORE 是 shadow、bench 才会写；
   * main 档下台库和原来逐字一样。调用方已经在 serial / tx 里（一次只做一件事）
   */
  private async ensureVars(): Promise<void> {
    if (this.varsReady) return;
    for (const sql of this.kit.varsSchema) await this.conn.run(sql);
    for (const probe of this.kit.varsProbes) {
      try { await this.conn.all(probe); } catch (e) { throw new BenchError('unsupported', `台库 ${this.slug} 的 bs_vars 和这份代码不符`, [], e); }
    }
    this.varsReady = true;
  }
  /** 读的方法用：还没有 bs_vars 就当作空，不建表（迁移的 dry-run、比对在 main 档下也不动台库的结构） */
  private async hasVars(): Promise<boolean> {
    if (this.varsReady) return true;
    return (await this.conn.all(this.kit.varsExists)).length > 0;
  }
  // 规矩（乐观锁、常量的作者、审计）在 workbench-vars.ts；这里只做按 revision 条件的读写，写入一律带期望 revision 或「没有才建」
  private varRow(r: Record<string, unknown>): BenchVarRow {
    return { key: String(r.key), kind: String(r.kind) === 'const' ? 'const' : 'var', value: String(r.value), revision: Number(r.revision), updated_by: String(r.updated_by), owner: String(r.owner), created_at: String(r.created_at), updated_at: String(r.updated_at) };
  }
  varsList(prefix: string): Promise<BenchVarRow[]> {
    return this.serial(async () => {
      const rows = prefix
        ? (!(await this.hasVars()) ? [] : await this.conn.all('SELECT * FROM bs_vars WHERE substr(key, 1, ?) = ? ORDER BY key', [prefix.length, prefix]))
        : (!(await this.hasVars()) ? [] : await this.conn.all('SELECT * FROM bs_vars ORDER BY key'));
      return rows.map((r) => this.varRow(r));
    });
  }
  varGet(key: string): Promise<BenchVarRow | null> {
    return this.serial(async () => { if (!(await this.hasVars())) return null; const r = await this.conn.all('SELECT * FROM bs_vars WHERE key = ?', [key]); return r.length ? this.varRow(r[0] as Record<string, unknown>) : null; });
  }
  varCount(): Promise<number> {
    return this.serial(async () => (!(await this.hasVars()) ? 0 : Number((await this.conn.all('SELECT COUNT(*) AS n FROM bs_vars'))[0].n)));
  }
  /** 没有才建（revision 1）；已经有了返回 false（并发创建撞键） */
  varInsert(r: { key: string; kind: string; value: string; by: string; owner: string; at: string }): Promise<boolean> {
    return this.tx(async () => { await this.ensureVars(); await this.setMeta('vars_dirty', '1'); return !!(await this.conn.run('INSERT INTO bs_vars (key, kind, value, revision, updated_by, owner, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING', [r.key, r.kind, r.value, r.by, r.owner, r.at, r.at])); });
  }
  /** 比较并写：当前 revision 是 expected 才写，revision + 1；不是返回 false */
  varUpdate(r: { key: string; expected: number; kind: string; value: string; by: string; owner: string; at: string }): Promise<boolean> {
    return this.tx(async () => { await this.ensureVars(); await this.setMeta('vars_dirty', '1'); return !!(await this.conn.run('UPDATE bs_vars SET kind = ?, value = ?, revision = revision + 1, updated_by = ?, owner = ?, updated_at = ? WHERE key = ? AND revision = ?', [r.kind, r.value, r.by, r.owner, r.at, r.key, r.expected])); });
  }
  varDelete(key: string, expected: number): Promise<boolean> {
    return this.tx(async () => { await this.ensureVars(); await this.setMeta('vars_dirty', '1'); return !!(await this.conn.run('DELETE FROM bs_vars WHERE key = ? AND revision = ?', [key, expected])); });
  }
  /**
   * 照给的行原样落一份（shadow 档跟写、迁移用）：台库里没有，或台库的 revision 比给的小，才写；一样或更新的不动。
   * row 为 null 是「主库里这个键已经删了」：台库里有就删。返回实际写了几行
   */
  varForce(key: string, row: BenchVarRow | null): Promise<number> {
    return this.tx(async () => {
      await this.ensureVars();
      if (!row) return Number(await this.conn.run('DELETE FROM bs_vars WHERE key = ?', [key]));
      return this.putVarRow(row);
    });
  }
  /** 迁移：一批行照 varForce 的规矩落进来，一个事务。返回实际写了几行 */
  varsImport(rows: BenchVarRow[]): Promise<number> {
    return this.tx(async () => { await this.ensureVars(); let n = 0; for (const r of rows) n += await this.putVarRow(r); return n; });
  }
  private async putVarRow(r: BenchVarRow): Promise<number> {
    const cur = await this.conn.all('SELECT revision FROM bs_vars WHERE key = ?', [r.key]);
    if (cur.length && Number(cur[0].revision) >= r.revision) return 0;
    if (cur.length) await this.conn.run('DELETE FROM bs_vars WHERE key = ?', [r.key]);
    await this.conn.run('INSERT INTO bs_vars (key, kind, value, revision, updated_by, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [r.key, r.kind, r.value, r.revision, r.updated_by, r.owner, r.created_at, r.updated_at]);
    return 1;
  }
  /**
   * 和主库的同步点（workbench-vars.ts 的 syncCard 用）：
   *   mark  上一次两边确认一致时，主库那份行集合的摘要（从没同步过是 null）；
   *   dirty bench 档在台库里写过、还没确认写回主库（varInsert / varUpdate / varDelete 在同一个事务里记上，varsSynced 清掉）
   *   digest 台库现在的摘要（和上面两样一次读出来，不会读到一半被写入插进来）
   */
  varsSyncGet(): Promise<{ mark: string | null; dirty: boolean; digest: string }> {
    return this.serial(async () => ({
      mark: await this.meta('vars_migrated'),
      dirty: (await this.meta('vars_dirty')) !== null,
      digest: varsDigestOf((!(await this.hasVars()) ? [] : await this.conn.all('SELECT * FROM bs_vars ORDER BY key')).map((r) => this.varRow(r))),
    }));
  }
  /**
   * 写回主库之后：记下主库那份现在的摘要（mark）；台库在同一个事务里算出的摘要也等于它，才清 dirty。
   * 这样别的写入已经进了台库、还没写回时（交错的两笔），dirty 留着，下次对同步点补写回，不会被当成「以主库为准」丢掉
   */
  varsSynced(mark: string): Promise<{ clean: boolean }> {
    return this.tx(async () => {
      await this.ensureVars();
      await this.setMeta('vars_migrated', mark);
      const clean = varsDigestOf((await this.conn.all('SELECT * FROM bs_vars ORDER BY key')).map((r) => this.varRow(r))) === mark;
      if (clean) await this.conn.run('DELETE FROM bs_meta WHERE k = ?', ['vars_dirty']);
      return { clean };
    });
  }
  /** 以主库为准：整张表换成给的行（原样，revision 也照抄），记同步点、清 dirty，一个事务。返回写了几行 */
  varsReplace(rows: BenchVarRow[], mark: string): Promise<number> {
    return this.tx(async () => {
      await this.ensureVars();
      await this.conn.run('DELETE FROM bs_vars');
      for (const r of rows) await this.conn.run('INSERT INTO bs_vars (key, kind, value, revision, updated_by, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [r.key, r.kind, r.value, r.revision, r.updated_by, r.owner, r.created_at, r.updated_at]);
      await this.setMeta('vars_migrated', mark);
      await this.conn.run('DELETE FROM bs_meta WHERE k = ?', ['vars_dirty']);
      return rows.length;
    });
  }
  /** 全部键的摘要：每个键的 kind、revision、owner、值的 sha256 按键排好再整体取 sha256（shadow 档比对、迁移的指纹用；不给值本身） */
  varsDigest(): Promise<{ count: number; sha256: string }> {
    return this.serial(async () => {
      const rows = (!(await this.hasVars()) ? [] : await this.conn.all('SELECT * FROM bs_vars ORDER BY key')).map((r) => this.varRow(r));
      return { count: rows.length, sha256: varsDigestOf(rows) };
    });
  }

  viewVersions(): Promise<ViewVersion[]> {
    return this.serial(async () => {
      const active = await this.activeVersion();
      const rows = await this.conn.all('SELECT version, sha256, author, note, at FROM bs_view_versions ORDER BY version DESC');
      return rows.map((r) => ({ version: Number(r.version), sha256: String(r.sha256), author: String(r.author), note: String(r.note), at: Number(r.at), active: Number(r.version) === active }));
    });
  }
  /** 两个版本之间的差异 */
  diffViews(a: number, b: number): Promise<JsonDiff[]> {
    return this.serial(async () => {
      const get = async (v: number) => {
        const r = Number.isSafeInteger(v) ? await this.conn.all('SELECT content FROM bs_view_versions WHERE version = ?', [v]) : [];
        if (!r.length) throw new BenchError('not_found', `没有视图第 ${String(v)} 版`);
        return JSON.parse(String(r[0].content)) as unknown;
      };
      return diffJson(await get(a), await get(b));
    });
  }

  /** 变更记录（新的在前）：视图保存与回退、列定义变更、快照与退回 */
  changes(limit = 100) {
    return this.serial(async () => {
      const rows = await this.conn.all('SELECT id, kind, target, from_version, to_version, actor, note, at FROM bs_changes ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(500, Math.floor(limit) || 100))]);
      return rows.map((r) => ({ id: Number(r.id), kind: String(r.kind), target: String(r.target), from: Number(r.from_version), to: Number(r.to_version), actor: String(r.actor), note: String(r.note), at: Number(r.at) }));
    });
  }
  /** 写入记录（新的在前）：只有摘要，没有内容 */
  writes(limit = 100) {
    return this.serial(async () => {
      const rows = await this.conn.all('SELECT id, dataset, op, body_sha256, row_count, actor, at FROM bs_writes ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(500, Math.floor(limit) || 100))]);
      return rows.map((r) => ({ id: Number(r.id), dataset: String(r.dataset), op: String(r.op), body_sha256: String(r.body_sha256), rows: Number(r.row_count), actor: String(r.actor), at: Number(r.at) }));
    });
  }

  /** 给这个台取一份一致的副本（备份用）：目标文件不能已经存在 */
  backupTo(file: string): Promise<void> {
    return this.serial(async () => {
      if (existsSync(file)) throw new BenchError('conflict', '备份的目标文件已经存在');
      // 先写到旁边的临时文件，写完、没超时，再改名：目标文件要么没有，要么是完整的
      const tmp = `${file}.partial`;
      rmSync(tmp, { force: true });
      try { await this.conn.backupTo(tmp); this.conn.check('备份写完之后'); renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    });
  }
  /** 等排着的读写都跑完再关；从调用这一刻起不再接新的读写。关过的再关一次没有效果 */
  close(): Promise<void> {
    if (this.closed) return this.chain.then(() => undefined);
    const r = this.serial(async () => { this.conn.close(); });
    this.closed = true;
    return r;
  }
}

// —— 打开、关闭、删除 ——
/** 一个台的库文件在哪；标识不合规就拒 */
export function benchFile(root: string, slug: string): string {
  if (typeof slug !== 'string' || !BENCH_SLUG_RE.test(slug)) throw new BenchError('invalid', '台的标识写法不对');
  const file = join(root, `${slug}.sqlite`);
  if (!isInsideRoot(root, file)) throw new BenchError('invalid', '台的标识写法不对');
  return file;
}

/** 一个目录下的全部台库：开着的连接、正在删的台、提交了还没取走的变更 */
export class BenchHost {
  readonly root: string;
  private kit: BenchSqlKit;
  private open = new Map<string, Promise<BenchStoreCore>>();
  /** 正在删的台：删完之前不许再取，否则新开的连接会落在马上要被删掉的文件上 */
  private removing = new Map<string, Promise<void>>();
  private fired: BenchChange[] = [];
  private caps: BenchCaps;

  /** caps：三道数据量上限，不给的取默认（BENCH_LIMITS）；测试用小的 */
  constructor(root: string, kit: BenchSqlKit, caps: Partial<BenchCaps> = {}) {
    this.root = root; this.kit = kit;
    this.caps = { datasetBytes: caps.datasetBytes ?? BENCH_LIMITS.datasetBytes, storeBytes: caps.storeBytes ?? BENCH_LIMITS.storeBytes, writeBytes: caps.writeBytes ?? BENCH_LIMITS.writeBytes };
  }

  /** 取走从上次取到现在提交了的变更 */
  takeChanges(): BenchChange[] { const f = this.fired; this.fired = []; return f; }

  /** 取一个台的库；第一次用时建出来。这个台正在删的时候拒绝，等删完再取 */
  async store(slug: string): Promise<BenchStoreCore> {
    const file = benchFile(this.root, slug);
    if (this.removing.has(slug)) throw new BenchError('conflict', `台 ${slug} 正在删除，稍后再试`);
    let p = this.open.get(slug);
    if (!p) {
      const opening = (async () => {
        let conn: Conn | null = null;
        try {
          mkdirSync(this.root, { recursive: true });
          conn = new SqliteConn(file);
          const s = new BenchStoreCore(slug, conn, this.kit, (c) => { this.fired.push(c); }, this.caps);
          await s.init();
          return s;
        } catch (e) {
          try { conn?.close(); } catch { /* 没开成或已经关了 */ }
          throw asBenchError(e);
        }
      })();
      // 没开成的不留在表里；但只摘自己这一条，不碰后来的人放进去的
      opening.catch(() => { if (this.open.get(slug) === opening) this.open.delete(slug); });
      this.open.set(slug, opening);
      p = opening;
    }
    return p;
  }

  /**
   * 删掉一个台的库（删台时用）：等排着的读写跑完、关掉连接，再删文件。
   * 从调用这一刻到删完，这个台取不到；之前拿到的句柄关掉之后也不能再用。删完可以重新建，是空的。
   * 同一个台同时删两次，等的是同一次。
   */
  async remove(slug: string): Promise<void> {
    const file = benchFile(this.root, slug);
    let job = this.removing.get(slug);
    if (!job) {
      job = (async () => {
        const p = this.open.get(slug);
        if (p) { try { await (await p).close(); } catch { /* 没开成的不用关 */ } }
        if (this.open.get(slug) === p) this.open.delete(slug);
        for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
      })().finally(() => { this.removing.delete(slug); });
      this.removing.set(slug, job);
    }
    return job;
  }

  /** 关掉所有开着的台库（进程退出、测试收尾） */
  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    for (const p of all) { try { await (await p).close(); } catch { /* 没开成的不用关 */ } }
  }
}
