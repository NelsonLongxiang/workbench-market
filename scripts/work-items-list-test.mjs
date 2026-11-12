#!/usr/bin/env node
/**
 * 事项列表的读接口 GET /api/work-items（前端的事项页用）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   可见范围：管理员看全部；登录的人只看自己是建立人的（按建立人主体，和详情、「关注」同一个判断）；
 *             别人的、建立人主体空着的都不出现，也不计数
 *   筛选：state、object、phase；计数在可见范围里按状态分组（不受 state 筛选影响）
 *   翻页：按 updated_at、id 倒序；游标一页页翻到底，不重不漏、顺序稳定；limit 缺省 100、上限 200
 *   每行：id、title、state、object、phase、seat、最后一条进展（谁、做了什么、那句话、什么时候）、updated_at、等谁放行（release_by）
 *   拒绝：没登录、提供方不认的会话 401；跨站 403；坏的 state、limit、cursor 400
 *   启动自检：远程匿名打列表必须 401
 *
 *   node scripts/work-items-list-test.mjs              测本仓库
 *   node scripts/work-items-list-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-items-list-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'list-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** 造事项：alpha 7 件（不同状态、对象），beta 3 件，建立人主体空着的 2 件；其中一件 alpha 的带一条进展 */
const SEED = `
const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
const { root } = await import(at('server/src/root-context.ts'));
const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
await root.plugin(WorkItemService);
const items = root.get('workItems');
const mk = (title, principal, extra = {}, steps = []) => {
  const it = items.create({ title, created_by: principal ?? 'human:somebody', creator_principal: principal, source_kind: 'agent', ...extra });
  for (const [k, x] of steps) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? x.verdict ?? ''), ...x });
  return it.id;
};
const toProgress = [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress', summary: '对账做到第三步' }]];
const out = { alpha: [], beta: [], none: [] };
for (let i = 0; i < 4; i++) out.alpha.push(mk('alpha 草稿 ' + i, 'user:alpha', { object: i % 2 ? 'po:1' : 'po:2', phase: 'p1' }));
for (let i = 0; i < 3; i++) out.alpha.push(mk('alpha 在办 ' + i, 'user:alpha', { object: 'po:1', phase: 'p2', seat: 'seat:checker' }, toProgress));
for (let i = 0; i < 3; i++) out.beta.push(mk('beta 的 ' + i, 'user:beta', { object: 'po:1', phase: 'p1' }));
for (let i = 0; i < 2; i++) out.none.push(mk('没有建立人 ' + i, null, { object: 'po:1' }));
console.log('SEEDED ' + JSON.stringify(out));
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout);
  if (!m) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
  const S = JSON.parse(m[1]);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const get = async (q, headers) => { const r = await fetch(base + '/api/work-items' + q, { headers }); let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ } return { status: r.status, body: j }; };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  await get('', ALPHA); await get('', BETA); // 先登录一次，主体建出来
  const ids = (b) => (b?.items ?? []).map((x) => x.id);
  const sum = (c) => Object.values(c ?? {}).reduce((a, b) => a + b, 0);

  // ---------- 可见范围 ----------
  const a = await get('', ALPHA), b = await get('', BETA), adm = await get('', ADMIN);
  check(a.status === 200 && show(ids(a.body).sort()) === show([...S.alpha].sort()) && a.body.total === 7 && sum(a.body.counts) === 7, 'alpha：只看到自己是建立人的 7 件，计数也只有这 7 件', show({ n: ids(a.body).length, total: a.body?.total, counts: a.body?.counts }));
  check(!ids(a.body).some((id) => S.beta.includes(id) || S.none.includes(id)), 'alpha 的列表里没有 beta 的、也没有建立人主体空着的');
  check(b.status === 200 && show(ids(b.body).sort()) === show([...S.beta].sort()) && b.body.total === 3, 'beta：只看到自己的 3 件', show(b.body?.total));
  check(adm.status === 200 && adm.body.total === 12 && ids(adm.body).length === 12, '管理员：看全部 12 件（含建立人主体空着的）', show(adm.body?.total));
  check(a.body.counts.draft === 4 && a.body.counts.progress === 3 && Object.keys(a.body.counts).length === 12, '计数按状态分组，十二个状态都在（没有的是 0）', show(a.body.counts));

  // ---------- 每行的字段 ----------
  const row = a.body.items.find((x) => x.title === 'alpha 在办 0');
  check(row && show(Object.keys(row).sort()) === show(['id', 'last_progress', 'object', 'phase', 'release_by', 'seat', 'state', 'title', 'updated_at']) && row.release_by === null && row.state === 'progress' && row.seat === 'seat:checker' && row.object === 'po:1' && row.phase === 'p2',
    '每行：id、title、state、object、phase、seat、last_progress、updated_at、release_by（不在等过目是 null）', show(row));
  check(row?.last_progress?.text === '对账做到第三步' && row.last_progress.fact === 'report' && typeof row.last_progress.at === 'string' && row.last_progress.at !== '', '最后一条进展取事项日志的最后一行：谁、做了什么、那句话、什么时候', show(row?.last_progress));
  const draft = a.body.items.find((x) => x.title === 'alpha 草稿 0');
  check(draft?.seat === '' && draft.last_progress?.fact === 'create', '没有接手席位的 seat 是空串；刚建的事项最后一条是「建立」', show(draft));

  // ---------- 筛选 ----------
  const st = await get('?state=progress', ALPHA), ob = await get('?object=po%3A2', ALPHA), ph = await get('?phase=p2&state=progress', ALPHA);
  check(st.body.items.length === 3 && st.body.items.every((x) => x.state === 'progress') && st.body.counts.draft === 4, '按 state 筛：只列 3 件在办；计数不受 state 筛选影响（草稿还是 4）', show({ n: st.body.items.length, counts: st.body.counts }));
  check(ob.body.items.length === 2 && ob.body.items.every((x) => x.object === 'po:2') && ob.body.total === 2, '按 object 筛：列出和计数都只算这个对象的', show(ob.body.total));
  check(ph.body.items.length === 3 && ph.body.items.every((x) => x.phase === 'p2'), 'state、phase 一起筛');
  const nob = await get('?object=po%3A1', BETA);
  check(nob.body.total === 3, 'beta 按 po:1 筛：只算自己的 3 件（alpha 的、没有建立人的同一个对象都不计数）', show(nob.body.total));

  // ---------- 翻页 ----------
  {
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const r = await get('?limit=5' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), ADMIN);
      seen.push(...r.body.items); cursor = r.body.next_cursor; pages++;
      if (pages > 10) break;
    } while (cursor);
    const sorted = [...seen].sort((x, y) => (x.updated_at === y.updated_at ? (x.id < y.id ? 1 : -1) : x.updated_at < y.updated_at ? 1 : -1));
    check(pages === 3 && seen.length === 12 && new Set(seen.map((x) => x.id)).size === 12 && show(seen.map((x) => x.id)) === show(sorted.map((x) => x.id)), '游标翻页：5、5、2 三页翻到底，不重不漏，按 updated_at、id 倒序', show({ pages, n: seen.length }));
    const all = await get('?limit=200', ADMIN), def = await get('', ADMIN);
    check(all.body.items.length === 12 && all.body.next_cursor === null && def.body.next_cursor === null, 'limit 上限 200、缺省 100：12 件一页取完，没有下一页');
  }

  // ---------- 拒绝 ----------
  {
    const anon = await get('', { 'x-forwarded-for': '198.51.100.7' });
    const local = await get('', SAME);
    const forged = await get('', { ...SAME, cookie: `session_id=${SESSIONS.forged}` });
    const cross = await get('', { ...ALPHA, 'sec-fetch-site': 'cross-site' });
    check(anon.status === 401 && local.status === 401 && forged.status === 401 && cross.status === 403, '远程匿名、本机浏览器页面没登录、提供方不认的会话：401；跨站：403', show({ anon: anon.status, local: local.status, forged: forged.status, cross: cross.status }));
    const bad = await Promise.all(['?state=bogus', '?limit=0', '?limit=201', '?limit=abc', '?cursor=%%%', '?cursor=' + Buffer.from('{"u":1}').toString('base64url')].map((q) => get(q, ADMIN)));
    check(bad.every((r) => r.status === 400), '坏的 state、limit（0、201、不是数）、cursor：400', show(bad.map((r) => [r.status, r.body?.error])));
  }

  // ---------- 启动自检 ----------
  {
    check(/"id":"market\.work-items\.list-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名打列表必须 401，而且过了');
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
