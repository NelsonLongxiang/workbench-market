#!/usr/bin/env node
/**
 * 驾驶舱谁能建、改、删（cockpit-access.ts），以及读应答里的 can.edit、/api/auth/me 的 can.create_cockpit。
 * 起隔离实例（假的登录提供方，NODE_ENV=test；合成口令；数据视图开着）。逐个身份核：
 *   一、读清单、读单个，can.edit 是多少：本机命令行、有效口令（远程、同源浏览器）、身份来源认的管理员 → true；
 *       远程匿名、口令不对、普通员工、带对的口令但浏览器从别的站点来 → false
 *   二、同一个身份真的去改一下（PUT 改名）：过得了门的就是 can.edit 为 true 的那几个，一个不多一个不少
 *   三、读不存在的驾驶舱照旧 404（处理函数改成异步之后，出错照样交给错误中间件）
 *   四、管理层（登录的人，没有管理员身份）：能建、能改共享的、能删；建的时候记下建立人，但读应答里不带；/api/auth/me 说能新建。
 *       普通员工、部门负责人（范围「全部」）：建、改都 403，什么都没改；AI 员工的预设里没有这三个动作。
 *       管理层授予一撤，这个人当场改不了——连他自己建的那个也改不了（建立人这次不单独给权）。
 *       管理层的授予仍是「只有属主能放行」那一档。
 *       改驾驶舱不带来看数据的权力：管理层把一份数据视图挂进驾驶舱之后，没有台权限的人取那份视图照样 403。
 *
 *   node scripts/cockpit-can-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'tmp', `cockpit-can-${process.pid}-${Date.now().toString(36)}`);
const TOKEN = 'synthetic-cockpit-can-admin';
let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
for (const d of ['data', 'home', 'ext']) mkdirSync(join(OUT, d), { recursive: true });
const env = {};
for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
Object.assign(env, { HOME: join(OUT, 'home'), PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: join(OUT, 'data'), NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: TOKEN, WM_BENCH_VIEWS: 'on', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext') });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
try {
  const end = Date.now() + 40000;
  for (;;) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 还没起来 */ } if (Date.now() > end || exited()) throw new Error(`实例没起来：${log.slice(-400)}`); await new Promise((r) => setTimeout(r, 200)); }
  const call = async (method, path, headers = {}, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, json };
  };
  const made = await call('POST', '/api/cockpits', {}, { name: '合成·权限舱' });
  const id = made.json?.id;
  check(made.status === 201 && Number.isInteger(id), '（准备）本机命令行建一个驾驶舱', made);
  // 让假提供方认出的人进主体表
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta, SESSIONS.noAdminFlag]) await call('GET', '/api/auth/viewer', { cookie: `session_id=${s}` });

  const REMOTE = { 'x-forwarded-for': '198.51.100.7' };
  const SAME = { origin: base, 'sec-fetch-site': 'same-origin' };
  const who = [
    ['本机命令行', {}, true],
    ['远程、有效口令', { ...REMOTE, 'x-admin-token': TOKEN }, true],
    ['同源浏览器、有效口令', { ...SAME, 'x-admin-token': TOKEN }, true],
    ['远程同源浏览器、身份来源认的管理员（没有口令）', { ...REMOTE, ...SAME, cookie: `session_id=${SESSIONS.admin}` }, true],
    ['远程匿名', REMOTE, false],
    ['远程、口令不对', { ...REMOTE, 'x-admin-token': 'not-the-token' }, false],
    ['远程同源浏览器、普通员工', { ...REMOTE, ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, false],
    ['浏览器从别的站点来、带着对的口令', { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site', 'x-admin-token': TOKEN }, false],
    ['本机但带浏览器标记、没有口令', SAME, false],
  ];

  console.log('一、读的应答里的 can.edit');
  for (const [name, h, want] of who) {
    const list = await call('GET', '/api/cockpits', h);
    const one = await call('GET', `/api/cockpits/${id}`, h);
    const inList = Array.isArray(list.json) ? list.json.find((c) => c.id === id) : null;
    check(list.status === 200 && one.status === 200 && inList?.can?.edit === want && one.json?.can?.edit === want && Object.keys(one.json.can).join() === 'edit',
      `${name}：清单和单个都读得到，can.edit 是 ${want}`, { list: list.status, one: one.status, inList: inList?.can, single: one.json?.can });
  }

  console.log('二、能不能改，和 can.edit 说的一样');
  const mismatch = [];
  for (const [name, h, want] of who) {
    const r = await call('PUT', `/api/cockpits/${id}`, h, { name: `合成·${name}` });
    if ((r.status === 200) !== want) mismatch.push({ name, status: r.status, want });
  }
  check(mismatch.length === 0, '每个身份：PUT 改名过得了门的，正好是 can.edit 为 true 的那几个', mismatch);

  console.log('三、出错照旧');
  const missing = await call('GET', '/api/cockpits/999999');
  check(missing.status === 404, '读不存在的驾驶舱：404', missing);
  const bad = await call('GET', '/api/cockpits/abc');
  check(bad.status === 404, '编号不是数字：404', bad);
  check(!exited(), '实例还活着（异步处理函数出错没有掀翻进程）');

  console.log('四、管理层能建能改；别的登录的人不能；撤了授予当场不能');
  // 授予：本机命令行（属主）起草、提交、放行
  const grant = async (principal, role) => { const d = await call('POST', '/api/grants', {}, { principal, role, scope: '*', reason: '合成：驾驶舱的写' }); const gid = d.json?.grant?.id; await call('POST', `/api/grants/${gid}/submit`); const a = await call('POST', `/api/grants/${gid}/approve`); return { id: gid, ok: a.status === 200 }; };
  const gB = await grant('user:beta', 'management');
  const gL = await grant('user:no-flag', 'dept-lead');
  check(gB.ok && gL.ok, '（准备）beta 拿到管理层授予、no-flag 拿到部门负责人授予（范围都是「全部」）', { gB, gL });
  const person = (s) => ({ ...REMOTE, ...SAME, cookie: `session_id=${s}` });
  const mgr = person(SESSIONS.beta), alpha = person(SESSIONS.alpha), lead = person(SESSIONS.noAdminFlag);
  const me = async (h) => (await call('GET', '/api/auth/me', h)).json?.can?.create_cockpit;
  const meSeen = { mgr: await me(mgr), alpha: await me(alpha), lead: await me(lead), anon: await me(REMOTE), cli: await me({}), token: await me({ ...REMOTE, 'x-admin-token': TOKEN }) };
  check(meSeen.mgr === true && meSeen.alpha === false && meSeen.lead === false && meSeen.anon === false && meSeen.cli === true && meSeen.token === true,
    '/api/auth/me 的 can.create_cockpit：管理层、本机命令行、管理口令能；普通员工、部门负责人、匿名不能', meSeen);
  const mine = await call('POST', '/api/cockpits', mgr, { name: '合成·管理层建的' });
  const db = new DatabaseSync(join(OUT, 'data', 'workbench-market.db'), { readOnly: true });
  const creator = (cid) => db.prepare('SELECT created_by FROM cockpits WHERE id = ?').get(cid)?.created_by;
  check(mine.status === 201 && creator(mine.json?.id) === 'user:beta' && !('created_by' in (mine.json ?? {})), '管理层建：201，记下建立人；应答里不带建立人', { s: mine.status, by: creator(mine.json?.id), keys: Object.keys(mine.json ?? {}) });
  const list = await call('GET', '/api/cockpits', mgr);
  check(list.status === 200 && list.json.every((c) => c.can?.edit === true && !('created_by' in c)), '管理层读清单：每一项 can.edit 都是 true，都不带建立人', list.json?.map((c) => [c.id, c.can, 'created_by' in c]));
  const shared = await call('PUT', `/api/cockpits/${id}`, mgr, { name: '合成·管理层改的共享舱' });
  check(shared.status === 200 && shared.json?.name === '合成·管理层改的共享舱', '管理层改共享的驾驶舱（本机命令行建的）：200', shared);
  const before = db.prepare('SELECT COUNT(*) AS n FROM cockpits').get().n;
  const tries = {
    alphaCreate: await call('POST', '/api/cockpits', alpha, { name: '不该建出来' }),
    alphaEdit: await call('PUT', `/api/cockpits/${mine.json?.id}`, alpha, { name: '不该改成' }),
    alphaDelete: await call('DELETE', `/api/cockpits/${mine.json?.id}`, alpha),
    leadCreate: await call('POST', '/api/cockpits', lead, { name: '不该建出来' }),
    leadEdit: await call('PUT', `/api/cockpits/${id}`, lead, { name: '不该改成' }),
    anonEdit: await call('PUT', `/api/cockpits/${id}`, REMOTE, { name: '不该改成' }),
    crossSite: await call('PUT', `/api/cockpits/${id}`, { ...REMOTE, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site', cookie: `session_id=${SESSIONS.beta}` }, { name: '不该改成' }),
  };
  const st = Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, `${v.status} ${v.json?.error ?? ''}`]));
  const after = db.prepare('SELECT COUNT(*) AS n FROM cockpits').get().n;
  const names = db.prepare('SELECT name FROM cockpits').all().map((r) => r.name);
  check(tries.alphaCreate.status === 403 && tries.alphaEdit.status === 403 && tries.alphaDelete.status === 403 && tries.alphaCreate.json?.error === 'cockpit_forbidden', '普通员工建、改、删别人建的：都是 403', st);
  check(tries.leadCreate.status === 403 && tries.leadEdit.status === 403, '部门负责人（范围「全部」，有读写拍板）建、改：403——驾驶舱的写不随普通的读写角色带出去', st);
  check(tries.anonEdit.status === 401 && tries.crossSite.status === 403, '远程匿名改：401；管理层的会话从别的站点来：403', st);
  check(after === before && !names.some((n) => n.startsWith('不该')), '被拒的这几次什么都没建、什么都没改', { before, after });
  const roles = (await call('GET', '/api/roles', {})).json?.roles ?? [];
  const role = (rid) => roles.find((r) => r.id === rid);
  const COCKPIT = ['cockpit.create', 'cockpit.update', 'cockpit.delete'];
  const named = (r) => (r?.permissions ?? []).flatMap((x) => x.actions ?? []);
  const kinds = (r) => (r?.permissions ?? []).flatMap((x) => x.kinds ?? []);
  check(COCKPIT.every((a) => named(role('management')).includes(a)) && role('management')?.approval === 'owner',
    '管理层的预设点名了这三个动作；管理层的授予仍是「只有属主能放行」那一档', { perms: role('management')?.permissions, approval: role('management')?.approval });
  check(role('ai-staff') && !kinds(role('ai-staff')).includes('admin') && !COCKPIT.some((a) => named(role('ai-staff')).includes(a)), 'AI 员工的预设：没有管理类，也没有点名这三个动作（席位建、改驾驶舱的判定一定是拒）', role('ai-staff')?.permissions);
  const seatJudge = await call('GET', '/api/principals/user%3Ano-flag/access?action=cockpit.update', {});
  check(seatJudge.json?.decision?.verdict === 'deny', '对照：判定说部门负责人改驾驶舱是 deny', seatJudge.json?.decision);

  // 改驾驶舱不带来看数据的权力：管理层登记一个台、挂一份视图进驾驶舱；alpha 取那份视图照样 403
  await call('POST', '/api/bench-views', mgr, { slug: 'synth-ck', title: '合成·驾驶舱台' });
  const mount = await call('PUT', `/api/cockpits/${mine.json?.id}`, mgr, { panels: [{ kind: 'bench-view', bench: 'synth-ck', view: 'board', tab: 'board' }] });
  const peek = await call('GET', '/api/bench-views/synth-ck/render?view=board', alpha);
  const ckAlpha = await call('GET', `/api/cockpits/${mine.json?.id}`, alpha);
  check(mount.status === 200 && ckAlpha.status === 200 && ckAlpha.json?.can?.edit === false && peek.status === 403, '管理层把一份视图挂进驾驶舱之后：普通员工看得到驾驶舱（can.edit 假），取那份视图照样 403', { mount: mount.status, ck: ckAlpha.status, peek: peek.status });

  // 撤掉管理层：当场改不了，连自己建的也改不了
  const rv = await call('POST', `/api/grants/${gB.id}/revoke`, {}, { reason: '合成：撤管理层' });
  const afterRevoke = { own: await call('PUT', `/api/cockpits/${mine.json?.id}`, mgr, { name: '撤了之后不该改成' }), shared: await call('PUT', `/api/cockpits/${id}`, mgr, { name: '撤了之后不该改成' }), create: await call('POST', '/api/cockpits', mgr, { name: '撤了之后不该建' }) };
  const canAfter = (await call('GET', `/api/cockpits/${mine.json?.id}`, mgr)).json?.can?.edit;
  check(rv.status === 200 && afterRevoke.own.status === 403 && afterRevoke.shared.status === 403 && afterRevoke.create.status === 403 && canAfter === false && (await me(mgr)) === false,
    '撤掉管理层授予：当场建不了、改不了共享的、连自己建的也改不了；can.edit、can.create_cockpit 当场变假', { rv: rv.status, own: afterRevoke.own.status, shared: afterRevoke.shared.status, create: afterRevoke.create.status, canAfter });
  db.close();
} catch (e) {
  fail++; console.log(`  ✗ ${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (!exited()) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  if (!exited()) child.kill('SIGKILL');
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* 删不掉只是留个临时目录 */ }
}
console.log(`cockpit-can-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
