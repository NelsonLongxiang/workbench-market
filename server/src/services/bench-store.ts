/**
 * 台库的数据访问（数据视图，docs/data-views.md 第二、四、五、七节）。
 *
 * 每个视图台一份自己的库，在数据目录的 bench-stores/ 下，一台一个文件。这个台的全部内容都在里面：
 * 数据集和行、列定义的历史版本、视图描述的历史版本和生效指针、快照、写入记录、变更记录。
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
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataDir, BENCH_STORE_SCHEMA_VERSION, benchStoreSchema, benchDatasetCreate, benchDatasetAddColumn, benchDatasetDropColumn,
  benchDatasetKeyIndex, benchDatasetDropIndex, type BenchDialect,
} from '../db.ts';
import { isInsideRoot } from '../path-inside.ts';
import {
  BENCH_LIMITS, BenchError, COLUMN_TYPES, NAME_RE, coerceValue, decodeValue, physCol, physTable, planQuery,
  type ColumnDef, type DatasetDef, type OutColumn,
} from '../bench-query.ts';
import { diffJson, validateViewDoc, type JsonDiff } from '../bench-views.ts';

export const BENCH_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEM_RE = /^[\x21-\x7e]{8,128}$/;
const ROOT = join(dataDir, 'bench-stores');

export type WriteCtx = { actor: string; at: number; idemKey?: string; note?: string };
export type WriteResult = { dataset: string; op: string; rows: number; row_count: number; snapshot_id?: number; inserted?: number; updated?: number; deleted?: number; duplicate?: boolean };
export type DatasetInput = { name: string; title?: string; columns: { name: string; type: string; label?: string; required?: boolean }[]; key?: string[] };
export type ViewVersion = { version: number; sha256: string; author: string; note: string; at: number; active: boolean };
export type BenchChange = { kind: string; bench: string; target: string; from: number; to: number; actor: string; at: number };

let changeListener: ((c: BenchChange) => void) | null = null;
/** 台库每次变更（事务提交之后）通知一次；对外入口接上之前没有人听 */
export function onBenchChange(fn: ((c: BenchChange) => void) | null): void { changeListener = fn; }

// —— 库连接：随库不同的写法只在这里 ——
interface Conn {
  readonly dialect: BenchDialect;
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
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
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
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
  async all(sql: string, params: unknown[] = []) { return this.stmt(sql).all(...(params as never[])) as Record<string, unknown>[]; }
  async run(sql: string, params: unknown[] = []) { return Number(this.stmt(sql).run(...(params as never[])).changes); }
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
    const ex = Object.keys(c).filter((k) => !['name', 'type', 'label', 'required'].includes(k));
    if (ex.length) throw new BenchError('invalid', `${at} 有不认识的键：${ex.join('、')}`);
    if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) throw new BenchError('invalid', `${at}：列名须为小写字母开头，只含小写字母、数字、下划线，最多 48 个字符`);
    if (seen.has(c.name)) throw new BenchError('invalid', `列名重复：${c.name}`);
    seen.add(c.name);
    if (!COLUMN_TYPES.includes(c.type as never)) throw new BenchError('invalid', `${at}（${c.name}）：类型须为 ${COLUMN_TYPES.join(' / ')}`);
    if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 64)) throw new BenchError('invalid', `${at}（${c.name}）：显示名须为 64 个字符以内的文本`);
    if (c.required !== undefined && typeof c.required !== 'boolean') throw new BenchError('invalid', `${at}（${c.name}）：required 须为 true 或 false`);
    return { name: c.name, type: c.type as ColumnDef['type'], label: c.label ?? '', required: c.required === true || key.includes(c.name) };
  });
  for (const k of key) {
    const c = columns.find((x) => x.name === k);
    if (!c) throw new BenchError('invalid', `主键里的列 ${k} 不在列定义里`);
    if (c.type === 'decimal' || c.type === 'boolean') throw new BenchError('invalid', `主键列 ${k} 不能是小数或布尔`);
  }
  return { name: input.name, title: title.trim(), columns, key: [...key] };
}

type CheckedRow = { cols: string[]; vals: (string | number | null)[] };
/**
 * 逐行按列定义核对。full：每行都落全部列（没给的可空列记空）；partial：只落给了的列，但主键列和必填列必须给。
 * 不合格整批拒收，逐条说明（最多列 50 条）。
 */
function checkRows(ds: DatasetDef, rows: unknown, mode: 'full' | 'partial', max: number): CheckedRow[] {
  if (!Array.isArray(rows)) throw new BenchError('invalid', 'rows 须为数组');
  if (rows.length > max) throw new BenchError('limit', `一次最多 ${max} 行（收到 ${rows.length} 行）`);
  const byName = new Map(ds.columns.map((c) => [c.name, c]));
  const errs: string[] = [], out: CheckedRow[] = [];
  let total = 0;
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
  return out;
}

export class BenchStore {
  readonly slug: string;
  private conn: Conn;
  private chain: Promise<unknown> = Promise.resolve();
  private pending: BenchChange[] = [];

  constructor(slug: string, conn: Conn) { this.slug = slug; this.conn = conn; }

  /** 这个台的读写排成一队 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(() => fn(), () => fn());
    this.chain = r.catch(() => undefined);
    return r;
  }
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.conn.begin();
      this.pending = [];
      let r: T;
      try { r = await fn(); await this.conn.commit(); } catch (e) {
        await this.conn.rollback();
        this.pending = [];
        if (!(e instanceof BenchError) && /unique|duplicate/i.test(String((e as Error)?.message ?? ''))) throw new BenchError('conflict', '主键重复：已有同主键的行');
        throw e;
      }
      const fired = this.pending; this.pending = [];
      if (changeListener) for (const c of fired) { try { changeListener(c); } catch { /* 通知失败不影响已提交的写入 */ } }
      return r;
    });
  }

  /** 建好固定的几张表；库比这份代码新就拒绝打开（旧代码不认识新结构，不碰它） */
  async init(): Promise<void> {
    await this.serial(async () => {
      for (const sql of benchStoreSchema(this.conn.dialect)) await this.conn.run(sql);
      const v = await this.meta('schema_version');
      if (v === null) await this.setMeta('schema_version', String(BENCH_STORE_SCHEMA_VERSION));
      else if (Number(v) > BENCH_STORE_SCHEMA_VERSION) throw new BenchError('unsupported', `台库 ${this.slug} 的结构是第 ${v} 版，比这份代码认识的第 ${BENCH_STORE_SCHEMA_VERSION} 版新，不打开`);
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
    const rows = await this.conn.all('SELECT name, title, version, columns, key_cols, row_count, created_at, updated_at, updated_by FROM bs_datasets ORDER BY name');
    return new Map(rows.map((r) => [String(r.name), {
      name: String(r.name), title: String(r.title), version: Number(r.version), columns: JSON.parse(String(r.columns)), key: JSON.parse(String(r.key_cols)),
      row_count: Number(r.row_count), created_at: Number(r.created_at), updated_at: Number(r.updated_at), updated_by: String(r.updated_by),
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
      const c = checkCtx(ctx), def = normalizeDataset(input), d = this.conn.dialect;
      const all = await this.load(), old = all.get(def.name), tbl = physTable(def.name), idx = `ux_${tbl}`;
      if (!old) {
        if (all.size >= BENCH_LIMITS.datasets) throw new BenchError('limit', `数据集个数已到上限 ${BENCH_LIMITS.datasets}`);
        await this.conn.run(benchDatasetCreate(d, tbl, def.columns.map((x) => ({ col: physCol(x.name), type: x.type }))));
        if (def.key.length) await this.conn.run(benchDatasetKeyIndex(tbl, idx, def.key.map(physCol)));
        await this.conn.run('INSERT INTO bs_datasets (name, title, version, columns, key_cols, row_count, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)',
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
      if (removed.length && old.row_count > 0) snapshotId = await this.takeSnapshot(old, 'before-drop-column', c);
      if (keyChanged) await this.conn.run(benchDatasetDropIndex(idx));
      for (const x of removed) await this.conn.run(benchDatasetDropColumn(tbl, physCol(x.name)));
      for (const x of added) await this.conn.run(benchDatasetAddColumn(d, tbl, physCol(x.name), x.type));
      if (keyChanged && def.key.length) {
        const cols = def.key.map(physCol).join(', ');
        const dup = await this.conn.all(`SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM ${tbl} GROUP BY ${cols} HAVING COUNT(*) > 1) t`);
        if (Number(dup[0].n) > 0) throw new BenchError('conflict', `现有数据里有 ${Number(dup[0].n)} 组主键重复，不能把主键设成 ${def.key.join('、')}`);
        await this.conn.run(benchDatasetKeyIndex(tbl, idx, def.key.map(physCol)));
      }
      const version = old.version + 1;
      await this.conn.run('UPDATE bs_datasets SET title = ?, version = ?, columns = ?, key_cols = ?, updated_at = ?, updated_by = ? WHERE name = ?',
        [def.title, version, JSON.stringify(def.columns), JSON.stringify(def.key), c.at, c.actor, def.name]);
      await this.conn.run('INSERT INTO bs_dataset_versions (dataset, version, title, columns, key_cols, author, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [def.name, version, def.title, JSON.stringify(def.columns), JSON.stringify(def.key), c.actor, c.note, c.at]);
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
  /** 幂等和写入记录：同键同内容返回原结果，同键不同内容拒绝；记录只存摘要 */
  private async logged(ds: DatasetDef, op: string, payload: unknown, ctx: WriteCtx, fn: (c: { actor: string; at: number; note: string }) => Promise<WriteResult>): Promise<WriteResult> {
    const c = checkCtx(ctx), body = sha256(canonical([ds.name, op, payload]));
    if (ctx.idemKey) {
      const prev = await this.conn.all('SELECT dataset, op, body_sha256, result FROM bs_writes WHERE idem_key = ?', [ctx.idemKey]);
      if (prev.length) {
        if (prev[0].body_sha256 !== body) throw new BenchError('conflict', '这个幂等键已经用在另一份内容上');
        return { ...(JSON.parse(String(prev[0].result)) as WriteResult), duplicate: true };
      }
    }
    const res = await fn(c);
    const n = await this.conn.all(`SELECT COUNT(*) AS n FROM ${physTable(ds.name)}`);
    res.row_count = Number(n[0].n);
    if (res.row_count > BENCH_LIMITS.rows) throw new BenchError('limit', `数据集 ${ds.name} 写入后有 ${res.row_count} 行，超过上限 ${BENCH_LIMITS.rows}，整批未写入`);
    await this.conn.run('UPDATE bs_datasets SET row_count = ?, updated_at = ?, updated_by = ? WHERE name = ?', [res.row_count, c.at, c.actor, ds.name]);
    await this.conn.run('INSERT INTO bs_writes (dataset, op, idem_key, body_sha256, row_count, actor, at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ds.name, op, ctx.idemKey ?? null, body, res.rows, c.actor, c.at, JSON.stringify(res)]);
    const max = await this.conn.all('SELECT MAX(id) AS m FROM bs_writes');
    await this.conn.run('DELETE FROM bs_writes WHERE id <= ?', [Number(max[0].m ?? 0) - BENCH_LIMITS.writeLog]);
    this.pending.push({ kind: `data.${op}`, bench: this.slug, target: ds.name, from: ds.version, to: ds.version, actor: c.actor, at: c.at });
    return res;
  }
  private async insert(ds: DatasetDef, rows: CheckedRow[]): Promise<void> {
    const tbl = physTable(ds.name);
    for (const r of rows) await this.conn.run(`INSERT INTO ${tbl} (${r.cols.map(physCol).join(', ')}) VALUES (${r.cols.map(() => '?').join(', ')})`, r.vals);
  }
  private async rowsOf(ds: DatasetDef): Promise<Record<string, unknown>[]> {
    const rows = await this.conn.all(`SELECT ${ds.columns.map((c) => `${physCol(c.name)} AS "${c.name}"`).join(', ')} FROM ${physTable(ds.name)} ORDER BY rid`);
    return rows.map((r) => Object.fromEntries(ds.columns.map((c) => [c.name, decodeValue(c.type, r[c.name])])));
  }
  private async takeSnapshot(ds: DatasetDef, reason: string, c: { actor: string; at: number }): Promise<number> {
    const rows = await this.rowsOf(ds);
    const r = await this.conn.all('INSERT INTO bs_snapshots (dataset, dataset_version, reason, row_count, content, author, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [ds.name, ds.version, reason, rows.length, JSON.stringify({ columns: ds.columns, key: ds.key, rows }), c.actor, c.at]);
    const keep = await this.conn.all('SELECT id FROM bs_snapshots WHERE dataset = ? ORDER BY id DESC LIMIT ?', [ds.name, BENCH_LIMITS.snapshots]);
    if (keep.length === BENCH_LIMITS.snapshots) await this.conn.run('DELETE FROM bs_snapshots WHERE dataset = ? AND id < ?', [ds.name, Number(keep[keep.length - 1].id)]);
    return Number(r[0].id);
  }

  /** 整份替换：给全部行，原子切换；原来有数据就先留一份快照（上一代） */
  replace(name: string, rows: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name), checked = checkRows(ds, rows, 'full', BENCH_LIMITS.rows);
      return this.logged(ds, 'replace', rows, ctx, async (c) => {
        const snapshot_id = ds.row_count > 0 ? await this.takeSnapshot(ds, 'replace', c) : undefined;
        await this.conn.run(`DELETE FROM ${physTable(ds.name)}`);
        await this.insert(ds, checked);
        return { dataset: ds.name, op: 'replace', rows: checked.length, row_count: 0, snapshot_id };
      });
    });
  }
  /** 只追加；有主键时和已有的行撞了就整批拒收 */
  append(name: string, rows: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name), checked = checkRows(ds, rows, 'full', BENCH_LIMITS.rowsPerWrite);
      return this.logged(ds, 'append', rows, ctx, async () => {
        await this.insert(ds, checked);
        return { dataset: ds.name, op: 'append', rows: checked.length, row_count: 0, inserted: checked.length };
      });
    });
  }
  /** 按主键有则改、无则加；每行给主键列和必填列，其余给了哪些列就改哪些列 */
  upsert(name: string, rows: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name);
      if (!ds.key.length) throw new BenchError('invalid', `数据集 ${ds.name} 没有主键，不能按主键更新`);
      const checked = checkRows(ds, rows, 'partial', BENCH_LIMITS.rowsPerWrite);
      return this.logged(ds, 'upsert', rows, ctx, async () => {
        const tbl = physTable(ds.name), keyCols = ds.key.map(physCol).join(', ');
        const before = Number((await this.conn.all(`SELECT COUNT(*) AS n FROM ${tbl}`))[0].n);
        for (const r of checked) {
          const rest = r.cols.filter((x) => !ds.key.includes(x));
          await this.conn.run(`INSERT INTO ${tbl} (${r.cols.map(physCol).join(', ')}) VALUES (${r.cols.map(() => '?').join(', ')}) ON CONFLICT (${keyCols}) DO `
            + (rest.length ? `UPDATE SET ${rest.map((x) => `${physCol(x)} = excluded.${physCol(x)}`).join(', ')}` : 'NOTHING'), r.vals);
        }
        const after = Number((await this.conn.all(`SELECT COUNT(*) AS n FROM ${tbl}`))[0].n);
        return { dataset: ds.name, op: 'upsert', rows: checked.length, row_count: 0, inserted: after - before, updated: checked.length - (after - before) };
      });
    });
  }
  /** 按主键删行；破坏性操作，原来有数据就先留快照 */
  deleteRows(name: string, keys: unknown, ctx: WriteCtx) {
    return this.tx(async () => {
      const ds = await this.need(name);
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
        const snapshot_id = ds.row_count > 0 ? await this.takeSnapshot(ds, 'before-delete', c) : undefined;
        let deleted = 0;
        for (const v of vals) deleted += await this.conn.run(`DELETE FROM ${physTable(ds.name)} WHERE ${ds.key.map((kc) => `${physCol(kc)} = ?`).join(' AND ')}`, v);
        return { dataset: ds.name, op: 'delete', rows: keys.length, row_count: 0, deleted, snapshot_id };
      });
    });
  }

  // —— 快照 ——
  snapshot(name: string, ctx: WriteCtx) {
    return this.tx(async () => {
      const c = checkCtx(ctx), ds = await this.need(name);
      const id = await this.takeSnapshot(ds, 'manual', c);
      await this.change('dataset.snapshot', ds.name, ds.version, ds.version, { ...c, note: c.note || `快照 #${id}` });
      return { id, dataset: ds.name, row_count: ds.row_count };
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
      const snap = JSON.parse(String(s[0].content)) as { columns: ColumnDef[]; rows: Record<string, unknown>[] };
      const usable = snap.columns.filter((x) => ds.columns.some((y) => y.name === x.name && y.type === x.type)).map((x) => x.name);
      const dropped = snap.columns.map((x) => x.name).filter((x) => !usable.includes(x));
      const checked = checkRows(ds, snap.rows.map((r) => Object.fromEntries(usable.map((k) => [k, r[k]]))), 'full', BENCH_LIMITS.rows);
      const backup = ds.row_count > 0 ? await this.takeSnapshot(ds, 'before-restore', c) : undefined;
      await this.conn.run(`DELETE FROM ${physTable(ds.name)}`);
      await this.insert(ds, checked);
      await this.conn.run('UPDATE bs_datasets SET row_count = ?, updated_at = ?, updated_by = ? WHERE name = ?', [checked.length, c.at, c.actor, ds.name]);
      await this.change('dataset.restore', ds.name, ds.version, ds.version, { ...c, note: c.note || `退回快照 #${snapshotId}` });
      return { dataset: ds.name, restored_from: snapshotId, row_count: checked.length, dropped_columns: dropped, snapshot_id: backup };
    });
  }

  // —— 读 ——
  /** 按查询描述读；params 是筛选栏当前的值 */
  query(spec: unknown, params: Record<string, unknown> = {}) {
    return this.serial(async () => {
      const plan = planQuery(spec, await this.load(), { params, dialect: this.conn.dialect });
      const rows = await this.conn.all(plan.sql, plan.args);
      const truncated = rows.length > plan.limit;
      return {
        dataset: plan.dataset, columns: plan.columns as OutColumn[], truncated,
        rows: rows.slice(0, plan.limit).map((r) => Object.fromEntries(plan.columns.map((c) => [c.name, decodeValue(c.type, r[c.name])]))),
      };
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
      await this.conn.backupTo(file);
    });
  }
  /** 等排着的读写都跑完再关 */
  close(): Promise<void> { return this.serial(async () => { this.conn.close(); }); }
}

// —— 打开、关闭、删除 ——
const open = new Map<string, Promise<BenchStore>>();
function fileOf(slug: string): string {
  if (typeof slug !== 'string' || !BENCH_SLUG_RE.test(slug)) throw new BenchError('invalid', '台的标识写法不对');
  const file = join(ROOT, `${slug}.sqlite`);
  if (!isInsideRoot(ROOT, file)) throw new BenchError('invalid', '台的标识写法不对');
  return file;
}
/** 这个台有没有库（没有的不会因为问一句就建出来） */
export function benchStoreExists(slug: string): boolean { return existsSync(fileOf(slug)); }
/** 取一个台的库；第一次用时建出来 */
export function benchStore(slug: string): Promise<BenchStore> {
  const file = fileOf(slug);
  let p = open.get(slug);
  if (!p) {
    p = (async () => {
      mkdirSync(ROOT, { recursive: true });
      const s = new BenchStore(slug, new SqliteConn(file));
      await s.init();
      return s;
    })();
    p.catch(() => open.delete(slug));
    open.set(slug, p);
  }
  return p;
}
/** 关掉所有开着的台库（进程退出、测试收尾） */
export async function closeBenchStores(): Promise<void> {
  const all = [...open.values()];
  open.clear();
  for (const p of all) { try { await (await p).close(); } catch { /* 没开成的不用关 */ } }
}
/** 删掉一个台的库（删台时用）：先关，再删文件 */
export async function removeBenchStore(slug: string): Promise<void> {
  const file = fileOf(slug), p = open.get(slug);
  open.delete(slug);
  if (p) { try { await (await p).close(); } catch { /* 没开成的不用关 */ } }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
}
