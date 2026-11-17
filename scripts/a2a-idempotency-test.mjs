#!/usr/bin/env node
/**
 * /a2a/direct 幂等登记落库（阶段七第 2 步）。
 *
 * 一、服务层（直接调 services/a2a-idempotency.ts，假时钟）：fresh / replay / conflict；30 分钟窗口的边界；
 *    过期后同一 task_id 重新算 fresh；库里只存指纹的 sha256，不存消息原文。
 * 二、HTTP（专用实例，同一个 DATA_DIR 重启一次）：重启前登记的 task_id，重启后同 payload 仍 409 -32003、
 *    异 payload 仍 409 -32002。
 * 三、对抗组：没有绑定的来源（unbound）只当数据——拿同一个 task_id 打过来一律 404，既不占用 task_id，
 *    也不能借 409 探出某个 task_id 是否被用过。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:net';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const UNIT_DATA = resolve('tmp/a2a-idem-unit');
const HTTP_DATA = 'tmp/a2a-idem-http';
rmSync(UNIT_DATA, { recursive: true, force: true });
mkdirSync(UNIT_DATA, { recursive: true });
rmSync(HTTP_DATA, { recursive: true, force: true });
mkdirSync(HTTP_DATA, { recursive: true });

// ---------- 一、服务层 ----------
console.log('一、服务层');
{
  process.env.DATA_DIR = UNIT_DATA;
  let svc = null;
  try { svc = await import('../server/src/services/a2a-idempotency.ts'); } catch (e) { ok('services/a2a-idempotency.ts 可加载', false, String(e?.message ?? e).slice(0, 160)); }
  if (svc) {
    const { claimA2aTask, A2A_IDEM_TTL_MS } = svc;
    const { db } = await import('../server/src/db.ts');
    const T0 = 1_000_000_000_000;
    ok('窗口仍是 30 分钟', A2A_IDEM_TTL_MS === 30 * 60 * 1000);
    ok('首次 → fresh', claimA2aTask('t-1', 'fp-a', T0) === 'fresh');
    ok('同 id 同指纹 → replay', claimA2aTask('t-1', 'fp-a', T0 + 1) === 'replay');
    ok('同 id 异指纹 → conflict', claimA2aTask('t-1', 'fp-b', T0 + 2) === 'conflict');
    ok('conflict 不改登记（原指纹仍判 replay）', claimA2aTask('t-1', 'fp-a', T0 + 3) === 'replay');
    ok('别的 id 互不影响', claimA2aTask('t-2', 'fp-a', T0 + 4) === 'fresh');
    ok('窗口边界（恰好 30 分钟）仍 replay', claimA2aTask('t-1', 'fp-a', T0 + A2A_IDEM_TTL_MS) === 'replay');
    ok('过窗口 → 同 id 重新 fresh', claimA2aTask('t-1', 'fp-b', T0 + A2A_IDEM_TTL_MS + 1) === 'fresh');
    ok('过窗口后的新登记按新指纹判', claimA2aTask('t-1', 'fp-b', T0 + A2A_IDEM_TTL_MS + 2) === 'replay');
    claimA2aTask('t-secret', 'team\u0000dsh/x\u0000机密原文-不该落库', T0 + A2A_IDEM_TTL_MS + 5);
    const rows = db.prepare('SELECT * FROM a2a_idempotency').all();
    ok('过期行在下次登记时清掉（t-2 已过窗口，t-1 新登记还在）', !rows.some((r) => r.task_id === 't-2') && rows.some((r) => r.task_id === 't-1'), JSON.stringify(rows));
    // 孤代理：utf8 编码会把两者都变成 U+FFFD；指纹必须仍然不同（旧的 Map 比原串，判 conflict）
    ok('只差一个孤代理的两条消息 → fresh 然后 conflict', claimA2aTask('t-sur', 'team\u0000dsh/x\u0000msg\ud800', T0 + A2A_IDEM_TTL_MS + 6) === 'fresh' && claimA2aTask('t-sur', 'team\u0000dsh/x\u0000msg\udc00', T0 + A2A_IDEM_TTL_MS + 7) === 'conflict');
    ok('……同一个孤代理串重发仍是 replay', claimA2aTask('t-sur', 'team\u0000dsh/x\u0000msg\ud800', T0 + A2A_IDEM_TTL_MS + 8) === 'replay');
    const raw = JSON.stringify(db.prepare('SELECT * FROM a2a_idempotency').all());
    ok('库里不存消息原文，只存 sha256', !raw.includes('机密原文') && /"fp_sha256":"[0-9a-f]{64}"/.test(raw), raw.slice(0, 200));
  }
}

// ---------- 二、三：HTTP 重启 + 对抗组 ----------
async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const reserve = createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r)); const PORT = reserve.address().port; await new Promise((r) => reserve.close(r));
const BASE = `http://127.0.0.1:${PORT}`;
const gh = await startFakeGithub();
function boot() {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: `../${HTTP_DATA}`, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', ADMIN_TOKEN: 'idem-admin-tok', WM_GITHUB_API: gh.api },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
const ADMIN = { 'X-Admin-Token': 'idem-admin-tok' };
const CALLER = 'dsh/1a2b3c4d';
const START = JSON.stringify({ sop: { action: 'start' } });

let child = boot();
try {
  console.log('二、重启后仍判 replay / conflict');
  if (!(await waitReady(BASE + '/api/health'))) throw new Error('实例未就绪（20s 超时）');
  const pub = await ghPublish(BASE, gh, { slug: 'idem-sop', kind: 'sop', title: '幂等 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 幂等 SOP\nsteps:\n  - key: a\n    title: A\n' }] });
  ok('SOP 发布', pub.status === 201, `status=${pub.status}`);
  await call('POST', '/api/sops/idem-sop/publish', {}, ADMIN);
  let r = await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'idem-sop', agent_node: CALLER, mode: 'run', direction: 'admits' }, ADMIN);
  ok('绑定 run 模式', r.status === 201, JSON.stringify(r.body));
  const card = (await call('GET', '/.well-known/agent-card.json')).body;
  const team = `market/${card.sessionTeams?.[0]?.team?.split('/')[1] ?? ''}`;

  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'idem-1', context_id: 'ctx-idem-1' });
  ok('重启前 start → DELIVERED', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED', JSON.stringify(r.body).slice(0, 160));
  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'idem-1', context_id: 'ctx-idem-1' });
  ok('重启前 replay → 409 -32003', r.status === 409 && r.body?.code === -32003 && r.body?.replay === true);

  // 对抗组 A（重启前）：未绑定来源用一个新 task_id 打过来 → 404，不占用这个 id
  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: 'dsh/ffffffff', task_id: 'idem-squat', context_id: 'ctx-squat' });
  ok('对抗：未绑定来源 → 404', r.status === 404, JSON.stringify(r.body));

  await stop(child);
  child = boot();
  if (!(await waitReady(BASE + '/api/health'))) throw new Error('重启后实例未就绪（20s 超时）');

  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'idem-1', context_id: 'ctx-idem-1' });
  ok('重启后同 payload → 409 -32003 replay', r.status === 409 && r.body?.code === -32003 && r.body?.replay === true, JSON.stringify(r.body).slice(0, 160));
  // 孤代理经 JSON 的 \\uXXXX 转义合法；两条只差一个孤代理的消息必须判 conflict
  const sur = (c) => `{"team":${JSON.stringify(team)},"caller_session":${JSON.stringify(CALLER)},"task_id":"idem-sur","context_id":"ctx-sur","message":"free text \\u${c}"}`;
  let rs = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sur('d800') });
  ok('孤代理 U+D800 → DELIVERED', rs.status === 200, String(rs.status));
  rs = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sur('dc00') });
  const rsb = await rs.json().catch(() => null);
  ok('同 id 换成 U+DC00 → 409 -32002 conflict（不是 replay）', rs.status === 409 && rsb?.code === -32002 && rsb?.replay === false, JSON.stringify(rsb));
  r = await call('POST', '/a2a/direct', { team, message: JSON.stringify({ sop: { action: 'start', text: 'variant' } }), caller_session: CALLER, task_id: 'idem-1', context_id: 'ctx-idem-2' });
  ok('重启后异 payload → 409 -32002 conflict', r.status === 409 && r.body?.code === -32002 && r.body?.replay === false, JSON.stringify(r.body).slice(0, 160));

  console.log('三、对抗组：未绑定来源只当数据');
  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: 'dsh/ffffffff', task_id: 'idem-1', context_id: 'ctx-idem-1' });
  ok('未绑定来源拿已登记的 id → 404（不借 409 泄露 id 是否用过）', r.status === 404, JSON.stringify(r.body));
  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'idem-squat', context_id: 'ctx-squat-ok' });
  ok('未绑定来源打过的 id 没被占用：绑定方随后 → DELIVERED', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED', JSON.stringify(r.body).slice(0, 160));
  r = await call('POST', '/a2a/direct', { team: 'market/deadbeef', message: START, caller_session: CALLER, task_id: 'idem-ghost', context_id: 'ctx-ghost' });
  ok('查无 SOP → 404', r.status === 404);
  r = await call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'idem-ghost', context_id: 'ctx-ghost-ok' });
  ok('查无 SOP 的请求也不占用 id', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED', JSON.stringify(r.body).slice(0, 160));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  await stop(child);
  await gh.close();
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
