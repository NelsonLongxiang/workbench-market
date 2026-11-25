#!/usr/bin/env node
/**
 * 图片第 1 步 PR A（docs/image-step1.md）：图片列的写入与查询限制、图片代取路由。
 * 起隔离实例（假的登录提供方，NODE_ENV=test，起法照 scripts/bench-report-test.mjs）；本测试自己在本机回环上起一个假图库，
 * WM_IMAGE_GALLERY_BASE 指过去。全是合成数据，不访问外网。
 *
 *   I1 写图片列：完整 http(s) 链接、图库相对路径能写；ftp:、javascript:、..、以 / 开头、带账号口令、超长报 400
 *   I2 查询：图片列只能判空、计数；按值筛选、分组、min/max、排序报 400
 *   I3 代取判权：匿名 401、管理口令 403、跨站 403、台上没授予 403、只有 report-read 或 report-respond（读不了视图）403——这几种图库都没收到请求；只有 render 的人取得到
 *   I10 Q9 按引用判：来源视图不在路径里的台、视图里没这条链接、只是部分相同、视图不存在、视图不显示图片列，都 403 且不外发；缓存命中也照判；
 *       来源按请求带的 p.* 渲染；没权限的人问不存在的台也是 403
 *   I4 代取结果：PNG 原样转出并带 nosniff、sandbox；JPEG、WebP（VP8X、VP8L）照转；GIF、SVG、text/html、头写 PNG 内容不是 PNG 都 415；超过 4000 万像素 502；302 502；超过 5 MB 502；超时 504
 *   I5 唯一保留的防护：完整链接指向回环（不在图库前缀下）、链路本地、私网、文档网段 400；在图库前缀下照取；地址分类照 url-admission.ts，只认公网
 *   I6 不转发读者的请求头：图库收到的请求里没有 Cookie、Authorization、Referer、X-Forwarded-For
 *   I7 缓存：同一张图第二次不再请求图库；缓存命中时没权限的人仍是 403
 *   I8 对外断开（WM_OUTBOUND=off）：503
 *   I9 钉址与混合解析（本进程直接调 fetchImage，桩 DNS，连接层只放行回环）：DNS 重绑定不访问回环服务；公网与回环混合解析 400；慢解析 504；钉址 lookup 两种调用都只给判过的地址
 *   I11 报告的图片节点（PR C，用例 8）：引用 image 参数、字段、数据行都冻结出链接加哈希（REST 与 MCP 生成都是）；取不到的图不出报告；
 *       报告作来源按引用判——读者能读这个台的报告（只有 report-read 也行，只有 render 不行）、报告属于这个台、冻结正文里有这条链接，否则 403、不外发
 *   I12 读时按冻结的哈希核对：图库里的图换了（重启实例、缓存过期后），报告作来源取回 409 image_changed，不给新图；没换的照给
 *
 *   node scripts/bench-image-test.mjs
 */
import net, { createServer as createNetServer } from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  // 宽为 0 的 PNG（文件头合法，尺寸不合法）
  '/photos/zero.png': ['image/png', (() => { const z = Buffer.from(PNG); z.writeUInt32BE(0, 16); return z; })()],
  '/photos/m1.png': ['image/png', PNG], '/photos/m2.png': ['image/png', PNG],
  // I11、I12：报告里的图
  '/photos/hero.png': ['image/png', PNG], '/photos/extra.jpg': ['image/jpeg', JPG], '/photos/r1.png': ['image/png', PNG], '/photos/r2.webp': ['image/webp', webpX(2, 3)],
};
// I12：冻结之后图库里换掉的图（先是 PNG，重启前换成 JPEG）
let MUT = ['image/png', PNG];
const gallery = createHttpServer((req, res) => {
  hits.push({ path: req.url, headers: req.headers });
  const u = req.url;
  if (u === '/photos/mut.png') { const [type, body] = MUT; res.writeHead(200, { 'content-type': type, 'content-length': body.length }); return void res.end(body); }
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
      'photos/anim.gif', 'photos/fake.png', 'photos/huge.png', 'photos/a.jpg', 'photos/a.webp', 'photos/vp8l.webp', 'photos/huge.webp', 'photos/only2.png', 'photos/zero.png',
      'http://127.0.0.1:1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/a.png', 'http://[::1]:1/a.png', 'http://192.0.2.1/a.png',
      `${GBASE}photos/a.png`, `${GBASE}..%2fsecret`, `${GBASE}photos/..%2F..%2Fsecret`];
    // only2.png 只给第二个台用：本台不写它
    const up = await srv.call('POST', '/api/bench-views/synth-img/datasets/pics/rows?op=upsert', { ...boss, raw: JSON.stringify([...REFS.filter((x) => x !== 'photos/only2.png').map((pic, i) => ({ id: 100 + i, pic, name: `图${i}` })), { id: 300, pic: null, name: 'photos/textonly.png' }]) });
    // 第 300 行：链接只出现在文本列（name）里，不在图片列——不算引用
    // 按筛选值分月的数据集：同一视图换一组筛选值，渲染出来的图就不同（R8：来源要按请求带的 p.* 渲染）
    const mp = await bv(boss, 'PUT', '/synth-img/datasets/mp', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'day', type: 'date', label: '日期' }, { name: 'pic', type: 'image', label: '图片' }] });
    const mpRows = await srv.call('POST', '/api/bench-views/synth-img/datasets/mp/rows?op=replace', { ...boss, raw: JSON.stringify([{ id: 1, day: '2026-01-05', pic: 'photos/m1.png' }, { id: 2, day: '2026-02-03', pic: 'photos/m2.png' }]) });
    check(mp.status === 200 && mpRows.status === 200, '（准备）分月数据集 mp', { mp: [mp.status, mp.text.slice(0, 160)], mpRows: [mpRows.status, mpRows.text.slice(0, 160)] });
    const vw = await bv(boss, 'PUT', '/synth-img/view', { doc: { title: '合成图片台', views: [
      { key: 'bymonth', title: '按月', blocks: [{ type: 'filter-bar', fields: [{ name: 'month', kind: 'month' }] }, { type: 'table', query: { dataset: 'mp', filter: [{ col: 'day', op: 'prefix', value: '$month' }], sort: [{ col: 'id' }] } }] },
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
    const zero = await img(boss, 'photos/zero.png');
    check(zero.status === 415 && zero.json?.error === 'image_unreadable', 'I4 宽为 0 的 PNG：415 image_unreadable（Q2c）', { zero: [zero.status, zero.json?.error] });
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
    check(typeof h.accept === 'string' && /image\/png/.test(h.accept) && !/gif|svg/i.test(h.accept), 'I6 发给图库的 accept 只列三种收的格式，不列 GIF、SVG', { accept: h.accept });
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
      textColumnOnly: (await img(boss, 'photos/textonly.png')).status, // 只在文本列里出现
      substrOfStored: (await img(boss, 'photos/c')).status, // R6：请求值是图片列里某个值的一段
      storedIsPrefix: (await img(boss, 'photos/c.png?v=1')).status, // R6：图片列里的值是请求值的一段
      unknownBenchNoAuth: (await img(member, 'photos/c.png', 'nope-bench')).status, // R9：没权限的人问不存在的台，也是 403（不露台在不在）
      noView: (await img(boss, 'photos/c.png', 'synth-img', 'nope')).status,
      hiddenCol: (await img(boss, 'photos/c.png', 'synth-img', 'noimg')).status,
      badVersion: (await srv.call('GET', '/api/bench-views/synth-img/image?u=photos%2Fc.png&view=pics&version=99', boss)).status,
    };
    const h1 = hitsOf('/photos/only2.png');
    check(Object.values(r).every((x) => x === 403) && h1 === h0 && hitsOf('/photos/zzz.png') === z0 && hitsOf('/photos/textonly.png') === 0 && hitsOf('/photos/c') === 0 && hitsOf('/photos/c.png?v=1') === 0,
      'I10 来源不属于路径里的台、视图里没有这条链接、链接只在文本列、只是部分相同（逐字相等才算）、视图不存在、视图不显示图片列、版本不存在、没权限的人问不存在的台：都 403，图库收到的请求数为 0', { ...r, hits: [h0, h1] });
    const pos = await img(boss, 'photos/only2.png', 'synth-img2', 'other');
    const bossUnknown = (await img(boss, 'photos/c.png', 'nope-bench')).status;
    check(bossUnknown === 404, 'I10 对照：有第一档权的人问不存在的台：404', { bossUnknown });
    // R8：来源按请求带的筛选值渲染。m2 只在二月，按一月渲染的视图里没有它
    const byMonth = (u, month) => srv.call('GET', `/api/bench-views/synth-img/image?u=${encodeURIComponent(u)}&view=bymonth&p.month=${month}`, boss);
    const m0 = hitsOf('/photos/m2.png');
    const m2jan = (await byMonth('photos/m2.png', '2026-01')).status, afterJan = hitsOf('/photos/m2.png');
    const m2feb = (await byMonth('photos/m2.png', '2026-02')).status, m1jan = (await byMonth('photos/m1.png', '2026-01')).status;
    check(m2jan === 403 && afterJan === m0 && m2feb === 200 && m1jan === 200, 'I10 来源按请求带的 p.* 渲染：二月的图按一月取 403、图库没收到；按二月取 200；一月的图按一月取 200（R8）', { m2jan, m2feb, m1jan, hits: [m0, afterJan] });
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

  console.log('I11 报告的图片节点：冻结链接加哈希、报告作来源按引用判（PR C，用例 8）');
  let mutReport = null, heroReport = null;
  {
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.admin });
    const sys = who(SESSIONS.admin);
    const sysId = db.prepare("SELECT id FROM principals WHERE id LIKE '%root-admin%'").get()?.id;
    const o1 = await activate({ principal: sysId, role: 'owner', scope: '*' });
    const o2 = await activate({ principal: 'user:alpha', role: 'owner', scope: '*' });
    const mk = await bv(boss, 'POST', '', { slug: 'synth-rep', title: '合成图片报告台' });
    const ds = await bv(boss, 'PUT', '/synth-rep/datasets/shots', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }, { name: 'name', type: 'text', label: '名字' }] });
    const rw = await srv.call('POST', '/api/bench-views/synth-rep/datasets/shots/rows?op=replace', { ...boss, raw: JSON.stringify([{ id: 1, pic: 'photos/r1.png', name: '甲' }, { id: 2, pic: 'photos/r2.webp', name: '乙' }]) });
    const vw = await bv(boss, 'PUT', '/synth-rep/view', { doc: { title: '合成图片报告台', views: [{ key: 'shots', title: '现场', blocks: [{ type: 'table', query: { dataset: 'shots', sort: [{ col: 'id' }] } }] }] }, base: 0, note: '合成' });
    const R = (scope, name) => ({ ref: { scope, name } });
    const TPL = {
      schema_version: 2, title: '合成·图片报告',
      parameters: { period: { type: 'month', required: true }, hero: { type: 'image', required: true } }, fields: { extra: { required: true, max_length: 2048 } },
      slots: { shots: { columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }, { name: 'name', type: 'text', label: '名字' }], key: ['id'], max_rows: 10, completeness: 'all' } },
      body: [
        { id: 'cover', type: 'cover', title: ['合成 ', R('parameter', 'period')] },
        { id: 'hero', type: 'image', src: R('parameter', 'hero'), alt: '头图' },
        { id: 'extra', type: 'image', src: R('field', 'extra'), alt: '附图' },
        { id: 'each', type: 'repeat', data: 'shots', row_key: ['id'], max_items: 10, children: [{ id: 'shot', type: 'image', src: R('row', 'pic'), alt: '现场' }] },
      ],
      claims: [{ kind: 'conclusion', label: '结论', min: 0, max: 1 }], responses: { stances: ['agree', 'dispute'], reason_required: true }, gate: { open_dispute_blocks_acceptance: false },
    };
    await cli('POST', '/api/report-dimensions', { id: 'imgrep', title: '合成图片报告' });
    const pub = await srv.call('POST', '/api/report-dimensions/imgrep/templates', { ...boss, body: { body: TPL } });
    const rev = await srv.call('POST', '/api/report-dimensions/imgrep/templates/1/review', { ...sys, body: {} });
    const act = await cli('POST', '/api/report-dimensions/imgrep/activate', { version: 1 });
    const bind = await bv(boss, 'PUT', '/synth-rep/reports/imgrep/binding', { base: 0, slots: { shots: { view: 'shots', block: 0, params: {}, columns: { id: 'id', pic: 'pic', name: 'name' } } } });
    check(o1 && o2 && mk.status === 201 && ds.status === 200 && rw.status === 200 && vw.status === 200 && pub.status === 201 && rev.status === 200 && act.status === 200 && bind.status === 200,
      '（准备）属主；台、数据集（image 列两行）、视图；维度 imgrep 的模板带 image 参数、三处图片节点，复核后生效；绑定',
      { o1, o2, mk: mk.status, ds: ds.status, rw: rw.status, vw: vw.status, pub: [pub.status, pub.text.slice(0, 200)], rev: [rev.status, rev.text.slice(0, 160)], act: act.status, bind: [bind.status, bind.text.slice(0, 200)] });

    const gen = (hero, subject, extra = 'photos/extra.jpg') => bv(boss, 'POST', '/synth-rep/reports', { dimension: 'imgrep', subject, inputs: { parameters: { period: '2026-11', hero }, fields: { extra } }, claims: [] });
    const imgs = (rep) => { const out = []; const walk = (ns) => { for (const n of ns ?? []) { if (n?.type === 'image') out.push(n); walk(n?.children); } }; walk(rep?.body?.body); return out; };
    const want = { 'photos/hero.png': sha(PNG), 'photos/extra.jpg': sha(JPG), 'photos/r1.png': sha(PNG), 'photos/r2.webp': sha(webpX(2, 3)) };
    const h0 = hitsOf('/photos/hero.png');
    const g = await gen('photos/hero.png', 'item:img-1');
    heroReport = g.json?.report?.id;
    const nodes = imgs(g.json?.report);
    const read = await bv(boss, 'GET', `/synth-rep/reports/${heroReport}`);
    check(g.status === 201 && nodes.length === 4 && nodes.every((n) => n.sha256 === want[n.src] && JSON.stringify(Object.keys(n).sort()) === '["alt","id","sha256","src","type"]')
        && JSON.stringify(nodes.map((n) => n.src)) === JSON.stringify(['photos/hero.png', 'photos/extra.jpg', 'photos/r1.png', 'photos/r2.webp']) && hitsOf('/photos/hero.png') === h0 + 1
        && JSON.stringify(imgs(read.json?.report)) === JSON.stringify(nodes),
      'I11 参数、字段、两行数据的图片节点各冻结出链接加哈希（取到的那份字节的 sha256），节点只有 id、type、src、alt、sha256；冻结时取了一次图；读回一样',
      { status: g.status, text: g.text.slice(0, 240), nodes, hits: [h0, hitsOf('/photos/hero.png')] });
    const bodyText = JSON.stringify(g.json?.report?.body ?? {});
    check(!bodyText.includes(PNG.toString('base64').slice(0, 16)) && !bodyText.includes('data:image') && bodyText.length < 4000, 'I11 正文只记链接加哈希：不带图的内容（没有 base64、data: 地址）', { len: bodyText.length });

    const e = { notImage: await gen('photos/page.html', 'item:img-e1'), missing: await gen('photos/none.png', 'item:img-e2'), blocked: await gen('http://192.0.2.1/a.png', 'item:img-e3'), badRef: await gen('javascript:alert(1)', 'item:img-e4') };
    const listed = (await bv(boss, 'GET', '/synth-rep/reports')).json?.reports ?? [];
    check(e.notImage.status === 400 && /report_image_unavailable/.test(e.notImage.text) && /image_type_unsupported/.test(e.notImage.text)
        && e.missing.status === 400 && /report_image_unavailable/.test(e.missing.text) && /image_fetch_failed/.test(e.missing.text)
        && e.blocked.status === 400 && /image_address_blocked/.test(e.blocked.text) && e.badRef.status === 400 && /report_invalid_image_ref/.test(e.badRef.text)
        && !listed.some((r) => /^item:img-e/.test(r.subject)),
      'I11 图取不到（不是图片、404、文档网段这类非公网地址）不出报告：400 report_image_unavailable 带代取的错误代号；参数不是合规链接 400 report_invalid_image_ref；清单里没有这几份',
      Object.fromEntries(Object.entries(e).map(([k, v]) => [k, [v.status, v.text.slice(0, 160)]])));

    // MCP 生成走同一处：相对路径按图库前缀取图（没传图库前缀就取不到）
    const sess = (await srv.call('POST', '/api/mcp/sessions', { headers: { ...REMOTE, 'x-admin-token': ADMIN }, body: { name: 'synth-img-seat' } })).json;
    const mg = await bv(boss, 'PUT', '/synth-rep/mcp-grants', { session: 'synth-img-seat', tools: ['report_generate'] });
    const mc = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${sess?.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_generate', arguments: { bench: 'synth-rep', dimension: 'imgrep', subject: 'item:img-mcp', inputs: { parameters: { period: '2026-11', hero: 'photos/r2.webp' }, fields: { extra: 'photos/extra.jpg' } }, claims: [] } } } });
    let mj = null; try { mj = JSON.parse(mc.json?.result?.content?.[0]?.text ?? ''); } catch { /* 出错时是一句话 */ }
    check(!!sess?.token && mg.status === 200 && mc.json?.result?.isError !== true && imgs(mj?.report).find((n) => n.id === 'hero')?.sha256 === want['photos/r2.webp'],
      'I11 MCP 的 report_generate 同样冻结：相对路径按图库前缀取到图、记下哈希', { mg: mg.status, mc: mc.text.slice(0, 240) });

    const gm = await gen('photos/mut.png', 'item:img-mut');
    mutReport = gm.json?.report?.id;
    check(gm.status === 201 && imgs(gm.json?.report).find((n) => n.id === 'hero')?.sha256 === sha(PNG), '（准备 I12）一份头图是 photos/mut.png 的报告，冻结时它是 PNG', { gm: [gm.status, gm.text.slice(0, 160)] });

    const rimg = (opts, u, id = heroReport, slug = 'synth-rep') => srv.call('GET', `/api/bench-views/${slug}/image?u=${encodeURIComponent(u)}&report=${id}`, opts);
    const okHero = await rimg(boss, 'photos/hero.png'), okExtra = await rimg(boss, 'photos/extra.jpg'), okRow = await rimg(boss, 'photos/r2.webp');
    check(okHero.status === 200 && okHero.buf.equals(PNG) && okHero.headers.get('content-type') === 'image/png' && okHero.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(okHero.headers.get('content-security-policy') ?? '')
        && okExtra.status === 200 && okExtra.buf.equals(JPG) && okRow.status === 200 && okRow.buf.equals(webpX(2, 3)),
      'I11 报告作来源：参数、字段、数据行的图都取得到，字节一致，带 nosniff、sandbox', { okHero: okHero.status, okExtra: okExtra.status, okRow: okRow.status });
    const before = hits.length;
    const deny = {
      anon: (await srv.call('GET', `/api/bench-views/synth-rep/image?u=photos%2Fhero.png&report=${heroReport}`, { headers: REMOTE })).status,
      cross: (await srv.call('GET', `/api/bench-views/synth-rep/image?u=photos%2Fhero.png&report=${heroReport}`, { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: P.boss })).status,
      noGrant: (await rimg(member, 'photos/hero.png')).status,
      notInReport: (await rimg(boss, 'photos/a.png')).status, // 别的台的视图里有，这份报告里没有
      inViewOnly: (await rimg(boss, 'photos/b.png')).status, // 本测试别处的视图里有，报告里没有
      part: (await rimg(boss, 'photos/hero')).status,
      noReport: (await rimg(boss, 'photos/hero.png', 99999)).status,
      badId: (await rimg(boss, 'photos/hero.png', 'abc')).status,
      zeroId: (await rimg(boss, 'photos/hero.png', 0)).status,
      otherBench: (await rimg(boss, 'photos/hero.png', heroReport, 'synth-img')).status, // 报告不属于路径里的台
    };
    check(deny.anon === 401 && deny.cross === 403 && Object.entries(deny).filter(([k]) => !['anon', 'cross'].includes(k)).every(([, v]) => v === 403) && hits.length === before,
      'I11 报告作来源按引用判：匿名 401、跨站 403；台上没授予、链接不在这份报告里（只在别的视图、只是一段）、报告不存在、编号不合、报告不属于路径里的台：403；图库都没收到请求', { ...deny, hits: [before, hits.length] });
    const ga = await activate({ principal: 'user:beta', role: 'img-report-only', scope: '*' });
    const viaReport = await rimg(member, 'photos/r1.png');
    const viaView = await img(member, 'photos/r1.png', 'synth-rep', 'shots');
    await revokeAll('img-report-only');
    const gone = await rimg(member, 'photos/r1.png');
    const gb = await activate({ principal: 'user:beta', role: 'img-render-only', scope: '*' });
    const renderOnly = await rimg(member, 'photos/r1.png');
    const renderView = await img(member, 'photos/r1.png', 'synth-rep', 'shots');
    await revokeAll('img-render-only');
    check(ga && gb && viaReport.status === 200 && viaReport.buf.equals(PNG) && viaView.status === 403 && gone.status === 403 && renderOnly.status === 403 && renderView.status === 200,
      'I11 只有 report-read 的读者从报告取得到图（同一张图从视图取 403）；收回后 403；只有 render 的人从报告取 403、从视图取得到',
      { viaReport: viaReport.status, viaView: viaView.status, gone: gone.status, renderOnly: renderOnly.status, renderView: renderView.status });
  }

  await srv.stop();
  console.log('I12 读时按冻结的哈希核对：图片已变');
  {
    MUT = ['image/jpeg', JPG]; // 冻结之后图库里的图换了；重启实例，进程内缓存随之清掉
    const again = await boot('on');
    for (const sess of Object.values(P)) await again.call('GET', '/api/auth/viewer', { session: sess });
    const b2 = { headers: { ...REMOTE, origin: `http://${again.host}`, 'sec-fetch-site': 'same-origin' }, session: P.boss };
    const m0 = hitsOf('/photos/mut.png');
    const changed = await again.call('GET', `/api/bench-views/synth-rep/image?u=photos%2Fmut.png&report=${mutReport}`, b2);
    const still = await again.call('GET', `/api/bench-views/synth-rep/image?u=photos%2Fhero.png&report=${heroReport}`, b2);
    check(mutReport && changed.status === 409 && changed.json?.error === 'image_changed' && !changed.buf.includes(JPG) && hitsOf('/photos/mut.png') === m0 + 1 && still.status === 200 && still.buf.equals(PNG),
      'I12 图库里的图换了：报告作来源取回 409 image_changed，不给新图（图库收到一次请求）；没换的照给', { changed: [changed.status, changed.text.slice(0, 120)], still: still.status, hits: [m0, hitsOf('/photos/mut.png')] });
    await again.stop();
  }
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
