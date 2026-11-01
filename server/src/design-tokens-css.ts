/** #321 设计 token 的服务端出口：读 DESIGN.md 生成的 web/src/tokens.css（scripts/gen-design-tokens.mjs 产物），
 *  给 SOP 执行页内联、给自产台以带版本号的固定路径下载（DESIGN.md「CSS 变量契约」：名字稳定、值可变）。
 *  按 mtime 缓存；文件不在时返回 null，调用方降级（执行页照常渲染，只是没有变量值）。 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOKENS_CSS_REL = 'web/src/tokens.css';

export interface TokensCss { css: string; version: string; major: string }
let cache: { path: string; mtimeMs: number; value: TokensCss } | null = null;

export function loadTokensCss(root = ROOT): TokensCss | null {
  const path = join(root, TOKENS_CSS_REL);
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.value;
  const css = readFileSync(path, 'utf8');
  const m = /--wm-version:\s*"(\d+)\.(\d+)\.(\d+)"/.exec(css);
  if (!m) return null;
  const value = { css, version: `${m[1]}.${m[2]}.${m[3]}`, major: m[1] };
  cache = { path, mtimeMs, value };
  return value;
}

/** 固定路径：/design/tokens@<主版本>.css（推荐，主版本内名字稳定）与 /design/tokens@<完整版本>.css（精确钉版本）。
 *  其他版本一律 404——只提供当前这一份，不猜。 */
export function resolveTokensPath(pathname: string, t: TokensCss): 'major' | 'exact' | null {
  const m = /^\/design\/tokens@([0-9.]+)\.css$/.exec(pathname);
  if (!m) return null;
  if (m[1] === t.major) return 'major';
  if (m[1] === t.version) return 'exact';
  return null;
}
