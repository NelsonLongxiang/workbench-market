#!/usr/bin/env node
/**
 * 经验库（/api/knowledge）的对抗组。真实的 server/src/index.ts，ygl-trees 换成假的命令行（scripts/fixtures/ygl-library-fake.mjs，经 WM_YGL_CLI），
 * 身份来源是假提供方；只在 127.0.0.1 上，不访问任何外部系统，不读宿主的 ygl-trees 工作区。
 *
 *   一、同步：四类都进目录，按页取（假命令行每页 2 条），游标走完
 *   二、谁看得到哪条（规范 14：权限由授予给，关系只收窄）：
 *       匿名 401；管理口令 403；跨站 403；
 *       普通员工（范围「全部」的 member）：只看全公司的；
 *       部门负责人（member + dept:sales 的 dept-lead）：全公司的 + 销售部的；别的部门、只给管理层的看不到；
 *       身份来源的管理员（迁移出的 admin + member）：和普通员工一样，只看全公司的（系统管理员不看业务内容）；
 *       管理层：全部；
 *       看不到的详情和不存在的逐字相同（404）
 *   三、不露内部标识：任何应答里都没有 ygl-trees 的 id、工作区路径和假命令行塞的多余字段；证据里的 javascript: 地址不给
 *   四、范围的说法：全公司、部门名、只给管理层；bench:、空的、对不上写法的一律当只给管理层
 *   五、来源坏了：详情现取失败 503（不当成空）；ygl-trees 说没这一条，回 404 并从目录去掉；
 *       重启后同一个库，键不变
 *   七、没接入（命令行不在、版本太旧不认 library、list 失败、回的不是 JSON、契约版本不对、工作区没设）：启动照常、自检不红；
 *       接口回空列表和 source=not_connected（不带原因）；管理员看得到原因；同一个原因只告警一次
 *   六、同步状态只给管理员：管理口令、本机命令行（属主）、系统管理员预设（身份来源的管理员第一次来就迁移出来）看得到；管理层、普通员工 403
 *
 *   node scripts/knowledge-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `knowledge-test-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const FAKE_CLI = join(HERE, 'fixtures', 'ygl-library-fake.mjs');
const ADMIN_TOKEN = 'synthetic-knowledge-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.64' };
const token = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };
const SECRET_IDS = ['claimSECRET1', 'noteSECRETstar', 'noteSECRETsales', 'noteSECRETops', 'noteSECRETrestr', 'noteSECRETempty', 'noteSECRETweird', 'skillSECRETbench', 'checkSECRET1'];

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = (m) => `2026-11-${String(10 + m).padStart(2, '0')}T08:00:00Z`;
const FIXTURE = {
  page_size: 2,
  items: {
    claim: [{ kind: 'claim', id: 'claimSECRET1', title: '合成依据：样品要复检', summary: '复核过的结论', status: 'supported', project: 'syn-project', created: T(0), updated: T(1) }],
    note: [
      { kind: 'note', id: 'noteSECRETstar', title: '合成经验：全公司', summary: '人人可见', scope: '*', tags: ['market'], created: T(0), updated: T(2) },
      { kind: 'note', id: 'noteSECRETsales', title: '合成经验：销售部', summary: '销售部可见', scope: 'dept:sales', created: T(0), updated: T(3) },
      { kind: 'note', id: 'noteSECRETops', title: '合成经验：运营部', summary: '运营部可见', scope: 'dept:ops', created: T(0), updated: T(4) },
      { kind: 'note', id: 'noteSECRETrestr', title: '合成经验：只给管理层', summary: '', scope: 'restricted', created: T(0), updated: T(5) },
      { kind: 'note', id: 'noteSECRETempty', title: '合成经验：没有范围', summary: '', created: T(0), updated: T(6) },
      { kind: 'note', id: 'noteSECRETweird', title: '合成经验：怪范围', summary: '', scope: 'team:x', created: T(0), updated: T(7) },
    ],
    skill: [{ kind: 'skill', id: 'skillSECRETbench', title: '合成方法', summary: '台范围', scope: 'bench:wb-1', created: T(0), updated: T(8) }],
    check: [{ kind: 'check', id: 'checkSECRET1', title: '合成检查', summary: '3 过 0 败', status: 'PASS', created: T(0), updated: T(9) }],
  },
  bodies: {
    'note:noteSECRETstar': { body: '# 合成正文\n以后照这样办。', yglhome_path: '/srv/SECRET-PATH', hits: 99 },
    'claim:claimSECRET1': { body: '断言正文', evidence: [
      { quote: '原文摘录', note: '解读', stance: 'support', created: T(0), source: { title: '合成来源', url: 'https://example.invalid/a' }, session: 'SECRET-SESSION' },
      { quote: '坏地址', note: '', stance: 'oppose', created: T(0), source: { title: '坏', url: 'javascript:alert(1)' } },
      { quote: '本机文件', note: '', stance: 'oppose', created: T(0), source: { title: '本机', url: 'file:///etc/hosts' } },
    ] },
  },
};

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
async function boot(name, fixture, { data, env: extraEnv = {}, dropEnv = [] } = {}) {
  const port = await freePort();
  const dir = join(OUT, name), home = join(dir, 'home'), ygl = join(dir, 'ygl');
  const dataDir = data ?? join(dir, 'data');
  for (const d of [dataDir, home, ygl]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ygl, 'library-fixture.json'), JSON.stringify(fixture));
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT,
    WM_YGL_CLI: FAKE_CLI, YGL_HOME: ygl, WM_KNOWLEDGE_SYNC_MINUTES: '1', ...extraEnv });
  for (const k of dropEnv) delete env[k];
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  // 等第一轮同步做完（启动自检通过后开始）：管理员看同步状态，四类都成过一次，或者都有失败原因
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    const st = (await call('GET', '/api/knowledge/status', { headers: token })).json?.kinds ?? [];
    if (st.length === 4 && st.every((k) => k.last_ok_at !== null || k.last_error)) break;
    await sleep(200);
  }
  return { host: new URL(base).host, call, ygl, dataDir, log: () => log };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const srv = await boot('main', FIXTURE);
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const as = (s) => ({ headers: { ...REMOTE, ...same }, session: s });
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta, SESSIONS.noAdminFlag]) await srv.call('GET', '/api/auth/viewer', { session: s });
  // 本机命令行（属主）建部门、发授予：alpha 普通员工；beta 普通员工 + 销售部负责人；root-admin 迁移出的系统管理员 + 普通员工；no-flag 管理层
  await srv.call('PUT', '/api/departments/sales', { body: { name: '合成销售部' } });
  await srv.call('PUT', '/api/departments/ops', { body: { name: '合成运营部' } });
  const issue = async (principal, role, scope) => { const d = await srv.call('POST', '/api/grants', { body: { principal, role, scope, reason: '合成：经验库对抗' } }); await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`); return (await srv.call('POST', `/api/grants/${d.json?.grant?.id}/approve`)).status; };
  const issued = [await issue('user:alpha', 'member', '*'), await issue('user:beta', 'member', '*'), await issue('user:beta', 'dept-lead', 'dept:sales'),
    await issue('user:root-admin', 'member', '*'), await issue('user:root-admin', 'admin', '*'), await issue('user:no-flag', 'management', '*')];
  const titles = (r) => (r.json?.items ?? []).map((i) => i.title).sort();
  const list = async (who) => srv.call('GET', '/api/knowledge', who);

  // ---------- 一、同步 ----------
  {
    const st = (await srv.call('GET', '/api/knowledge/status', { headers: token })).json?.kinds ?? [];
    const by = Object.fromEntries(st.map((k) => [k.kind, k]));
    check(issued.every((s) => s === 200) && by.claim?.items === 1 && by.note?.items === 6 && by.skill?.items === 1 && by.check?.items === 1 && st.every((k) => k.last_ok_at && !k.last_error),
      '同步：四类都进了目录（经验 6 条按每页 2 条翻了 3 页），没有失败', show({ issued, st }));
  }

  // ---------- 二、谁看得到哪条 ----------
  const all = (await list(as(SESSIONS.noAdminFlag)));
  const keyOf = (t) => all.json?.items?.find((i) => i.title === t)?.key;
  {
    const anon = await list({ headers: REMOTE });
    const tok = await list({ headers: token });
    const cross = await list({ headers: { ...REMOTE, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }, session: SESSIONS.noAdminFlag });
    // 只带 Sec-Fetch-Site、不带 Origin 的跨站（浏览器的简单 GET 就是这样）：靠 sec-fetch-site 那一支拦
    const crossSf = await list({ headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: SESSIONS.noAdminFlag });
    const a = await list(as(SESSIONS.alpha)), b = await list(as(SESSIONS.beta)), r = await list(as(SESSIONS.admin));
    check(anon.status === 401 && tok.status === 403 && tok.json?.error === 'knowledge_admin_token_denied' && cross.status === 403 && crossSf.status === 403 && crossSf.json?.error === 'knowledge_cross_origin_denied',
      '匿名 401；管理口令 403（经验是业务内容）；跨站 403（带 Origin 的、只带 Sec-Fetch-Site 的都拦）', show({ anon: anon.status, tok: [tok.status, tok.json?.error], cross: cross.status, crossSf: crossSf.status }));
    check(show(titles(a)) === show(['合成经验：全公司']) && show(titles(r)) === show(['合成经验：全公司']),
      '普通员工、身份来源的管理员（迁移出的 admin + member）：只看得到全公司的', show({ alpha: titles(a), rootAdmin: titles(r) }));
    check(show(titles(b)) === show(['合成经验：全公司', '合成经验：销售部']),
      '销售部负责人：全公司的 + 销售部的；运营部的、只给管理层的看不到（范围「全部」的 member 不让人看到每个部门的）', show(titles(b)));
    check(all.status === 200 && (all.json?.items ?? []).length === 9 && all.json?.source === 'ok', '管理层：九条全看得到', show(titles(all)));
    // 看不到的详情和不存在的逐字一样
    const hidden = await srv.call('GET', `/api/knowledge/${keyOf('合成经验：销售部')}`, as(SESSIONS.alpha));
    const ghost = await srv.call('GET', '/api/knowledge/AAAAAAAAAAAAAAAAAAAAAA', as(SESSIONS.alpha));
    const junk = await srv.call('GET', '/api/knowledge/..%2F..%2Fetc', as(SESSIONS.alpha));
    const okDetail = await srv.call('GET', `/api/knowledge/${keyOf('合成经验：销售部')}`, as(SESSIONS.beta));
    check(hidden.status === 404 && hidden.text === ghost.text && ghost.status === 404 && junk.status === 404 && okDetail.status === 200,
      '看不到的详情和不存在的、写法不对的键，一样回 404、应答逐字相同；看得到的人 200', show({ hidden: [hidden.status, hidden.text], ghost: ghost.text, junk: junk.status, ok: okDetail.status }));
    const kb = await srv.call('GET', '/api/knowledge?kind=kb', as(SESSIONS.noAdminFlag));
    const bad = await srv.call('GET', '/api/knowledge?kind=note', as(SESSIONS.noAdminFlag));
    const badAnon = await srv.call('GET', '/api/knowledge?kind=note', { headers: REMOTE });
    check((kb.json?.items ?? []).length === 6 && kb.json.items.every((i) => i.kind === 'kb') && bad.status === 400 && badAnon.status === 401,
      '按类筛：kind=kb 只给经验；页面的四类之外（比如 ygl-trees 自己的 note）400；匿名带坏参数照样 401（先认人）', show({ kb: (kb.json?.items ?? []).length, bad: bad.status, badAnon: badAnon.status }));
  }

  // ---------- 三、不露内部标识 ----------
  {
    const texts = [all.text, (await srv.call('GET', `/api/knowledge/${keyOf('合成经验：全公司')}`, as(SESSIONS.alpha))).text, (await srv.call('GET', `/api/knowledge/${keyOf('合成依据：样品要复检')}`, as(SESSIONS.noAdminFlag))).text];
    const leaked = SECRET_IDS.filter((id) => texts.some((t) => t.includes(id)));
    const extra = ['SECRET-PATH', 'SECRET-SESSION', 'hits', 'yglhome', srv.ygl].filter((w) => texts.some((t) => t.includes(w)));
    const claim = JSON.parse(texts[2]);
    check(leaked.length === 0 && extra.length === 0 && claim.evidence?.length === 3 && claim.evidence[0].source?.url === 'https://example.invalid/a' && claim.evidence[1].source?.url === null && claim.evidence[2].source?.url === null
      && JSON.parse(texts[1]).body.includes('以后照这样办') && (all.json?.items ?? []).every((i) => /^[A-Za-z0-9_-]{22}$/.test(i.key)),
      '不露内部标识：列表、详情里没有 ygl-trees 的 id、工作区路径、多余字段；键是不透明的 22 位；证据的 javascript:、file: 地址不给（只放 http/https）',
      show({ leaked, extra, ev: claim.evidence }));
  }

  // ---------- 四、范围的说法 ----------
  {
    const label = Object.fromEntries((all.json?.items ?? []).map((i) => [i.title, i.scope_label]));
    check(label['合成经验：全公司'] === '全公司' && label['合成经验：销售部'] === '合成销售部' && ['合成经验：只给管理层', '合成经验：没有范围', '合成经验：怪范围', '合成方法', '合成检查', '合成依据：样品要复检'].every((t) => label[t] === '只给管理层'),
      '范围的说法：全公司、部门名（不露 dept:）；没给范围的、bench:、对不上写法的、依据和检查（没有范围）一律只给管理层', show(label));
  }

  // ---------- 五、来源坏了 ----------
  {
    const starKey = keyOf('合成经验：全公司'), salesKey = keyOf('合成经验：销售部');
    writeFileSync(join(srv.ygl, 'library-fixture.json'), JSON.stringify({ ...FIXTURE, show_fail: 'exit2' }));
    const down = await srv.call('GET', `/api/knowledge/${starKey}`, as(SESSIONS.alpha));
    writeFileSync(join(srv.ygl, 'library-fixture.json'), JSON.stringify({ ...FIXTURE, show_fail: 'gone' }));
    const gone = await srv.call('GET', `/api/knowledge/${salesKey}`, as(SESSIONS.beta));
    const after = titles(await list(as(SESSIONS.beta)));
    check(down.status === 503 && down.json?.error === 'knowledge_unavailable' && gone.status === 404 && !after.includes('合成经验：销售部'),
      '详情现取失败回 503（不当成空）；ygl-trees 说没这一条，回 404 并从目录去掉', show({ down: down.status, gone: gone.status, after }));
    // 六、同步状态只给管理员
    const stOf = async (o) => (await srv.call('GET', '/api/knowledge/status', o)).status;
    const stm = { token: await stOf({ headers: token }), localCli: await stOf({}), rootAdmin: await stOf(as(SESSIONS.admin)), mgmt: await stOf(as(SESSIONS.noAdminFlag)), alpha: await stOf(as(SESSIONS.alpha)),
      anon: await stOf({ headers: REMOTE }), crossSf: await stOf({ headers: { ...token, 'sec-fetch-site': 'cross-site' } }) };
    check(show(stm) === show({ token: 200, localCli: 200, rootAdmin: 200, mgmt: 403, alpha: 403, anon: 401, crossSf: 403 }),
      '同步状态按统一判定（管理类）：管理口令、本机命令行（属主）、持系统管理员预设的人看得到；管理层、普通员工 403；匿名 401；跨站 403', show(stm));
    await stop();
    // 重启：同一个库，键不变；顺带全量对账——ygl-trees 那边删掉了运营部那条，重启后到了全量的时候，目录里要去掉
    {
      const kdb = new DatabaseSync(join(srv.dataDir, 'workbench-market.db'), { timeout: 5000 });
      try { kdb.prepare("UPDATE knowledge_sync SET last_full_at = NULL WHERE kind = 'note'").run(); } finally { kdb.close(); }
    }
    const dropped = { ...FIXTURE, items: { ...FIXTURE.items, note: FIXTURE.items.note.filter((n) => n.id !== 'noteSECRETops') } };
    const again = await boot('main-again', dropped, { data: srv.dataDir });
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      const note = ((await again.call('GET', '/api/knowledge/status', { headers: token })).json?.kinds ?? []).find((k) => k.kind === 'note');
      if (note?.last_full_at) break;
      await sleep(200);
    }
    const againList = (await again.call('GET', '/api/knowledge', { headers: { ...REMOTE, origin: `http://${again.host}`, 'sec-fetch-site': 'same-origin' }, session: SESSIONS.noAdminFlag })).json?.items ?? [];
    const keyAgain = againList.find((i) => i.title === '合成经验：全公司')?.key;
    check(keyAgain === starKey, '重启后同一个库，同一条的键不变（密钥存在库里）', show({ keyAgain, starKey }));
    check(!againList.some((i) => i.title === '合成经验：运营部') && againList.some((i) => i.title === '合成经验：只给管理层'),
      '全量对账：ygl-trees 那边删掉的条目，全量同步后从目录去掉；还在的照留', show(againList.map((i) => i.title)));
    await stop();
  }
  // ---------- 七、没接入：ygl-trees 不在、太旧、契约不对、工作区没设——启动不受影响、自检不红，接口照常回空列表加「未接入」，同一个原因只告警一次 ----------
  const cases = [
    ['exit2', { ...FIXTURE, fail: 'exit2' }, {}, [], 'exit'],
    ['notjson', { ...FIXTURE, fail: 'notjson' }, {}, [], 'not_json'],
    ['contract', { ...FIXTURE, contract: 'ygl-library/2' }, {}, [], 'contract_unsupported'],
    ['old-cli', { ...FIXTURE, fail: 'unknowncmd' }, {}, [], 'exit'],
    ['no-cli', FIXTURE, { WM_YGL_CLI: join(OUT, 'nowhere', 'bin.cjs') }, [], 'no_cli'],
    ['no-home', FIXTURE, {}, ['YGL_HOME'], 'no_home'],
  ];
  for (const [mode, fixture, env, drop, want] of cases) {
    const bad = await boot(`bad-${mode}`, fixture, { env, dropEnv: drop });
    const sameB = { origin: `http://${bad.host}`, 'sec-fetch-site': 'same-origin' };
    const health = await bad.call('GET', '/api/health');
    const l = await bad.call('GET', '/api/knowledge', { headers: { ...REMOTE, ...sameB }, session: SESSIONS.noAdminFlag });
    const st = (await bad.call('GET', '/api/knowledge/status', { headers: token })).json?.kinds ?? [];
    const warns = bad.log().split('\n').filter((line) => line.includes('[knowledge] 经验库这一轮没同步上'));
    check(health.status === 200 && !bad.log().includes('startup-refused') && /"id":"market\.knowledge\.anonymous-read"[^}]*"verdict":"pass"/.test(bad.log())
      && l.status === 200 && (l.json?.items ?? []).length === 0 && l.json?.source === 'not_connected' && !l.text.includes(want)
      && st.every((k) => k.last_error === want) && warns.length === 1 && !warns[0].includes(bad.ygl),
      `没接入（${mode}）：启动照常、自检不红；接口回空列表、source=not_connected、不带原因；管理员看得到原因 ${want}；四类同一个原因只告警一次、不带路径`,
      show({ health: health.status, status: l.status, source: l.json?.source, errors: st.map((k) => k.last_error), warns }));
    if (mode === 'exit2') {
      // 全新的库、谁都没发过授予：同步状态（没接入时管理员要靠它看原因）三种管理身份都看得到——
      // 本机命令行（属主）；身份来源说是管理员的人（第一次见到时迁移出 admin 预设，不用等别处先触发迁移）；管理口令。普通员工照样 403
      const stOf = async (o) => (await bad.call('GET', '/api/knowledge/status', o)).status;
      const fresh = { localCli: await stOf({}), odooAdmin: await stOf({ headers: { ...REMOTE, ...sameB }, session: SESSIONS.admin }), token: await stOf({ headers: token }),
        alpha: await stOf({ headers: { ...REMOTE, ...sameB }, session: SESSIONS.alpha }) };
      check(show(fresh) === show({ localCli: 200, odooAdmin: 200, token: 200, alpha: 403 }),
        '全新的库：本机命令行、身份来源的管理员（当场迁移出系统管理员预设）、管理口令都看得到同步状态；普通员工 403', show(fresh));
    }
    await stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  await stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`knowledge-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
