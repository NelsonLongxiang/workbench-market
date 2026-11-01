#!/usr/bin/env node
/** #321 设计 token 出口回归（独立实例、合成数据）：
 *  HTTP：/design/tokens@1.css（no-cache）与 @1.0.0（immutable）内容与 web/src/tokens.css 一致、其他版本 404；
 *        SOP 执行页内联同一份变量，页面自有样式不再写死色值。
 *  浏览器（Python Playwright，PYTHON 指定解释器；SKIP_BROWSER=1 只跑 HTTP 部分）：执行页与市场前端同主色/次级文字色/字号/字体；
 *        示例自产台（docs/examples/self-built-tokens.html）正文、状态、面与线全部取变量。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const TMP = resolve('tmp/tokens-surface-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN = 'synthetic-tokens-admin';
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: ADMIN };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const adm = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
};
const tokensFile = readFileSync('web/src/tokens.css', 'utf8');
const version = /--wm-version:\s*"([\d.]+)"/.exec(tokensFile)[1];
const major = version.split('.')[0];
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const r1 = await fetch(`${base}/design/tokens@${major}.css`);
  const b1 = await r1.text();
  ok(`/design/tokens@${major}.css → 200 text/css，内容 = web/src/tokens.css`, r1.status === 200 && /text\/css/.test(r1.headers.get('content-type') ?? '') && b1 === tokensFile);
  ok('主版本路径 no-cache（值更新后生效）+ nosniff + 版本头', r1.headers.get('cache-control') === 'no-cache' && r1.headers.get('x-content-type-options') === 'nosniff' && r1.headers.get('x-wm-tokens-version') === version);
  const r2 = await fetch(`${base}/design/tokens@${version}.css`);
  ok(`/design/tokens@${version}.css → 200 且 immutable 长缓存`, r2.status === 200 && /immutable/.test(r2.headers.get('cache-control') ?? '') && (await r2.text()) === tokensFile);
  for (const v of [String(Number(major) + 1), `${major}.0`, `${major}.0.99`, '0']) {
    ok(`其他版本 tokens@${v}.css → 404`, (await fetch(`${base}/design/tokens@${v}.css`)).status === 404);
  }
  ok('不在固定路径下的 /design/tokens.css 不被 SPA 兜成 200 HTML', !/text\/html/.test((await fetch(`${base}/design/tokens.css`)).headers.get('content-type') ?? '') );

  await adm('POST', '/api/apps', { slug: 'tokens-sop', kind: 'sop', title: 'Token SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: Token SOP\nsteps:\n  - key: a\n    title: 第一步\n    body: <p class="muted">说明</p><input data-field="a">\n' }] });
  await adm('POST', '/api/sops/tokens-sop/publish', {});
  const html = await (await fetch(`${base}/sop/tokens-sop/`)).text();
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  ok('执行页内联同一份 --wm-* 变量', styles.length >= 2 && styles[0].includes('--wm-color-primary:') && styles[0].trim() === tokensFile.trim());
  const own = styles.slice(1).join('\n').replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里的 issue 号（#321）不算色值
  const literals = own.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
  ok('执行页自有样式不写死色值（只用变量）', styles.length >= 2 && own.trim().length > 0 && literals.length === 0, JSON.stringify(literals));
  ok('执行页样式取 var(--wm-*)', /var\(--wm-color-primary\)/.test(own) && /var\(--wm-font-sans\)/.test(own) && /var\(--wm-color-nav-bg\)/.test(own));
  const scriptPart = html.slice(html.indexOf('<script>'));
  ok('执行页脚本里也不再用内联色值', !/#[0-9a-fA-F]{6}\b/.test(scriptPart.replace(/\/\/[^\n]*/g, '')));

  await adm('POST', '/api/apps', { slug: 'tokens-demo', kind: 'app', title: '自产台 token 示例', changelog: 'x', files: [{ path: 'index.html', content: readFileSync('docs/examples/self-built-tokens.html', 'utf8') }] });
  if (process.env.SKIP_BROWSER === '1') {
    console.log('  - 浏览器部分已跳过（SKIP_BROWSER=1）');
  } else {
    if (!existsSync('web/dist/index.html')) throw new Error('缺 web/dist：先跑 pnpm --filter web build（或 SKIP_BROWSER=1）');
    const cfg = join(TMP, 'browser.json');
    writeFileSync(cfg, JSON.stringify({ base }));
    const py = spawn(process.env.PYTHON || 'python3', ['scripts/tokens-surface-browser.py', cfg], { stdio: 'inherit' });
    const code = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
    if (code) fail++;
  }
} catch (e) {
  fail++; console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 300));
  if (fail && serverErr) console.log(serverErr.slice(-1200));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`tokens-surface-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
