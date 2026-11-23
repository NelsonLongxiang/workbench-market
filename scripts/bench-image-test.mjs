#!/usr/bin/env node
/**
 * 图片第 1 步 PR A（docs/image-step1.md）：图片列的写入与查询限制、图片代取路由。
 * 起隔离实例（假的登录提供方，NODE_ENV=test，起法照 scripts/bench-report-test.mjs）；本测试自己在本机回环上起一个假图库，
 * WM_IMAGE_GALLERY_BASE 指过去。全是合成数据，不访问外网。
 *
 *   I1 写图片列：完整 http(s) 链接、图库相对路径能写；ftp:、javascript:、..、以 / 开头、带账号口令、超长报 400
 *   I2 查询：图片列只能判空、计数；按值筛选、分组、min/max、排序报 400
 *   I3 代取判权：匿名 401、管理口令 403、跨站 403、台上没授予 403、只有 report-read 或 report-respond（读不了视图）403——这几种图库都没收到请求；只有 render 的人取得到
 *   I10 Q9 按引用判：来源视图不在路径里的台、视图里没这条链接、视图不存在、视图不显示图片列，都 403 且不外发；缓存命中也照判
 *   I4 代取结果：PNG 原样转出并带 nosniff、sandbox；JPEG、WebP（VP8X、VP8L）照转；GIF、SVG、text/html、头写 PNG 内容不是 PNG 都 415；超过 4000 万像素 502；302 502；超过 5 MB 502；超时 504
 *   I5 唯一保留的防护：完整链接指向回环（不在图库前缀下）、链路本地、私网、文档网段 400；在图库前缀下照取；地址分类照 url-admission.ts，只认公网
 *   I6 不转发读者的请求头：图库收到的请求里没有 Cookie、Authorization、Referer、X-Forwarded-For
 *   I7 缓存：同一张图第二次不再请求图库；缓存命中时没权限的人仍是 403
 *   I8 对外断开（WM_OUTBOUND=off）：503
 *   I9 钉址与混合解析（本进程直接调 fetchImage，桩 DNS，连接层只放行回环）：DNS 重绑定不访问回环服务；公网与回环混合解析 400；慢解析 504；钉址 lookup 两种调用都只给判过的地址
 *
 *   node scripts/bench-image-test.mjs
 */
import net, { createServer as createNetServer } from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
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
// 只解析文件头就能读出宽高的几种合成图（不解码，字节固定）
const webpX = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'latin1'); b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const webpL = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8L', 'latin1'), Buffer.from([10, 0, 0, 0, 0x2f, 0x02, 0x00, 0x01, 0x00]), Buffer.alloc(5)]); // 3×5
const hugePng = Buffer.from(PNG); hugePng.writeUInt32BE(8000, 16); hugePng.writeUInt32BE(8000, 20); // 6400 万像素
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108000300040301220002110103110001ffd9', 'hex'); // 4×3
const GALLERY = {
  '/photos/b.png': ['image/png', PNG], '/photos/d.png': ['image/png', PNG], '/photos/only2.png': ['image/png', PNG],
  '/photos/a.jpg': ['image/jpeg', JPG], '/photos/a.webp': ['image/webp', webpX(2, 3)], '/photos/vp8l.webp': ['image/webp', webpL],
  '/photos/huge.png': ['image/png', hugePng], '/photos/huge.webp': ['image/webp', webpX(10000, 5000)],
  '/photos/anim.gif': ['image/gif', Buffer.from('474946383961010001000000002c00000000010001000002003b', 'hex')],
  '/photos/fake.png': ['image/png', Buffer.from('<html><script>alert(1)</script></html>')],
};
const gallery = createHttpServer((req, res) => {
  hits.push({ path: req.url, headers: req.headers });
  const u = req.url;
  if (GALLERY[u]) { const [type, body] = GALLERY[u]; res.writeHead(200, { 'content-type': type, 'content-length': body.length }); return void res.end(body); }
  if (u === '/photos/a.png' || u === '/photos/c.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); return void res.end(PNG); }
  if (u === '/photos/page.html') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<script>alert(1)</script>'); }
  if (u === '/photos/redirect.png') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return void res.end(); }
  if (u === '/photos/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); return void res.end(Buffer.alloc(6 * 1024 * 1024)); }
  if (u === '/photos/vec.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return void res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
  // 每 0.5 秒滴 1 字节，共 15 秒：连接一直有动静，只有整体 10 秒截止挡得住
  if (u === '/photos/drip.png') { res.writeHead(200, { 'content-type': 'image/png' }); let n = 0; const t = setInterval(() => { if (res.destroyed || n++ >= 30) { clearInterval(t); if (!res.destroyed) res.end(); return; } res.write(Buffer.from([0])); }, 500); res.on('close', () => clearInterval(t)); return; }
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
  // Q9 按引用判：每次都带来源视图（缺省 pics，显示图片列）
  const img = (opts, u, slug = 'synth-img', view = 'pics') => srv.call('GET', `/api/bench-views/${slug}/image?u=${encodeURIComponent(u)}&view=${view}`, opts);

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

  // Q9 按引用判：图片要出现在来源视图里才取得到。把测试用到的链接都写进图片列；视图 pics 显示整张表，noimg 不显示图片列
  {
    const REFS = ['photos/b.png', 'photos/c.png', 'photos/d.png', 'photos/page.html', 'photos/redirect.png', 'photos/big.png', 'photos/none.png', 'photos/vec.svg', 'photos/drip.png', 'photos/slow.png',
      'photos/anim.gif', 'photos/fake.png', 'photos/huge.png', 'photos/a.jpg', 'photos/a.webp', 'photos/vp8l.webp', 'photos/huge.webp', 'photos/only2.png',
      'http://127.0.0.1:1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/a.png', 'http://[::1]:1/a.png', 'http://192.0.2.1/a.png',
      `${GBASE}photos/a.png`, `${GBASE}..%2fsecret`, `${GBASE}photos/..%2F..%2Fsecret`];
    // only2.png 只给第二个台用：本台不写它
    const up = await srv.call('POST', '/api/bench-views/synth-img/datasets/pics/rows?op=upsert', { ...boss, raw: JSON.stringify(REFS.filter((x) => x !== 'photos/only2.png').map((pic, i) => ({ id: 100 + i, pic, name: `图${i}` }))) });
    const vw = await bv(boss, 'PUT', '/synth-img/view', { doc: { title: '合成图片台', views: [
      { key: 'pics', title: '图片', blocks: [{ type: 'table', query: { dataset: 'pics', sort: [{ col: 'id' }] } }] },
      { key: 'noimg', title: '不显示图片', blocks: [{ type: 'table', query: { dataset: 'pics', select: ['id', 'name'], sort: [{ col: 'id' }] } }] }] }, base: 0, note: '合成' });
    check(up.status === 200 && vw.status === 200, '（准备）用到的链接写进图片列；视图 pics 显示图片列、noimg 不显示', { up: [up.status, up.text.slice(0, 160)], vw: [vw.status, vw.text.slice(0, 200)] });
  }

  console.log('I3 代取判权');
  {
    const before = hitsOf('/photos/a.png');
    const anon = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png&view=pics', { headers: REMOTE });
    const tok = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png&view=pics', { headers: { ...REMOTE, 'x-admin-token': ADMIN } });
    const cross = await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fa.png&view=pics', { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: P.boss });
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
    const hd = hitsOf('/photos/d.png');
    const viaReport = await img(member, 'photos/d.png');
    const reportHits = hitsOf('/photos/d.png') - hd;
    const renderNow = await bv(member, 'GET', '/synth-img/render');
    await revokeAll('img-report-only');
    const gone = await img(member, 'photos/a.png');
    await cli('POST', '/api/roles/guest/copy', { id: 'img-respond-only', name: '合成·只回应报告' });
    await cli('PUT', '/api/roles/img-respond-only', { permissions: [{ actions: ['bench-store.report-respond'] }] });
    await cli('POST', '/api/roles/img-respond-only/approve');
    const gc = await activate({ principal: 'user:beta', role: 'img-respond-only', scope: '*' });
    const h0 = hitsOf('/photos/b.png');
    const viaRespond = await img(member, 'photos/b.png');
    await revokeAll('img-respond-only');
    check(gc && viaRespond.status === 403 && hitsOf('/photos/b.png') === h0, 'I3 只有 report-respond 的人：403，图库收到的请求数为 0', { gc, viaRespond: viaRespond.status, hits: [h0, hitsOf('/photos/b.png')] });
    check(ga && gb && viaRender.status === 200 && viaReport.status === 403 && reportHits === 0 && renderNow.status === 403 && gone.status === 403,
      'I3 只有 render 的人取得到图；只有 report-read 的人读不了来源视图：403，图库没收到（报告作来源随 PR C）；收回后 403', { reportHits, ga, gb, viaRender: viaRender.status, viaReport: viaReport.status, renderNow: renderNow.status, gone: gone.status });
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
    const fmt = { jpg: await img(boss, 'photos/a.jpg'), webp: await img(boss, 'photos/a.webp'), vp8l: await img(boss, 'photos/vp8l.webp') };
    check(fmt.jpg.status === 200 && fmt.jpg.buf.equals(JPG) && fmt.webp.status === 200 && fmt.vp8l.status === 200, 'I4 JPEG、WebP（VP8X、VP8L）：200', { jpg: fmt.jpg.status, webp: fmt.webp.status, vp8l: fmt.vp8l.status });
    const gif = await img(boss, 'photos/anim.gif');
    const fake = await img(boss, 'photos/fake.png');
    check(gif.status === 415 && gif.json?.error === 'image_type_unsupported' && fake.status === 415 && fake.json?.error === 'image_unreadable' && !fake.text.includes('<script>'),
      'I4 GIF 415（Q4 不收）；头写 image/png、内容不是 PNG：415 image_unreadable，不转出内容', { gif: [gif.status, gif.json?.error], fake: [fake.status, fake.json?.error] });
    const hugeP = await img(boss, 'photos/huge.png');
    const hugeW = await img(boss, 'photos/huge.webp');
    check(hugeP.status === 502 && hugeP.json?.error === 'image_too_many_pixels' && hugeW.status === 502 && hugeW.json?.error === 'image_too_many_pixels',
      'I4 超过 4000 万像素（PNG 8000×8000、WebP 10000×5000）：502 image_too_many_pixels（Q2）', { hugeP: [hugeP.status, hugeP.json?.error], hugeW: [hugeW.status, hugeW.json?.error] });
    const svg = await img(boss, 'photos/vec.svg');
    check(svg.status === 415 && !svg.text.includes('<svg'), 'I4 image/svg+xml：415，不转出内容', { svg: svg.status });
    const d0 = Date.now();
    const drip = await img(boss, 'photos/drip.png');
    const dripTook = Date.now() - d0;
    check(drip.status === 504 && dripTook < 12_000, 'I4 图库一直滴字节、总时长超 10 秒：504（整体截止，不只是空闲超时）', { drip: drip.status, took: dripTook });
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
      doc: (await img(boss, 'http://192.0.2.1/a.png')).status,
      gallery: (await img(boss, `${GBASE}photos/a.png`)).status,
    };
    check(r.loop === 400 && r.meta === 400 && r.priv === 400 && r.v6 === 400 && r.doc === 400, 'I5 完整链接指向回环（不在图库前缀下）、链路本地、私网、IPv6 回环、文档网段：400', r);
    // 例外只认图库前缀，不认图库那台主机：前缀带子路径时，同主机前缀外的路径照样拒
    const { blockedAddress, underGallery } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'bench-image.ts')).href);
    const sub = 'http://127.0.0.1:8090/gallery/';
    const unit = { inPrefix: underGallery(new URL('http://127.0.0.1:8090/gallery/a.png'), sub), outPrefix: underGallery(new URL('http://127.0.0.1:8090/admin/x'), sub), unset: underGallery(new URL('http://127.0.0.1:8090/gallery/a.png'), null),
      pub4: blockedAddress('93.184.216.34'), pub6: blockedAddress('2606:4700::1'), ula: blockedAddress('fd00::1'), mapped: blockedAddress('::ffff:10.0.0.1'), bench: blockedAddress('198.18.0.1'), multi: blockedAddress('224.0.0.1') };
    check(unit.inPrefix && !unit.outPrefix && !unit.unset && !unit.pub4 && !unit.pub6 && unit.ula && unit.mapped && unit.bench && unit.multi,
      'I5 例外只认图库前缀（同主机前缀外不算）；公网 IPv4、IPv6 放行，ULA、映射私网、基准网段、组播都拒', unit);
    check(r.gallery === 200, 'I5 完整链接指向图库那台主机：照取', r);
    // %2e%2e 这种写法 URL 解析时就规范化掉了（拐不出前缀就仍在前缀下，拐出了就不再算图库、按内网地址拒）；这里只核解析不掉的 %2f
    const esc = { a: (await img(boss, `${GBASE}..%2fsecret`)).status, b: (await img(boss, `${GBASE}photos/..%2F..%2Fsecret`)).status };
    check(esc.a === 400 && esc.b === 400 && hits.every((h) => !String(h.path).toLowerCase().includes('secret')), 'I5 图库前缀下的完整链接也不许 ..、%2f 拐出前缀：400，图库没收到', esc);
  }

  console.log('I6 不转发读者的请求头');
  {
    const n = hits.length;
    await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fc.png&view=pics', { headers: { ...REMOTE, ...same, authorization: 'Bearer synthetic', referer: 'http://example.test/x' }, session: P.boss });
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

  console.log('I10 Q9 按引用判');
  {
    const mk2 = await bv(boss, 'POST', '', { slug: 'synth-img2', title: '合成图片台二' });
    const ds2 = await bv(boss, 'PUT', '/synth-img2/datasets/pics2', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }] });
    const rw2 = await srv.call('POST', '/api/bench-views/synth-img2/datasets/pics2/rows?op=replace', { ...boss, raw: JSON.stringify([{ id: 1, pic: 'photos/only2.png' }]) });
    const vw2 = await bv(boss, 'PUT', '/synth-img2/view', { doc: { title: '合成图片台二', views: [{ key: 'other', title: '二', blocks: [{ type: 'table', query: { dataset: 'pics2', sort: [{ col: 'id' }] } }] }] }, base: 0, note: '合成' });
    const h0 = hitsOf('/photos/only2.png'), z0 = hitsOf('/photos/zzz.png');
    const r = {
      otherBenchLink: (await img(boss, 'photos/only2.png')).status, // 链接只在别的台的视图里
      otherBenchView: (await img(boss, 'photos/only2.png', 'synth-img', 'other')).status, // 视图名只在别的台
      notReferenced: (await img(boss, 'photos/zzz.png')).status,
      noView: (await img(boss, 'photos/c.png', 'synth-img', 'nope')).status,
      hiddenCol: (await img(boss, 'photos/c.png', 'synth-img', 'noimg')).status,
      badVersion: (await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fc.png&view=pics&version=99', boss)).status,
    };
    const h1 = hitsOf('/photos/only2.png');
    check(Object.values(r).every((x) => x === 403) && h1 === h0 && hitsOf('/photos/zzz.png') === z0,
      'I10 来源不属于路径里的台、视图里没有这条链接、视图不存在、视图不显示图片列、版本不存在：都 403，图库收到的请求数为 0', { ...r, hits: [h0, h1] });
    const pos = await img(boss, 'photos/only2.png', 'synth-img2', 'other');
    check(mk2.status === 201 && ds2.status === 200 && rw2.status === 200 && vw2.status === 200 && pos.status === 200, 'I10 对照：同一条链接从它真正所在的台和视图取：200', { mk2: mk2.status, ds2: ds2.status, rw2: rw2.status, vw2: [vw2.status, vw2.text.slice(0, 120)], pos: pos.status });
    // 缓存命中照判：photos/c.png 已在缓存里
    const hc = hitsOf('/photos/c.png');
    const cached = { hidden: (await img(boss, 'photos/c.png', 'synth-img', 'noimg')).status };
    const gb = await activate({ principal: 'user:beta', role: 'img-report-only', scope: '*' });
    cached.reportOnly = (await img(member, 'photos/c.png')).status;
    await revokeAll('img-report-only');
    cached.ok = (await img(boss, 'photos/c.png')).status;
    check(gb && cached.hidden === 403 && cached.reportOnly === 403 && cached.ok === 200 && hitsOf('/photos/c.png') === hc,
      'I10 缓存命中时照判：视图不显示 403、读不了视图 403；有权且引用的照取（命中缓存，图库没收到新请求）', cached);
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
    // 按引用判过了才轮到对外断开：台上要有引用这条链接的视图
    await off.call('PUT', '/api/bench-views/synth-off/datasets/pics', { ...ob, body: { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }] } });
    await off.call('POST', '/api/bench-views/synth-off/datasets/pics/rows?op=replace', { ...ob, raw: JSON.stringify([{ id: 1, pic: 'photos/a.png' }]) });
    const ov = await off.call('PUT', '/api/bench-views/synth-off/view', { ...ob, body: { doc: { title: '合成断开台', views: [{ key: 'pics', title: '图片', blocks: [{ type: 'table', query: { dataset: 'pics', sort: [{ col: 'id' }] } }] }] }, base: 0, note: '合成' } });
    const before = hits.length;
    const r = await off.call('GET', '/api/bench-views/synth-off/image?u=photos%2Fa.png&view=pics', ob);
    check(ov.status === 200 && r.status === 503 && hits.length === before, 'I8 WM_OUTBOUND=off：503，图库没收到请求', { ov: ov.status, r: [r.status, r.text.slice(0, 120)], hits: [before, hits.length] });
    odb.close();
  }

  console.log('I9 钉址与混合解析');
  {
    // 本进程里直接调 fetchImage：判时的解析（dns/promises）和连接时的解析都换成桩；连接层只放行回环，别的地址一律在连之前拦下，不发出任何外网连接
    const { fetchImage, clearImageCache, pinnedLookup } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'bench-image.ts')).href);
    let inner = 0;
    const internal = createHttpServer((_req, res) => { inner++; res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); res.end(PNG); });
    await new Promise((r) => internal.listen(0, '127.0.0.1', r));
    const IPORT = internal.address().port;
    const PUB = '93.184.216.34';
    const judge = new Map([['rebind.image-test', [{ address: PUB, family: 4 }]], ['mixed.image-test', [{ address: PUB, family: 4 }, { address: '127.0.0.1', family: 4 }]], ['mixed2.image-test', [{ address: '127.0.0.1', family: 4 }, { address: PUB, family: 4 }]]]);
    const atConnect = new Map([['rebind.image-test', '127.0.0.1'], ['mixed.image-test', '127.0.0.1'], ['mixed2.image-test', '127.0.0.1']]);
    const answer = (addr, opt, cb) => (opt && typeof opt === 'object' && opt.all ? cb(null, [{ address: addr, family: net.isIP(addr) }]) : cb(null, addr, net.isIP(addr)));
    const realP = dns.promises.lookup, realConnect = net.Socket.prototype.connect;
    const outside = [];
    dns.promises.lookup = async (h, o) => {
      // 慢解析：12 秒后才给一个公网地址（解析也算在 10 秒里）
      if (h === 'slowdns.image-test') { await new Promise((r) => setTimeout(r, 12_000)); return o && o.all ? [{ address: PUB, family: 4 }] : { address: PUB, family: 4 }; }
      return judge.has(h) ? (o && o.all ? judge.get(h) : judge.get(h)[0]) : realP.call(dns.promises, h, o);
    };
    syncBuiltinESMExports();
    net.Socket.prototype.connect = function (...args) {
      const o = Array.isArray(args[0]) ? args[0][0] : (args[0] && typeof args[0] === 'object' ? args[0] : null);
      if (o && typeof o.host === 'string' && !o.path && net.isIP(o.host) === 0) {
        const base = o.lookup || ((h, opt, cb) => (atConnect.has(h) ? answer(atConnect.get(h), opt, cb) : dns.lookup(h, opt, cb)));
        o.lookup = (h, opt, cb) => base(h, opt, (err, a, f) => {
          if (err) return cb(err);
          const list = Array.isArray(a) ? a.map((x) => x.address) : [a];
          if (list.some((x) => x !== '127.0.0.1' && x !== '::1')) { outside.push(`${h}->${list.join(',')}`); return cb(Object.assign(new Error('测试：拦下非回环连接'), { code: 'ECONNREFUSED' })); }
          cb(null, a, f);
        });
      }
      return realConnect.apply(this, args);
    };
    const run = async (host) => { try { await fetchImage(`http://${host}:${IPORT}/x.png`, null); return 200; } catch (e) { return e?.http ?? String(e?.code ?? e); } };
    try {
      clearImageCache();
      const rebind = await run('rebind.image-test');
      const afterRebind = inner;
      const mixed = await run('mixed.image-test');
      const mixed2 = await run('mixed2.image-test');
      check(rebind !== 200 && afterRebind === 0 && outside.some((x) => x.startsWith('rebind.image-test->' + PUB)),
        'I9 DNS 重绑定（判时公网、连时回环）：连的是判过的公网地址（被测试拦下），回环上的内网服务 0 次被访问', { rebind, inner: afterRebind, outside });
      check(mixed === 400 && mixed2 === 400 && inner === 0, 'I9 解析结果公网与回环混合（两种顺序）：400，内网服务 0 次被访问', { mixed, mixed2, inner });
      const s0 = Date.now();
      const slow = await run('slowdns.image-test');
      const slowTook = Date.now() - s0;
      check(slow === 504 && slowTook < 11_500, 'I9 解析 12 秒才回：504，不超过 10 秒多一点（解析算进 10 秒）', { slow, took: slowTook });
      const pl = pinnedLookup({ address: PUB, family: 4 });
      const got = {};
      pl('x.image-test', { all: true }, (e, a) => { got.all = a; });
      pl('x.image-test', {}, (e, a, f) => { got.one = [a, f]; });
      pl('x.image-test', 4, (e, a, f) => { got.num = [a, f]; });
      check(JSON.stringify(got.all) === JSON.stringify([{ address: PUB, family: 4 }]) && got.one?.[0] === PUB && got.one?.[1] === 4 && got.num?.[0] === PUB,
        'I9 钉址的 lookup：要整组地址时只给判过的那一个；要单个时也是它', got);
    } finally {
      dns.promises.lookup = realP; syncBuiltinESMExports(); net.Socket.prototype.connect = realConnect; internal.close();
    }
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
