#!/usr/bin/env node
/** A2A P1 冒烟：专用实例（独立 DATA_DIR + ADMIN_TOKEN）上卡片签名（上游 verifyCard 裁判）+ 绑定 CRUD + 上卡规则。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9811;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-a2a-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// 起专用实例
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'e2e-admin-tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 3500));

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // ① 卡片：形状 + 上游 verifyCard 裁判
  const card = (await call('GET', '/.well-known/agent-card.json')).body;
  ok('卡片核心字段', typeof card.name === 'string' && typeof card.session === 'string' && typeof card.team === 'string' && typeof card.expiresAt === 'number');
  ok('卡片签名面在场', typeof card.publicKey === 'string' && typeof card.signature === 'string');
  ok('expiresAt ≤ 48h', card.expiresAt - Date.now() <= 48 * 3600 * 1000 && card.expiresAt > Date.now());
  ok('无绑定时 sessionTeams 为空数组', Array.isArray(card.sessionTeams) && card.sessionTeams.length === 0);
  ok('不发布 teamMemberships', !('teamMemberships' in card));
  const { verifyCard } = await import('file:///D:/workspace/dsh-open-a2a-net/src/card.ts');
  const v = verifyCard(card, Date.now());
  ok('上游 verifyCard 裁判 PASS', v.ok === true, JSON.stringify(v).slice(0, 120));

  // 发布 SOP（无绑定 → 不上卡）
  const yaml = 'title: A2A 冒烟 SOP\nsteps:\n  - key: a\n    title: A\n';
  await call('POST', '/api/apps', { slug: 'a2a-smoke-sop', kind: 'sop', title: 'A2A 冒烟 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: yaml }] });
  await call('POST', '/api/sops/a2a-smoke-sop/publish', {});
  let card2 = (await call('GET', '/.well-known/agent-card.json')).body;
  ok('published 无绑定不上卡', card2.sessionTeams.length === 0);

  // ② 绑定 CRUD
  let r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'dsh/1a2b3c4d' });
  ok('无 token 403', r.status === 403);
  r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'dsh/1a2b3c4d' }, { 'X-Admin-Token': 'wrong' });
  ok('错 token 403', r.status === 403);
  r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'dsh/1a2b3c4d', mode: 'run', remote_api_key: 'sk-remote-1' }, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('绑定 201', r.status === 201 && r.body.ok, JSON.stringify(r.body));
  const bid = r.body.id;
  r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'bad node!' }, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('坏 node 400', r.status === 400);
  r = await call('GET', '/api/sops/a2a-smoke-sop/bindings', null, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('绑定列表（含掩码 key）', Array.isArray(r.body) && r.body.length === 1 && r.body[0].remote_api_key === '****' && r.body[0].node === 'dsh/1a2b3c4d');
  // Origin 跨源 403
  r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'dsh/ffffffff' }, { 'X-Admin-Token': 'e2e-admin-tok', Origin: 'http://evil.example' });
  ok('跨源写 403', r.status === 403);

  // ③ 上卡规则：有效绑定 → 上卡；卡片不含绑定图（node 句柄不出现）
  card2 = (await call('GET', '/.well-known/agent-card.json')).body;
  ok('绑定后上卡', card2.sessionTeams.length === 1 && card2.sessionTeams[0].name === 'a2a-smoke-sop');
  ok('队名 market/<id8> 形态', /^market\/[0-9a-f]{8}$/.test(card2.sessionTeams[0].team), card2.sessionTeams[0].team);
  ok('卡片不含 agent 句柄（A8）', !JSON.stringify(card2).includes('dsh/1a2b3c4d'));
  ok('上卡后 verifyCard 仍 PASS', verifyCard(card2, Date.now()).ok === true);

  // ④ 软撤销 → 下卡
  r = await call('DELETE', `/api/sops/a2a-smoke-sop/bindings/${bid}`, null, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('软撤销 200', r.status === 200);
  card2 = (await call('GET', '/.well-known/agent-card.json')).body;
  ok('撤销后下卡', card2.sessionTeams.length === 0);
  r = await call('GET', '/api/sops/a2a-smoke-sop/bindings', null, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('撤销留审计行', r.body.length === 1 && r.body[0].revoked_at !== '');

  // ⑤ /a2a/direct not-found（不泄露存在性）
  r = await call('POST', '/a2a/direct', { jsonrpc: '2.0', method: 'message/send', params: {} });
  ok('/a2a/direct 无 team 字段 → 200 -32000（非 P1 404——P2 开放）', r.status === 200 && r.body?.code === -32000);

  // ============ P2：准入 / 幂等 / 512KiB / context_id（GH #17 阶段表） ============
  // 恢复一条有效绑定（P1 流程已软撤销 bid——重绑拿 mode=run；node8 从重绑后的卡片取）
  r = await call('POST', '/api/sops/a2a-smoke-sop/bindings', { node: 'dsh/1a2b3c4d', mode: 'run' }, { 'X-Admin-Token': 'e2e-admin-tok' });
  ok('P2 重绑 run 模式', r.status === 201, JSON.stringify(r.body));
  const card3 = (await call('GET', '/.well-known/agent-card.json')).body;
  const node8 = card3.sessionTeams[0]?.team?.split('/')[1] ?? '';
  const teamName = `market/${node8}`;
  // ① 匿名拒（上游 anonymous hole 同款）
  r = await call('POST', '/a2a/direct', { team: teamName, message: 'x' });
  ok('匿名派单拒 -32000', r.status === 200 && r.body?.code === -32000 && r.body?.task_status === 'TASK_STATE_FAILED');
  // ② 无绑定 caller 拒
  r = await call('POST', '/a2a/direct', { team: teamName, message: 'x', caller_session: 'dsh/ffffffff' });
  ok('未绑定 caller 拒', r.status === 200 && r.body?.code === -32000 && /no valid binding/.test(r.body?.error ?? ''));
  // ③ 查无 SOP → 404 不泄露
  r = await call('POST', '/a2a/direct', { team: 'market/deadbeef', message: 'x', caller_session: 'dsh/1a2b3c4d' });
  ok('未知 id8 → 404', r.status === 404);
  // ④ start（结构化）→ DELIVERED + run↔context
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'start' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-1', context_id: 'ctx-p2-a' });
  ok('start → TASK_STATE_DELIVERED', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED' && r.body?.delivered === true, JSON.stringify(r.body).slice(0, 160));
  ok('task_id 回显', r.body?.task_id === 'p2-task-1');
  ok('sop.run_id 在场', Number.isInteger(r.body?.sop?.run_id));
  const p2run = r.body.sop.run_id;
  // ⑤ 幂等 replay（同 key 同 payload）
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'start' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-1', context_id: 'ctx-p2-a' });
  ok('同 key 同 payload → 409 -32003 replay', r.status === 409 && r.body?.code === -32003 && r.body?.replay === true);
  // ⑥ 幂等 conflict（同 key 不同 payload——指纹={team,caller,message}，变 message 才算异）
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'start', text: 'variant' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-1', context_id: 'ctx-p2-b' });
  ok('同 key 异 payload → 409 -32002 conflict', r.status === 409 && r.body?.code === -32002 && r.body?.replay === false, JSON.stringify(r.body).slice(0, 120));
  // ⑦ note（同 context 续 run）
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'note', text: 'P2 备注测试' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-2', context_id: 'ctx-p2-a' });
  ok('note → DELIVERED 续同 run', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED' && r.body?.sop?.run_id === p2run);
  // ⑧ status（同 context）
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'status' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-3', context_id: 'ctx-p2-a' });
  ok('status → DELIVERED + steps≥1', r.status === 200 && r.body?.sop?.steps >= 1);
  // ⑨ note 数据落 sop_runs（a2a-notes）
  const runDetail = await call('GET', `/api/sop/runs/${p2run}`);
  const notes = runDetail.body?.data?.['a2a-notes'];
  ok('note 写入 a2a-notes', Array.isArray(notes) && notes.some((n) => n.text === 'P2 备注测试'), JSON.stringify(notes).slice(0, 120));
  // ⑩ 512KiB → 413
  const bigMsg = 'x'.repeat(600 * 1024);
  const bigR = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team: teamName, message: bigMsg, caller_session: 'dsh/1a2b3c4d' }) });
  ok('512KiB 上限 → 413', bigR.status === 413, `status=${bigR.status}`);
  // ⑪ read 模式只读（P1 绑过 read 的场景用新 SOP 验证——此处以 mode 断言覆盖）
  r = await call('POST', '/a2a/direct', { team: teamName, message: JSON.stringify({ sop: { action: 'note', text: 'x' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'p2-task-4', context_id: 'ctx-p2-a' });
  ok('run 模式 note 放行', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== A2A P1+P2 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
