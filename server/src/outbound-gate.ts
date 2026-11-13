/**
 * 对外断开（预发模式）：WM_OUTBOUND=off 时，这个进程一个字节都不往外发。
 *
 * 用在拿生产数据的副本起一个预发实例的时候：副本里的台地址、通知绑定、投递目标、对端都是生产的真实地址，
 * 不断开就会拿着生产的数据去给真实的对端发消息。只能经环境变量打开（库里没有、接口也改不了）；缺省 on，非法值拒绝启动。
 *
 * 闸放在最底下，不靠一处处改调用方（漏一处就漏一个字节）：
 *   · TCP / TLS：net.Socket.prototype.connect。fetch（undici）、http(s).request、http2、http-proxy-middleware、Redis 客户端、
 *     tls.connect 最后都走到这里。只放行连本进程自己在听的回环地址和端口（地址、地址族都要对上，localhost 钉到那个地址上），
 *     其余在连之前就拒绝：不发 SYN、不做 DNS 解析。
 *     Unix 域套接字（path）一律拒绝。
 *   · DNS：dns.lookup、dns.promises.lookup、各种 resolve*、Resolver 实例。只放行 localhost 和本来就是 IP 的名字（不出网）。
 *   · UDP：dgram 的 send、connect 一律拒绝。
 *   · 子进程：child_process 的 spawn、exec、execFile、fork 及其同步版本一律抛错——子进程的网络这个进程管不到。
 *   · worker_threads：新开 Worker 抛错——每个 Worker 有自己的一份模块，上面的补丁管不到它。
 *     例外只有下面登记的线程入口（ALLOWED_WORKERS）：这些入口自己第一件事就是装上这个闸（引用本文件），
 *     起的时候强制带上 WM_OUTBOUND=off，线程里同样一个字节都不往外发。别的文件、eval 的代码、字符串路径照旧拒绝。
 * 拦不到的：本进程之外的东西（数据目录里别的进程、宿主机）；原生扩展自己开的套接字（本仓没有）；直接调内部绑定
 * （process.binding('tcp_wrap')，本仓没有）；入站请求的应答（那是对方连进来的，照常回）。
 * 拦下的按类别计数，最近 20 个目标留给管理员看。会定时往外发的 worker 自己先问 outboundOff()，整轮跳过——
 * 不然被拦的发送会被当成失败，按退避重试、最后判死。
 */
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { defineConfig, loadConfig } from './config.ts';

/** 对外断开时仍然允许起的线程入口：必须是自己会装这个闸的文件。现在只有台库的工作线程 */
const ALLOWED_WORKERS: ReadonlySet<string> = new Set([new URL('./services/bench-store-worker.ts', import.meta.url).href]);
const RealWorker = workerThreads.Worker;

/** 对外断开的开关：WM_OUTBOUND 只认 on、off（空是 on），别的值拒绝启动 */
export const Config = defineConfig((env) => {
  const raw = String(env.WM_OUTBOUND ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`[outbound] WM_OUTBOUND 只能是 on 或 off（得：${JSON.stringify(raw)}），拒绝启动`);
  return { off: raw === 'off' };
});
const OFF = loadConfig(Config).off;

/** 这个进程是不是处在「对外断开」 */
export function outboundOff(): boolean { return OFF; }

export type OutboundKind = 'tcp' | 'unix-socket' | 'dns' | 'udp' | 'subprocess' | 'worker'
  | 'event-delivery' | 'receipt-outbox' | 'allow-notify' | 'health-patrol' | 'health-check' | 'mcp-upstream' | 'sandbox' | string;
const counts = new Map<string, number>();
const recent: { kind: string; target: string; at: string }[] = [];
/** 记一次被拦（或整轮跳过）。target 只给管理员看 */
export function noteBlocked(kind: OutboundKind, target = ''): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  recent.push({ kind, target: String(target).slice(0, 200), at: new Date().toISOString() });
  if (recent.length > 20) recent.shift();
}
/** 健康检查里报的：匿名只给开关，管理员再给计数和最近的目标 */
export function outboundStatus(detail: boolean): Record<string, unknown> | null {
  if (!OFF) return null;
  return detail ? { mode: 'off', blocked: Object.fromEntries(counts), recent: recent.slice() } : { mode: 'off' };
}
export class OutboundBlockedError extends Error {
  readonly code = 'EOUTBOUNDOFF';
  constructor(what: string) { super(`对外已断开（WM_OUTBOUND=off）：拒绝 ${what}`); }
}

// ---------- 本进程自己在听的地址 ----------
// 记的是服务器本身，连接时再看它此刻的地址：listen 之后 server.listening 立刻为真，listening 事件却要等下一拍，
// 记端口要等事件的话，紧跟着的第一条自检请求会被误拦。
// 放行比的是实际监听的地址和地址族，不只比端口号。
const ownServers = new Set<net.Server>();
const v6OnlyServers = new WeakSet<net.Server>();
const IPLIKE = (h: string) => net.isIP(h.replace(/^\[|\]$/g, '')) !== 0;
/** 目标若落在本进程自己监听的地址上，返回实际要连的地址（localhost 钉成那个服务器所在的回环地址）；否则 null */
function ownTarget(host: string, port: number): string | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = h === '127.0.0.1' || h === '::ffff:127.0.0.1';
  const v6 = h === '::1';
  if (!v4 && !v6 && h !== 'localhost') return null;
  for (const s of ownServers) {
    const a = s.address();
    if (!a || typeof a !== 'object' || a.port !== port) continue;
    const covers4 = a.address === '127.0.0.1' || a.address === '0.0.0.0' || a.address === '::ffff:127.0.0.1' || (a.address === '::' && !v6OnlyServers.has(s));
    const covers6 = a.address === '::1' || a.address === '::';
    if (v4 && covers4) return h;
    if (v6 && covers6) return h;
    if (h === 'localhost') { if (covers4) return '127.0.0.1'; if (covers6) return '::1'; }
  }
  return null;
}

/** 从 Socket.prototype.connect 的各种参数写法里取出目标 */
function targetOf(args: unknown[]): { host: string; port: number; path: string } {
  let a: unknown = args[0];
  if (Array.isArray(a)) a = a[0]; // net.connect 内部规范化以后传进来的是 [options, cb]
  if (a && typeof a === 'object') {
    const o = a as { host?: unknown; port?: unknown; path?: unknown };
    return { host: String(o.host ?? 'localhost'), port: Number(o.port ?? 0), path: typeof o.path === 'string' ? o.path : '' };
  }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { host: '', port: 0, path: a };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a ?? 0), path: '' };
}
/** 把参数里的目标主机换成 pin（只在 localhost 时用：解析结果可能落到另一个地址族上别人的端口） */
function pinHost(args: unknown[], pin: string): unknown[] {
  const a = args[0];
  if (Array.isArray(a) && a[0] && typeof a[0] === 'object') {
    // net.connect 规范化后的数组上带着 Node 内部的符号标记，复制时要一起带上，不然会被当成没规范化过
    const b: unknown[] = a.slice();
    for (const sym of Object.getOwnPropertySymbols(a)) (b as unknown as Record<symbol, unknown>)[sym] = (a as unknown as Record<symbol, unknown>)[sym];
    b[0] = { ...(a[0] as object), host: pin };
    return [b, ...args.slice(1)];
  }
  if (a && typeof a === 'object' && !Array.isArray(a)) return [{ ...(a as object), host: pin }, ...args.slice(1)];
  return [a, pin, ...args.slice(2).filter((x) => typeof x === 'function')];
}

if (OFF) {
  // 记下本进程 listen 的端口（市场、控制面、内容面……），只有连它们的才放行
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    ownServers.add(this);
    if (args[0] && typeof args[0] === 'object' && (args[0] as { ipv6Only?: unknown }).ipv6Only === true) v6OnlyServers.add(this);
    this.once('close', () => ownServers.delete(this));
    return (listen as (...x: unknown[]) => net.Server).apply(this, args);
  } as typeof listen;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args);
    const pin = t.path === '' ? ownTarget(t.host, t.port) : null;
    if (pin !== null) return (connect as (...x: unknown[]) => net.Socket).apply(this, pin === t.host.replace(/^\[|\]$/g, '').toLowerCase() ? args : pinHost(args, pin));
    const what = t.path !== '' ? `unix:${t.path}` : `${t.host}:${t.port}`;
    noteBlocked(t.path !== '' ? 'unix-socket' : 'tcp', what);
    const err = new OutboundBlockedError(`连接 ${what}`);
    process.nextTick(() => this.destroy(err));
    return this;
  } as typeof connect;

  // DNS：localhost 和 IP 不出网，放行；其余拒绝
  const lookup = dns.lookup;
  const blockedName = (name: unknown) => { const h = String(name ?? '').toLowerCase(); return !(h === 'localhost' || IPLIKE(h)); };
  (dns as { lookup: unknown }).lookup = function (hostname: string, ...rest: unknown[]) {
    if (!blockedName(hostname)) return (lookup as (...x: unknown[]) => unknown)(hostname, ...rest);
    noteBlocked('dns', hostname);
    const cb = rest.find((x) => typeof x === 'function') as ((e: Error) => void) | undefined;
    const err = new OutboundBlockedError(`解析 ${hostname}`);
    if (cb) process.nextTick(() => cb(err));
    return {};
  };
  const pLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async function (hostname: string, ...rest: unknown[]) {
    if (!blockedName(hostname)) return (pLookup as (...x: unknown[]) => unknown)(hostname, ...rest);
    noteBlocked('dns', hostname);
    throw new OutboundBlockedError(`解析 ${hostname}`);
  };
  // resolve* 一律去问 DNS 服务器：全拒
  const refuseResolve = (name: string) => function (hostname: string, ...rest: unknown[]) {
    noteBlocked('dns', `${name} ${hostname}`);
    const err = new OutboundBlockedError(`DNS ${name} ${hostname}`);
    const cb = rest.find((x) => typeof x === 'function') as ((e: Error) => void) | undefined;
    if (cb) { process.nextTick(() => cb(err)); return undefined; }
    return Promise.reject(err);
  };
  const resolvers = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'lookupService'];
  for (const name of resolvers) {
    for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype] as Record<string, unknown>[]) {
      if (typeof target[name] === 'function') target[name] = refuseResolve(name);
    }
  }

  // UDP
  for (const name of ['send', 'connect'] as const) {
    (dgram.Socket.prototype as unknown as Record<string, unknown>)[name] = function () {
      noteBlocked('udp', name);
      throw new OutboundBlockedError(`UDP ${name}`);
    };
  }

  // 子进程
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    (childProcess as unknown as Record<string, unknown>)[name] = function (file: unknown) {
      noteBlocked('subprocess', String(file ?? ''));
      throw new OutboundBlockedError(`起子进程 ${String(file ?? '')}`);
    };
  }
  // worker_threads：只放行登记过的入口，别的一构造就抛错
  (workerThreads as unknown as Record<string, unknown>).Worker = class GatedWorker extends RealWorker {
    constructor(file: unknown, options?: { workerData?: unknown; resourceLimits?: unknown; eval?: unknown }) {
      // 只认 URL 对象、逐字相等：字符串路径、带查询串的、eval 的代码都不是登记过的那个入口。
      // 地址只读一次，然后用核对过的这个地址另建一个对象去起线程，不把调用方给的对象交下去：
      // 对象自己报的地址可以是假的（子类改写读取器、第一次读和第二次读不一样、伪造一个挂着 URL 原型的对象），
      // 而起线程实际读的是它的路径。
      let href = '';
      try { href = file instanceof URL ? String(file.href) : ''; } catch { href = ''; }
      if (!ALLOWED_WORKERS.has(href) || options?.eval) {
        noteBlocked('worker', String(href || typeof file));
        throw new OutboundBlockedError('新开 Worker');
      }
      // 只带数据和内存上限过去；环境变量强制是「对外断开」，调用方给的 env、execArgv、argv 一概不带
      super(new URL(href), { workerData: options?.workerData, resourceLimits: options?.resourceLimits as never, env: { ...process.env, WM_OUTBOUND: 'off' } });
    }
  };
  // 让 ESM 的具名引入（import { spawn } from 'node:child_process'）也看到替换后的函数
  syncBuiltinESMExports();
  if (workerThreads.isMainThread) console.warn('[outbound] WM_OUTBOUND=off：对外已断开。这是预发实例，所有出站在发出前被拦下并计数；定时投递整轮跳过、在途保持挂起');
}

/**
 * 启动自检那一行：真的去连一个 TEST-NET 地址（192.0.2.1，不可路由），确认在连之前就被拦下（错误码是 EOUTBOUNDOFF，
 * 而不是超时或连不上）。闸没装上、或者被别的代码绕开，这一行就不过，实例拒绝启动。
 */
export function verifyOutboundGate(): Promise<{ ok: boolean; reason: string | null }> {
  if (!OFF) return Promise.resolve({ ok: true, reason: null });
  return new Promise((resolve) => {
    const s = new net.Socket();
    const timer = setTimeout(() => { s.destroy(); resolve({ ok: false, reason: 'gate-not-installed' }); }, 1000);
    s.once('error', (e: Error & { code?: string }) => { clearTimeout(timer); resolve(e.code === 'EOUTBOUNDOFF' ? { ok: true, reason: null } : { ok: false, reason: 'not-blocked-before-connect' }); });
    s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve({ ok: false, reason: 'connected' }); });
    s.connect(9, '192.0.2.1');
  });
}
