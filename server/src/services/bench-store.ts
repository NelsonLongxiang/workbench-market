/**
 * 台库对市场进程的接口（数据视图，docs/data-views.md 第二、十一节）。
 *
 * 台库的读写不在市场进程里跑：逻辑在 bench-store-core.ts，由一个工作线程承载（bench-store-worker.ts）。
 * 这里只做四件事——排队、转发、看时限、线程出事时收拾。对调用方来说接口和原来一样，全部是异步的。
 *
 * 为什么要这样：台库是同步访问的，一条语句跑多久，所在的线程就停多久。留在市场进程里，
 * 一条慢查询或一次大写入会让所有人的所有请求都不动。
 *
 * 时限分两层：
 *   · 第一层在线程里（core）：每次读写带着时限过去，到时限自己停下、回滚，回一句 timeout。这是确定的：没有生效。
 *   · 第二层在这里：时限加宽限过了还没回话（卡在一条停不下来的语句里），强行终止线程，另起一个。
 *     强行终止挡不住一件事——事务可能正好在终止之前提交了。所以这种超时对写入是「不确定」的，报错里写明，
 *     由调用方带同一个幂等键重试，或者读一次确认。
 *
 * 台按标识固定分到几条「道」上，一道一个工作线程、一个队（docs/data-views.md 第十三节第 5 条第 2 步）：
 *   · 同一个台的读写永远在同一道上，一次一件、按到达的顺序做；一个台的库只被一个线程打开。
 *   · 不同道上的台同时做：一个台的慢操作只让同一道上的台排队，别的道不受影响。
 *   · 道数默认见 defaultLanes()；测试可以用 configureBenchRuntime({ lanes }) 在没有活的时候改。
 *   · 大写入全局一次一件（不论在哪一道）：一份接近数据集上限的写入，进程内存要涨几百 MB；几道同时做会叠起来。
 *     「大」按体量估（原始字节数，或行数组各格的字符数），不按行数：宽行不到两千行也能到上限。
 *     所以大写入要先拿到唯一的那张「大写入许可」，拿不到就在自己那一道的队头等着（只挡同一道上的台），读和小写入照常并行。
 * 线程在这一道第一次有活时才起；时限、强行终止、意外退出都按道各管各的。
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, benchSqlKit } from '../db.ts';
import { BENCH_LIMITS, BenchError } from '../bench-query.ts';
import { BENCH_METHODS, BENCH_SLUG_RE, benchFile, type BenchChange, type BenchStoreCore } from './bench-store-core.ts';
import type { BenchReply, BenchRequest, BenchWireError } from './bench-store-worker.ts';

export { BENCH_SLUG_RE };
export type { WriteCtx, WriteResult, DatasetInput, ViewVersion, BenchChange, BenchVarRow } from './bench-store-core.ts';
export { varsDigestOf } from './bench-store-core.ts';

const ROOT = join(dataDir, 'bench-stores');
/** 删卡片、清扫时台库的备份放这里，留 BENCH_BACKUP_KEEP_MS（bench-card-delete.ts、services/bench-sweep.ts） */
export const BENCH_DELETED_DIR = join(ROOT, '.deleted');
export const BENCH_BACKUP_KEEP_MS = 30 * 86_400_000;
/** 备份文件名：<台标识>--<删的时刻（毫秒）>.sqlite；清扫按名字里的时刻算到期 */
export const benchBackupName = (slug: string, at: number): string => `${slug}--${at}.sqlite`;
export const BENCH_BACKUP_NAME_RE = /^([a-z0-9][a-z0-9-]{0,63})--(\d{13})\.sqlite$/;
const CODES = new Set(['invalid', 'not_found', 'conflict', 'limit', 'unsupported', 'internal', 'timeout', 'busy']);

let changeListener: ((c: BenchChange) => void) | null = null;
/** 台库每次变更（事务提交之后）通知一次；对外入口接上之前没有人听 */
export function onBenchChange(fn: ((c: BenchChange) => void) | null): void { changeListener = fn; }

// —— 时限 ——
/** 默认道数：可用的核数减一（给市场进程留一个），至少 1、至多 4 */
export function defaultLanes(): number { return Math.min(4, Math.max(1, availableParallelism() - 1)); }
const limits = { queryMs: BENCH_LIMITS.queryMs as number, writeMs: BENCH_LIMITS.writeMs as number, graceMs: BENCH_LIMITS.killGraceMs as number, lanes: defaultLanes() };
export type BenchRuntimeLimits = typeof limits;
/** 改时限（毫秒）或道数，返回改之前的值。测试用；时限只影响之后发起的读写，道数只能在没有活、没有开着的库的时候改 */
export function configureBenchRuntime(next: Partial<BenchRuntimeLimits>): BenchRuntimeLimits {
  const prev = { ...limits };
  for (const k of ['queryMs', 'writeMs', 'graceMs'] as const) {
    const v = next[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) throw new BenchError('invalid', `${k} 须为不小于 0 的毫秒数`);
    limits[k] = v;
  }
  if (next.lanes !== undefined && next.lanes !== limits.lanes) {
    if (!Number.isSafeInteger(next.lanes) || next.lanes < 1 || next.lanes > 16) throw new BenchError('invalid', 'lanes 须为 1～16 的整数');
    if (lanes.some((l) => l.worker || l.current || l.queue.length || l.stopping) || handles.size || removing.size) throw new BenchError('conflict', '台库还有活或开着的库，先 closeBenchStores() 再改道数');
    limits.lanes = next.lanes;
    lanes.length = 0;
  }
  return prev;
}

// —— 道：一个工作线程和它前面的队 ——
type Job = { id: number; slug: string; method: string; args: unknown[]; budgetMs: number; big: boolean; resolve: (v: unknown) => void; reject: (e: unknown) => void };
type Lane = {
  queue: Job[];
  current: Job | null;
  worker: Worker | null;
  /** 正在等一个被强行终止的线程退出；它退出之前这一道不起新的（旧线程手里可能还握着库的写锁） */
  stopping: Promise<void> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
};
const lanes: Lane[] = [];
let seq = 0;
/** 大写入：体量超过这个数。原始字节按字节数；行数组按各格估（文本按字符数，别的每格 8）。按道数之外再全局一次一件 */
export const BIG_WRITE = { bytes: 4 * 1024 * 1024 };
/** 正拿着大写入许可的那件事（全局只有一件） */
let bigHolder: Job | null = null;
/**
 * 估一份参数的体量，超过 limit 就停（只要知道「大不大」，不必量完：最多看到门槛那么多）。
 * 行数组不能只看行数：一行可以有 60 列、一格可以有 1 万字符，不到两千行也能到数据集的上限。
 */
function sizeOver(a: unknown, limit: number): boolean {
  if (a instanceof Uint8Array) return a.byteLength > limit;
  if (!Array.isArray(a)) return false;
  let n = 0;
  for (const row of a) {
    n += 8;
    if (row && typeof row === 'object') for (const v of Object.values(row as Record<string, unknown>)) n += typeof v === 'string' ? v.length : 8;
    else if (typeof row === 'string') n += row.length;
    if (n > limit) return true;
  }
  return false;
}
/** 在入队时算一次，记在这件事上（队头反复检查时不再量） */
function bigWrite(method: string, args: unknown[]): boolean {
  return BENCH_METHODS.get(method) === 'write' && args.some((a) => sizeOver(a, BIG_WRITE.bytes));
}
const isBig = (job: Job): boolean => job.big;
const stats = { spawns: 0, kills: 0, crashes: 0, bigWaits: 0, recycles: 0 };
/** 线程起过几次、被强行终止过几次、自己意外退出过几次、大写入为等许可停过几次、大写入后换过几次线程，现在排着几件事（各道加起来），有几道 */
export function benchRuntimeStats(): { spawns: number; kills: number; crashes: number; bigWaits: number; recycles: number; queued: number; lanes: number } {
  const queued = lanes.reduce((n, l) => n + l.queue.length + (l.current ? 1 : 0), 0);
  return { ...stats, queued, lanes: limits.lanes };
}
/** 各道排着的件数（不含正在做的），加起来不超过 BENCH_LIMITS.queue */
const queuedTotal = (): number => lanes.reduce((n, l) => n + l.queue.length, 0);

/** 台固定落在哪一道：按标识算一个稳定的散列（同一个标识永远同一道） */
export function benchLaneOf(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) { h ^= slug.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % limits.lanes;
}
function laneOf(slug: string): Lane {
  const i = benchLaneOf(slug);
  while (lanes.length < limits.lanes) lanes.push({ queue: [], current: null, worker: null, stopping: null, watchdog: null });
  return lanes[i] as Lane;
}

/** 测试用：让手上有活的道的工作线程像自己意外退出那样停掉（不走「强行终止」那条路），用来验退出之后的收拾 */
export function stopBenchWorkerAbruptly(): void { for (const l of lanes) if (l.current) void l.worker?.terminate(); }

function fromWire(e: BenchWireError): BenchError {
  const code = CODES.has(e.code) ? (e.code as BenchError['code']) : 'internal';
  return new BenchError(code, String(e.message), Array.isArray(e.details) ? e.details.map(String) : [], e.cause === undefined ? undefined : new Error(e.cause));
}

function spawn(lane: Lane): Worker {
  const w = new Worker(new URL('./bench-store-worker.ts', import.meta.url), { workerData: { root: ROOT, kit: benchSqlKit('sqlite') } });
  stats.spawns++;
  w.on('message', (m: BenchReply) => onReply(lane, w, m));
  // 线程里抛了没人接的错（比如内存用尽）会先报错、再退出。只在退出的时候收拾：那时线程已经不在了，不会和新起的线程抢库的锁
  let failure: unknown;
  w.on('error', (e) => { failure = e; });
  w.on('exit', (code) => onDown(lane, w, failure ?? new Error(`台库的工作线程退出了（退出码 ${code}）`)));
  w.unref(); // 闲着的线程不拦着进程退出；有事在做的时候再 ref
  return w;
}

/** 这一道轮到下一件事：线程空着、没有在等旧线程退出，就发过去并开始计时 */
function pump(lane: Lane): void {
  while (!lane.current && !lane.stopping && lane.queue.length) {
    const head = lane.queue[0] as Job;
    // 大写入：许可在别人手里就在队头等（同一道上后面的也等，保住同一个台的先后），放回来时会被叫醒
    if (isBig(head) && bigHolder && bigHolder !== head) { stats.bigWaits++; break; }
    const job = lane.queue.shift() as Job;
    if (isBig(job)) bigHolder = job;
    try {
      lane.worker ??= spawn(lane);
      lane.worker.ref();
      lane.worker.postMessage({ id: job.id, slug: job.slug, method: job.method, args: job.args, budgetMs: job.budgetMs } satisfies BenchRequest);
    } catch (e) {
      // 参数里有过不了线程的东西（函数、符号之类），或者线程起不来；这件事失败，接着做下一件
      const uncloneable = (e as Error)?.name === 'DataCloneError';
      job.reject(uncloneable ? new BenchError('invalid', '参数里有不能传给台库的值（函数、符号之类）') : new BenchError('internal', '台库内部错误', [], e));
      if (bigHolder === job) bigHolder = null; // 没发出去：许可直接收回（这一道接着做，别的道下面统一叫醒）
      continue;
    }
    lane.current = job;
    lane.watchdog = setTimeout(() => kill(lane, job), job.budgetMs + limits.graceMs);
  }
  if (!lane.current && lane.worker) lane.worker.unref();
  wakeBig(lane);
}

/** 许可空出来了：叫醒在别的道队头等着的大写入。从上次叫醒的下一道开始轮，编号大的道不会一直轮不到 */
let wakeFrom = 0;
function wakeBig(except: Lane): void {
  for (let k = 0; k < lanes.length && !bigHolder; k++) {
    const i = (wakeFrom + k) % lanes.length, l = lanes[i] as Lane;
    if (l === except || l.current || l.stopping || !l.queue.length || !isBig(l.queue[0] as Job)) continue;
    pump(l);
    if (bigHolder) wakeFrom = (i + 1) % lanes.length;
  }
}

/** 手上这件事结束了（回话、报错、超时、线程退出都算）：清计时；它要是拿着大写入许可，放回去之前先让本道接着做 */
function settle(lane: Lane): Job | null {
  const job = lane.current;
  lane.current = null;
  if (lane.watchdog) clearTimeout(lane.watchdog);
  lane.watchdog = null;
  if (job && bigHolder === job) bigHolder = null;
  return job;
}

function onReply(lane: Lane, w: Worker, m: BenchReply): void {
  // 已经判了超时、被终止的线程晚到的回话不认
  if (w !== lane.worker || !lane.current || m.id !== lane.current.id) return;
  const job = settle(lane) as Job;
  if (changeListener) for (const c of m.changes) { try { changeListener(c); } catch { /* 通知失败不影响已提交的写入 */ } }
  if (m.ok) job.resolve(m.value); else job.reject(fromWire(m.error));
  // 做完一次大写入就换掉这条线程：它的堆里攒着几百 MB 还没回收的东西，几道各攒一份会叠起来。
  // 线程已经回过话、手上没活，库都关在线程里；等它退出之后这一道再起新的（不和旧线程抢库的锁）
  if (isBig(job)) recycle(lane);
  pump(lane);
}

/** 换掉空着的线程：先摘下来，等它退出之后这一道再接着做 */
function recycle(lane: Lane): void {
  const w = lane.worker;
  if (!w || lane.current) return;
  lane.worker = null;
  stats.recycles++;
  lane.stopping = w.terminate().then(() => undefined, () => undefined).then(() => { lane.stopping = null; pump(lane); });
}

/** 线程自己退出了（不是我们终止的）：手上那件事失败，这一道的下一件事会另起一个线程 */
function onDown(lane: Lane, w: Worker, e: unknown): void {
  if (w !== lane.worker) return; // 是我们自己终止的那个
  lane.worker = null;
  stats.crashes++;
  const job = settle(lane);
  if (job) job.reject(new BenchError('internal', '台库的工作线程意外退出；如果是写入，是否生效不确定：带同一个幂等键重试，或者读一次确认', [], e));
  pump(lane);
}

/** 时限加宽限过了还没回话：强行终止这一道的线程。等它真的退出之后这一道再做下一件事；别的道不受影响 */
function kill(lane: Lane, job: Job): void {
  if (lane.current !== job) return;
  settle(lane);
  stats.kills++;
  const w = lane.worker;
  lane.worker = null;
  job.reject(new BenchError('timeout', `台库操作超过时限（${job.budgetMs} 毫秒）而且没有停下来，已强行中止。如果是写入，是否生效不确定：带同一个幂等键重试，或者读一次确认`));
  if (!w) { pump(lane); return; }
  lane.stopping = w.terminate().then(() => undefined, () => undefined).then(() => { lane.stopping = null; pump(lane); });
  wakeBig(lane); // 许可在 settle 里已经放了：别的道不用等这个旧线程退出
}

function enqueue(lane: Lane, slug: string, method: string, args: unknown[]): Promise<unknown> {
  const budgetMs = BENCH_METHODS.get(method) === 'read' ? limits.queryMs : limits.writeMs;
  return new Promise((resolve, reject) => {
    lane.queue.push({ id: ++seq, slug, method, args, budgetMs, big: bigWrite(method, args), resolve, reject });
    pump(lane);
  });
}

/**
 * 写入的行数组里，格只能是单个值（文本、数字、布尔、空）。有对象或数组的格，在递给线程之前就拒：
 * 线程里的校验也会拒，但复制给线程时内存已经占了；而且大写入按体量估时这样的格只按 8 记，会低估。说明是第几行哪一列
 */
function nonScalarCell(method: string, args: unknown[]): BenchError | null {
  if (BENCH_METHODS.get(method) !== 'write') return null;
  for (const a of args) {
    if (!Array.isArray(a)) continue;
    for (let i = 0; i < a.length; i++) {
      const r = a[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object') return new BenchError('invalid', `第 ${i + 1} 行的 ${k.slice(0, 40)} 列不是单个值（是对象或数组），整批未写入`);
      }
    }
  }
  return null;
}

function call(slug: string, method: string, args: unknown[]): Promise<unknown> {
  if (queuedTotal() >= BENCH_LIMITS.queue) return Promise.reject(new BenchError('busy', '台库正忙，排着队的读写太多，稍后再试'));
  const cell = nonScalarCell(method, args);
  if (cell) return Promise.reject(cell);
  return enqueue(laneOf(slug), slug, method, args);
}

// —— 一个台的句柄 ——
type Core = BenchStoreCore;
/** 一个台的库。方法和 bench-store-core.ts 的 BenchStoreCore 一一对应，各自的说明看那边 */
export class BenchStore {
  readonly slug: string;
  private closed = false;
  constructor(slug: string) { this.slug = slug; }
  /** 台被删了或库被关了：这个句柄从此不能再用，调用方重新取 */
  retire(): void { this.closed = true; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rpc(method: string, args: unknown[]): Promise<any> {
    if (this.closed) return Promise.reject(new BenchError('conflict', `台库 ${this.slug} 已经关闭，重新取一次再用`));
    return call(this.slug, method, args);
  }
  datasets(): ReturnType<Core['datasets']> { return this.rpc('datasets', []); }
  defineDataset(...a: Parameters<Core['defineDataset']>): ReturnType<Core['defineDataset']> { return this.rpc('defineDataset', a); }
  datasetVersions(...a: Parameters<Core['datasetVersions']>): ReturnType<Core['datasetVersions']> { return this.rpc('datasetVersions', a); }
  replace(...a: Parameters<Core['replace']>): ReturnType<Core['replace']> { return this.rpc('replace', a); }
  append(...a: Parameters<Core['append']>): ReturnType<Core['append']> { return this.rpc('append', a); }
  upsert(...a: Parameters<Core['upsert']>): ReturnType<Core['upsert']> { return this.rpc('upsert', a); }
  deleteRows(...a: Parameters<Core['deleteRows']>): ReturnType<Core['deleteRows']> { return this.rpc('deleteRows', a); }
  snapshot(...a: Parameters<Core['snapshot']>): ReturnType<Core['snapshot']> { return this.rpc('snapshot', a); }
  snapshots(...a: Parameters<Core['snapshots']>): ReturnType<Core['snapshots']> { return this.rpc('snapshots', a); }
  restore(...a: Parameters<Core['restore']>): ReturnType<Core['restore']> { return this.rpc('restore', a); }
  query(...a: Parameters<Core['query']>): ReturnType<Core['query']> { return this.rpc('query', a); }
  getView(...a: Parameters<Core['getView']>): ReturnType<Core['getView']> { return this.rpc('getView', a); }
  putView(...a: Parameters<Core['putView']>): ReturnType<Core['putView']> { return this.rpc('putView', a); }
  rollbackView(...a: Parameters<Core['rollbackView']>): ReturnType<Core['rollbackView']> { return this.rpc('rollbackView', a); }
  viewVersions(): ReturnType<Core['viewVersions']> { return this.rpc('viewVersions', []); }
  diffViews(...a: Parameters<Core['diffViews']>): ReturnType<Core['diffViews']> { return this.rpc('diffViews', a); }
  changes(...a: Parameters<Core['changes']>): ReturnType<Core['changes']> { return this.rpc('changes', a); }
  writes(...a: Parameters<Core['writes']>): ReturnType<Core['writes']> { return this.rpc('writes', a); }
  backupTo(...a: Parameters<Core['backupTo']>): ReturnType<Core['backupTo']> { return this.rpc('backupTo', a); }
  renderView(...a: Parameters<Core['renderView']>): ReturnType<Core['renderView']> { return this.rpc('renderView', a); }
  submitForm(...a: Parameters<Core['submitForm']>): ReturnType<Core['submitForm']> { return this.rpc('submitForm', a); }
  varsList(...a: Parameters<Core['varsList']>): ReturnType<Core['varsList']> { return this.rpc('varsList', a); }
  varGet(...a: Parameters<Core['varGet']>): ReturnType<Core['varGet']> { return this.rpc('varGet', a); }
  varCount(): ReturnType<Core['varCount']> { return this.rpc('varCount', []); }
  varsDigest(): ReturnType<Core['varsDigest']> { return this.rpc('varsDigest', []); }
  varInsert(...a: Parameters<Core['varInsert']>): ReturnType<Core['varInsert']> { return this.rpc('varInsert', a); }
  varUpdate(...a: Parameters<Core['varUpdate']>): ReturnType<Core['varUpdate']> { return this.rpc('varUpdate', a); }
  varDelete(...a: Parameters<Core['varDelete']>): ReturnType<Core['varDelete']> { return this.rpc('varDelete', a); }
  varForce(...a: Parameters<Core['varForce']>): ReturnType<Core['varForce']> { return this.rpc('varForce', a); }
  varsImport(...a: Parameters<Core['varsImport']>): ReturnType<Core['varsImport']> { return this.rpc('varsImport', a); }
  varsMarkGet(): ReturnType<Core['varsMarkGet']> { return this.rpc('varsMarkGet', []); }
  varsMarkSet(...a: Parameters<Core['varsMarkSet']>): ReturnType<Core['varsMarkSet']> { return this.rpc('varsMarkSet', a); }
}

// —— 打开、关闭、删除 ——
const handles = new Map<string, Promise<BenchStore>>();
/** 已经开成的句柄：删台、关库的那一刻要立即让它们失效，不能等一轮异步 */
const live = new Map<string, BenchStore>();
/** 正在删的台：删完之前不许再取 */
const removing = new Map<string, Promise<void>>();

/** 这个台有没有库（没有的不会因为问一句就建出来） */
export function benchStoreExists(slug: string): boolean { return existsSync(benchFile(ROOT, slug)); }

/** 取一个台的库；第一次用时建出来。这个台正在删的时候拒绝，等删完再取 */
export async function benchStore(slug: string): Promise<BenchStore> {
  benchFile(ROOT, slug); // 标识不合规在这里就拒，不发给线程
  if (removing.has(slug)) throw new BenchError('conflict', `台 ${slug} 正在删除，稍后再试`);
  let p = handles.get(slug);
  if (!p) {
    const opening = call(slug, '@open', []).then(() => {
      const s = new BenchStore(slug);
      if (handles.get(slug) === opening) live.set(slug, s); else s.retire(); // 开的过程中被删了或关了
      return s;
    });
    // 没开成的不留在表里；但只摘自己这一条，不碰后来的人放进去的
    opening.catch(() => { if (handles.get(slug) === opening) handles.delete(slug); });
    handles.set(slug, opening);
    p = opening;
  }
  return p;
}

/**
 * 删掉一个台的库（删台时用）：等排着的读写跑完、关掉连接，再删文件。
 * 从调用这一刻到删完，这个台取不到；之前拿到的句柄从这一刻起不能再用。删完可以重新建，是空的。
 * 同一个台同时删两次，等的是同一次。
 */
export async function removeBenchStore(slug: string): Promise<void> {
  benchFile(ROOT, slug);
  let job = removing.get(slug);
  if (!job) {
    live.get(slug)?.retire();
    live.delete(slug);
    handles.delete(slug);
    job = call(slug, '@remove', []).then(() => undefined).finally(() => { removing.delete(slug); });
    removing.set(slug, job);
  }
  return job;
}

/** 关掉所有开着的台库并停掉工作线程（进程退出、测试收尾）。之前拿到的句柄都不能再用 */
export async function closeBenchStores(): Promise<void> {
  for (const s of live.values()) s.retire();
  live.clear();
  handles.clear();
  await Promise.all(lanes.map(async (lane) => {
    if (!lane.worker && !lane.current && !lane.queue.length && !lane.stopping) return;
    try { await enqueue(lane, '', '@closeAll', []); } catch { /* 关不干净也接着往下走 */ }
    if (lane.stopping) await lane.stopping;
    // 这期间又有人排了新的事：线程留着接着做，不在别人做到一半的时候停它
    if (lane.current || lane.queue.length) return;
    const w = lane.worker;
    lane.worker = null;
    if (w) await w.terminate();
  }));
}
