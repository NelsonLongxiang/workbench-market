/**
 * 判定切换的读路（阶段六 6d）：新判定说拒，但旧处理函数照跑；在应答头发出去的那一刻看旧的状态码。
 * 旧的要放行（2xx、3xx）就换成拒绝：状态码、头换掉，旧的应答体一个字节都不发；别的状态码（旧的也拒、400、404、405、410……）原样放过。
 * 这个文件不依赖任何服务，单独测（scripts/judgment-enforce-test.mjs）。
 */
import type express from 'express';

/**
 * 读的路：让旧处理函数照跑，在应答头发出去的那一刻看它的状态码。2xx、3xx（旧的要放行）就换成拒绝：
 * 状态码、内容类型、长度换掉，旧的应答体一个字节都不发；别的状态码原样放过。
 */
export function denyIfAllowed(res: express.Response, status: number, body: string, record: () => void): void {
  const raw = res as unknown as { writeHead: (...a: unknown[]) => unknown; write: (...a: unknown[]) => boolean; end: (...a: unknown[]) => unknown };
  const writeHead = raw.writeHead.bind(res), write = raw.write.bind(res), end = raw.end.bind(res);
  let decided = false, blocked = false;
  const decide = (code: number) => {
    if (decided) return;
    decided = true;
    if (code < 200 || code >= 400) return;
    blocked = true;
    record();
    for (const h of res.getHeaderNames()) if (!['vary', 'x-powered-by'].includes(h)) res.removeHeader(h);
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  };
  raw.writeHead = (code: unknown, ...rest: unknown[]) => {
    decide(Number(code));
    // 换成拒绝时，旧的那几个头（第二、三个参数里带的）一概不要
    return blocked ? writeHead(status) : writeHead(code, ...rest);
  };
  raw.write = (...a: unknown[]) => {
    if (!res.headersSent) decide(res.statusCode);
    return blocked ? true : write(...a);
  };
  raw.end = (...a: unknown[]) => {
    if (!res.headersSent) decide(res.statusCode);
    if (!blocked) return end(...a);
    const cb = a.find((x) => typeof x === 'function') as (() => void) | undefined;
    return (end as (b: string, cb?: () => void) => unknown)(res.req.method === 'HEAD' ? '' : body, cb);
  };
}

/**
 * 面门：这个请求是不是被面门挡在外面（路由声明了 surfaceGate、when 成立）。when 抛错按「没走错面」算——
 * 面门判不了就照常比、照常判，不靠它把请求从比对里摘出去（摘出去会藏住不一致）。
 */
export function surfaceBlocked(spec: { surfaceGate?: { when: (req: express.Request) => boolean } } | undefined, req: express.Request): boolean {
  if (!spec?.surfaceGate) return false;
  try { return spec.surfaceGate.when(req) === true; } catch { return false; }
}
