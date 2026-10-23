/**
 * ESM 解析垫片：把 @deepseek-ai/* 与 @nelsonlongxiang/* 解析到 dsh-open-a2a-net 的 node_modules。
 * 原因：npm 上的新版 @deepseek-ai/dsh-tools 依赖未发布的 @deepseek-ai/dsh-type-meta；
 * 上游检出里有一套完整可用的安装，且与插件 lib 用的是同一物理路径（同一份模块实例）。
 * 用法：node --import ./scripts/a2a-peer-loader.mjs scripts/a2a-peer.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const UPSTREAM_PKG = 'D:/workspace/dsh-open-a2a-net/package.json';

const hookSource = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const upstreamRequire = createRequire(${JSON.stringify(UPSTREAM_PKG)});
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@nelsonlongxiang/')) {
    try {
      return { url: pathToFileURL(upstreamRequire.resolve(specifier)).href, shortCircuit: true };
    } catch { /* 让默认解析接手 */ }
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hookSource)}`);
void pathToFileURL;
