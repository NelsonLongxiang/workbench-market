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
 * 所有台共用一个工作线程，一次只做一件事：一个台的慢操作会让别的台的读写排队，最长等到时限；市场进程本身不受影响。
 * 线程在第一次用到台库时才起。
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, benchSqlKit } from '../db.ts';
import { BENCH_LIMITS, BenchError } from '../bench-query.ts';
import { BENCH_METHODS, BENCH_SLUG_RE, benchFile, type BenchChange, type BenchStoreCore } from './bench-store-core.ts';
import type { BenchReply, BenchRequest, BenchWireError } from './bench-store-worker.ts';

export { BENCH_SLUG_RE };
export type { WriteCtx, WriteResult, DatasetInput, ViewVersion, BenchChange } from './bench-store-core.ts';

const ROOT = join(dataDir, 'bench-stores');
const CODES = new Set(['invalid', 'not_found', 'conflict', 'limit', 'unsupported', 'internal', 'timeout', 'busy']);

let changeListener: ((c: BenchChange) => void) | null = null;
/** 台库每次变更（事务提交之后）通知一次；对外入口接上之前没有人听 */
export function onBenchChange(fn: ((c: BenchChange) => void) | null): void { changeListener = fn; }

// —— 时限 ——
const limits = { queryMs: BENCH_LIMITS.queryMs as number, writeMs: BENCH_LIMITS.writeMs as number, graceMs: BENCH_LIMITS.killGraceMs as number };
export type BenchRuntimeLimits = typeof limits;
/** 改时限（毫秒），返回改之前的值。测试用；只影响之后发起的读写 */
export function configureBenchRuntime(next: Partial<BenchRuntimeLimits>): BenchRuntimeLimits {
  const prev = { ...limits };
  for (const k of ['queryMs', 'writeMs', 'graceMs'] as const) {
    const v = next[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) throw new BenchError('invalid', `${k} 须为不小于 0 的毫秒数`);
    limits[k] = v;
  }
  return prev;
}

// —— 工作线程和它前面的队 ——
type Job = { id: number; slug: string; method: string; args: unknown[]; budgetMs: number; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const queue: Job[] = [];
let current: Job | null = null;
let worker: Worker | null = null;
/** 正在等一个被强行终止的线程退出；它退出之前不起新的（旧线程手里可能还握着库的写锁） */
let stopping: Promise<void> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const stats = { spawns: 0, kills: 0, crashes: 0 };
/** 线程起过几次、被强行终止过几次、自己意外退出过几次，现在排着几件事 */
export function benchRuntimeStats(): { spawns: number; kills: number; crashes: number; queued: number } {
  return { ...stats, queued: queue.length + (current ? 1 : 0) };
}

/** 测试用：让工作线程像自己意外退出那样停掉（不走「强行终止」那条路），用来验退出之后的收拾 */
export function stopBenchWorkerAbruptly(): void { void worker?.terminate(); }

function fromWire(e: BenchWireError): BenchError {
  const code = CODES.has(e.code) ? (e.code as BenchError['code']) : 'internal';
  return new BenchError(code, String(e.message), Array.isArray(e.details) ? e.details.map(String) : [], e.cause === undefined ? undefined : new Error(e.cause));
}

function spawn(): Worker {
  const w = new Worker(new URL('./bench-store-worker.ts', import.meta.url), { workerData: { root: ROOT, kit: benchSqlKit('sqlite') } });
  stats.spawns++;
  w.on('message', (m: BenchReply) => onReply(w, m));
  // 线程里抛了没人接的错（比如内存用尽）会先报错、再退出。只在退出的时候收拾：那时线程已经不在了，不会和新起的线程抢库的锁
  let failure: unknown;
  w.on('error', (e) => { failure = e; });
  w.on('exit', (code) => onDown(w, failure ?? new Error(`台库的工作线程退出了（退出码 ${code}）`)));
  w.unref(); // 闲着的线程不拦着进程退出；有事在做的时候再 ref
  return w;
}

/** 轮到下一件事：线程空着、没有在等旧线程退出，就发过去并开始计时 */
function pump(): void {
  while (!current && !stopping && queue.length) {
    const job = queue.shift() as Job;
    try {
      worker ??= spawn();
      worker.ref();
      worker.postMessage({ id: job.id, slug: job.slug, method: job.method, args: job.args, budgetMs: job.budgetMs } satisfies BenchRequest);
    } catch (e) {
      // 参数里有过不了线程的东西（函数、符号之类），或者线程起不来；这件事失败，接着做下一件
      const uncloneable = (e as Error)?.name === 'DataCloneError';
      job.reject(uncloneable ? new BenchError('invalid', '参数里有不能传给台库的值（函数、符号之类）') : new BenchError('internal', '台库内部错误', [], e));
      continue;
    }
    current = job;
    watchdog = setTimeout(() => kill(job), job.budgetMs + limits.graceMs);
  }
  if (!current && worker) worker.unref();
}

function settle(): Job | null {
  const job = current;
  current = null;
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  return job;
}

function onReply(w: Worker, m: BenchReply): void {
  // 已经判了超时、被终止的线程晚到的回话不认
  if (w !== worker || !current || m.id !== current.id) return;
  const job = settle() as Job;
  if (changeListener) for (const c of m.changes) { try { changeListener(c); } catch { /* 通知失败不影响已提交的写入 */ } }
  if (m.ok) job.resolve(m.value); else job.reject(fromWire(m.error));
  pump();
}

/** 线程自己退出了（不是我们终止的）：手上那件事失败，下一件事会另起一个线程 */
function onDown(w: Worker, e: unknown): void {
  if (w !== worker) return; // 是我们自己终止的那个
  worker = null;
  stats.crashes++;
  const job = settle();
  if (job) job.reject(new BenchError('internal', '台库的工作线程意外退出；如果是写入，是否生效不确定：带同一个幂等键重试，或者读一次确认', [], e));
  pump();
}

/** 时限加宽限过了还没回话：强行终止线程。等它真的退出之后再做下一件事 */
function kill(job: Job): void {
  if (current !== job) return;
  settle();
  stats.kills++;
  const w = worker;
  worker = null;
  job.reject(new BenchError('timeout', `台库操作超过时限（${job.budgetMs} 毫秒）而且没有停下来，已强行中止。如果是写入，是否生效不确定：带同一个幂等键重试，或者读一次确认`));
  if (!w) { pump(); return; }
  stopping = w.terminate().then(() => undefined, () => undefined).then(() => { stopping = null; pump(); });
}

function call(slug: string, method: string, args: unknown[]): Promise<unknown> {
  if (queue.length >= BENCH_LIMITS.queue) return Promise.reject(new BenchError('busy', '台库正忙，排着队的读写太多，稍后再试'));
  const budgetMs = BENCH_METHODS.get(method) === 'read' ? limits.queryMs : limits.writeMs;
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, slug, method, args, budgetMs, resolve, reject });
    pump();
  });
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
  if (!worker && !current && !queue.length && !stopping) return;
  try { await call('', '@closeAll', []); } catch { /* 关不干净也接着往下走 */ }
  if (stopping) await stopping;
  // 这期间又有人排了新的事：线程留着接着做，不在别人做到一半的时候停它
  if (current || queue.length) return;
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}
