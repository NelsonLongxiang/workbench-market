#!/usr/bin/env node
/**
 * 自定义角色（对抗组）：从内置预设复制、改、删、属主放行、导出。
 *   · 内置预设、声明文件里的角色不能在界面上改；不能和任何角色重名（id 或名字）；
 *   · 带来管理类或决定类权限的建和改要属主放行（口令管理员建的先待放行、改的先记成提议，放行前不生效）；
 *   · 从 AI 员工复制出来的不许带决定类；有授予在用的不能删；改动告诉你会影响哪些授予；
 *   · 声明文件里的优先：重启后声明文件用了同一个 id 的，库里的自定义角色不加载；每一步都留痕；导出成声明文件的格式。
 * 只在本机起隔离实例，不访问任何外部系统。
 *   node scripts/custom-roles-smoke.mjs              测本仓库
 *   node scripts/custom-roles-smoke.mjs --root DIR   测另一棵目录树
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `custom-roles-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-custom-roles-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.95' };
const TOKEN = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };
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

const data = join(OUT, 'data'), home = join(OUT, 'home');
mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
const running = [];
async function boot(extraEnv = {}) {
  const port = await freePort();
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, REDIS_URL: '', ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (!ready) { await stop(); throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-3).join(' | ')}`); }
  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json };
  };
  const srv = { call, stop, log: () => log };
  running.push(srv);
  return srv;
}

try {
  const rolesFile = join(OUT, 'roles.json');
  writeFileSync(rolesFile, JSON.stringify({ roles: [{ id: 'buyer', name: '采购专员', permissions: [{ kinds: ['read'] }] }] }));
  let srv = await boot({ WM_ROLES_FILE: rolesFile });
  // 种两个人，后面起草授予用
  { const db = new DatabaseSync(join(data, 'workbench-market.db')); try { db.exec('PRAGMA busy_timeout=5000'); for (const p of ['user:amy', 'user:ben']) db.prepare("INSERT INTO principals (id, id_key, kind) VALUES (?, ?, 'person')").run(p, p); db.prepare("INSERT INTO principals (id, id_key, kind, owner) VALUES ('seat:bot', 'seat:bot', 'seat', 'user:amy')").run(); } finally { db.close(); } }

  // ---------- 一、锁住的和重名的 ----------
  {
    const preset = await srv.call('PUT', '/api/roles/admin', {}, { name: '改个名' });
    const declared = await srv.call('PUT', '/api/roles/buyer', {}, { name: '改个名' });
    const delPreset = await srv.call('DELETE', '/api/roles/owner');
    const clashId = await srv.call('POST', '/api/roles/member/copy', {}, { id: 'buyer', name: '别的名字' });
    const clashName = await srv.call('POST', '/api/roles/member/copy', {}, { id: 'buyer2', name: '采购专员' });
    const clashPresetName = await srv.call('POST', '/api/roles/member/copy', {}, { id: 'emp2', name: '普通员工' });
    check(preset.status === 403 && declared.status === 403 && delPreset.status === 403 && clashId.status === 409 && clashName.status === 409 && clashPresetName.status === 409,
      '内置预设、声明文件里的角色不能改不能删（403）；新角色和内置、声明文件里的重名（id 或名字）409', show({ preset: preset.status, declared: declared.status, delPreset: delPreset.status, clashId: clashId.status, clashName: clashName.status, clashPresetName: clashPresetName.status }));
  }
  // ---------- 二、属主放行 ----------
  {
    const byToken = await srv.call('POST', '/api/roles/management/copy', TOKEN, { id: 'exec-copy', name: '管理层副本' });
    const usable = await srv.call('POST', '/api/grants', {}, { principal: 'user:amy', role: 'exec-copy', scope: '*', reason: '合成' });
    const approveByToken = await srv.call('POST', '/api/roles/exec-copy/approve', TOKEN);
    const approved = await srv.call('POST', '/api/roles/exec-copy/approve');
    const usableAfter = await srv.call('POST', '/api/grants', {}, { principal: 'user:amy', role: 'exec-copy', scope: '*', reason: '合成' });
    check(byToken.status === 201 && byToken.json?.role?.status === 'pending' && usable.status === 422 && approveByToken.status === 403 && approved.status === 200 && usableAfter.status === 201,
      '口令管理员复制带决定类的预设：先待属主放行，放行前不能授予；口令放行 403，属主（本机命令行）放行后能授予 [red-line:custom-roles-owner-approval]', show({ byToken: byToken.json?.role?.status, usable: usable.status, approveByToken: approveByToken.status, approved: approved.status, usableAfter: usableAfter.status }));
    // 读的角色改成带管理类：口令管理员改的先记成提议，生效的定义不动
    const reader = await srv.call('POST', '/api/roles/guest/copy', TOKEN, { id: 'reader', name: '只读' });
    const widen = await srv.call('PUT', '/api/roles/reader', TOKEN, { permissions: [{ kinds: ['read', 'admin'] }] });
    const listed = (await srv.call('GET', '/api/roles')).json?.roles?.find((r) => r.id === 'reader');
    check(reader.status === 201 && reader.json?.role?.status === 'active' && widen.status === 200 && widen.json?.pending === true && widen.json?.role?.proposed && JSON.stringify(listed?.permissions) === '[]',
      '不带管理、决定的复制直接生效；口令管理员把它改成带管理类：只记成提议，生效的定义不变，等属主放行', show({ reader: reader.json?.role?.status, pending: widen.json?.pending, live: listed?.permissions }));
  }
  // ---------- 三、AI 员工的副本不许带决定类；改动告诉你影响哪些授予；在用的不能删 ----------
  {
    const ai = await srv.call('POST', '/api/roles/ai-staff/copy', {}, { id: 'bot-plus', name: 'AI 员工加强' });
    const withDecide = await srv.call('PUT', '/api/roles/bot-plus', {}, { permissions: [{ kinds: ['read', 'write', 'decide'] }] });
    const g = await srv.call('POST', '/api/grants', {}, { principal: 'seat:bot', role: 'bot-plus', scope: '*', reason: '合成' });
    const narrow = await srv.call('PUT', '/api/roles/bot-plus', {}, { permissions: [{ kinds: ['read'] }] });
    const del = await srv.call('DELETE', '/api/roles/bot-plus');
    check(ai.status === 201 && withDecide.status === 422 && withDecide.json?.error === 'decide_non_person' && g.status === 201
      && narrow.status === 200 && narrow.json?.affected_grants?.some((x) => x.id === g.json?.grant?.id) && del.status === 409 && del.json?.grants?.length === 1,
      'AI 员工复制出来的加决定类 422；改动的应答列出会影响的授予；有授予在用（草稿也算）的删不掉 409，并列出是哪几条', show({ withDecide: withDecide.status, affected: narrow.json?.affected_grants?.length, del: del.status }));
  }
  // ---------- 二之二、碰业务的自定义角色要属主放行 ----------
  {
    const biz = await srv.call('POST', '/api/roles/guest/copy', TOKEN, { id: 'biz-writer', name: '业务写手' });
    const widen = await srv.call('PUT', '/api/roles/biz-writer', TOKEN, { permissions: [{ kinds: ['write'], domains: ['app-data'] }] });
    const live = (await srv.call('GET', '/api/roles', TOKEN)).json?.roles?.find((r) => r.id === 'biz-writer');
    const memberCopy = await srv.call('POST', '/api/roles/member/copy', TOKEN, { id: 'member-copy', name: '员工副本' });
    const sysOnly = await srv.call('POST', '/api/roles/guest/copy', TOKEN, { id: 'sys-reader', name: '只看设置' });
    const sysWiden = await srv.call('PUT', '/api/roles/sys-reader', TOKEN, { permissions: [{ kinds: ['read'], domains: ['setting'] }] });
    const ownerOk = await srv.call('POST', '/api/roles/biz-writer/approve');
    const liveAfter = (await srv.call('GET', '/api/roles', TOKEN)).json?.roles?.find((r) => r.id === 'biz-writer');
    check(biz.status === 201 && biz.json?.pending === false && widen.status === 200 && widen.json?.pending === true && !!widen.json?.role?.proposed && JSON.stringify(live?.permissions) === '[]'
      && memberCopy.status === 201 && memberCopy.json?.pending === true && sysWiden.status === 200 && sysWiden.json?.pending === false
      && ownerOk.status === 200 && JSON.stringify(liveAfter?.permissions) === JSON.stringify([{ kinds: ['write'], domains: ['app-data'] }]),
      '碰业务的自定义角色要属主放行：口令管理员把访客的副本改成带业务域的写，只记成提议、生效的定义还是空的；复制普通员工（带业务读）先待属主放行；只碰系统域的照常生效；属主放行之后才生效 [red-line:business-roles-owner-approval]',
      JSON.stringify({ widen: widen.json, live: live?.permissions, memberCopy: memberCopy.json?.pending, sysWiden: sysWiden.json, liveAfter: liveAfter?.permissions }));
  }
  // ---------- 三之二、复制几层都算 AI 员工的副本；删掉中间一层，来源链也不断 ----------
  {
    const x1 = await srv.call('POST', '/api/roles/ai-staff/copy', {}, { id: 'ai-x1', name: 'AI 一层' });
    const x2 = await srv.call('POST', '/api/roles/ai-x1/copy', {}, { id: 'ai-x2', name: 'AI 两层' });
    const twoLevels = await srv.call('PUT', '/api/roles/ai-x2', {}, { permissions: [{ kinds: ['read', 'decide'] }] });
    const delMiddle = await srv.call('DELETE', '/api/roles/ai-x1');
    const afterDelete = await srv.call('PUT', '/api/roles/ai-x2', {}, { permissions: [{ kinds: ['read', 'decide'] }] });
    const plain = await srv.call('POST', '/api/roles/member/copy', {}, { id: 'not-ai', name: '不是 AI 的副本' });
    const plainDecide = await srv.call('PUT', '/api/roles/not-ai', {}, { permissions: [{ kinds: ['read', 'decide'] }] });
    check(x1.status === 201 && x2.status === 201 && twoLevels.status === 422 && twoLevels.json?.error === 'decide_non_person'
      && delMiddle.status === 200 && afterDelete.status === 422 && plainDecide.status === 200,
      'AI 员工复制两层（ai-staff → ai-x1 → ai-x2）再加决定类照样 422；删掉中间一层之后还是 422（来源接到上一层）；不是从 AI 员工来的照常 [red-line:ai-copies-no-decide]',
      show({ twoLevels: twoLevels.status, delMiddle: delMiddle.status, afterDelete: afterDelete.status, plain: plainDecide.status }));
  }
  // ---------- 四、留痕、导出 ----------
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
    let events = [];
    try { events = db.prepare("SELECT role_id, event, actor FROM custom_role_events ORDER BY seq").all(); } finally { db.close(); }
    const kinds = events.map((e) => `${e.role_id}:${e.event}`);
    const exp = await srv.call('GET', '/api/roles/export');
    check(['exec-copy:create', 'exec-copy:approve', 'reader:create', 'reader:propose', 'bot-plus:create', 'bot-plus:update'].every((k) => kinds.includes(k)) && events.every((e) => e.actor)
      && Array.isArray(exp.json?.roles) && exp.json.roles.some((r) => r.id === 'exec-copy') && exp.json.roles.every((r) => Object.keys(r).sort().join() === 'id,name,permissions'),
      '每次建、提议、改、放行都留痕（带是谁）；导出成声明文件的格式（{ roles: [{ id, name, permissions }] }，只含生效的）', show({ kinds }));
  }
  // ---------- 五、声明文件优先 ----------
  {
    await srv.stop();
    writeFileSync(rolesFile, JSON.stringify({ roles: [{ id: 'buyer', name: '采购专员', permissions: [{ kinds: ['read'] }] }, { id: 'exec-copy', name: '声明文件里的管理层副本', permissions: [{ kinds: ['read'] }] }] }));
    srv = await boot({ WM_ROLES_FILE: rolesFile });
    const role = (await srv.call('GET', '/api/roles')).json?.roles?.find((r) => r.id === 'exec-copy');
    check(role?.name === '声明文件里的管理层副本' && role?.custom === false && /custom-role-shadowed/.test(srv.log()),
      '声明文件后来用了同一个 id：重启后以声明文件为准，库里的自定义角色不加载，留一行痕', show({ name: role?.name, custom: role?.custom }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`custom-roles-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
