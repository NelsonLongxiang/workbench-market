#!/usr/bin/env node
// #437③ 进行中的 run 升级到当前 SOP 版本：隔离 DATA_DIR + 本机 GitHub 替身，合成 SOP 发两版。
// 判据：
//   U1 预检：旧/新规则各核一遍，列出新增、失效字段和没处放的数据；无读授权 403
//   U2 升级只限管理员或本机命令行；要写 reason；expected_version 不符 409
//   U3 升级后版本变成当前版，已填数据原样保留；完成按新规则校验
//   U4 已是当前版、已完成的 run 不能升级；审计记版本、操作者、理由，不记字段值
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'sop-upgrade-'));
const PORT = 22000 + Math.floor(Math.random() * 20000);
const B = 'http://127.0.0.1:' + PORT;
const ADMIN = 'sop-upgrade-admin';
const gh = await startFakeGithub();
const env = { ...process.env, WM_GITHUB_API: gh.api, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'off', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '' };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLI = { 'content-type': 'application/json' };
const REMOTE = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' };
const ADM = { ...REMOTE, 'x-admin-token': ADMIN };
async function call(method, path, headers = CLI, body) {
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 无体 */ }
  return { status: r.status, body: j };
}
const sop = (steps) => [{ path: 'sop.yaml', content: JSON.stringify({ title: 'Upgrade SOP', steps }) }];
const V1 = sop([{ key: 's1', title: 'One', body: '<input data-field="a" data-label="甲" required><input data-field="b">' }]);
const V2 = sop([
  { key: 's1', title: 'One', body: '<input data-field="a" data-label="甲" required><input data-field="c" data-label="丙" required>' },
  { key: 's2', title: 'Two', body: '<input data-field="d" data-label="丁">' },
]);

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: 'ignore' });
try {
  const end = Date.now() + 20000;
  while (Date.now() < end) { try { if ((await fetch(B + '/api/health', { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* 未起 */ } await sleep(200); }
  let r = await ghPublish(B, gh, { slug: 'upg-sop', kind: 'sop', title: 'Upgrade SOP', changelog: 'v1', files: V1 }, { 'x-admin-token': ADMIN });
  ok('SOP v1 同步', r.status === 201, String(r.status));
  await call('POST', '/api/sops/upg-sop/publish', CLI, { changelog: 'v1' });
  r = await call('POST', '/api/sop/runs', CLI, { slug: 'upg-sop' });
  const run = r.body?.id, cap = r.body?.read_capability;
  ok('开 run（v1）', Number.isInteger(run) && r.body?.version === 1, `id=${r.body?.id} version=${r.body?.version}`);
  r = await call('PUT', `/api/sop/runs/${run}`, CLI, { stepKey: 's1', value: { a: '甲值', b: '乙值' } });
  ok('按 v1 填写', r.status === 200, JSON.stringify(r.body));
  r = await ghPublish(B, gh, { slug: 'upg-sop', kind: 'sop', title: 'Upgrade SOP', changelog: 'v2', files: V2 }, { 'x-admin-token': ADMIN });
  ok('SOP v2 同步（新增必填 丙、去掉 b、新增一步）', r.status === 200 || r.status === 201, String(r.status));

  console.log('▶ U1 预检');
  r = await call('GET', `/api/sop/runs/${run}/upgrade-preflight`, REMOTE);
  ok('无读授权预检 → 403', r.status === 403, String(r.status));
  r = await call('GET', `/api/sop/runs/${run}/upgrade-preflight`, { ...REMOTE, 'x-run-read-capability': cap });
  const p = r.body ?? {};
  ok('预检：v1 → v2', r.status === 200 && p.from_version === 1 && p.to_version === 2 && p.up_to_date === false, JSON.stringify(p));
  ok('预检：旧规则下无问题，新规则下 丙 必填', Array.isArray(p.violations_now) && p.violations_now.length === 0 && p.violations_after?.some((v) => v.includes('丙') && v.includes('必填')), JSON.stringify([p.violations_now, p.violations_after]));
  ok('预检：新增 s1.c、s2.d，失效 s1.b，s1.b 的数据没处放', JSON.stringify(p.fields_added) === JSON.stringify(['s1.c', 's2.d']) && JSON.stringify(p.fields_removed) === JSON.stringify(['s1.b']) && JSON.stringify(p.data_without_field) === JSON.stringify(['s1.b']), JSON.stringify(p));

  console.log('▶ U2 权限与确认');
  r = await call('POST', `/api/sop/runs/${run}/upgrade`, REMOTE, { reason: 'x' });
  ok('远程非管理员升级 → 403', r.status === 403, String(r.status));
  r = await call('POST', `/api/sop/runs/${run}/upgrade`, ADM, {});
  ok('不写 reason → 400', r.status === 400, JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${run}/upgrade`, ADM, { reason: '采用新规则', expected_version: 1 });
  ok('expected_version 与当前版不符 → 409', r.status === 409, JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${run}/upgrade`, ADM, { reason: '采用新规则', expected_version: 2 });
  ok('管理员确认升级 → 200', r.status === 200 && r.body?.upgraded === true && r.body?.to_version === 2, JSON.stringify(r.body));

  console.log('▶ U3 升级后');
  r = await call('GET', `/api/sop/runs/${run}`, { ...REMOTE, 'x-run-read-capability': cap });
  ok('run 现在是 v2，已填数据原样保留（含没处放的 b）', r.body?.sop_version === 2 && r.body?.data?.s1?.a === '甲值' && r.body?.data?.s1?.b === '乙值', JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${run}/finish`, CLI);
  ok('完成按 v2 校验：缺 丙 → 400', r.status === 400 && /丙/.test(r.body?.error ?? ''), JSON.stringify(r.body));
  await call('PUT', `/api/sop/runs/${run}`, CLI, { stepKey: 's1', value: { a: '甲值', b: '乙值', c: '丙值' } });
  r = await call('POST', `/api/sop/runs/${run}/finish`, CLI);
  ok('补上 丙 后完成 → 200', r.status === 200 && r.body?.status === 'finished', JSON.stringify(r.body));

  console.log('▶ U4 不能升级的情况与审计');
  r = await call('POST', `/api/sop/runs/${run}/upgrade`, CLI, { reason: 'again' });
  ok('已完成的 run 升级 → 409', r.status === 409, JSON.stringify(r.body));
  r = await call('POST', '/api/sop/runs', CLI, { slug: 'upg-sop' });
  const run2 = r.body?.id;
  r = await call('POST', `/api/sop/runs/${run2}/upgrade`, CLI, { reason: 'noop' });
  ok('已是当前版的 run 升级 → 409', r.status === 409, JSON.stringify(r.body));
} catch (e) {
  fail++; console.log('  ✗ 异常 ' + (e?.stack ?? e));
} finally {
  if (child.exitCode === null) { const ex = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await Promise.race([ex, sleep(5000)]); }
  await gh.close();
}
const db = new DatabaseSync(resolve(DATA, 'workbench-market.db'), { readOnly: true });
const audit = db.prepare('SELECT run_id, from_version, to_version, actor, reason, violations FROM sop_run_upgrade_audit').all();
db.close();
ok('审计一条：v1→v2、操作者 admin-token、理由、预检问题数，不含字段值', audit.length === 1 && audit[0].from_version === 1 && audit[0].to_version === 2 && audit[0].actor === 'admin-token' && audit[0].reason === '采用新规则' && audit[0].violations === 1 && !JSON.stringify(audit).includes('甲值'), JSON.stringify(audit));
rmSync(DATA, { recursive: true, force: true });
console.log(`\n===== #437③ run 升级冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
