#!/usr/bin/env node
/**
 * 出自产台页面 HTML 的单测（阶段八 8f-2，server/src/app-html.ts）。不起服务，换上会抛错的依赖，看请求一定有应答：
 *   · 出票抛错：页面照常返回，不带票据，缓存头照旧，不算回落
 *   · 认人抛错：当认不出，页面照常返回，不带票据
 *   · 拼页面（登录门改写）抛错：回到原样页面（sendFile），记一笔回落
 *   · 历史版本：不认人、不出票
 *   · 正常：带票据，private, no-store、Vary: Cookie
 *
 *   node scripts/app-html-unit.mjs              测本仓库
 *   node scripts/app-html-unit.mjs --root DIR   测另一棵目录树
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const { serveAppHtml } = await import(pathToFileURL(join(ROOT, 'server/src/app-html.ts')).href);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };

function fakeRes() {
  const r = { headers: {}, varies: [], sent: null, file: null, headersSent: false, type: null };
  return Object.assign(r, {
    setHeader(k, v) { r.headers[k.toLowerCase()] = v; return r; },
    vary(v) { r.varies.push(v); return r; },
    type(t) { r.type = t; return r; },
    send(b) { r.sent = String(b); r.headersSent = true; return r; },
    sendFile(f) { r.file = f; r.headersSent = true; return r; },
  });
}
const RAW = '<html><head><title>x</title></head><body>ok</body></html>';
const base = (over = {}) => {
  const calls = { person: 0, fallback: 0, issue: 0 };
  const deps = {
    person: async () => { calls.person++; return 'user:alpha'; },
    appToken: () => 'a'.repeat(64),
    workbenchId: () => '7',
    issueTicket: (p, s) => { calls.issue++; return `st1.${Buffer.from(p + '|' + s).toString('base64url')}.sig`; },
    rewrite: (_req, html) => html,
    countFallback: () => { calls.fallback++; },
    ...over,
  };
  return { deps, calls };
};
const run = async (over, input = {}) => {
  const { deps, calls } = base(typeof over === 'function' ? over() : over);
  const res = fakeRes();
  await serveAppHtml({}, res, { raw: RAW, abs: '/synthetic/index.html', slug: 'tka', current: true, ...input }, deps);
  return { res, calls };
};

{
  const { res, calls } = await run({});
  check(res.sent?.includes('name="wm-submitter-ticket"') && res.sent.includes('window.WM_SUBMITTER_TICKET=') && res.headers['cache-control'] === 'private, no-store' && res.varies.includes('Cookie') && calls.fallback === 0, '正常：带票据，private, no-store、Vary: Cookie');
}
{
  const { res, calls } = await run({ issueTicket: () => { throw new Error('出票故意抛错'); } });
  check(res.sent !== null && res.sent.includes('wm-app-token') && !res.sent.includes('wm-submitter-ticket') && !res.sent.includes('WM_SUBMITTER_TICKET') && res.headers['cache-control'] === undefined && res.file === null && calls.fallback === 0,
    '出票抛错：页面照常返回（有台令牌），不带票据，缓存头照旧，不算回落', JSON.stringify({ sent: res.sent?.slice(0, 80), cc: res.headers['cache-control'] }));
}
{
  const { res, calls } = await run({ person: async () => { throw new Error('认人故意抛错'); } });
  check(res.sent !== null && !res.sent.includes('wm-submitter-ticket') && calls.fallback === 0, '认人抛错：当认不出，页面照常返回，不带票据');
}
{
  const { res, calls } = await run({ rewrite: () => { throw new Error('改写故意抛错'); } });
  check(res.sent === null && res.file === '/synthetic/index.html' && calls.fallback === 1, '拼页面抛错：回到原样页面（sendFile），记一笔回落，请求不挂着', JSON.stringify({ file: res.file, fallback: calls.fallback }));
}
{
  const { res, calls } = await run({ countFallback: () => { throw new Error('计数故意抛错'); }, appToken: () => { throw new Error('令牌故意抛错'); } });
  check(res.file === '/synthetic/index.html', '回落时计数也抛错：照样回到原样页面');
}
{
  const { res, calls } = await run({}, { current: false });
  check(res.sent !== null && !res.sent.includes('wm-submitter-ticket') && calls.person === 0 && calls.issue === 0, '历史版本：不认人、不出票，页面照常');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
