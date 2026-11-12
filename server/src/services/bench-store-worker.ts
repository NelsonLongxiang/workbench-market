/**
 * 台库的工作线程入口（数据视图，docs/data-views.md 第十一节）。
 *
 * 台库是同步访问的：一条语句跑多久，所在的线程就停多久。放在这个线程里跑，停的是它，市场进程只等回话。
 * 市场进程一次只发一件事过来（bench-store.ts 那边排队），这里做完回一句，带上这件事提交了的变更。
 *
 * 这个文件和它引用的东西都不引用 db.ts（只引类型）：引用就会在这个线程里再开一次主库。
 * 库文件放在哪、建表语句和随库不同的写法，都由市场进程在起线程的时候递进来（workerData）。
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { BenchSqlKit } from '../db.ts';
import { BenchError } from '../bench-query.ts';
import { BENCH_METHODS, BenchHost, type BenchChange } from './bench-store-core.ts';

export type BenchRequest = { id: number; slug: string; method: string; args: unknown[]; budgetMs: number };
export type BenchWireError = { code: string; message: string; details: string[]; cause?: string };
export type BenchReply = { id: number; changes: BenchChange[] } & ({ ok: true; value: unknown } | { ok: false; error: BenchWireError });

const port = parentPort;
if (!port) throw new Error('bench-store-worker.ts 只作为工作线程运行');
const { root, kit } = workerData as { root: string; kit: BenchSqlKit };
const host = new BenchHost(root, kit);

/** 错误过线程：只带代号、说明和细目；原始的错（库的报错原文）缩成一行文字，给市场进程记日志用，不对外 */
function wire(e: unknown): BenchWireError {
  const b = e instanceof BenchError ? e : new BenchError('internal', '台库内部错误', [], e);
  const cause = b.cause === undefined ? undefined : String((b.cause as Error)?.message ?? b.cause).slice(0, 500);
  return { code: b.code, message: b.message, details: b.details, cause };
}

async function handle(m: BenchRequest): Promise<unknown> {
  if (typeof m.slug !== 'string' || typeof m.method !== 'string' || !Array.isArray(m.args) || typeof m.budgetMs !== 'number') throw new BenchError('invalid', '发给台库的消息格式不对');
  if (m.method === '@open') { await host.store(m.slug); return null; }
  if (m.method === '@remove') { await host.remove(m.slug); return null; }
  if (m.method === '@closeAll') { await host.closeAll(); return null; }
  // 只认登记过的操作名：不拿传来的名字直接去对象上取
  if (!BENCH_METHODS.has(m.method)) throw new BenchError('invalid', `台库没有这个操作：${String(m.method).slice(0, 40)}`);
  const s = await host.store(m.slug);
  const fn = (s as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m.method];
  return s.withBudget(m.budgetMs, () => fn.apply(s, m.args));
}

port.on('message', (m: BenchRequest) => {
  // 连编号都没有的不是我们的消息：不理它，也不让它把线程弄垮
  if (!m || typeof m !== 'object' || typeof m.id !== 'number') return;
  handle(m).then(
    (value) => port.postMessage({ id: m.id, ok: true, value, changes: host.takeChanges() } satisfies BenchReply),
    (e) => port.postMessage({ id: m.id, ok: false, error: wire(e), changes: host.takeChanges() } satisfies BenchReply),
  );
});
