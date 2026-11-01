/** Read-only active-version assets, not the legacy token-injecting app handler. */
import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';
export type StaticContentTarget = { url: string; root: string; version: number };
export const STATIC_TARGET = /^[/]apps[/][a-z0-9][a-z0-9-]{0,63}[/]$/;
const MIME: Record<string, string> = { '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2' };
/** Caller already enforced target/context/origin. Decode each resource segment once,
 * never normalize traversal into another asset or consult SPA/LayerFS/network fallback. */
export async function readStaticContent(target: StaticContentTarget, requestUrl: string, id: number, head: boolean) {
  const match = new RegExp('^/go/' + id + '(?:/|$)', 'i').exec(requestUrl.split('?')[0]);
  if (!match || !STATIC_TARGET.test(target.url) || !Number.isSafeInteger(target.version) || target.version < 1) return null;
  let path = requestUrl.split('?')[0].slice(match[0].length);
  if (!path || path.endsWith('/')) path += 'index.html';
  let segments: string[];
  try { segments = path.split('/').map(s => decodeURIComponent(s)); } catch { return null; }
  if (segments.some(s => !s || s === '.' || s === '..' || s.startsWith('.') || /[\\/:?#%\x00-\x1f\x7f]/.test(s))) return null;
  try {
    const root = resolve(target.root);
    if ((await lstat(root)).isSymbolicLink()) return null;
    const realRoot = await realpath(root);
    let file = root;
    for (const segment of segments) { file = resolve(file, segment); if ((await lstat(file)).isSymbolicLink()) return null; }
    const realFile = await realpath(file), rel = relative(realRoot, realFile);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(realRoot, rel) !== realFile) return null;
    const handle = await open(realFile, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
      let body: Buffer | null = null;
      if (!head) {
        // Bound reads even if a local writer grows the file after stat().
        const chunks: Buffer[] = []; let bytes = 0;
        while (true) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, 8 * 1024 * 1024 + 1 - bytes));
          const read = await handle.read(chunk, 0, chunk.length, null);
          if (!read.bytesRead) break;
          bytes += read.bytesRead; if (bytes > 8 * 1024 * 1024) return null;
          chunks.push(chunk.subarray(0, read.bytesRead));
        }
        body = Buffer.concat(chunks, bytes);
        if (bytes !== stat.size) return null; // changed snapshot: never send a stale Content-Length
      }
      return { body, size: stat.size, mime: MIME[extname(realFile).toLowerCase()] ?? 'application/octet-stream', version: target.version };
    } finally { await handle.close(); }
  } catch { return null; }
}
