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
  ok('/a2a/direct 一律 404', r.status === 404);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== A2A P1 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
