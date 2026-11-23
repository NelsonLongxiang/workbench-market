#!/usr/bin/env node
/**
 * 图片第 1 步 PR A（docs/image-step1.md）：图片列的写入与查询限制、图片代取路由。
 * 起隔离实例（假的登录提供方，NODE_ENV=test，起法照 scripts/bench-report-test.mjs）；本测试自己在本机回环上起一个假图库，
 * WM_IMAGE_GALLERY_BASE 指过去。全是合成数据，不访问外网。
 *
 *   I1 写图片列：完整 http(s) 链接、图库相对路径能写；ftp:、javascript:、..、以 / 开头、带账号口令、超长报 400
 *   I2 查询：图片列只能判空、计数；按值筛选、分组、min/max、排序报 400
 *   I3 代取判权：匿名 401、管理口令 403、跨站 403、台上没授予 403——这几种图库都没收到请求；只有 render、只有 report-read 的人都取得到
 *   I4 代取结果：PNG 原样转出并带 nosniff、sandbox；text/html 415；302 502；超过 5 MB 502；超时 504
 *   I5 唯一保留的防护：完整链接指向回环（不是图库那台）、链路本地、私网 400；指向图库那台主机照取
 *   I6 不转发读者的请求头：图库收到的请求里没有 Cookie、Authorization、Referer、X-Forwarded-For
 *   I7 缓存：同一张图第二次不再请求图库；缓存命中时没权限的人仍是 403
 *   I8 对外断开（WM_OUTBOUND=off）：503
 *
 *   node scripts/bench-image-test.mjs
 */
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `bench-image-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN = 'synthetic-image-admin-token';
const REMOTE = { 'x-forwarded-for': '192.0.2.63' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createNetServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

// —— 假图库：记下每个请求的路径和请求头 ——
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d3c3b4a90000000049454e44ae426082', 'hex');
const hits = [];
const gallery = createHttpServer((req, res) => {
  hits.push({ path: req.url, headers: req.headers });
  const u = req.url;
  if (u === '/photos/a.png' || u === '/photos/c.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); return void res.end(PNG); }
  if (u === '/photos/page.html') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<script>alert(1)</script>'); }
  if (u === '/photos/redirect.png') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return void res.end(); }
  if (u === '/photos/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); return void res.end(Buffer.alloc(6 * 1024 * 1024)); }
  if (u === '/photos/slow.png') { const t = setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); } }, 12_000); res.on('close', () => clearTimeout(t)); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => gallery.listen(0, '127.0.0.1', r));
const GPORT = gallery.address().port;
const GBASE = `http://127.0.0.1:${GPORT}/`;
const hitsOf = (p) => hits.filter((h) => h.path === p).length;

const running = [];
async function boot(name, extraEnv = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN: ADMIN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin', WM_EXTENSIONS_DIR: ext, WM_BENCH_VIEWS: 'on', WM_IMAGE_GALLERY_BASE: GBASE, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => { if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); } if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); } };
  if (!ready) { await stop(); throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  const call = async (method, path, { headers = {}, body, raw, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (raw !== undefined || body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* 不是 JSON */ }
      return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), json };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null, buf: Buffer.alloc(0), headers: new Headers() }; }
  };
  const srv = { name, base, host: new URL(base).host, data, stop, call, db: () => new DatabaseSync(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}

try {
  const srv = await boot('on');
  const db = srv.db();
  const P = { boss: SESSIONS.alpha, member: SESSIONS.beta };
  for (const s of Object.values(P)) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const boss = who(P.boss), member = who(P.member);
  const cli = (method, path, body) => srv.call(method, path, body === undefined ? {} : { body });
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { reason: '合成：图片', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); const a = await srv.call('POST', `/api/grants/${id}/approve`); return a.status === 200; };
  const revokeAll = async (role) => { for (const g of db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = ? AND status = 'active'").all(role)) await cli('POST', `/api/grants/${g.id}/revoke`, { reason: '合成：用完收回' }); };
  const bv = (opts, method, path, body) => srv.call(method, `/api/bench-views${path}`, { ...opts, ...(body === undefined ? {} : { body }) });
  const img = (opts, u, slug = 'synth-img') => srv.call('GET', `/api/bench-views/${slug}/image?u=${encodeURIComponent(u)}`, opts);

  const g1 = await activate({ principal: 'user:alpha', role: 'management', scope: '*' });
  const mk = await bv(boss, 'POST', '', { slug: 'synth-img', title: '合成图片台' });
  const ds = await bv(boss, 'PUT', '/synth-img/datasets/pics', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }, { name: 'name', type: 'text', label: '名字' }] });
  check(g1 && mk.status === 201 && ds.status === 200, '（准备）管理层；台；数据集带一列 image', { g1, mk: mk.status, ds: [ds.status, ds.text.slice(0, 160)] });

  console.log('I1 写图片列');
  {
    const rows = (data, op = 'replace') => srv.call('POST', `/api/bench-views/synth-img/datasets/pics/rows?op=${op}`, { ...boss, raw: JSON.stringify(data) });
    const ok = await rows([{ id: 1, pic: 'https://example.com/a.png', name: '甲' }, { id: 2, pic: 'photos/a.png', name: '乙' }, { id: 3, pic: null, name: '丙' }]);
    const bad = {};
    for (const [k, v] of Object.entries({ ftp: 'ftp://example.com/a.png', js: 'javascript:alert(1)', dotdot: 'photos/../a.png', enc: 'photos/%2e%2e/a.png', slash: '/abs.png', userinfo: 'https://u:p@example.com/a.png', long: 'a'.repeat(2049), space: 'photos/a b.png', num: 7 })) bad[k] = (await rows([{ id: 9, pic: v, name: 'x' }], 'upsert')).status;
    check(ok.status === 200, 'I1 完整 https 链接、图库相对路径、空值都能写', { ok: [ok.status, ok.text.slice(0, 160)] });
    check(Object.values(bad).every((s) => s === 400), 'I1 ftp:、javascript:、..（含编码的 %2e%2e）、以 / 开头、带账号口令、超长、带空白、非文本：都 400', bad);
  }

  console.log('I2 查询');
  {
    const q = (query) => bv(boss, 'POST', '/synth-img/query', { query: { dataset: 'pics', ...query } });
    const r = {
      eq: (await q({ filter: [{ col: 'pic', op: 'eq', value: 'photos/a.png' }] })).status,
      contains: (await q({ filter: [{ col: 'pic', op: 'contains', value: 'a' }] })).status,
      notnull: (await q({ filter: [{ col: 'pic', op: 'not_null' }] })).status,
      group: (await q({ group: ['pic'], measures: [{ as: 'n', fn: 'count' }] })).status,
      max: (await q({ measures: [{ as: 'm', fn: 'max', col: 'pic' }] })).status,
      cd: (await q({ measures: [{ as: 'n', fn: 'count_distinct', col: 'pic' }] })).status,
      sort: (await q({ sort: [{ col: 'pic' }] })).status,
      select: (await q({ select: ['id', 'pic'] })).status,
    };
    check(r.eq === 400 && r.contains === 400 && r.group === 400 && r.max === 400 && r.sort === 400, 'I2 图片列按值筛选、contains、分组、max、排序：400', r);
    check(r.notnull === 200 && r.cd === 200 && r.select === 200, 'I2 图片列判空、count_distinct、选出来：200', r);
  }

  console.log('I3 代取判权');
  {
    const before = hitsOf('/photos/a.png');
    const anon = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png', { headers: REMOTE });
    const tok = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png', { headers: { ...REMOTE, 'x-admin-token': ADMIN } });
    const cross = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png', { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: P.boss });
    const mem = await img(member, 'photos/a.png');
    const after = hitsOf('/photos/a.png');
    check(anon.status === 401 && tok.status === 403 && cross.status === 403 && mem.status === 403 && after === before,
      'I3 匿名 401、管理口令 403、跨站 403、台上没授予 403；这几种图库都没收到请求', { anon: anon.status, tok: tok.status, cross: cross.status, mem: mem.status, hits: [before, after] });
    // 只有 render（自定义角色）、只有 report-read（自定义角色）
    await cli('POST', '/api/roles/guest/copy', { id: 'img-render-only', name: '合成·只看台' });
    await cli('PUT', '/api/roles/img-render-only', { permissions: [{ actions: ['bench-store.render'] }] });
    await cli('POST', '/api/roles/img-render-only/approve');
    await cli('POST', '/api/roles/guest/copy', { id: 'img-report-only', name: '合成·只读报告' });
    await cli('PUT', '/api/roles/img-report-only', { permissions: [{ actions: ['bench-store.report-read'] }] });
    await cli('POST', '/api/roles/img-report-only/approve');
    const ga = await activate({ principal: 'user:beta', role: 'img-render-only', scope: '*' });
    const viaRender = await img(member, 'photos/a.png');
    await revokeAll('img-render-only');
    const gb = await activate({ principal: 'user:beta', role: 'img-report-only', scope: '*' });
    const viaReport = await img(member, 'photos/a.png');
    const renderNow = await bv(member, 'GET', '/synth-img/render');
    await revokeAll('img-report-only');
    const gone = await img(member, 'photos/a.png');
    check(ga && gb && viaRender.status === 200 && viaReport.status === 200 && renderNow.status === 403 && gone.status === 403,
      'I3 只有 render 的人、只有 report-read 的人（看不了台）都取得到图；收回后 403', { ga, gb, viaRender: viaRender.status, viaReport: viaReport.status, renderNow: renderNow.status, gone: gone.status });
  }

  console.log('I4 代取结果');
  {
    const ok = await img(boss, 'photos/a.png');
    check(ok.status === 200 && ok.buf.equals(PNG) && ok.headers.get('content-type') === 'image/png' && ok.headers.get('x-content-type-options') === 'nosniff'
        && ok.headers.get('content-security-policy') === "default-src 'none'; sandbox" && ok.headers.get('cache-control') === 'private, max-age=300' && ok.headers.get('referrer-policy') === 'no-referrer',
      'I4 PNG：200，字节一致，带 nosniff、sandbox、private 缓存、no-referrer', { status: ok.status, type: ok.headers.get('content-type'), csp: ok.headers.get('content-security-policy'), cc: ok.headers.get('cache-control') });
    const html = await img(boss, 'photos/page.html');
    const redirect = await img(boss, 'photos/redirect.png');
    const big = await img(boss, 'photos/big.png');
    const missing = await img(boss, 'photos/none.png');
    check(html.status === 415 && !html.text.includes('<script>') && redirect.status === 502 && big.status === 502 && missing.status === 502,
      'I4 text/html 415 且不转出内容；302 不跟 502；超过 5 MB 502；图库 404 502', { html: html.status, redirect: redirect.status, big: big.status, missing: missing.status });
    const t0 = Date.now();
    const slow = await img(boss, 'photos/slow.png');
    const took = Date.now() - t0;
    check(slow.status === 504 && took < 12_000, 'I4 图库 10 秒不回：504，不一直等', { slow: slow.status, took });
  }

  console.log('I5 唯一保留的防护');
  {
    const r = {
      loop: (await img(boss, 'http://127.0.0.1:1/a.png')).status,
      meta: (await img(boss, 'http://169.254.169.254/latest/meta-data')).status,
      priv: (await img(boss, 'http://10.0.0.1/a.png')).status,
      v6: (await img(boss, 'http://[::1]:1/a.png')).status,
      gallery: (await img(boss, `${GBASE}photos/a.png`)).status,
    };
    check(r.loop === 400 && r.meta === 400 && r.priv === 400 && r.v6 === 400, 'I5 完整链接指向回环（不是图库那台）、链路本地、私网、IPv6 回环：400', r);
    check(r.gallery === 200, 'I5 完整链接指向图库那台主机：照取', r);
  }

  console.log('I6 不转发读者的请求头');
  {
    const n = hits.length;
    await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fc.png', { headers: { ...REMOTE, ...same, authorization: 'Bearer synthetic', referer: 'http://example.test/x' }, session: P.boss });
    const h = hits.slice(n).find((x) => x.path === '/photos/c.png')?.headers ?? {};
    check(hits.length === n + 1 && !h.cookie && !h.authorization && !h.referer && !h['x-forwarded-for'], 'I6 图库收到的请求里没有 Cookie、Authorization、Referer、X-Forwarded-For', { got: Object.keys(h) });
  }

  console.log('I7 缓存');
  {
    const before = hitsOf('/photos/c.png');
    const again = await img(boss, 'photos/c.png');
    const mem = await img(member, 'photos/c.png');
    check(again.status === 200 && hitsOf('/photos/c.png') === before && mem.status === 403, 'I7 第二次取同一张图不再请求图库；缓存命中时没权限的人仍 403', { again: again.status, hits: [before, hitsOf('/photos/c.png')], mem: mem.status });
  }

  await srv.stop();
  console.log('I8 对外断开');
  {
    const off = await boot('off', { WM_OUTBOUND: 'off' });
    const odb = off.db();
    await off.call('GET', '/api/auth/viewer', { session: P.boss });
    const d = await off.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成' } });
    await off.call('POST', `/api/grants/${d.json?.grant?.id}/submit`); await off.call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const ob = { headers: { ...REMOTE, origin: `http://${off.host}`, 'sec-fetch-site': 'same-origin' }, session: P.boss };
    await off.call('POST', '/api/bench-views', { ...ob, body: { slug: 'synth-off', title: '合成断开台' } });
    const before = hits.length;
    const r = await off.call('GET', '/api/bench-views/synth-off/image?u=photos%2Fa.png', ob);
    check(r.status === 503 && hits.length === before, 'I8 WM_OUTBOUND=off：503，图库没收到请求', { r: [r.status, r.text.slice(0, 120)], hits: [before, hits.length] });
    odb.close();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  gallery.close();
  rmSync(OUT, { recursive: true, force: true });
  console.log(`bench-image-test: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
