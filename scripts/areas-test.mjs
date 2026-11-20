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
 * C 组：领域负责人（PR2b）。服务层的另见 scripts/areas-lead-test.mjs（#28 主测、到期、#29b 两个进程并发收回）
 *   C1 放行第一位负责人后变 active、留痕   C2 不能收回最后一位负责人（路由层，原因透传）；有两位时能收一位；草稿照常作废；撤领域一并收回
 *   C3 负责人本人停用：退回 pending-lead、留痕、属主的待办；恢复后回到 active   C4 负责人授予到期：退回 pending-lead
 *
 * D 组：部门迁成领域（PR3a）。并发调两次（#21）见 scripts/areas-lead-test.mjs 的 L6
 *   D1 只有属主能迁   D2 每个部门一个领域；只给有生效负责人授予的部门起草 area-lead（待核）；旧数据不删   D3 再跑一次没有变化   D4 放行后变 active
 *   D5 页面要的 can、leads 及其可见范围（D5d：领域成员看得到本人那条等放行的）
 *   D6 迁移起草的负责人被收回（否决）后再迁移不重新起草   D7 已有理由不同的手工待放行负责人，迁移不再起草（去重按人、角色、范围，不看理由）
 *   D8 否决迁移草稿后属主手动指定照样走通、之后再迁移不另起草   D9 手工收回的不算迁移否决过，迁移照样起草   D10 负责人已生效后再迁移不起草
 *   D11 标识不合领域写法的部门（直接写库）：迁移记 id_invalid，不建领域
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
import { legacyDepartmentIn } from './lib/legacy-dept-seed.mjs';

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
      'B3a（#7、#20、#23、#27）[red-line:area-spec-owner-only] 系统管理员起草 area-spec、area-lead、只列定规范的自定义角色、只列一个负责人动作的、整类决定的（都带 area:）：403；管理层也 403；库里没有新授予', { tries, monaTry });
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

  // ================= C：领域负责人（docs/domains-step1.md 第 1 步 PR2b） =================
  await A.person('lia', 'Lia-pass-000001', '192.0.2.91');
  await A.person('ivy', 'Ivy-pass-000001', '192.0.2.92');
  await A.person('kim', 'Kim-pass-000001', '192.0.2.93');
  for (const [id, name] of [['theta', '辛领域'], ['iota', '壬领域'], ['kappa', '癸领域']]) await A.cli('POST', '/api/areas', { id, name });
  /** 本机命令行起草、提交、放行一条负责人授予，回编号 */
  const leadOf = async (principal, area, expires_at) => {
    const d = await A.cli('POST', '/api/grants', { principal, role: 'area-lead', scope: `area:${area}`, reason: '合成', ...(expires_at ? { expires_at } : {}) });
    const id = d.json?.grant?.id;
    await A.cli('POST', `/api/grants/${id}/submit`); await A.cli('POST', `/api/grants/${id}/approve`);
    return id;
  };
  const kindsOf = (area) => { const d = A.db(); try { return d.prepare('SELECT kind, detail FROM area_events WHERE area_id = ? ORDER BY seq').all(area); } finally { d.close(); } };
  const grantStatus = (id) => { const d = A.db(); try { return d.prepare('SELECT status FROM grants WHERE id = ?').get(id)?.status; } finally { d.close(); } };

  // ---- C1 放行第一位负责人：active，留痕 ----
  const t1 = await leadOf('user:leo', 'theta');
  {
    const k = kindsOf('theta').map((r) => r.kind);
    check((await areaStatus('theta')) === 'active' && k.includes('lead-active'), 'C1（#28 路由层）放行第一位负责人后 GET /api/areas 里的状态从 pending-lead 变 active，留痕 lead-active', k);
  }

  // ---- C2 不能收回最后一位负责人；拒绝原因透传 ----
  {
    const byCli = await A.cli('POST', `/api/grants/${t1}/revoke`, { reason: '合成' });
    const byOwner = await olga.go('POST', `/api/grants/${t1}/revoke`, { json: { reason: '合成' } });
    check(byCli.status === 409 && byCli.json?.error === 'area_last_lead' && /至少要有一位负责人/.test(byCli.json?.message ?? '') && byOwner.status === 409 && byOwner.json?.error === 'area_last_lead'
        && grantStatus(t1) === 'active' && (await areaStatus('theta')) === 'active',
      'C2（#29 路由层）本机命令行、属主收回领域最后一位负责人：409 area_last_lead，原因原样透给调用方；授予照旧生效', { cli: [byCli.status, byCli.json], owner: byOwner.status });
    const t2 = await leadOf('user:lia', 'theta');
    const r1 = await A.cli('POST', `/api/grants/${t1}/revoke`, { reason: '合成：换人' });
    const r2 = await A.cli('POST', `/api/grants/${t2}/revoke`, { reason: '合成' });
    check(r1.status === 200 && r2.status === 409 && r2.json?.error === 'area_last_lead' && (await areaStatus('theta')) === 'active',
      'C2b 两位负责人时收回一位：成；剩下那一位再收回：409', { r1: r1.status, r2: r2.status });
    // 还没放行的负责人授予（草稿）不算生效，收回照常
    const d = await A.cli('POST', '/api/grants', { principal: 'user:kim', role: 'area-lead', scope: 'area:theta', reason: '合成' });
    const rd = await A.cli('POST', `/api/grants/${d.json?.grant?.id}/revoke`, { reason: '合成：作废' });
    check(rd.status === 200, 'C2c 负责人授予还在草稿时作废：照常 200（不是生效的负责人）', { rd: rd.status });
    // 撤领域：连同最后一位负责人一起收回（裁定 6）
    const ret = await olga.go('POST', '/api/areas/theta/retire', { json: { reason: '合成' } });
    check(ret.status === 200 && ret.json?.grants_revoked?.includes(t2) && grantStatus(t2) === 'revoked', 'C2d 属主撤领域：最后一位负责人一并收回，不受「至少一位」拦', { s: ret.status, body: ret.json?.grants_revoked });
  }

  // ---- C3 负责人本人停用：退回 pending-lead、留痕、给属主待办；恢复后回到 active ----
  {
    await leadOf('user:ivy', 'iota');
    const st0 = await areaStatus('iota');
    const dis = await A.cli('POST', '/api/principals/disable', { id: 'user:ivy', reason: '合成：离职' });
    const st1 = await areaStatus('iota');
    const ev = kindsOf('iota').at(-1);
    const att = (r) => (r.json?.items ?? []).filter((x) => x.source === 'areas-no-lead').map((x) => x.source_id);
    const olgaAtt = att(await olga.go('GET', '/api/attention')), monaAtt = att(await mona.go('GET', '/api/attention')), tomAtt = att(await tom.go('GET', '/api/attention'));
    const tokenAtt = att(await A.remote('GET', '/api/attention', { token: ADMIN_TOKEN }));
    check(st0 === 'active' && dis.status === 200 && st1 === 'pending-lead' && ev?.kind === 'lead-missing' && /离职|停用/.test(ev?.detail ?? ''),
      'C3a（#29）唯一的负责人本人被停用：领域退回 pending-lead，留痕 lead-missing 写原因', { st0, dis: dis.status, st1, ev });
    check(olgaAtt.includes('iota') && !monaAtt.length && !tomAtt.length && !tokenAtt.length,
      'C3b 「等你拍板」里给属主一条「这个领域没有负责人」的待办；管理层、普通员工、管理口令看不到', { olgaAtt, monaAtt, tomAtt, tokenAtt });
    const res = await A.cli('POST', '/api/principals/restore', { id: 'user:ivy', reason: '合成：回来了' });
    check(res.status === 200 && (await areaStatus('iota')) === 'active' && kindsOf('iota').at(-1)?.kind === 'lead-active' && !att(await olga.go('GET', '/api/attention')).includes('iota'),
      'C3c 恢复这个人：领域回到 active，留痕 lead-active，待办消失', { s: res.status });
  }

  // ---- C4 负责人授予到期 ----
  {
    await leadOf('user:kim', 'kappa', Date.now() + 2500);
    const st0 = await areaStatus('kappa');
    await sleep(3200);
    await A.cli('GET', '/api/grants'); // 列授予时顺手把到期的标成过期
    check(st0 === 'active' && (await areaStatus('kappa')) === 'pending-lead' && kindsOf('kappa').at(-1)?.kind === 'lead-missing',
      'C4 唯一负责人的授予到期：领域退回 pending-lead，留痕 lead-missing', { st0 });
  }

  // ================= D：部门迁成领域（docs/domains-step1.md 第二节第 3 小节；第 1 步 PR3a） =================
  const dan = await A.person('dan', 'Dan-pass-000001', '192.0.2.101');
  await A.person('eve', 'Eve-pass-000001', '192.0.2.102');
  await A.person('fay', 'Fay-pass-000001', '192.0.2.103');
  // 四个部门（部门已停写，都是直接写库造的停写前的数据，scripts/lib/legacy-dept-seed.mjs）：m-sales 有生效的负责人授予（属主当时指定，发了 dept-lead）；m-ops 没有负责人；
  // m-hr 的负责人有授予但本人停用了；m-fin 只有负责人字段、没有授予（直接写库，「待属主放行」）
  { const d = A.db(); try { legacyDepartmentIn(d, 'm-sales', '合成销售部', 'user:dan'); } finally { d.close(); } }
  { const d = A.db(); try { legacyDepartmentIn(d, 'm-ops', '合成运营部'); } finally { d.close(); } }
  { const d = A.db(); try { legacyDepartmentIn(d, 'm-hr', '合成人事部', 'user:eve'); } finally { d.close(); } }
  await A.cli('POST', '/api/principals/disable', { id: 'user:eve', reason: '合成：离职' });
  { const d = A.db(); try { d.prepare("INSERT INTO departments (id, name, lead_principal, created_at, updated_at) VALUES ('m-fin', '合成财务部', 'user:fay', 1, 1)").run(); } finally { d.close(); } }
  const oldTables = () => { const d = A.db(); try { const n = (t) => Number(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n); return { departments: n('departments'), members: n('department_members'), links: n('dept_lead_grants'), deptGrants: n("grants WHERE scope LIKE 'dept:%'") }; } finally { d.close(); } };
  const migGrants = () => { const d = A.db(); try { return d.prepare("SELECT principal_id, role, scope, status, reason FROM grants WHERE reason = '由部门负责人迁移' ORDER BY id").all(); } finally { d.close(); } };
  const areaRow = (id) => { const d = A.db(); try { return d.prepare('SELECT status, source FROM areas WHERE id = ?').get(id) ?? null; } finally { d.close(); } };

  // ---- D1 只有属主能迁 ----
  {
    const before = counts(A);
    const tries = {};
    for (const [who, b] of [['sam', sam], ['mona', mona], ['tom', tom]]) tries[who] = (await b.go('POST', '/api/areas/migrate', { json: {} })).status;
    tries.token = (await A.remote('POST', '/api/areas/migrate', { json: {}, token: ADMIN_TOKEN })).status;
    tries.anon = (await A.remote('POST', '/api/areas/migrate', { json: {} })).status;
    check(Object.values(tries).every((s) => s === 401 || s === 403) && tries.sam === 403 && tries.token === 403 && same(before, counts(A)) && migGrants().length === 0,
      'D1 系统管理员、管理层、普通员工、管理口令、远程匿名调迁移：401/403，库里没有变化', tries);
  }

  // ---- D2 属主迁一次 ----
  const old0 = oldTables();
  {
    const r = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const created = (r.json?.created ?? []).map((x) => x.id).sort().join(',');
    const drafted = r.json?.drafted ?? [];
    const g = migGrants();
    const st = Object.fromEntries(['m-sales', 'm-ops', 'm-hr', 'm-fin'].map((id) => [id, areaRow(id)]));
    const ev = (() => { const d = A.db(); try { return d.prepare("SELECT area_id, detail FROM area_events WHERE kind = 'migrate' ORDER BY seq").all().map((x) => `${x.area_id}:${x.detail}`); } finally { d.close(); } })();
    check(r.status === 200 && created === 'm-fin,m-hr,m-ops,m-sales' && Object.values(st).every((x) => x?.status === 'pending-lead' && x?.source === 'department')
        && ev.includes('m-sales:m-sales') && ev.length === 4,
      'D2a 属主迁移：每个部门建一个同标识、同名的领域（source=department、pending-lead），各留痕一行 migrate', { s: r.status, created, st, ev });
    check(g.length === 1 && g[0].principal_id === 'user:dan' && g[0].role === 'area-lead' && g[0].scope === 'area:m-sales' && g[0].status === 'pending'
        && drafted.length === 1 && drafted[0].department === 'm-sales',
      'D2b（#26、#14）只给有生效负责人授予的部门（m-sales）起草 area-lead，停在待核；负责人停用的（m-hr）、只有字段的（m-fin）、没有负责人的不起草；不起草 area-member、area-spec', { g, drafted });
    check(same(old0, oldTables()), 'D2c 旧数据一律不删：部门、部门成员、负责人授予的对照、dept: 范围的授予原样', { before: old0, after: oldTables() });
  }

  // ---- D3 再跑一次 ----
  {
    const before = { c: counts(A), g: migGrants().length, old: oldTables() };
    const r = await A.cli('POST', '/api/areas/migrate', {});
    check(r.status === 200 && (r.json?.created ?? []).length === 0 && (r.json?.drafted ?? []).length === 0 && same(before, { c: counts(A), g: migGrants().length, old: oldTables() }),
      'D3（#13）再跑一次：不新建领域、不重复起草，库里没有变化', { s: r.status, body: r.json });
  }

  // ---- D4 属主放行迁移出来的负责人：领域变 active ----
  {
    const id = (() => { const d = A.db(); try { return d.prepare("SELECT id FROM grants WHERE reason = '由部门负责人迁移'").get().id; } finally { d.close(); } })();
    const ap = await olga.go('POST', `/api/grants/${id}/approve`);
    check(ap.status === 200 && areaRow('m-sales')?.status === 'active', 'D4 属主放行迁移起草的负责人：m-sales 变 active', { ap: ap.status });
  }

  // ---- D5 页面要的：can 和负责人 ----
  {
    const canOf = async (b) => (b ? await b.go('GET', '/api/areas') : await A.cli('GET', '/api/areas')).json?.can;
    const cans = { olga: await canOf(olga), cli: await canOf(null), mona: await canOf(mona), tom: await canOf(tom), token: (await A.remote('GET', '/api/areas', { token: ADMIN_TOKEN })).json?.can };
    const yes = { create: true, migrate: true, assign_lead: true }, no = { create: false, migrate: false, assign_lead: false };
    const leads = (await olga.go('GET', '/api/areas/m-sales')).json?.leads;
    const iotaLeads = (await olga.go('GET', '/api/areas/iota')).json?.leads;
    check(same(cans.olga, yes) && same(cans.cli, yes) && same(cans.mona, no) && same(cans.tom, no) && same(cans.token, no),
      'D5a GET /api/areas 的 can：属主、本机命令行三项都是真；管理层、普通员工、管理口令都是假', cans);
    check(leads?.length === 1 && leads[0].principal === 'user:dan' && leads[0].status === 'active' && leads[0].display_name !== undefined && iotaLeads?.some((x) => x.principal === 'user:ivy' && x.status === 'active'),
      'D5b GET /api/areas/:id 的 leads：列出生效的负责人（迁移后放行的 dan、恢复后的 ivy）', { leads, iotaLeads });
    // 再给 m-sales 起草一位负责人 kim，停在待核：等放行的是人员信息，只有属主看得到
    const k = await A.cli('POST', '/api/grants', { principal: 'user:kim', role: 'area-lead', scope: 'area:m-sales', reason: '合成' });
    await A.cli('POST', `/api/grants/${k.json?.grant?.id}/submit`);
    const who = (r) => (r.json?.leads ?? []).map((x) => `${x.principal}:${x.status}`).sort().join(',');
    const seen = {
      olga: who(await olga.go('GET', '/api/areas/m-sales')), cli: who(await A.cli('GET', '/api/areas/m-sales')),
      mona: who(await mona.go('GET', '/api/areas/m-sales')), token: who(await A.remote('GET', '/api/areas/m-sales', { token: ADMIN_TOKEN })),
      dan: who(await dan.go('GET', '/api/areas/m-sales')),
    };
    const tomS = (await tom.go('GET', '/api/areas/m-sales')).status, samS = (await sam.go('GET', '/api/areas/m-sales')).status;
    check(seen.olga === 'user:dan:active,user:kim:pending' && seen.cli === seen.olga && seen.mona === 'user:dan:active' && seen.token === 'user:dan:active' && seen.dan === 'user:dan:active'
        && tomS === 404 && samS === 404,
      'D5c leads 的可见范围：属主、本机命令行看得到等放行的 kim；管理层、管理口令、负责人 dan 只看到生效的；无关的普通员工、系统管理员连领域都看不到（404）', { seen, tomS, samS });
  }

  // ---- D5d 领域成员看得到本人那条等放行的负责人 ----
  {
    const d = await A.cli('POST', '/api/grants', { principal: 'user:alice', role: 'area-lead', scope: 'area:zeta', reason: '合成：提拔' });
    await A.cli('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const who = (r) => (r.json?.leads ?? []).map((x) => `${x.principal}:${x.status}`).sort().join(',');
    const aliceSees = who(await alice.go('GET', '/api/areas/zeta')), monaSees = who(await mona.go('GET', '/api/areas/zeta')), olgaSees = who(await olga.go('GET', '/api/areas/zeta'));
    check(aliceSees.includes('user:alice:pending') && !monaSees.includes('user:alice:pending') && olgaSees.includes('user:alice:pending'),
      'D5d 领域成员 alice 在 zeta 的 leads 里看得到本人那条等放行的负责人授予；管理层看不到这条；属主看得到', { aliceSees, monaSees, olgaSees });
  }

  // ---- D6 迁移起草的负责人被收回（否决）后，再迁移不重新起草 ----
  {
    { const d = A.db(); try { legacyDepartmentIn(d, 'm-legal', '合成法务部', 'user:lia'); } finally { d.close(); } }
    const m1 = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const gid = (m1.json?.drafted ?? []).find((x) => x.department === 'm-legal')?.grant;
    const rv = await A.cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：属主否决' });
    const m2 = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const rows = (() => { const d = A.db(); try { return d.prepare("SELECT status FROM grants WHERE principal_id = 'user:lia' AND role = 'area-lead' AND scope = 'area:m-legal'").all().map((r) => r.status); } finally { d.close(); } })();
    check(!!gid && rv.status === 200 && !(m2.json?.drafted ?? []).some((x) => x.department === 'm-legal') && same(rows, ['revoked']),
      'D6 迁移起草的负责人被属主收回（否决）后再跑迁移：不重新起草，这个人、角色、范围下只有那条已收回的', { gid, rv: rv.status, m2: m2.json, rows });
  }

  // ---- D7 已有一条理由不同的手工待放行负责人：迁移不再起草 ----
  {
    await A.cli('POST', '/api/areas', { id: 'm-qa', name: '合成质检' });
    const d = await A.cli('POST', '/api/grants', { principal: 'user:kim', role: 'area-lead', scope: 'area:m-qa', reason: '合成：手工指定' });
    await A.cli('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    { const d = A.db(); try { legacyDepartmentIn(d, 'm-qa', '合成质检', 'user:kim'); } finally { d.close(); } }
    const m = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const rows = (() => { const db = A.db(); try { return db.prepare("SELECT status, reason FROM grants WHERE principal_id = 'user:kim' AND role = 'area-lead' AND scope = 'area:m-qa'").all().map((r) => `${r.status}:${r.reason}`); } finally { db.close(); } })();
    check(m.status === 200 && !(m.json?.drafted ?? []).some((x) => x.department === 'm-qa') && same(rows, ['pending:合成：手工指定']),
      'D7 这个人、角色、范围下已有一条理由不同的手工待放行授予：迁移不再起草，只有那一条', { m: m.json, rows });
  }

  // ---- D8 属主否决迁移草稿后，手动给同一个人指定负责人照样走得通；之后再迁移不另起草 ----
  {
    const d = await olga.go('POST', '/api/grants', { json: { principal: 'user:lia', role: 'area-lead', scope: 'area:m-legal', reason: '合成：属主手动指定' } });
    const sub = await olga.go('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const ap = await olga.go('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const st = areaRow('m-legal')?.status;
    const m = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const skip = (m.json?.skipped ?? []).find((x) => x.department === 'm-legal')?.reason;
    check(d.status === 201 && sub.status === 200 && ap.status === 200 && st === 'active' && !(m.json?.drafted ?? []).some((x) => x.department === 'm-legal') && skip === 'already_open',
      'D8 迁移草稿被属主否决后，属主手动给 lia 指定负责人：起草 201、提交 200、放行 200，m-legal 变 active；再迁移记 already_open，不另起草',
      { d: d.status, sub: sub.status, ap: ap.status, st, skip, m: m.json });
  }

  // ---- D9 手工起草后收回的负责人授予，不算「迁移否决过」：迁移照样起草 ----
  {
    await A.cli('POST', '/api/areas', { id: 'm-ware', name: '合成仓储' });
    const d = await A.cli('POST', '/api/grants', { principal: 'user:kim', role: 'area-lead', scope: 'area:m-ware', reason: '合成：手工起草' });
    await A.cli('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const rv = await A.cli('POST', `/api/grants/${d.json?.grant?.id}/revoke`, { reason: '合成：手工收回' });
    { const d = A.db(); try { legacyDepartmentIn(d, 'm-ware', '合成仓储', 'user:kim'); } finally { d.close(); } }
    const m = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const drafted = (m.json?.drafted ?? []).find((x) => x.department === 'm-ware');
    check(rv.status === 200 && drafted?.principal === 'user:kim',
      'D9 同一个人、角色、范围下只有一条手工起草后收回的授予：不算迁移否决过，迁移照样起草', { rv: rv.status, m: m.json });
  }

  // ---- D10 负责人已经生效后再迁移，不再起草 ----
  {
    const m = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const skip = (m.json?.skipped ?? []).find((x) => x.department === 'm-sales')?.reason;
    const n = (() => { const db = A.db(); try { return Number(db.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal_id = 'user:dan' AND role = 'area-lead' AND scope = 'area:m-sales'").get().n); } finally { db.close(); } })();
    check(skip === 'already_open' && !(m.json?.drafted ?? []).some((x) => x.department === 'm-sales') && n === 1,
      'D10 m-sales 的负责人 dan 已生效（D4 放行的），再迁移：记 already_open，不另起草，dan 在这个范围下仍只有一条', { skip, n, m: m.json });
  }

  // ---- D11 标识不合领域写法的部门（直接写库、外部同步来的）：迁移记 id_invalid，不建领域 ----
  {
    { const d = A.db(); try { d.prepare("INSERT INTO departments (id, name, created_at, updated_at) VALUES ('Bad_Dept', '合成不合规部门', 1, 1)").run(); } finally { d.close(); } }
    const m = await olga.go('POST', '/api/areas/migrate', { json: {} });
    const skip = (m.json?.skipped ?? []).find((x) => x.department === 'Bad_Dept')?.reason;
    const made = (() => { const d = A.db(); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM areas WHERE id = 'Bad_Dept'").get().n); } finally { d.close(); } })();
    check(m.status === 200 && skip === 'id_invalid' && made === 0, 'D11 标识不合领域写法的部门（直接写库的）：迁移记 skipped id_invalid，不建领域', { s: m.status, skip, made });
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
