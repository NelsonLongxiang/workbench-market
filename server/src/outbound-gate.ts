/**
 * 对外断开（预发模式）：WM_OUTBOUND=off 时，这个进程一个字节都不往外发。
 *
 * 用在拿生产数据的副本起一个预发实例的时候：副本里的台地址、通知绑定、投递目标、对端都是生产的真实地址，
 * 不断开就会拿着生产的数据去给真实的对端发消息。只能经环境变量打开（库里没有、接口也改不了）；缺省 on，非法值拒绝启动。
 *
 * 闸放在最底下，不靠一处处改调用方（漏一处就漏一个字节）：
 *   · TCP / TLS：net.Socket.prototype.connect。fetch（undici）、http(s).request、http2、http-proxy-middleware、Redis 客户端、
 *     tls.connect 最后都走到这里。只放行连本进程自己在听的端口（回环地址），其余在连之前就拒绝：不发 SYN、不做 DNS 解析。
 *     Unix 域套接字（path）一律拒绝。
 *   · DNS：dns.lookup、dns.promises.lookup、各种 resolve*、Resolver 实例。只放行 localhost 和本来就是 IP 的名字（不出网）。
 *   · UDP：dgram 的 send、connect 一律拒绝。
 *   · 子进程：child_process 的 spawn、exec、execFile、fork 及其同步版本一律抛错——子进程的网络这个进程管不到。
 *   · worker_threads：新开 Worker 一律抛错——每个 Worker 有自己的一份模块，上面的补丁管不到它。
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

const raw = String(process.env.WM_OUTBOUND ?? '').trim();
if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`[outbound] WM_OUTBOUND 只能是 on 或 off（得：${JSON.stringify(raw)}），拒绝启动`);
const OFF = raw === 'off';

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

// ---------- 本进程自己在听的端口 ----------
// 记的是服务器本身，连接时再看它此刻的地址：listen 之后 server.listening 立刻为真，listening 事件却要等下一拍，
// 记端口要等事件的话，紧跟着的第一条自检请求会被误拦
const ownServers = new Set<net.Server>();
const ownPort = (port: number) => [...ownServers].some((s) => { const a = s.address(); return Boolean(a && typeof a === "object" && a.port === port); });
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const IPLIKE = (h: string) => net.isIP(h.replace(/^\[|\]$/g, '')) !== 0;

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
function allowedTcp(host: string, port: number): boolean {
  return LOOPBACK.has(host.replace(/^\[|\]$/g, '').toLowerCase()) && ownPort(port);
}

if (OFF) {
  // 记下本进程 listen 的端口（市场、控制面、内容面……），只有连它们的才放行
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    ownServers.add(this);
    this.once('close', () => ownServers.delete(this));
    return (listen as (...x: unknown[]) => net.Server).apply(this, args);
  } as typeof listen;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args);
    if (t.path === '' && allowedTcp(t.host, t.port)) return (connect as (...x: unknown[]) => net.Socket).apply(this, args);
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
  // worker_threads：继承一个一构造就抛错的类
  (workerThreads as unknown as Record<string, unknown>).Worker = class BlockedWorker {
    constructor(file: unknown) { noteBlocked('worker', String(file ?? '')); throw new OutboundBlockedError('新开 Worker'); }
  };
  // 让 ESM 的具名引入（import { spawn } from 'node:child_process'）也看到替换后的函数
  syncBuiltinESMExports();
  console.warn('[outbound] WM_OUTBOUND=off：对外已断开。这是预发实例，所有出站在发出前被拦下并计数；定时投递整轮跳过、在途保持挂起');
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
