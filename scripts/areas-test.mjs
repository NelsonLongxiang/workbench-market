#!/usr/bin/env node
/**
 * 领域对象（docs/domains-step1.md 第 1 步的 PR1：三张表、服务、七条路由）的对抗组。隔离实例（NODE_ENV=test），站内账号走浏览器的真实路径。
 * 合成的人：olga 持 owner（属主）、mona 持 management（管理层）、sam 持 admin（系统管理员）、tom 持 member（普通员工）、nina 什么授予都没有。
 * 第 1 步 PR1 里写只有属主（和本机命令行）；读：属主、管理层、管理口令、本机命令行看全部，别人列表为空、单条 404（按领域授予看是 PR2）。
 *
 *   A1  （规格第五节 #1）系统管理员、管理层、普通员工、管理口令建领域、撤领域：403，库里没有变化；属主、本机命令行 2xx
 *   A2  新建的领域是 pending-lead（还没有生效的领域负责人）、来源 manual，留痕一行 create
 *   A3  （#11）标识写法不对（大写、超长、空、带斜杠）：400；名字为空、超长、带控制字符：400；同标识再建：409
 *   A4  （#4）属主新加两版规范、再回退到第 1 版：2xx；回退只移指针，版本数不变；每步一行留痕
 *   A5  （#5）直接在库里改、删一个规范版本：触发器拒；同 (领域, 版本) 再插一行：拒；留痕只增不改
 *   A6  （#6）生效指针指向不存在的版本：400；库里直接改指针到不存在的版本：触发器拒
 *   A7  （#16）规范正文超 64 KB：400；带了 sha256 和正文对不上：400；对得上：201、回的 sha256 一致
 *   A8  （#15，按统筹裁定 2 改写）撤领域时，范围 area:<标识> 的没结束的授予（草稿、待核、生效）同一个事务里一并撤销、各记一行痕，
 *       已经撤了的不动、不新记痕，别的范围的不动；撤了的领域只读：新加规范、移指针、再撤 409
 *   A9  读：属主、管理层、管理口令、本机命令行列得全、单条 200；普通员工、系统管理员、没授予的人列表为空、单条 404；规范正文同
 *   A10 （#18）远程匿名：读 401；写 401 或 403，库里没有变化
 *   A11 跨站来的浏览器（属主的 cookie）：写 403，库里没有变化
 *   A12 不存在的领域：单条、规范清单、新加规范、撤领域 404；版本号写法不对 400
 *
 * B 组：按领域授予（PR2a）。另有 alice（zeta 的领域成员）、sid（zeta 的定规范）、leo（zeta、eta 的负责人）、bob（eta 的定规范、zeta 的「只列定规范」自定义角色）
 *   B1 area: 范围写法、领域在不在、领域的预设只能带 area:          B2 pending-lead 只放宽属主起草负责人；放行第一位负责人后变 active
 *   B3 覆盖定规范、负责人动作的授予只有属主起草、放行（按权限覆盖） B4 AI 席位拿不到领域的预设
 *   B5 定规范的硬规则（只认属主和本领域 area-spec）、不经管理员门后的跨站和匿名   B6 读按 area: 授予   B7 负责人专有动作第 1 步走不到
 *
 *   node scripts/areas-test.mjs
 */
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `areas-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-areas-admin-token';
const BUSY_MS = 10_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

async function boot() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: base, WM_TRUSTED_PROXIES: '127.0.0.1', ADMIN_TOKEN });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);

  /** 浏览器：同源标记 + 自己的 cookie 罐 + 自己的来源地址；跟着页面上新的表单地址走（state 一次性） */
  const browser = (ip) => {
    const jar = new Map(), moved = new Map();
    const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
    const go = async (method, path0, { form, json, headers = {} } = {}) => {
      const path = method === 'POST' ? latest(path0) : path0;
      const h = { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip, ...headers };
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let body;
      if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/max-age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v); }
      const text = await res.text();
      const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1];
      if (method === 'POST' && act && act !== path) moved.set(path, act);
      let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
      return { status: res.status, location: res.headers.get('location') ?? '', text, json: j };
    };
    return { go, jar };
  };
  const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
  async function login(username, password, newPw, ip) {
    const b = browser(ip);
    const r0 = await b.go('GET', '/login/local?next=/');
    const form = r0.location ? new URL(r0.location).pathname + new URL(r0.location).search : '';
    let r = await b.go('POST', form, { form: { username, password } });
    if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: newPw, confirm: newPw } });
    if (r.status === 302) await b.go('GET', new URL(r.location).pathname + new URL(r.location).search);
    return b;
  }
  /** 本机命令行（回环、不带浏览器标记）：属主 */
  const cli = (method, path, json) => fetch(new URL(path, base), { method, headers: json === undefined ? {} : { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  /** 远程来的请求（经受信代理报的来源地址），可带管理口令 */
  const remote = (method, path, { json, token, headers = {} } = {}) => fetch(new URL(path, base), {
    method, headers: { 'x-real-ip': '198.51.100.9', ...(token ? { 'x-admin-token': token } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成' }); const id = d.json?.grant?.id; await cli('POST', `/api/grants/${id}/submit`); const a = await cli('POST', `/api/grants/${id}/approve`); return { id, status: a.status }; };
  const person = async (username, pw, ip) => { const t = (await cli('POST', '/api/local-accounts', { username })).json?.temp_password ?? ''; return login(username, t, pw, ip); };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
  return { base, browser, login, cli, remote, grant, person, db };
}

/** 库里的领域、规范版本、留痕各有几行（看「库里没有变化」） */
const counts = (A) => {
  const d = A.db();
  try {
    const n = (sql) => Number(d.prepare(sql).get().n);
    return { areas: n('SELECT COUNT(*) AS n FROM areas'), specs: n('SELECT COUNT(*) AS n FROM area_specs'), events: n('SELECT COUNT(*) AS n FROM area_events'), retired: n("SELECT COUNT(*) AS n FROM areas WHERE status = 'retired'") };
  } catch (e) { return { error: String(e?.message ?? e) }; } finally { d.close(); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

try {
  const A = await boot();
  const olga = await A.person('olga', 'Olga-pass-00001', '192.0.2.71'); const go = await A.grant('user:olga', 'owner');
  const mona = await A.person('mona', 'Mona-pass-00001', '192.0.2.72'); const gm = await A.grant('user:mona', 'management');
  const sam = await A.person('sam', 'Sam-pass-000001', '192.0.2.73'); const gs = await A.grant('user:sam', 'admin');
  const tom = await A.person('tom', 'Tom-pass-000001', '192.0.2.74'); const gt = await A.grant('user:tom', 'member');
  const nina = await A.person('nina', 'Nina-pass-00001', '192.0.2.75');
  check(go.status === 200 && gm.status === 200 && gs.status === 200 && gt.status === 200, '（准备）属主、管理层、系统管理员、普通员工的授予都放行了', { go, gm, gs, gt });

  // ---- A1 建、撤只有属主 ----
  {
    const before = counts(A);
    const tries = [];
    for (const [who, b] of [['sam', sam], ['mona', mona], ['tom', tom], ['nina', nina]]) tries.push([who, (await b.go('POST', '/api/areas', { json: { id: `by-${who}`, name: '合成' } })).status]);
    tries.push(['admin-token', (await A.remote('POST', '/api/areas', { json: { id: 'by-token', name: '合成' }, token: ADMIN_TOKEN })).status]);
    const after = counts(A);
    check(tries.every(([, s]) => s === 403) && same(before, after), 'A1a 系统管理员、管理层、普通员工、没授予的人、管理口令建领域：403，库里没有变化', { tries, before, after });
    const byOwner = await olga.go('POST', '/api/areas', { json: { id: 'alpha', name: '甲领域' } });
    const byCli = await A.cli('POST', '/api/areas', { id: 'beta', name: '乙领域' });
    check(byOwner.status === 201 && byCli.status === 201 && byOwner.json?.area?.id === 'alpha' && byCli.json?.area?.id === 'beta', 'A1b 属主（浏览器）、本机命令行建领域：201', { o: byOwner.status, c: byCli.status, body: byOwner.json });
    await A.cli('POST', '/api/areas', { id: 'gamma', name: '丙领域' });
    const before2 = counts(A);
    const rtries = [];
    for (const [who, b] of [['sam', sam], ['mona', mona], ['tom', tom]]) rtries.push([who, (await b.go('POST', '/api/areas/gamma/retire', { json: { reason: '合成' } })).status]);
    rtries.push(['admin-token', (await A.remote('POST', '/api/areas/gamma/retire', { json: { reason: '合成' }, token: ADMIN_TOKEN })).status]);
    check(rtries.every(([, s]) => s === 403) && same(before2, counts(A)), 'A1c 系统管理员、管理层、普通员工、管理口令撤领域：403，库里没有变化', { rtries });
    const rOwner = await olga.go('POST', '/api/areas/gamma/retire', { json: { reason: '合成' } });
    check(rOwner.status === 200 && rOwner.json?.area?.status === 'retired', 'A1d 属主撤领域：200，状态 retired（不删）', { s: rOwner.status, body: rOwner.json });
  }

  // ---- A2 新建的状态和留痕 ----
  {
    const a = (await olga.go('GET', '/api/areas/alpha')).json?.area;
    const d = A.db();
    let ev = [];
    try { ev = d.prepare("SELECT kind, actor, actor_principal FROM area_events WHERE area_id = 'alpha' ORDER BY seq").all(); } catch (e) { ev = [String(e?.message ?? e)]; } finally { d.close(); }
    check(a?.status === 'pending-lead' && a?.source === 'manual' && a?.spec_version === null && a?.name === '甲领域'
        && ev.length === 1 && ev[0].kind === 'create' && ev[0].actor_principal === 'user:olga',
      'A2 新建的领域是 pending-lead、来源 manual、没有生效规范；留痕一行 create，记着做的人', { a, ev });
  }

  // ---- A3 写法 ----
  {
    const before = counts(A);
    const bad = [];
    for (const id of ['Alpha', 'a'.repeat(49), '', '1abc', 'a/b', 'a_b', 'area:x']) bad.push([id.slice(0, 12), (await olga.go('POST', '/api/areas', { json: { id, name: '合成' } })).status]);
    for (const name of ['', ' ', 'x'.repeat(65), 'a\u0001b', 7]) bad.push([String(name).slice(0, 6), (await olga.go('POST', '/api/areas', { json: { id: 'delta', name } })).status]);
    bad.push(['no-body', (await olga.go('POST', '/api/areas', { json: [] })).status]);
    const dup = await olga.go('POST', '/api/areas', { json: { id: 'alpha', name: '重复' } });
    const after = counts(A);
    check(bad.every(([, s]) => s === 400) && dup.status === 409 && same(before, after), 'A3 标识、名字写法不对 400；同标识再建 409；库里没有变化', { bad, dup: dup.status, before, after });
  }

  // ---- A4 新加两版、回退 ----
  {
    const v1 = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: '# 甲领域规范\n第一版', note: '第一版' } });
    const v2 = await A.cli('POST', '/api/areas/alpha/specs', { body: '# 甲领域规范\n第二版', note: '第二版' });
    const mid = (await olga.go('GET', '/api/areas/alpha')).json?.area;
    const back = await olga.go('POST', '/api/areas/alpha/specs/activate', { json: { version: 1 } });
    const list = (await olga.go('GET', '/api/areas/alpha/specs')).json?.specs ?? [];
    const one = (await olga.go('GET', '/api/areas/alpha/specs/2')).json?.spec;
    const d = A.db();
    let ev = [];
    try { ev = d.prepare("SELECT kind, version FROM area_events WHERE area_id = 'alpha' ORDER BY seq").all().map((r) => `${r.kind}:${r.version ?? ''}`); } finally { d.close(); }
    check(v1.status === 201 && v1.json?.spec?.version === 1 && v2.status === 201 && v2.json?.spec?.version === 2 && mid?.spec_version === 2,
      'A4a 属主（浏览器）、本机命令行各新加一版：201，版本号 1、2，新加的那版生效', { v1: v1.status, v2: v2.status, mid });
    check(back.status === 200 && back.json?.area?.spec_version === 1 && list.length === 2 && list.every((s) => s.body === undefined) && one?.body === '# 甲领域规范\n第二版' && one?.sha256 === sha('# 甲领域规范\n第二版'),
      'A4b 回退到第 1 版：200，只移指针，版本数仍是 2；清单不带正文，单版带正文和 sha256', { back: back.status, area: back.json?.area, n: list.length, one });
    check(same(ev, ['create:', 'spec-add:1', 'spec-add:2', 'spec-activate:1']), 'A4c 每步一行留痕：create、spec-add×2、spec-activate', ev);
  }

  // ---- A5 版本不能改、不能删 ----
  {
    const d = A.db();
    try {
      const upd = throws(() => d.prepare("UPDATE area_specs SET body = 'x' WHERE area_id = 'alpha' AND version = 1").run());
      const updNote = throws(() => d.prepare("UPDATE area_specs SET note = 'x' WHERE area_id = 'alpha' AND version = 1").run());
      const del = throws(() => d.prepare("DELETE FROM area_specs WHERE area_id = 'alpha' AND version = 1").run());
      const dupIns = throws(() => d.prepare("INSERT INTO area_specs (area_id, version, body, sha256, note, created_at, created_by) VALUES ('alpha', 1, 'x', 'x', '', 1, 'x')").run());
      const repl = throws(() => d.prepare("INSERT OR REPLACE INTO area_specs (area_id, version, body, sha256, note, created_at, created_by) VALUES ('alpha', 1, 'x', 'x', '', 1, 'x')").run());
      const evUpd = throws(() => d.prepare("UPDATE area_events SET kind = 'retire' WHERE area_id = 'alpha'").run());
      const evDel = throws(() => d.prepare("DELETE FROM area_events WHERE area_id = 'alpha'").run());
      const areaDel = throws(() => d.prepare("DELETE FROM areas WHERE id = 'alpha'").run());
      const areaRekey = throws(() => d.prepare("UPDATE areas SET id = 'alpha2' WHERE id = 'alpha'").run());
      const body = d.prepare("SELECT body FROM area_specs WHERE area_id = 'alpha' AND version = 1").get()?.body;
      check(upd && updNote && del && dupIns && repl && body === '# 甲领域规范\n第一版', 'A5a 库里改、删、覆盖规范版本：触发器拒，正文原样', { upd, updNote, del, dupIns, repl, body });
      check(evUpd && evDel, 'A5b 留痕只增不改：库里改、删都拒', { evUpd, evDel });
      check(areaDel && areaRekey, 'A5c 领域不删、标识不改：库里删、改标识都拒', { areaDel, areaRekey });
    } finally { d.close(); }
  }

  // ---- A6 指针指向不存在的版本 ----
  {
    const before = counts(A);
    const r = await olga.go('POST', '/api/areas/alpha/specs/activate', { json: { version: 9 } });
    const bad = [];
    for (const version of [0, -1, 1.5, '1', null, 'x']) bad.push((await olga.go('POST', '/api/areas/alpha/specs/activate', { json: { version } })).status);
    const d = A.db();
    let dbRefused = false, ptr = null;
    try {
      dbRefused = throws(() => d.prepare("UPDATE areas SET spec_version = 9 WHERE id = 'alpha'").run());
      ptr = d.prepare("SELECT spec_version FROM areas WHERE id = 'alpha'").get()?.spec_version;
    } finally { d.close(); }
    check(r.status === 400 && bad.every((s) => s === 400) && dbRefused && ptr === 1 && same(before, counts(A)), 'A6 生效指针指向不存在的版本、版本号写法不对：400；库里直接改也拒，指针不动', { r: r.status, bad, dbRefused, ptr });
  }

  // ---- A7 正文大小、摘要 ----
  {
    const before = counts(A);
    const big = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: 'x'.repeat(65537) } });
    const bigCjk = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: '规'.repeat(21846) } }); // 65538 字节
    const empty = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: '' } });
    const notStr = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: 7 } });
    const longNote = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: 'x', note: 'n'.repeat(201) } });
    const mismatch = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: '第三版', sha256: sha('别的') } });
    const after = counts(A);
    const ok = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: '第三版', sha256: sha('第三版'), note: '带摘要' } });
    const atLimit = await olga.go('POST', '/api/areas/alpha/specs', { json: { body: 'y'.repeat(65536) } });
    const d = A.db();
    let dbBig = false;
    try { dbBig = throws(() => d.prepare("INSERT INTO area_specs (area_id, version, body, sha256, note, created_at, created_by) VALUES ('alpha', 99, ?, 'x', '', 1, 'x')").run('z'.repeat(65537))); } finally { d.close(); }
    check([big, bigCjk, empty, notStr, longNote, mismatch].every((r) => r.status === 400) && same(before, after), 'A7a 正文超 64 KB（按字节）、空、不是字符串、说明超长、sha256 对不上：400，库里没有变化',
      { s: [big, bigCjk, empty, notStr, longNote, mismatch].map((r) => r.status), before, after });
    check(ok.status === 201 && ok.json?.spec?.sha256 === sha('第三版') && atLimit.status === 201 && dbBig, 'A7b sha256 对得上、正好 64 KB：201；库里直接插超 64 KB 的也拒', { ok: ok.status, atLimit: atLimit.status, dbBig });
  }

  // ---- A8 撤领域：没结束的授予一并撤销；撤了只读 ----
  {
    await A.cli('POST', '/api/areas', { id: 'epsilon', name: '戊领域' });
    let ids = [];
    {
      const d = A.db();
      try {
        const ins = d.prepare("INSERT INTO grants (principal_id, role, scope, reason, status, created_by, created_at, updated_at) VALUES (?, 'member', ?, '合成', 'draft', 'cli', 1, 1)");
        // 草稿、待核、生效各一条（都该撤），已撤的一条（不动、不新记痕），别的领域的一条（不动）
        ids = ['user:tom', 'user:nina', 'user:mona', 'user:sam'].map((p) => Number(ins.run(p, 'area:epsilon').lastInsertRowid));
        ids.push(Number(ins.run('user:tom', 'area:epsilon-2').lastInsertRowid));
        d.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(ids[1]);
        d.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(ids[2]);
        d.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(ids[2]);
        d.prepare("UPDATE grants SET status = 'revoked' WHERE id = ?").run(ids[3]);
      } finally { d.close(); }
    }
    const r = await olga.go('POST', '/api/areas/epsilon/retire', { json: { reason: '合成' } });
    const d = A.db();
    let st = [], ev = [];
    try {
      st = ids.map((id) => d.prepare('SELECT status FROM grants WHERE id = ?').get(id)?.status);
      ev = ids.map((id) => d.prepare("SELECT COUNT(*) AS n FROM grant_events WHERE grant_id = ? AND event = 'revoke'").get(id).n);
    } finally { d.close(); }
    check(r.status === 200 && r.json?.area?.status === 'retired' && JSON.stringify(r.json?.grants_revoked) === JSON.stringify(ids.slice(0, 3))
        && same(st, ['revoked', 'revoked', 'revoked', 'revoked', 'draft']) && same(ev.map(Number), [1, 1, 1, 0, 0]),
      'A8a 撤领域：area:epsilon 的草稿、待核、生效授予一并撤销、各记一行痕，应答列出编号；已撤的不动、不新记痕；area:epsilon-2 的不动', { s: r.status, body: r.json, st, ev });
    const before = counts(A);
    const add = await olga.go('POST', '/api/areas/gamma/specs', { json: { body: '撤了的' } });
    const act = await olga.go('POST', '/api/areas/gamma/specs/activate', { json: { version: 1 } });
    const again = await olga.go('POST', '/api/areas/gamma/retire', { json: { reason: '合成' } });
    check(add.status === 409 && act.status === 409 && again.status === 409 && same(before, counts(A)), 'A8b 撤了的领域只读：新加规范、移指针、再撤都 409，库里没有变化', { add: add.status, act: act.status, again: again.status });
  }

  // ---- A9 读 ----
  {
    const ids = (r) => (r.json?.areas ?? []).map((a) => a.id).sort().join(',');
    const full = 'alpha,beta,epsilon,gamma';
    const seen = {
      olga: ids(await olga.go('GET', '/api/areas')), mona: ids(await mona.go('GET', '/api/areas')),
      token: ids(await A.remote('GET', '/api/areas', { token: ADMIN_TOKEN })), cli: ids(await A.cli('GET', '/api/areas')),
    };
    const one = {
      olga: (await olga.go('GET', '/api/areas/alpha')).status, mona: (await mona.go('GET', '/api/areas/alpha')).status,
      monaSpec: (await mona.go('GET', '/api/areas/alpha/specs/1')).status, cliSpecs: (await A.cli('GET', '/api/areas/alpha/specs')).status,
    };
    check(Object.values(seen).every((s) => s === full) && Object.values(one).every((s) => s === 200), 'A9a 属主、管理层、管理口令、本机命令行：列表全、单条和规范 200', { seen, one });
    const hidden = {};
    for (const [who, b] of [['tom', tom], ['sam', sam], ['nina', nina]]) {
      const l = await b.go('GET', '/api/areas');
      hidden[who] = [l.status, ids(l), (await b.go('GET', '/api/areas/alpha')).status, (await b.go('GET', '/api/areas/alpha/specs')).status, (await b.go('GET', '/api/areas/alpha/specs/1')).status];
    }
    check(Object.values(hidden).every(([s, l, a, b, c]) => s === 200 && l === '' && a === 404 && b === 404 && c === 404), 'A9b 普通员工、系统管理员、没授予的人：列表 200 但为空；单条、规范清单、单版 404（和不存在一样）', hidden);
  }

  // ---- A10 远程匿名 ----
  {
    const before = counts(A);
    const reads = [(await A.remote('GET', '/api/areas')).status, (await A.remote('GET', '/api/areas/alpha')).status, (await A.remote('GET', '/api/areas/alpha/specs')).status, (await A.remote('GET', '/api/areas/alpha/specs/1')).status];
    const writes = [
      (await A.remote('POST', '/api/areas', { json: { id: 'anon', name: 'x' } })).status,
      (await A.remote('POST', '/api/areas/alpha/specs', { json: { body: 'x' } })).status,
      (await A.remote('POST', '/api/areas/alpha/specs/activate', { json: { version: 2 } })).status,
      (await A.remote('POST', '/api/areas/alpha/retire', { json: {} })).status,
    ];
    check(reads.every((s) => s === 401) && writes.every((s) => s === 401 || s === 403) && same(before, counts(A)), 'A10 远程匿名：读 401；写 401/403，库里没有变化', { reads, writes });
  }

  // ---- A11 跨站 ----
  {
    const before = counts(A);
    const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.invalid' };
    const s = [
      (await olga.go('POST', '/api/areas', { json: { id: 'cross', name: 'x' }, headers: cross })).status,
      (await olga.go('POST', '/api/areas/alpha/specs', { json: { body: 'x' }, headers: cross })).status,
      (await olga.go('POST', '/api/areas/alpha/specs/activate', { json: { version: 2 }, headers: cross })).status,
      (await olga.go('POST', '/api/areas/beta/retire', { json: {}, headers: cross })).status,
      (await olga.go('GET', '/api/areas', { headers: cross })).status,
    ];
    check(s.every((x) => x === 403) && same(before, counts(A)), 'A11 跨站来的浏览器带属主的 cookie：读写都 403，库里没有变化', s);
  }

  // ---- A12 不存在 ----
  {
    const s = [
      (await olga.go('GET', '/api/areas/nope')).status, (await olga.go('GET', '/api/areas/nope/specs')).status, (await olga.go('GET', '/api/areas/nope/specs/1')).status,
      (await olga.go('GET', '/api/areas/alpha/specs/42')).status,
      (await olga.go('POST', '/api/areas/nope/specs', { json: { body: 'x' } })).status, (await olga.go('POST', '/api/areas/nope/specs/activate', { json: { version: 1 } })).status,
      (await olga.go('POST', '/api/areas/nope/retire', { json: {} })).status,
    ];
    const b = [(await olga.go('GET', '/api/areas/BAD')).status, (await olga.go('GET', '/api/areas/alpha/specs/0x1')).status, (await olga.go('GET', '/api/areas/alpha/specs/1.5')).status, (await olga.go('GET', '/api/areas/alpha/specs/0')).status];
    check(s.every((x) => x === 404) && b.every((x) => x === 400), 'A12 不存在的领域、版本：404；标识、版本号写法不对：400', { s, b });
  }

  // ================= B：按领域授予（docs/domains-step1.md 第 1 步 PR2a） =================
  const alice = await A.person('alice', 'Alice-pass-0001', '192.0.2.81');
  const sid = await A.person('sid', 'Sid-pass-000001', '192.0.2.82');
  const leo = await A.person('leo', 'Leo-pass-000001', '192.0.2.83');
  const bob = await A.person('bob', 'Bob-pass-000001', '192.0.2.84');
  await A.cli('POST', '/api/areas', { id: 'zeta', name: '己领域' });
  await A.cli('POST', '/api/areas', { id: 'eta', name: '庚领域' });
  /** 起草（不提交）：回状态码和编号 */
  const draftBy = async (b, principal, role, scope) => {
    const r = b ? await b.go('POST', '/api/grants', { json: { principal, role, scope, reason: '合成' } }) : await A.cli('POST', '/api/grants', { principal, role, scope, reason: '合成' });
    return { status: r.status, id: r.json?.grant?.id ?? null, error: r.json?.error ?? null };
  };
  const grantCount = () => { const d = A.db(); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope LIKE 'area:%'").get().n); } finally { d.close(); } };
  const areaStatus = async (id) => (await A.cli('GET', `/api/areas/${id}`)).json?.area?.status;
  // 自定义角色：只列定规范的、只列一个负责人动作的、整类「决定」的（都由本机命令行建、放行）
  for (const [id, permissions] of [['spec-setter', [{ actions: ['area.spec-set'] }]], ['lead-helper', [{ actions: ['area.release'] }]], ['decide-all', [{ kinds: ['decide'] }]]]) {
    await A.cli('POST', '/api/roles/guest/copy', { id, name: `合成${id}` });
    await A.cli('PUT', `/api/roles/${id}`, { permissions });
    await A.cli('POST', `/api/roles/${id}/approve`);
  }

  // ---- B1 范围写法、领域在不在 ----
  {
    const before = grantCount();
    const r = [];
    for (const scope of ['area:Zeta', `area:${'z'.repeat(49)}`, 'area:', 'area:zeta/x']) r.push([scope.slice(0, 12), (await draftBy(null, 'user:alice', 'area-member', scope)).status]);
    const missing = await draftBy(null, 'user:alice', 'area-member', 'area:nope');
    const retired = await draftBy(null, 'user:alice', 'area-member', 'area:gamma');
    const star = await draftBy(null, 'user:alice', 'area-member', '*');
    const dept = await draftBy(null, 'user:alice', 'area-lead', 'self');
    check(r.every(([, s]) => s === 400) && missing.status === 422 && missing.error === 'area_unknown' && retired.status === 422 && retired.error === 'area_retired'
        && star.status === 422 && star.error === 'area_scope_required' && dept.status === 422 && grantCount() === before,
      'B1（#11）area: 后面大写、超长、空、带斜杠：400；不存在、已撤的领域：422；领域的预设带 *、self 范围：422；库里没有新授予', { r, missing, retired, star, dept });
  }

  // ---- B2 pending-lead：只放宽属主起草负责人 ----
  {
    const st0 = await areaStatus('zeta');
    const member = await draftBy(olga, 'user:alice', 'area-member', 'area:zeta');
    const spec = await draftBy(olga, 'user:sid', 'area-spec', 'area:zeta');
    const cliMember = await draftBy(null, 'user:alice', 'area-member', 'area:zeta');
    const samLead = await draftBy(sam, 'user:leo', 'area-lead', 'area:zeta');
    check(st0 === 'pending-lead' && member.status === 409 && member.error === 'area_pending_lead' && spec.status === 409 && cliMember.status === 409 && [403, 409].includes(samLead.status) && samLead.id === null,
      'B2a（验收席加的）pending-lead 的领域上，属主、本机命令行也起草不了 area-member、area-spec（409）；系统管理员起草不了负责人（拒）', { st0, member, spec, cliMember, samLead });
    const lead = await draftBy(olga, 'user:leo', 'area-lead', 'area:zeta');
    const sub = await olga.go('POST', `/api/grants/${lead.id}/submit`);
    const mid = await areaStatus('zeta');
    const ap = await olga.go('POST', `/api/grants/${lead.id}/approve`);
    const st1 = await areaStatus('zeta');
    check(lead.status === 201 && sub.status === 200 && mid === 'pending-lead' && ap.status === 200 && st1 === 'active',
      'B2b（裁定 1、#8）属主起草第一位负责人、自己放行：都成；放行之后领域从 pending-lead 变成 active（之前还是 pending-lead）', { lead, sub: sub.status, mid, ap: ap.status, st1 });
    const eLead = await draftBy(null, 'user:leo', 'area-lead', 'area:eta');
    await A.cli('POST', `/api/grants/${eLead.id}/submit`); const eAp = await A.cli('POST', `/api/grants/${eLead.id}/approve`);
    check(eAp.status === 200 && (await areaStatus('eta')) === 'active', 'B2c 本机命令行起草、放行 eta 的第一位负责人：eta 变 active', { eAp: eAp.status });
  }

  // ---- B3 定规范、负责人：按权限覆盖判，只有属主起草、放行 ----
  {
    const before = grantCount();
    const tries = {};
    for (const role of ['area-spec', 'area-lead', 'spec-setter', 'lead-helper', 'decide-all']) tries[role] = (await draftBy(sam, 'user:sid', role, 'area:zeta')).status;
    const monaTry = (await draftBy(mona, 'user:sid', 'area-spec', 'area:zeta')).status;
    check(Object.values(tries).every((s) => s === 403) && monaTry === 403 && grantCount() === before,
      'B3a（#7、#20、#23、#27）系统管理员起草 area-spec、area-lead、只列定规范的自定义角色、只列一个负责人动作的、整类决定的（都带 area:）：403；管理层也 403；库里没有新授予', { tries, monaTry });
    // 系统管理员起草 area-member 可以（两人制），放行不行；管理层也放行不了（带业务拍板，只有属主）
    const m = await draftBy(sam, 'user:alice', 'area-member', 'area:zeta');
    await sam.go('POST', `/api/grants/${m.id}/submit`);
    const samAp = await sam.go('POST', `/api/grants/${m.id}/approve`);
    const monaAp = await mona.go('POST', `/api/grants/${m.id}/approve`);
    const olgaAp = await olga.go('POST', `/api/grants/${m.id}/approve`);
    check(m.status === 201 && samAp.status === 403 && [403, 404].includes(monaAp.status) && olgaAp.status === 200,
      'B3b 系统管理员能起草 area-member（两人制），放行不了；管理层放行不了；属主放行', { m, samAp: samAp.status, monaAp: monaAp.status, olgaAp: olgaAp.status });
    // 属主起草的 area-spec：属主自己放行（#8）；eta 的那条由本机命令行放行
    const s1 = await draftBy(olga, 'user:sid', 'area-spec', 'area:zeta');
    await olga.go('POST', `/api/grants/${s1.id}/submit`); const s1a = await olga.go('POST', `/api/grants/${s1.id}/approve`);
    const s2 = await draftBy(null, 'user:bob', 'area-spec', 'area:eta');
    await A.cli('POST', `/api/grants/${s2.id}/submit`); const s2a = await A.cli('POST', `/api/grants/${s2.id}/approve`);
    const custom = await draftBy(olga, 'user:bob', 'spec-setter', 'area:zeta');
    await olga.go('POST', `/api/grants/${custom.id}/submit`); const ca = await olga.go('POST', `/api/grants/${custom.id}/approve`);
    check(s1a.status === 200 && s2a.status === 200 && ca.status === 200, 'B3c（#8）属主起草 area-spec 自己放行、本机命令行起草放行另一条、属主授出只列定规范的自定义角色：都成', { s1a: s1a.status, s2a: s2a.status, ca: ca.status });
  }

  // ---- B4 AI 席位 ----
  {
    const d = A.db();
    try { d.prepare("INSERT INTO principals (id, id_key, kind, display_name, owner) VALUES ('seat:area-bot', 'seat:area-bot', 'seat', '合成席位', 'user:tom')").run(); } finally { d.close(); }
    const r = await draftBy(null, 'seat:area-bot', 'area-member', 'area:zeta');
    const r2 = await draftBy(null, 'seat:area-bot', 'area-spec', 'area:zeta');
    check(r.status === 422 && r.error === 'decide_non_person' && r2.status === 422, 'B4（#9）给 AI 席位起草 area-member、area-spec：422（决定类不给非人主体）', { r, r2 });
  }

  // ---- B5 定规范的硬规则 ----
  {
    const add = (b, area) => b.go('POST', `/api/areas/${area}/specs`, { json: { body: `合成·${Math.random()}` } });
    const s = {
      sidZeta: (await add(sid, 'zeta')).status, sidActivate: (await sid.go('POST', '/api/areas/zeta/specs/activate', { json: { version: 1 } })).status,
      aliceZeta: (await add(alice, 'zeta')).status, leoZeta: (await add(leo, 'zeta')).status,
      bobZeta: (await add(bob, 'zeta')).status, bobEta: (await add(bob, 'eta')).status, sidEta: (await add(sid, 'eta')).status,
      mona: (await add(mona, 'zeta')).status, sam: (await add(sam, 'zeta')).status, tom: (await add(tom, 'zeta')).status,
      token: (await A.remote('POST', '/api/areas/zeta/specs', { json: { body: 'x' }, token: ADMIN_TOKEN })).status,
    };
    const n = (await A.cli('GET', '/api/areas/zeta/specs')).json?.specs?.length;
    check(s.sidZeta === 201 && s.sidActivate === 200 && s.bobEta === 201, 'B5a（#4、#8）持本领域 area-spec 的人新加规范、回退：2xx', s);
    check(s.aliceZeta === 403 && s.leoZeta === 403 && s.sidEta === 403 && s.mona === 403 && s.sam === 403 && s.tom === 403 && s.token === 403 && n === 1,
      'B5b（#2、#3、#19、#25）领域成员、领域负责人、别的领域的 area-spec、管理层、系统管理员、普通员工、管理口令定规范：403，zeta 只多了 sid 那一版', { ...s, n });
    check(s.bobZeta === 403, 'B5c（#20）持「只列定规范」的自定义角色（area:zeta，属主放行的）的人定规范：403——硬规则只认 area-spec', s);
    const cross = await sid.go('POST', '/api/areas/zeta/specs', { json: { body: 'x' }, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.invalid' } });
    const anon = await A.remote('POST', '/api/areas/zeta/specs', { json: { body: 'x' } });
    const anonAct = await A.remote('POST', '/api/areas/zeta/specs/activate', { json: { version: 1 } });
    check(cross.status === 403 && anon.status === 401 && anonAct.status === 401 && (await A.cli('GET', '/api/areas/zeta/specs')).json?.specs?.length === 1,
      'B5d 定规范不经管理员门之后：跨站带 area-spec 持有人的 cookie 403；远程匿名 401；库里没有变化', { cross: cross.status, anon: anon.status, anonAct: anonAct.status });
  }

  // ---- B6 读按 area: 授予 ----
  {
    const ids = (r) => (r.json?.areas ?? []).map((a) => a.id).sort().join(',');
    const v = {
      aliceList: ids(await alice.go('GET', '/api/areas')), aliceZeta: (await alice.go('GET', '/api/areas/zeta')).status, aliceEta: (await alice.go('GET', '/api/areas/eta')).status,
      aliceSpecs: (await alice.go('GET', '/api/areas/zeta/specs')).status, aliceEtaSpecs: (await alice.go('GET', '/api/areas/eta/specs')).status,
      leoList: ids(await leo.go('GET', '/api/areas')),
      sidList: ids(await sid.go('GET', '/api/areas')), sidSpecs: (await sid.go('GET', '/api/areas/zeta/specs')).status, sidSpec1: (await sid.go('GET', '/api/areas/zeta/specs/1')).status,
      tomList: ids(await tom.go('GET', '/api/areas')), tomZeta: (await tom.go('GET', '/api/areas/zeta')).status,
    };
    check(v.aliceList === 'zeta' && v.aliceZeta === 200 && v.aliceEta === 404 && v.aliceSpecs === 200 && v.aliceEtaSpecs === 404 && v.leoList === 'eta,zeta',
      'B6a（#10）area:zeta 的领域成员只列得出 zeta、读得到 zeta 和它的规范，eta 404；负责人 leo 列出他负责的两个', v);
    check(v.sidList === '' && v.sidSpecs === 200 && v.sidSpec1 === 200 && v.tomList === '' && v.tomZeta === 404,
      'B6b area-spec 只带规范的读：领域清单里没有、规范读得到；只有范围「全部」普通员工授予的人一个也看不到', v);
  }

  // ---- B7 负责人专有动作：第 1 步走不到 ----
  {
    const r = await leo.go('POST', '/api/areas/zeta/retire', { json: { reason: '合成' } });
    check(r.status === 403 && (await areaStatus('zeta')) === 'active', 'B7（#24）持 area-lead 的人调领域的写路由（负责人动作恒为假的 refine 挂在这里）：照旧按撤领域只认属主，403', { s: r.status });
  }

} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`areas-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
