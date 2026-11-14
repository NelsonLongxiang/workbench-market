#!/usr/bin/env node
/**
 * 技能版本链里的快照路径只给管理员（对抗组）：GET /api/skills/:slug/versions 的每个版本带不带 snapshot_path，看是谁来问。
 *   · 管理员（管理口令、本机命令行）：带；
 *   · 别人（远程匿名、本机的浏览器页面）：不带，其余字段照旧，摘要 tree_digest 保留（核对完整性用，不算泄露）；
 *   · MCP 的 skill_versions（tools/call 和内嵌 REST）：会话是代理不是管理员，一律不带，摘要照旧。
 * 身份来源认出来的管理员和管理口令走同一个判断（settingsAdminRead，设置、导出用的就是它），这里不另起登录方。
 *
 * 隔离：空的 DATA_DIR（tmp/ 下现建、跑完删），MCP 网关开，不读任何真实数据。
 *   node scripts/skill-versions-path-test.mjs
 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 20000 + Math.floor(Math.random() * 12000);
const B = `http://127.0.0.1:${PORT}`;
const ADMIN = 'skv-admin-token';
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'skill-versions-path-'));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_LOGIN_GATE: '' },
});
async function waitReady(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${B}/api/health`)).status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
async function call(method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const AT = { 'x-admin-token': ADMIN };
const REMOTE = { 'x-forwarded-for': '198.51.100.7' };
const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', origin: B };
const SLUG = 'skv:probe';
const versionsAs = async (headers) => call('GET', `/api/skills/${encodeURIComponent(SLUG)}/versions`, null, headers);
const hasPath = (vs) => Array.isArray(vs) && vs.length > 0 && vs.every((v) => typeof v.snapshot_path === 'string' && v.snapshot_path.startsWith('skill-snapshots/'));
const noPath = (vs) => Array.isArray(vs) && vs.length > 0 && vs.every((v) => !('snapshot_path' in v));
const digestKept = (vs) => Array.isArray(vs) && vs.length > 0 && vs.every((v) => /^[0-9a-f]{64}$/.test(String(v.tree_digest ?? '')));

try {
  if (!(await waitReady())) throw new Error('市场实例没起来');
  const files = [{ path: 'SKILL.md', content: '---\nname: skv-probe\ndescription: 合成技能\n---\n正文' }];
  let r = await call('POST', `/api/skills/${encodeURIComponent(SLUG)}/versions`, { files, changelog: 'v1', reviewed_by: 'synthetic-reviewer' }, AT);
  ok('布置：管理口令发布 v1', r.status === 201, JSON.stringify(r.body).slice(0, 120));
  r = await call('POST', `/api/skills/${encodeURIComponent(SLUG)}/versions`, { files: [{ ...files[0], content: files[0].content + '\nv2' }], changelog: 'v2', reviewed_by: 'synthetic-reviewer' }, AT);
  ok('布置：管理口令发布 v2', r.status === 201, JSON.stringify(r.body).slice(0, 120));

  // 不是管理员：没有快照路径，别的照旧
  r = await versionsAs(REMOTE);
  ok('远程匿名：200', r.status === 200, `status=${r.status}`);
  ok('远程匿名：版本里没有 snapshot_path', noPath(r.body?.versions), JSON.stringify(r.body?.versions?.[0] ?? null).slice(0, 200));
  ok('远程匿名：摘要 tree_digest 保留', digestKept(r.body?.versions));
  ok('远程匿名：版本号、当前版本、改了什么照旧', r.body?.active_version === 2 && r.body?.versions?.map((v) => v.version).join() === '2,1' && r.body?.versions?.[0]?.changelog === 'v2' && r.body?.versions?.[0]?.active === true, JSON.stringify(r.body).slice(0, 200));
  r = await versionsAs({ ...REMOTE, 'x-admin-token': 'wrong-token' });
  ok('远程、管理口令不对：没有 snapshot_path', noPath(r.body?.versions), JSON.stringify(r.body?.versions?.[0] ?? null).slice(0, 160));
  r = await versionsAs(PAGE);
  ok('本机的浏览器页面（带浏览器标记）：没有 snapshot_path', noPath(r.body?.versions), JSON.stringify(r.body?.versions?.[0] ?? null).slice(0, 160));
  ok('本机的浏览器页面：摘要保留', digestKept(r.body?.versions));

  // 管理员：带快照路径（相对数据目录）
  r = await versionsAs({ ...REMOTE, ...AT });
  ok('远程、带管理口令：有 snapshot_path（相对数据目录）', hasPath(r.body?.versions), JSON.stringify(r.body?.versions?.[0] ?? null).slice(0, 160));
  r = await versionsAs({});
  ok('本机命令行：有 snapshot_path', hasPath(r.body?.versions), JSON.stringify(r.body?.versions?.[0] ?? null).slice(0, 160));

  // MCP：会话是代理，不是管理员，一律不带
  const sess = await call('POST', '/api/mcp/sessions', { name: 'skv-agent' }, AT);
  await call('PUT', `/api/mcp/sessions/${sess.body.id}/grants`, { grants: ['skill_versions'] }, AT);
  const rpc = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_versions', arguments: { slug: SLUG } } }, { authorization: `Bearer ${sess.body.token}` });
  let out = null; try { out = JSON.parse(rpc.body?.result?.content?.[0]?.text ?? 'null'); } catch {}
  ok('MCP skill_versions：没有 snapshot_path', noPath(out), JSON.stringify(out?.[0] ?? rpc.body).slice(0, 200));
  ok('MCP skill_versions：摘要保留', digestKept(out));
  const rest = await call('POST', '/api/mcp-rest/tools/skill_versions', { slug: SLUG }, { authorization: `Bearer ${sess.body.token}` });
  const restOut = rest.body?.result ?? rest.body;
  ok('MCP 内嵌 REST skill_versions：没有 snapshot_path', noPath(Array.isArray(restOut) ? restOut : restOut?.versions ?? restOut), JSON.stringify(rest.body).slice(0, 200));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n===== 技能版本链的快照路径只给管理员 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
