/**
 * 「关注」的答复转给原路由（阶段八 8d）：提供方 answer() 的一种实现。阶段三把各来源的处理函数抽出来之后逐个换成直接调用。
 *
 * 在进程内把一个请求交给同一个 Express 应用：全局中间件（写请求总门、管理员认定、登录门……）和原路由自己的守卫一层不少地照走。
 * 硬约束：
 *   1. 路径和方法只来自调用方写死的小表，id 编码后填进去；这里再挡一道：只收 /api/ 下、不收「关注」自己的路径。
 *   2. 身份原样带过去：连接的来源地址、端口、是不是加密照抄原请求的（回环直连不会因此变成本机命令行，远程的还是远程），
 *      只抄下面这几个和身份、来源有关的头，不加、不换、不提升。同源检查按原请求的头判。
 *      连接本身用一个不接到网络上的替身：转发的读写不会碰到原请求那条真的连接。
 *   3. 请求体由调用方按答法换算好再交进来，这里不透传原请求体的任何字段。
 *   4. 原路由回什么状态码和正文，就原样交回去。
 * 应答不写到真的连接上：截下状态码、头和正文。
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type express from 'express';

/** 原样带过去的请求头：身份（cookie、口令）、同源判断（Origin、Referer、Sec-Fetch-*）、来源地址相关、Host */
export const FORWARDED_HEADERS = [
  'host', 'cookie', 'x-admin-token', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'user-agent',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip',
] as const;

export type Forwarded = { status: number; body: unknown };

/** 不接网络的连接替身：来源地址这些照抄原连接，读写都是空操作 */
function standIn(real: Socket): Socket {
  const s = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }) as unknown as Socket & Record<string, unknown>;
  for (const k of ['remoteAddress', 'remotePort', 'remoteFamily', 'localAddress', 'localPort', 'encrypted'] as const) {
    Object.defineProperty(s, k, { value: (real as unknown as Record<string, unknown>)?.[k], enumerable: true });
  }
  s.setTimeout = (() => s) as never; s.setNoDelay = (() => s) as never; s.setKeepAlive = (() => s) as never;
  return s;
}

export function forwardable(method: string, path: string): boolean {
  return ['POST', 'PUT'].includes(method) && path.startsWith('/api/') && !path.toLowerCase().startsWith('/api/attention') && !/[?#\s]|\/\.\.?(\/|$)/.test(path);
}

export function forward(app: express.Express, original: express.Request, method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<Forwarded> {
  if (!forwardable(method, path)) return Promise.reject(new Error(`attention：不转 ${method} ${path}`));
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const req = new IncomingMessage(standIn(original.socket));
  req.method = method;
  req.url = path;
  for (const h of FORWARDED_HEADERS) {
    const v = original.headers[h];
    if (v !== undefined) req.headers[h] = v;
  }
  req.headers['content-type'] = 'application/json';
  req.headers['content-length'] = String(payload.length);
  req.push(payload);
  req.push(null);

  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const take = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
    };
    res.write = ((chunk: unknown, encoding?: unknown) => { take(chunk, encoding); return true; }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown) => {
      take(chunk, encoding);
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown = text;
      try { parsed = text === '' ? null : JSON.parse(text); } catch { /* 不是 JSON 就原样给文本 */ }
      resolve({ status: res.statusCode, body: parsed });
      return res;
    }) as typeof res.end;
    try {
      (app as unknown as (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void)(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: 404, body: { error: 'not_found' } });
      });
    } catch (e) { reject(e); }
  });
}
