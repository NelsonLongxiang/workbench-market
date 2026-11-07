#!/usr/bin/env node
// #437① 文件清单字段：隔离 DATA_DIR + 本机 GitHub 替身，合成一个带文件清单字段的 SOP。
// 判据：
//   L1 完成时逐行按文件面核：文件不在本记录、sha256 与实际内容不一致（含同名不同内容）、文件名不一致都拦下
//   L2 角色缺失按结构规则拦；合规后完成成功；引用来的文件同样可以登记
//   L3（有 PYTHON 且装了 Playwright 时）执行页表格编辑器：选文件自动带出 sha256，选角色，保存后完成成功
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'sop-file-list-'));
const PORT = 22000 + Math.floor(Math.random() * 10000);
const B = 'http://127.0.0.1:' + PORT;
const ADMIN = 'sop-file-list-admin';
const gh = await startFakeGithub();
const env = { ...process.env, WM_GITHUB_API: gh.api, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'off', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '' };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = { 'content-type': 'application/json' };
async function call(method, path, headers = CLI, body) {
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 无体 */ }
  return { status: r.status, body: j };
}
async function upload(run, name, text) {
  const fd = new FormData(); fd.append('file', new Blob([text], { type: 'text/plain' }), name);
  const r = await fetch(`${B}/api/sop/runs/${run}/files`, { method: 'POST', body: fd });
  return (await r.json().catch(() => null)) ?? {};
}
const sha = (t) => createHash('sha256').update(t).digest('hex');
const body = '<p>交付文件清单：<textarea data-field="files" data-label="交付文件清单" data-type="file-list" data-roles="交付件|验证报告" data-min-items="1"></textarea></p>';
const SOP = [{ path: 'sop.yaml', content: JSON.stringify({ title: 'File List SOP', steps: [{ key: 'deliver', title: '交付', body }] }) }];

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: 'ignore' });
try {
  const end = Date.now() + 20000;
  while (Date.now() < end) { try { if ((await fetch(B + '/api/health', { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* 未起 */ } await sleep(200); }
  const pub = await ghPublish(B, gh, { slug: 'fl-sop', kind: 'sop', title: 'File List SOP', changelog: 'v1', files: SOP }, { 'x-admin-token': ADMIN });
  ok('SOP 同步', pub.status === 201, String(pub.status));
  await call('POST', '/api/sops/fl-sop/publish', CLI, { changelog: 'v1' });
  const run = (await call('POST', '/api/sop/runs', CLI, { slug: 'fl-sop' })).body;
  const f1 = await upload(run.id, '交付.xlsx.txt', '交付内容 v1');
  const save = (rows) => call('PUT', `/api/sop/runs/${run.id}`, CLI, { stepKey: 'deliver', value: { files: rows } });
  const finish = () => call('POST', `/api/sop/runs/${run.id}/finish`, CLI);

  console.log('▶ L1 按文件面逐行核');
  await save([]);
  let r = await finish();
  ok('空清单不能完成（必填）', r.status === 400 && /交付文件清单/.test(r.body?.error ?? ''), JSON.stringify(r.body));
  await save([{ file_id: 99999, name: 'x', sha256: sha('x'), role: '交付件' }]);
  r = await finish();
  ok('文件不在本记录 → 拦下', r.status === 400 && (r.body?.violations ?? []).some((v) => v.includes('不在本记录')), JSON.stringify(r.body));
  await save([{ file_id: f1.id, name: f1.name, sha256: sha('别的内容'), role: '交付件' }]);
  r = await finish();
  ok('同名不同内容（sha256 与实际不一致）→ 拦下', r.status === 400 && (r.body?.violations ?? []).some((v) => v.includes('实际内容不一致')), JSON.stringify(r.body));
  await save([{ file_id: f1.id, name: '改过的名字.xlsx', sha256: f1.sha256, role: '交付件' }]);
  r = await finish();
  ok('文件名与文件面不一致 → 拦下', r.status === 400 && (r.body?.violations ?? []).some((v) => v.includes('文件名')), JSON.stringify(r.body));

  console.log('▶ L2 结构规则与通过');
  await save([{ file_id: f1.id, name: f1.name, sha256: f1.sha256 }]);
  r = await finish();
  ok('角色没选 → 拦下', r.status === 400 && (r.body?.violations ?? []).some((v) => v.includes('角色须为')), JSON.stringify(r.body));
  const other = (await call('POST', '/api/sop/runs', CLI, { slug: 'fl-sop' })).body;
  const f2 = await upload(other.id, '验证报告.md', '# 报告');
  const ref = await call('POST', `/api/sop/runs/${run.id}/files/refs`, { ...CLI, 'x-run-read-capability': run.read_capability }, { items: [{ run_id: other.id, file_id: f2.id, read_capability: other.read_capability }] });
  const refId = ref.body?.results?.[0]?.id;
  ok('引用另一条记录的报告', ref.status === 200 && Number.isInteger(refId), JSON.stringify(ref.body));
  await save([{ file_id: f1.id, name: f1.name, sha256: f1.sha256, role: '交付件' }, { file_id: refId, name: '验证报告.md', sha256: sha('# 报告'), role: '验证报告' }]);
  r = await finish();
  ok('上传的与引用的各一行，都对得上 → 完成', r.status === 200 && r.body?.status === 'finished', JSON.stringify(r.body));

  console.log('▶ L2b 旧文件没记 sha256');
  const run4 = (await call('POST', '/api/sop/runs', CLI, { slug: 'fl-sop' })).body;
  const f4 = await upload(run4.id, '旧件.txt', '旧文件内容');
  { const db = new DatabaseSync(resolve(DATA, 'workbench-market.db')); db.prepare("UPDATE sop_run_files SET sha256 = '' WHERE id = ?").run(f4.id); db.close(); }
  r = await call('GET', `/api/sop/runs/${run4.id}/files`, { 'x-run-read-capability': run4.read_capability });
  ok('列文件时补算缺的 sha256（流式）', r.body?.items?.find((f) => f.id === f4.id)?.sha256 === sha('旧文件内容'), JSON.stringify(r.body?.items));
  await call('PUT', `/api/sop/runs/${run4.id}`, CLI, { stepKey: 'deliver', value: { files: [{ file_id: f4.id, name: '旧件.txt', sha256: sha('旧文件内容'), role: '交付件' }] } });
  r = await call('POST', `/api/sop/runs/${run4.id}/finish`, CLI);
  ok('按补出的 sha 登记，第一次完成就能通过', r.status === 200, JSON.stringify(r.body));

  if (process.env.PYTHON) {
    console.log('▶ L3 执行页表格编辑器');
    const run3 = (await call('POST', '/api/sop/runs', CLI, { slug: 'fl-sop' })).body;
    const f3 = await upload(run3.id, '合同.xlsx.txt', '合同内容');
    const cfg = join(DATA, 'browser.json');
    writeFileSync(cfg, JSON.stringify({ base: B, slug: 'fl-sop', run: run3.id, read_capability: run3.read_capability, upload_token: run3.upload_token, file_id: f3.id }));
    const py = spawn(process.env.PYTHON, ['scripts/sop-file-list-browser.py', cfg], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; py.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r2) => py.once('exit', r2));
    const got = (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } })();
    ok('选文件自动带出 sha256，选角色，完成成功', code === 0 && got?.sha === sha('合同内容') && /执行完成/.test(got?.state ?? ''), out.slice(-400));
    const g = await call('GET', `/api/sop/runs/${run3.id}`, { 'x-run-read-capability': run3.read_capability });
    const row = g.body?.data?.deliver?.files?.[0];
    ok('存下的是行对象数组（file_id、文件名、sha256、角色）', g.body?.status === 'finished' && row?.file_id === f3.id && row?.name === '合同.xlsx.txt' && row?.sha256 === sha('合同内容') && row?.role === '交付件', JSON.stringify(g.body?.data));
  } else console.log('  - L3 SKIP（设 PYTHON 指向装了 Playwright 的解释器才跑）');
} catch (e) {
  fail++; console.log('  ✗ 异常 ' + (e?.stack ?? e));
} finally {
  if (child.exitCode === null) { const ex = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await Promise.race([ex, sleep(5000)]); }
  await gh.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n===== #437① 文件清单字段冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
