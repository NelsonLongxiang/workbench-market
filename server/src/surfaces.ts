/** #292 M1 面（surface）：同一个 express app 挂在多个端口上，每个端口一个面。
 *  - market（PORT，默认 9800）：业务面，照旧承载 /go、/sop、/apps、/lifecycle 等；**不接受浏览器发来的管理写**；
 *  - control（WM_CONTROL_PORT，默认 9801；设 0 关闭）：管理控制面，口令只在这里输入和使用，不承载任何不可信内容。
 *  #291 的内容 listener 也从这里注册（registerSurface），不另写一套 listen。
 *
 *  权威来源：面只按 **req.socket.localPort** 判（内核给的、客户端改不了），不看 Host、不看 X-Forwarded-*。
 *  Host 只用于拼显示链接与 Origin 比对；内容面若需按 Host 选 target，由内容模块自己在本面内做白名单。
 *  WS upgrade 不经过 Express：调用方在每个 server 上挂 'upgrade'，用 surfaceOf(req) 同样判面（req.socket 照样可用）。 */
import type { Server, IncomingMessage } from 'node:http';
import type { Express } from 'express';

export type SurfaceName = 'market' | 'control' | (string & {});
type Registered = { name: SurfaceName; port: number; server: Server };
const surfaces: Registered[] = [];

/** 读端口配置：WM_CONTROL_PORT 缺省 9801；'0' 或与业务端口相同 → 关闭控制面（此时浏览器管理写全部拒绝，只能走本机 CLI） */
export function surfacePorts(env: NodeJS.ProcessEnv = process.env): { market: number; control: number | null } {
  const market = Number(env.PORT) || 9800;
  const raw = String(env.WM_CONTROL_PORT ?? '').trim();
  const n = raw === '' ? 9801 : Number(raw);
  const control = Number.isInteger(n) && n > 0 && n < 65536 && n !== market ? n : null;
  return { market, control };
}

/** 在 port 上挂一个面（同一个 app）；返回 server，调用方自己挂 upgrade / close */
export function registerSurface(app: Express, name: SurfaceName, port: number, onListen?: () => void): Server {
  if (surfaces.some((s) => s.port === port)) throw new Error(`端口 ${port} 已注册为面 ${surfaces.find((s) => s.port === port)!.name}`);
  const server = app.listen(port, onListen);
  surfaces.push({ name, port, server });
  return server;
}

export function surfaceOf(req: IncomingMessage): SurfaceName | null {
  const port = req.socket?.localPort;
  return surfaces.find((s) => s.port === port)?.name ?? null;
}

export function surfacePort(name: SurfaceName): number | null {
  return surfaces.find((s) => s.name === name)?.port ?? null;
}

export function allSurfaceServers(): Server[] {
  return surfaces.map((s) => s.server);
}

/** 浏览器标记：现代浏览器的非 GET/HEAD 请求一律带 Origin；Sec-Fetch-* 只在 https/回环时有，作补充 */
export function browserMarked(req: IncomingMessage): boolean {
  const h = req.headers;
  return h.origin !== undefined || h['sec-fetch-site'] !== undefined || h['sec-fetch-mode'] !== undefined;
}

/** 经过（同机）反代：带 X-Forwarded-For / Forwarded / X-Real-IP 的一律不算本机直连 */
export function forwarded(req: IncomingMessage): boolean {
  const h = req.headers;
  return h['x-forwarded-for'] !== undefined || h.forwarded !== undefined || h['x-real-ip'] !== undefined;
}

/** 本机直连：socket 对端是回环地址，且没有反代转发头（同机 nginx 转进来的远程请求不算） */
export function rawLoopback(req: IncomingMessage): boolean {
  const ip = String(req.socket?.remoteAddress ?? '');
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !forwarded(req);
}

/** Origin 是否就是本面：host 与请求 Host 相同，且端口等于本面端口（Host 由浏览器如实填写；端口再钉一次） */
export function originIsThisSurface(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(String(origin));
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return u.host === String(req.headers.host ?? '') && port === req.socket?.localPort;
  } catch { return false; }
}

/** 给浏览器显示的另一面地址（只用请求里的主机名拼链接，不据此做任何授权） */
export function surfaceUrl(req: IncomingMessage, name: SurfaceName): string | null {
  const port = surfacePort(name);
  if (!port) return null;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return null;
  return `http://${host}:${port}`;
}
