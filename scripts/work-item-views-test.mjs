#!/usr/bin/env node
/**
 * 规范 14 第 2 步 B（前一半）：事项上看得到的人和列表的视角（放宽访问的对抗组）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   看得到：建立人、管理层；别人 404。成员的主人、负责人随关系确认制接上（后面的 PR），这里还看不到
 *   视角：mine（我安排的）、all（全部，管理层）；seats、team 列出但不可用；应答带每个视角可不可用、几件；
 *         不带 view 落在第一个有内容的；不可用的视角 403；坏的 view 400
 *   管理层按 work-items.view-all 这个拍板类动作认，不按「管理」类别、也不按「看」：
 *     只授普通员工（全业务域能看）、只授系统管理员（不是身份来源管理员）的人：「全部」403、别人的详情 404，只看得到自己建的
 *     只授管理层的人：「全部」200、别人的详情 200；今天的管理员（会话登录、管理口令）照旧看全部
 *   不变量：每个人、每个可用的视角，列表里的每一条，详情都是 200
 *   「关注」的验收条目和详情同一处判断：看不到这件事项的人没有这一条；mine 只对建立人为真
 *
 *   node scripts/work-item-views-test.mjs              测本仓库
 *   node scripts/work-item-views-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-views-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'views-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  // 事项：alpha 建三件（一件推到等验收），zeta 建两件（一件推到等验收）。都只经事项服务
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    const mk = (title, who) => items.create({ title, created_by: who, creator_principal: who, source_kind: 'agent' }).id;
    const ready = (id) => { for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(id, { kind: k, source: 'seed', id: id + ':' + k + ':' + (x.status ?? x.verdict ?? ''), ...x }); return id; };
    const out = { a1: mk('合成：alpha 的一', 'user:alpha'), a2: mk('合成：alpha 的二', 'user:alpha'), aReady: ready(mk('合成：alpha 的待验收', 'user:alpha')),
      z1: mk('合成：zeta 的一', 'user:zeta'), zReady: ready(mk('合成：zeta 的待验收', 'user:zeta')) };
    out.states = [out.aReady, out.zReady].map((id) => items.get(id).state);
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  if (show(I.states) !== show(['ready', 'ready'])) throw new Error(`待验收的没推到 ready：${show(I.states)}`);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const WHO = { 建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, 别的员工: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 会话管理员: { ...SAME, cookie: `session_id=${SESSIONS.admin}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);

  const list = (h, q = '') => call('GET', `/api/work-items${q}`, h);
  const ids = (r) => (r.body?.items ?? []).map((x) => x.id).sort();
  const sorted = (...a) => [...a].sort();
  const views = (r) => Object.fromEntries(Object.entries(r.body?.views ?? {}).map(([k, v]) => [k, v.available ? v.count : null]));
  const ALL = sorted(I.a1, I.a2, I.aReady, I.z1, I.zReady);

  // ---------- 建立人 ----------
  {
    const r = await list(WHO.建立人);
    check(r.status === 200 && r.body.view === 'mine' && show(views(r)) === show({ mine: 3, seats: null, team: null, all: null }) && show(ids(r)) === show(sorted(I.a1, I.a2, I.aReady)),
      '建立人：只有「我安排的」，3 件（别人建的不在）；seats、team 列出但不可用', show({ v: r.body?.view, views: views(r) }));
    const d = await call('GET', `/api/work-items/${I.a1}`, WHO.建立人), o = await call('GET', `/api/work-items/${I.z1}`, WHO.建立人);
    check(d.status === 200 && o.status === 404, '建立人：自己的详情能看；别人建的 404', show({ d: d.status, o: o.status }));
    const out = await Promise.all(['seats', 'team', 'all'].map((v) => list(WHO.建立人, `?view=${v}`)));
    check(out.every((x) => x.status === 403 && x.body?.error === 'work_items_view_unavailable'), '建立人要 seats、team、全部：403（这几个视角对他不可用）', show(out.map((x) => x.status)));
  }
  // ---------- 别的员工 ----------
  {
    const r = await list(WHO.别的员工), d = await call('GET', `/api/work-items/${I.a1}`, WHO.别的员工);
    check(r.status === 200 && r.body.view === 'mine' && ids(r).length === 0 && d.status === 404, '别的员工：「我安排的」0 件，缺省落在第一个可用的；别人建的详情 404', show({ v: r.body?.view, n: ids(r).length, d: d.status }));
  }
  // ---------- 今天的管理员 ----------
  {
    for (const [who, h] of [['管理口令', ADMIN], ['会话管理员', WHO.会话管理员]]) {
      const r = await list(h, '?view=all'), d = await call('GET', `/api/work-items/${I.z1}`, h);
      check(r.status === 200 && r.body.view === 'all' && show(ids(r)) === show(ALL) && views(r).all === 5 && d.status === 200, `${who}：「全部」5 件，任何一件的详情能看（迁移后同时是管理层）`, show({ s: r.status, n: ids(r).length, d: d.status }));
    }
    const bad = await list(WHO.建立人, '?view=bogus'), seat = await list(WHO.建立人, '?seat=');
    check(bad.status === 400 && bad.body?.error === 'work_items_view_invalid' && seat.status === 400, '坏的 view、空的 seat：400', show({ bad: bad.status, seat: seat.status }));
    const anon = await list({ 'x-forwarded-for': '198.51.100.7' });
    check(anon.status === 401, '远程匿名：401', show(anon.status));
  }
  // ---------- 「关注」的验收条目 ----------
  {
    const accept = async (h) => ((await call('GET', '/api/attention', h)).body?.items ?? []).filter((x) => x.source === 'work-items' && x.category === 'accept').map((x) => [x.source_id, x.mine]).sort();
    const a = await accept(WHO.建立人), b = await accept(WHO.别的员工), g = await accept(WHO.会话管理员);
    check(show(a) === show([[I.aReady, true]]) && b.length === 0 && show(g) === show([[I.aReady, false], [I.zReady, false]].sort()),
      '「关注」的验收：建立人只看到自己的、轮到他；别的员工一条没有；管理层看到全部、都是代办（mine:false）', show({ a, b, g }));
  }
  // ---------- 不变量：列表里的每一条，详情都是 200 ----------
  {
    const bad = [];
    for (const [who, h] of [...Object.entries(WHO), ['管理口令', ADMIN]]) {
      const first = await list(h);
      for (const [v, x] of Object.entries(first.body?.views ?? {})) {
        if (!x.available) continue;
        for (const id of ids(await list(h, `?view=${v}`))) { const d = await call('GET', `/api/work-items/${id}`, h); if (d.status !== 200) bad.push([who, v, id, d.status]); }
      }
    }
    check(bad.length === 0, '每个人、每个可用的视角：列表里的每一条，详情都是 200', show(bad));
  }
  // ---------- 管理层按拍板类动作认 ----------
  {
    // 授予由本机命令行（属主）走完起草→提交→放行：系统管理员角色只有属主能放
    const grant = async (role) => {
      const d = await call('POST', '/api/grants', {}, { principal: 'user:alpha', role, scope: '*', reason: '合成：对抗例' });
      const gid = d.body?.grant?.id;
      await call('POST', `/api/grants/${gid}/submit`, {}, {});
      const a = await call('POST', `/api/grants/${gid}/approve`, {}, {});
      return { gid, ok: a.status === 200 && a.body?.grant?.status === 'active', a };
    };
    const revoke = (gid) => call('POST', `/api/grants/${gid}/revoke`, {}, { reason: '合成：对抗例结束' });
    for (const [role, label] of [['member', '普通员工（全业务域能看）'], ['admin', '系统管理员（不是身份来源管理员）']]) {
      const g = await grant(role);
      const all = await list(WHO.建立人, '?view=all'), other = await call('GET', `/api/work-items/${I.z1}`, WHO.建立人), mine = await list(WHO.建立人);
      check(g.ok && all.status === 403 && other.status === 404 && mine.body?.views?.all?.available === false && mine.body?.views?.mine?.count === 3,
        `只授${label}：「全部」403、别人的详情 404，只看得到自己建的——和今天一样，不比今天多`, show({ g: g.a?.status, all: all.status, other: other.status, views: views(mine) }));
      await revoke(g.gid);
    }
    const g = await grant('management');
    const all = await list(WHO.建立人, '?view=all'), other = await call('GET', `/api/work-items/${I.z1}`, WHO.建立人);
    check(g.ok && all.status === 200 && show(ids(all)) === show(ALL) && other.status === 200, '只授管理层：「全部」200（5 件）、别人的详情 200', show({ g: g.a?.status, all: all.status, n: ids(all).length, other: other.status }));
    await revoke(g.gid);
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
