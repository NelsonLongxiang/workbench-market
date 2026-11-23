/**
 * 图片代取（docs/image-step1.md 第四节；属主 2026-11-23：图片只用链接，浏览器不访问图库，由市场统一代取）。
 *
 * 浏览器只请求 /api/bench-views/<台>/image?u=<格子里的原值>；判权在路由里做（先判权，再到这里取）。这里只管：
 *   · 把格子里的值还原成地址：图库内的相对路径拼上 WM_IMAGE_GALLERY_BASE，完整的 http(s) 链接照用；
 *   · 唯一保留的一条防护：解析出的地址只要有一个不是公网就不取（只有图库前缀下的除外）——保护的是市场自己和内网服务；
 *     解析一次就把连接钉到这个地址上，取的时候不再解析（防解析结果被换）；
 *   · 只发 GET、不带读者的任何请求头、不跟随跳转、限大小限时限并发；对外断开（WM_OUTBOUND=off）时不发；
 *   · 只转出 png、jpeg、webp、gif 四种；进程内短时缓存。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { outboundOff } from './outbound-gate.ts';
import { IMAGE_REF_CHARS, galleryPathOk, imageRefOk } from './bench-query.ts';
import { classifyV4, classifyV6, parseV4, parseV6 } from './url-admission.ts';

export const IMAGE_LIMITS = { refChars: IMAGE_REF_CHARS, bytes: 5 * 1024 * 1024, timeoutMs: 10_000, concurrent: 8, cacheMs: 5 * 60_000, cacheBytes: 64 * 1024 * 1024 };
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class ImageError extends Error {
  readonly http: number;
  readonly code: string;
  constructor(http: number, code: string, message: string) { super(message); this.http = http; this.code = code; }
}

/** 地址是不是公网：照登记准入那一套分类（server/src/url-admission.ts 的 classifyV4、classifyV6），只认 public 一档。
 *  回环、私网、链路本地（含云元数据 169.254.169.254）、CGNAT、文档与基准网段、组播、IPv6 的 2000::/3 以外、映射到这些的 ::ffff: 地址都不取 */
export function blockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4 !== null) return classifyV4(v4) !== 'public';
  const v6 = parseV6(ip);
  if (v6 !== null) return classifyV6(v6).cls !== 'public';
  return true;
}
/** 完整链接在不在配置的图库前缀下（唯一的例外：图库按属主决定只绑本机回环） */
export function underGallery(u: URL, galleryBase: string | null): boolean {
  return !!galleryBase && u.href.startsWith(galleryBase);
}

/** 格子里的值 → 要取的地址。相对路径要有图库前缀 */
export function resolveImageRef(ref: string, galleryBase: string | null): URL {
  if (!imageRefOk(ref)) throw new ImageError(400, 'image_ref_invalid', '图片须为 http(s) 链接或图库内的相对路径');
  if (/^https?:\/\//i.test(ref)) {
    const full = new URL(ref);
    // 图库前缀下的完整链接，前缀之后的部分照相对路径的规矩核（..、%2f 不许拐出前缀）
    if (galleryBase && underGallery(full, galleryBase) && !galleryPathOk(full.href.slice(galleryBase.length))) throw new ImageError(400, 'image_ref_invalid', '图片路径出了图库范围');
    return full;
  }
  if (!galleryBase) throw new ImageError(400, 'image_gallery_unset', '没有配图库地址（WM_IMAGE_GALLERY_BASE），相对路径的图片取不了');
  const u = new URL(ref, galleryBase);
  if (!u.href.startsWith(galleryBase)) throw new ImageError(400, 'image_ref_invalid', '图片路径出了图库范围');
  return u;
}

type Got = { type: string; body: Buffer };
const cache = new Map<string, { at: number; got: Got }>();
let cacheBytes = 0;
let running = 0;

function fromCache(key: string, now: number): Got | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > IMAGE_LIMITS.cacheMs) { cache.delete(key); cacheBytes -= hit.got.body.length; return null; }
  return hit.got;
}
function toCache(key: string, got: Got, now: number): void {
  if (got.body.length > IMAGE_LIMITS.cacheBytes) return;
  for (const [k, v] of cache) { if (cacheBytes + got.body.length <= IMAGE_LIMITS.cacheBytes) break; cache.delete(k); cacheBytes -= v.got.body.length; }
  cache.set(key, { at: now, got }); cacheBytes += got.body.length;
}
/** 测试用：清缓存 */
export function clearImageCache(): void { cache.clear(); cacheBytes = 0; }

/** 解析主机名；解析出的地址只要有一个不是公网就拒（图库前缀下的除外）。返回要钉住的地址：取的时候直接连它，不再解析 */
async function pinAddress(u: URL, galleryBase: string | null): Promise<{ address: string; family: number }> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isGallery = underGallery(u, galleryBase);
  const all = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!all.length) throw new ImageError(502, 'image_fetch_failed', '图片地址解析不出来');
  if (!isGallery && all.some((a) => blockedAddress(a.address))) throw new ImageError(400, 'image_address_blocked', '图片地址指向本机或内网，不取');
  return all[0];
}

function get(u: URL, pin: { address: string; family: number }): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: 'GET',
      headers: { accept: 'image/png, image/jpeg, image/webp, image/gif', 'user-agent': 'workbench-market-image' },
      // 钉址：连接只用判过的地址，不再解析（防 DNS 重绑定）；连接层要整组地址时也只给这一个
      lookup: (_h: string, o: { all?: boolean } | number | undefined, cb: (e: Error | null, a: unknown, f?: number) => void) =>
        (typeof o === 'object' && o?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
      timeout: IMAGE_LIMITS.timeoutMs,
    } as never, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) { res.resume(); return reject(new ImageError(502, 'image_fetch_failed', status >= 300 && status < 400 ? '图片地址要跳转，不跟' : `图片地址回了 ${status}`)); }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!TYPES.has(type)) { res.resume(); return reject(new ImageError(415, 'image_type_unsupported', '只认 PNG、JPEG、WebP、GIF')); }
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > IMAGE_LIMITS.bytes) { req.destroy(); reject(new ImageError(502, 'image_too_large', '图片超过 5 MB')); } else chunks.push(c); });
      res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
      res.on('error', () => reject(new ImageError(502, 'image_fetch_failed', '图片取到一半断了')));
    });
    const deadline = setTimeout(() => { req.destroy(); reject(new ImageError(504, 'image_timeout', '取图超时')); }, IMAGE_LIMITS.timeoutMs);
    req.on('timeout', () => { req.destroy(); reject(new ImageError(504, 'image_timeout', '取图超时')); });
    req.on('error', (e) => reject(e instanceof ImageError ? e : new ImageError(502, 'image_fetch_failed', '图片取不到')));
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

/** 取一张图（路由已判过权）。出错抛 ImageError */
export async function fetchImage(ref: string, galleryBase: string | null, now = Date.now()): Promise<Got> {
  const u = resolveImageRef(ref, galleryBase);
  const key = u.href;
  const hit = fromCache(key, now);
  if (hit) return hit;
  if (outboundOff()) throw new ImageError(503, 'image_outbound_off', '图片暂不可用（对外已断开）');
  if (running >= IMAGE_LIMITS.concurrent) throw new ImageError(503, 'image_busy', '取图的人太多，稍后再试');
  running++;
  try {
    // 解析也算在 10 秒里：慢解析器不能一直占着并发名额
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pin = await Promise.race([pinAddress(u, galleryBase), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new ImageError(504, 'image_timeout', '解析图片地址超时')), IMAGE_LIMITS.timeoutMs); })]).finally(() => clearTimeout(timer));
    const got = await get(u, pin);
    toCache(key, got, now);
    return got;
  } finally { running--; }
}