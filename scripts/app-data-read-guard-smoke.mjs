#!/usr/bin/env node
/**
 * 台数据与附件的读守卫（对抗组）：GET /api/apps/:slug/data、/files、/files/:id 要本台的台令牌、管理员（同源）或本机命令行；
 * 下载另认登录门签给本台页面的查看凭证（wm_av）。都不满足 403，先于查台。WM_APP_DATA_READ=warn 照旧放行、只计数留痕。
 * MCP 的 app_data_list、app_files_list 可以按台授权（工具@台），台外不给；MCP 内嵌 REST 的下载同样按台核对。
 *
 * 只在本机起隔离实例，身份来源是合成的（identity-fake-preload），不访问任何外部系统。
 *   node scripts/app-data-read-guard-smoke.mjs              测本仓库
 *   node scripts/app-data-read-guard-smoke.mjs --root DIR   测另一棵目录树
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `app-data-read-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-app-read-admin-token';
const REMOTE = { 'x-forwarded-for': '192.0.2.81' };
const SECRET_A = 'SECRET-APP-A-PO-31337', SECRET_B = 'SECRET-APP-B-PO-42424', FILE_B = 'file-b-canary-77';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

const running = [];
async function boot(name, extraEnv = {}, dataDir = null) {
  const port = await freePort();
  const data = dataDir ?? join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  if (!ready) { await stop(); return { failed: true, code: child.exitCode, log }; }
  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json, headers: res.headers };
  };
  const srv = { name, base, data, call, stop, log: () => log };
  running.push(srv);
  return srv;
}

/** 种两个台（ra、rb），各一张市场卡片、一条数据、一个附件 */
async function seed(srv, as = REMOTE) {
  const db = new DatabaseSync(join(srv.data, 'workbench-market.db'), { timeout: 5000 });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    for (const s of ['ra', 'rb']) {
      db.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run(s, s);
      db.prepare("INSERT INTO workbenches (name, url, type) VALUES (?, ?, 'market-app')").run(s, `/apps/${s}/`);
    }
  } finally { db.close(); }
  const wid = {};
  { const db2 = new DatabaseSync(join(srv.data, 'workbench-market.db'), { timeout: 5000 }); try { for (const s of ['ra', 'rb']) wid[s] = db2.prepare('SELECT id FROM workbenches WHERE url = ?').get(`/apps/${s}/`).id; } finally { db2.close(); } }
  const files = {};
  for (const [s, secret, fileText] of [['ra', SECRET_A, 'file-a-canary-55'], ['rb', SECRET_B, FILE_B]]) {
    await srv.call('POST', `/api/apps/${s}/data`, as, { data: { po: secret } });
    const fd = new FormData();
    fd.append('file', new Blob([fileText], { type: 'text/plain' }), `${s}.txt`);
    const up = await srv.call('POST', `/api/apps/${s}/files`, as, fd);
    files[s] = up.json?.id;
  }
  // 台令牌的密钥在第一次用到时生成：带一个随便的令牌问一次，再从数据目录读出密钥算令牌
  await srv.call('GET', '/api/apps/ra/data', { ...REMOTE, origin: 'null', 'x-app-token': '0'.repeat(64) }); // 沙箱页的 CORS 那一步就会比令牌
  const key = readFileSync(join(srv.data, '.wm-app-token.key'), 'utf8').trim();
  const tok = (slug) => createHmac('sha256', key).update(slug).digest('hex');
  return { wid, files, tok };
}

try {
  // ---------- 一、开关 ----------
  {
    const bad = await boot('bad-mode', { WM_APP_DATA_READ: 'off' });
    check(bad.failed === true && bad.code !== 0 && /WM_APP_DATA_READ/.test(bad.log), 'WM_APP_DATA_READ 不是 enforce/warn：拒绝启动（不当成关）', show({ code: bad.code }));
  }

  const srv = await boot('enforce');
  const { wid, files, tok } = await seed(srv);
  const tA = tok('ra'), tB = tok('rb');
  const asA = { ...REMOTE, 'x-app-token': tA };
  const leaks = (r) => r.text.includes(SECRET_A) || r.text.includes(SECRET_B) || r.text.includes(FILE_B);

  // ---------- 二、拒绝：凭 slug 裸读 ----------
  {
    const paths = ['/api/apps/rb/data', '/api/apps/rb/files', `/api/apps/rb/files/${files.rb}`];
    const anon = await Promise.all(paths.map((p) => srv.call('GET', p, REMOTE)));
    const cross = await Promise.all(paths.map((p) => srv.call('GET', p, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' })));
    const staff = await Promise.all(paths.map((p) => srv.call('GET', p, { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` })));
    const otherTok = await Promise.all(paths.map((p) => srv.call('GET', p, asA)));
    const badTok = await Promise.all(paths.map((p) => srv.call('GET', p, { ...REMOTE, 'x-app-token': 'f'.repeat(64) })));
    // 64 个字符、UTF-8 下 128 字节：按字符比长度会让常量时间比较抛错
    const wideTok = await srv.call('GET', '/api/apps/rb/data', { ...REMOTE, 'x-app-token': '\u00ff'.repeat(64) });
    const all = [...anon, ...cross, ...staff, ...otherTok, ...badTok, wideTok];
    check(all.every((r) => r.status === 403 && r.json?.error === 'app_read_denied' && !leaks(r)),
      '拒绝：匿名、带有效口令的跨站、登录的非管理员、别的台的令牌、错的令牌、非 ASCII 令牌——数据、文件列表、下载一律 403，拿不到任何内容', show(all.map((r) => r.status)));
    const same = anon.every((r) => r.text === anon[0].text) && (await srv.call('GET', '/api/apps/no-such-app/data', REMOTE)).text === anon[0].text
      && (await srv.call('GET', '/api/apps/rb/files/999999', REMOTE)).text === anon[0].text;
    check(same, '拒绝先于查台：台不存在、文件不存在，应答和存在时逐字节相同（不能按 slug、文件 id 探测）');
    const q = await Promise.all([
      srv.call('GET', '/api/apps/rb/data?limit=200&before_id=999999', REMOTE),
      srv.call('GET', `/api/apps/rb/data?x-app-token=${tB}`, REMOTE),
      srv.call('GET', `/api/apps/rb/files?limit=1&before_id=${files.rb + 1}`, REMOTE),
      srv.call('GET', `/api/apps/rb/files/${files.rb}?wm_av=forged.${'0'.repeat(32)}`, REMOTE),
      srv.call('HEAD', `/api/apps/rb/files/${files.rb}`, REMOTE),
    ]);
    check(q.every((r) => r.status === 403 && !leaks(r)), '翻页、筛选参数、查询串里带台令牌、伪造的查看凭证、HEAD：照样 403', show(q.map((r) => r.status)));
  }

  // ---------- 三、放行 ----------
  {
    const own = await Promise.all([srv.call('GET', '/api/apps/rb/data', { ...REMOTE, 'x-app-token': tB }), srv.call('GET', '/api/apps/rb/files', { ...REMOTE, 'x-app-token': tB }), srv.call('GET', `/api/apps/rb/files/${files.rb}`, { ...REMOTE, 'x-app-token': tB })]);
    const sandbox = await srv.call('GET', '/api/apps/rb/data?limit=1', { ...REMOTE, origin: 'null', 'x-app-token': tB });
    check(own[0].status === 200 && own[0].text.includes(SECRET_B) && own[1].status === 200 && own[1].json?.items?.length === 1 && own[2].status === 200 && own[2].text === FILE_B
      && sandbox.status === 200 && sandbox.headers.get('access-control-allow-origin') === 'null',
      '本台的台令牌能读本台的数据、文件列表、下载；沙箱页（Origin: null）照旧拿到 CORS 头', show(own.map((r) => r.status)));
    const admin = await Promise.all([srv.call('GET', '/api/apps/rb/data', { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }), srv.call('GET', `/api/apps/rb/files/${files.rb}`, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN })]);
    const odooAdmin = await srv.call('GET', '/api/apps/rb/data', { ...REMOTE, cookie: `session_id=${SESSIONS.admin}` });
    const cli = await srv.call('GET', '/api/apps/rb/data');
    check(admin.every((r) => r.status === 200) && admin[0].text.includes(SECRET_B) && odooAdmin.status === 200 && cli.status === 200,
      '管理口令（同源）、身份来源的管理员、本机命令行能读', show({ admin: admin.map((r) => r.status), odooAdmin: odooAdmin.status, cli: cli.status }));
    const crossFile = await srv.call('GET', `/api/apps/ra/files/${files.rb}`, asA);
    check(crossFile.status === 404 && !leaks(crossFile), '换 id 读别的台的附件：本台的令牌加别的台的文件 id，只当本台没有这个文件（404），不给内容', show({ status: crossFile.status }));
    // #955：文件号只收十进制正整数。十六进制、小数、指数、前导零、前导空白、正号这些写法，和不存在的号一样 404，不给内容
    const altIds = [`0x${Number(files.rb).toString(16)}`, `${files.rb}.0`, `${files.rb}e0`, `0${files.rb}`, `%20${files.rb}`, `%2B${files.rb}`];
    const ownAlt = await Promise.all(altIds.map((x) => srv.call('GET', `/api/apps/rb/files/${x}`, { ...REMOTE, 'x-app-token': tB })));
    const ownCanon = await srv.call('GET', `/api/apps/rb/files/${files.rb}`, { ...REMOTE, 'x-app-token': tB });
    check(ownAlt.every((r) => r.status === 404 && !leaks(r)) && ownCanon.status === 200,
      '本台令牌下载：文件号写成十六进制、小数、指数、前导零、前导空白、正号都 404、不给内容；十进制的原号照常 200', show({ alt: ownAlt.map((r) => r.status), canon: ownCanon.status }));
    const adminH = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };
    // 逐条发，不并发：并发时删附件可能先落地，改备注就因为文件没了才 404，分不出新旧写法
    const altWrites = [];
    altWrites.push(await srv.call('PATCH', `/api/apps/rb/files/${files.rb}.0`, adminH, { note: 'x' }));
    altWrites.push(await srv.call('DELETE', `/api/apps/rb/files/${files.rb}e0`, adminH));
    altWrites.push(await srv.call('DELETE', `/api/apps/rb/data/0x1`, adminH));
    const stillThere = await srv.call('GET', `/api/apps/rb/files/${files.rb}`, { ...REMOTE, 'x-app-token': tB });
    check(altWrites.every((r) => r.status === 404) && stillThere.status === 200,
      '管理员改备注、删附件、删数据：号写成别的写法一律 404，原来那个附件还在', show({ writes: altWrites.map((r) => r.status), still: stillThere.status }));
    const writeStill = await srv.call('POST', '/api/apps/rb/data', REMOTE, { data: { x: 1 } });
    check(writeStill.status === 201 || writeStill.status === 200, '提交数据照旧开放（这次只收读）', show({ status: writeStill.status }));
  }

  // ---------- 四、MCP 按台授权 ----------
  {
    const mk = async (name, grants) => {
      const s = await srv.call('POST', '/api/mcp/sessions', { 'x-admin-token': ADMIN_TOKEN }, { name });
      await srv.call('PUT', `/api/mcp/sessions/${s.json?.id}/grants`, { 'x-admin-token': ADMIN_TOKEN }, { grants });
      return { authorization: `Bearer ${s.json?.token}` };
    };
    const scoped = await mk('read-a-only', [`app_data_list@${wid.ra}`, `app_files_list@${wid.ra}`]);
    const global = await mk('read-all', ['app_data_list', 'app_files_list']);
    const rest = (h, p) => srv.call('GET', `/api/mcp-rest${p}`, h);
    const aData = await rest(scoped, '/apps/ra/data'), bData = await rest(scoped, '/apps/rb/data');
    const aFiles = await rest(scoped, '/apps/ra/files'), bFiles = await rest(scoped, '/apps/rb/files');
    const bDown = await rest(scoped, `/apps/rb/files/${files.rb}`), noApp = await rest(scoped, '/apps/no-such-app/files/1');
    check(aData.status === 200 && aData.text.includes(SECRET_A) && aFiles.status === 200 && bData.status === 403 && bFiles.status === 403 && bDown.status === 403 && noApp.status === 403 && !leaks(bData) && !leaks(bDown),
      'MCP 只授权了 工具@台A 的会话：读 A 能读；读 B 的数据、文件列表、下载都 403（下载先于查台，台不存在也 403）', show({ aData: aData.status, bData: bData.status, aFiles: aFiles.status, bFiles: bFiles.status, bDown: bDown.status, noApp: noApp.status }));
    const gA = await rest(global, '/apps/ra/data'), gB = await rest(global, '/apps/rb/data');
    check(gA.status === 200 && gB.status === 200, '不带 @ 的全局授权照旧能读全部台（存量会话不变，不自动收紧也不放宽）', show({ gA: gA.status, gB: gB.status }));
    const badGrant = await srv.call('PUT', `/api/mcp/sessions/1/grants`, { 'x-admin-token': ADMIN_TOKEN }, { grants: ['app_files_upload@1'] });
    check(badGrant.status === 400, '不支持按台的工具（上传）写 工具@台 照旧 400', show({ status: badGrant.status }));
  }

  // ---------- 四之二、#266：响应头、Range、重复的认证头、软删和缺失、日志里没有凭据 ----------
  {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const upload = async (slug, name, bytes, type) => { const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name); return (await srv.call('POST', `/api/apps/${slug}/files`, REMOTE, fd)).json?.id; };
    const png = await upload('ra', 'pic.png', PNG, 'image/png'), pdf = await upload('ra', 'doc.pdf', PDF, 'application/pdf');
    const soft = await upload('rb', 'soft.txt', 'soft-canary-91', 'text/plain'), gone = await upload('rb', 'gone.txt', 'gone-canary-92', 'text/plain');
    // 下载的响应头：不进任何缓存、不随 Referer 外带、CSP 关住脚本（PDF 在 inline 时不加 sandbox，Chrome 的 PDF 阅读器在 sandbox 下打不开）
    const dl = async (slug, id, t) => srv.call('GET', `/api/apps/${slug}/files/${id}`, { ...REMOTE, 'x-app-token': t });
    const hdr = (r) => ({ status: r.status, disp: r.headers.get('content-disposition'), cc: r.headers.get('cache-control'), rp: r.headers.get('referrer-policy'), csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') });
    const txt = hdr(await dl('rb', files.rb, tB)), img = hdr(await dl('ra', png, tA)), doc = hdr(await dl('ra', pdf, tA));
    const locked = (h) => h.status === 200 && h.cc === 'no-store' && h.rp === 'no-referrer' && h.nosniff === 'nosniff' && /default-src 'none'/.test(h.csp ?? '') && /img-src 'self'/.test(h.csp ?? '');
    check(locked(txt) && /sandbox/.test(txt.csp) && /^attachment/.test(txt.disp) && locked(img) && /sandbox/.test(img.csp) && /^inline/.test(img.disp),
      '#266 A16/A21 下载：Cache-Control no-store、Referrer-Policy no-referrer、nosniff、CSP default-src none + sandbox（附件和 inline 图片都是）', show({ txt, img }));
    check(locked(doc) && /^inline/.test(doc.disp) && !/sandbox/.test(doc.csp),
      '#266 下载 inline 的 PDF：同样不缓存、不外带，CSP 关住脚本，但不加 sandbox（不然浏览器的 PDF 阅读器打不开）', show(doc));
    // 列表读（台数据、附件列表）：返回的是这个台的业务数据，和下载一样不进任何缓存；被拒的 403 本来就是 no-store
    const listHdr = async (route, h) => { const x = await srv.call('GET', `/api/apps/rb/${route}`, h); return { status: x.status, cc: x.headers.get('cache-control') }; };
    const lData = await listHdr('data', { ...REMOTE, 'x-app-token': tB }), lFiles = await listHdr('files', { ...REMOTE, 'x-app-token': tB });
    const lDenied = await listHdr('data', REMOTE);
    check(lData.status === 200 && lData.cc === 'no-store' && lFiles.status === 200 && lFiles.cc === 'no-store' && lDenied.status === 403 && lDenied.cc === 'no-store',
      '#266 列表读（台数据、附件列表）：带令牌 200 与被拒 403 都是 Cache-Control no-store', show({ lData, lFiles, lDenied }));
    // 带台令牌的台页面：不进任何缓存、不随 Referer 外带
    mkdirSync(join(srv.data, 'apps', 'ra', 'v1'), { recursive: true });
    writeFileSync(join(srv.data, 'apps', 'ra', 'v1', 'index.html'), '<html><head></head><body>synthetic page</body></html>');
    const pageAnon = await srv.call('GET', '/apps/ra/', REMOTE), pageStaff = await srv.call('GET', '/apps/ra/', { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}`, 'sec-fetch-site': 'same-origin' });
    const ph = (r) => ({ status: r.status, token: /WM_APP_TOKEN="[0-9a-f]{64}"/.test(r.text), cc: r.headers.get('cache-control'), rp: r.headers.get('referrer-policy'), csp: r.headers.get('content-security-policy') });
    const pa = ph(pageAnon), ps = ph(pageStaff);
    check(pa.status === 200 && pa.token && pa.cc === 'no-store' && pa.rp === 'no-referrer' && /^sandbox /.test(pa.csp ?? '') && ps.status === 200 && ps.token && /no-store/.test(ps.cc ?? '') && ps.rp === 'no-referrer',
      '#266 A21 带台令牌的台页面：Cache-Control no-store（认出人的是 private, no-store）、Referrer-Policy no-referrer；原来的 CSP sandbox 照旧', show({ pa, ps }));
    // Range：不带凭据照样 403，不回 206、不给内容
    const range = await srv.call('GET', `/api/apps/rb/files/${files.rb}`, { ...REMOTE, range: 'bytes=0-3' });
    check(range.status === 403 && range.json?.error === 'app_read_denied' && !leaks(range) && range.headers.get('content-range') === null, '#266 A13 带 Range、不带凭据：403，不回 206、不给内容', show({ status: range.status }));
    // 重复的认证头：两个 X-App-Token（一个对一个错、两个都对）都不挑一个用
    const dupH = new Headers({ ...REMOTE }); dupH.append('x-app-token', tB); dupH.append('x-app-token', 'f'.repeat(64));
    const dupH2 = new Headers({ ...REMOTE }); dupH2.append('x-app-token', tB); dupH2.append('x-app-token', tB);
    const dup = await fetch(srv.base + '/api/apps/rb/data', { headers: dupH }), dup2 = await fetch(srv.base + '/api/apps/rb/data', { headers: dupH2 });
    const dupT = await dup.text(), dup2T = await dup2.text();
    check(dup.status === 403 && dup2.status === 403 && !dupT.includes(SECRET_B) && !dup2T.includes(SECRET_B), '#266 A12 两个 X-App-Token 头（一对一错、两个都对）：403，不挑其中一个用', show({ dup: dup.status, dup2: dup2.status }));
    // 软删、磁盘上缺失、编码过的路径：带对的令牌也只给 404 或拒绝，不给内容、不露落盘路径
    const del = await srv.call('DELETE', `/api/apps/rb/files/${soft}`, { 'x-admin-token': ADMIN_TOKEN });
    const softGet = await dl('rb', soft, tB);
    const sp = (() => { const d = new DatabaseSync(join(srv.data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare('SELECT storage_path FROM app_files WHERE id = ?').get(gone)?.storage_path; } finally { d.close(); } })();
    if (sp) rmSync(join(srv.data, sp), { force: true });
    const goneGet = await dl('rb', gone, tB);
    const enc = await Promise.all([`/api/apps/rb/files/${files.rb}%2F..%2F${files.ra}`, '/api/apps/rb/files/..%2F..%2Fworkbench-market.db', `/api/apps/rb%2F..%2Fra/files/${files.ra}`, `/api/apps/rb/files/${encodeURIComponent('0x' + files.rb)}`]
      .map((p) => srv.call('GET', p, { ...REMOTE, 'x-app-token': tB })));
    const noLeak = (r) => !r.text.includes('soft-canary-91') && !r.text.includes('gone-canary-92') && !r.text.includes('file-a-canary-55') && !r.text.includes('uploads/') && !r.text.includes('SQLite format');
    check(del.status === 200 && softGet.status === 404 && noLeak(softGet) && !!sp && goneGet.status === 404 && noLeak(goneGet),
      '#266 A19 软删了的附件、磁盘上已经没有的附件：带对的令牌也是 404，不给内容、不露落盘路径', show({ del: del.status, soft: softGet.status, gone: goneGet.status, sp: !!sp }));
    check(enc.slice(0, 3).every((r) => r.status >= 400 && r.status < 500 && noLeak(r)), '#266 A19 编码过的路径（文件号里带 %2F..、路径穿到库文件、台名里带 %2F.. 穿到别的台）：4xx，不给内容', show(enc.slice(0, 3).map((r) => r.status)));
    // 文件号写成 0x<号>：编号按 Number() 解析，会认成同一个号（同一个台、同一个文件、同一把令牌），不是越权；记一笔，收紧另议（会改应答、要重录）
    check(noLeak(enc[3]) && (enc[3].status !== 200 || enc[3].text === 'file-b-canary-77'), '#266 A19 文件号写成 0x<号>：最多认成本台同一个文件，不会读到别的台、别的文件', show({ status: enc[3].status }));
    // 日志里没有凭据：上面带过台令牌、管理口令、登录会话，进程的输出里一个都不出现
    const log = srv.log();
    check(![tA, tB, ADMIN_TOKEN, SESSIONS.alpha].some((x) => log.includes(x)), '#266 A18 服务端日志里不出现台令牌、管理口令、登录会话号', show({ len: log.length }));
  }

  // ---------- 五、换过的台令牌 ----------
  {
    await srv.stop();
    writeFileSync(join(srv.data, '.wm-app-token.key'), 'b'.repeat(64), { mode: 0o600 });
    const again = await boot('rotated', {}, srv.data);
    const old = await again.call('GET', '/api/apps/rb/data', { ...REMOTE, 'x-app-token': tB });
    const fresh = await again.call('GET', '/api/apps/rb/data', { ...REMOTE, 'x-app-token': createHmac('sha256', 'b'.repeat(64)).update('rb').digest('hex') });
    check(old.status === 403 && !leaks(old) && fresh.status === 200, '密钥换过之后旧的台令牌读不到，新令牌能读', show({ old: old.status, fresh: fresh.status }));
    await again.stop();
  }

  // ---------- 六、告警模式 ----------
  {
    const w = await boot('warn', { WM_APP_DATA_READ: 'warn' });
    await seed(w);
    const r = await w.call('GET', '/api/apps/rb/data', REMOTE);
    await w.call('GET', '/api/apps/rb/data', { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` });
    await sleep(200);
    const lines = w.log().split('\n').filter((l) => l.includes('"source":"app-data-read"'));
    const anonLine = lines.find((l) => l.includes('"caller":"anonymous"')), staffLine = lines.find((l) => l.includes('"caller":"login-not-admin"'));
    check(r.status === 200 && r.text.includes(SECRET_B) && !!anonLine && !!staffLine && anonLine.includes('"route":"GET /api/apps/:slug/data"')
      && !lines.some((l) => l.includes(SECRET_B) || l.includes(SESSIONS.alpha) || l.includes('rb')),
      '告警模式：照旧放行；按路由和调用方类别留痕（匿名、登录的非管理员分开），痕里没有正文、凭据和台名', show({ status: r.status, lines: lines.length }));
    await w.stop();
  }

  // ---------- 七、登录门开着：查看凭证 ----------
  {
    const g = await boot('gate', { WM_LOGIN_GATE: 'enforce' });
    const { files: gf } = await seed(g, {}); // 登录门开着：远程匿名的提交被登录门先拦，用本机命令行种数据
    const page = await g.call('GET', '/apps/rb/', { ...REMOTE, 'x-admin-token': ADMIN_TOKEN, accept: 'text/html', 'sec-fetch-dest': 'document' });
    const cap = /\/~wm\/([0-9a-z]+\.[0-9a-f]{32})\//.exec(String(page.headers.get('location') ?? ''))?.[1] ?? '';
    const withCap = await g.call('GET', `/api/apps/rb/files/${gf.rb}?wm_av=${cap}`, REMOTE);
    const capOnData = await g.call('GET', `/api/apps/rb/data?wm_av=${cap}`, REMOTE);
    const capOtherApp = await g.call('GET', `/api/apps/ra/files/${gf.ra}?wm_av=${cap}`, REMOTE);
    const noCap = await g.call('GET', `/api/apps/rb/files/${gf.rb}`, REMOTE);
    check(!!cap && withCap.status === 200 && withCap.text === FILE_B && capOnData.status === 401 && capOtherApp.status === 401 && noCap.status === 401,
      '登录门开着：本台页面的查看凭证能下载本台附件（沙箱页的下载链接）；拿它读数据、读别的台的附件不行，不带凭证登录门先拦', show({ cap: !!cap, withCap: withCap.status, capOnData: capOnData.status, capOtherApp: capOtherApp.status, noCap: noCap.status }));
    const staff = await g.call('GET', '/api/apps/rb/data', { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` });
    check(staff.status === 403 && !leaks(staff), '登录门开着：登录的员工过了登录门，读台数据照样要台令牌或管理员（403）', show({ status: staff.status }));
    await g.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`app-data-read-guard-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
