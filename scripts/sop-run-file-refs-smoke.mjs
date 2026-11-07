#!/usr/bin/env node
// #437② run 引用已有文件与配额：隔离 DATA_DIR + 本机 GitHub 替身，合成两个 SOP。
// 判据：
//   R1 上传回执带 sha256 与配额；配额只算本 run 自己上传的
//   R2 引用同 SOP 其他 run 的文件：带源 run 读凭证可以，缺凭证、文件不存在、跨 SOP 都逐条失败，不影响已成功的
//   R3 重复引用记 duplicate；引用不占上传配额；下载引用文件内容与源一致
//   R4 按 sha256 引用只限管理员；单批超上限 400；已完成的 run 不能再关联；审计记 ref:<源文件 id>
//   R5（有 PYTHON 且装了 Playwright 时）执行页多选逐个上传：成功、失败各自显示，剩余配额可见
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'sop-refs-'));
const PORT = 22000 + Math.floor(Math.random() * 10000);
const B = 'http://127.0.0.1:' + PORT;
const ADMIN = 'sop-refs-admin';
const gh = await startFakeGithub();
const env = { ...process.env, WM_GITHUB_API: gh.api, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'off', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '' };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = { 'content-type': 'application/json' };
const REMOTE = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' };
const withCap = (cap, h = REMOTE) => ({ ...h, 'x-run-read-capability': cap });
const ADM = { ...REMOTE, 'x-admin-token': ADMIN };
async function call(method, path, headers = CLI, body) {
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 无体 */ }
  return { status: r.status, body: j };
}
async function upload(run, name, text) {
  const fd = new FormData(); fd.append('file', new Blob([text], { type: 'text/plain' }), name);
  const r = await fetch(`${B}/api/sop/runs/${run}/files`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sop = (title) => [{ path: 'sop.yaml', content: JSON.stringify({ title, steps: [{ key: 's1', title: 'One', body: '<input data-field="a">' }] }) }];

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: 'ignore' });
try {
  const end = Date.now() + 20000;
  while (Date.now() < end) { try { if ((await fetch(B + '/api/health', { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* 未起 */ } await sleep(200); }
  for (const slug of ['refs-sop', 'other-sop']) {
    const r = await ghPublish(B, gh, { slug, kind: 'sop', title: slug, changelog: 'v1', files: sop(slug) }, { 'x-admin-token': ADMIN });
    ok(`SOP ${slug} 同步`, r.status === 201, String(r.status));
    await call('POST', `/api/sops/${slug}/publish`, CLI, { changelog: 'v1' });
  }
  const mk = async (slug) => (await call('POST', '/api/sop/runs', CLI, { slug })).body;
  const A = await mk('refs-sop'), Bn = await mk('refs-sop'), C = await mk('other-sop');

  console.log('▶ R1 上传与配额');
  const u1 = await upload(A.id, 'history-1.txt', '历史资料一');
  const u2 = await upload(A.id, 'history-2.txt', '历史资料二');
  const sha1 = createHash('sha256').update('历史资料一').digest('hex'), sha2 = createHash('sha256').update('历史资料二').digest('hex');
  ok('上传回执带 sha256 与配额', u1.status === 201 && u1.body?.sha256 === sha1 && u1.body?.quota?.upload_count === 1 && u2.body?.quota?.upload_left_count === 18, JSON.stringify(u1.body));

  console.log('▶ R2 逐条引用');
  let r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, withCap(Bn.read_capability), { items: [
    { run_id: A.id, file_id: u1.body.id, read_capability: A.read_capability },
    { run_id: A.id, file_id: u2.body.id },
    { run_id: A.id, file_id: 99999, read_capability: A.read_capability },
  ] });
  const res = r.body?.results ?? [];
  ok('一批三条：带凭证的 linked，缺凭证、不存在的各自 failed', r.status === 200 && res[0]?.status === 'linked' && res[1]?.status === 'failed' && /读授权/.test(res[1]?.reason ?? '') && res[2]?.status === 'failed' && r.body?.linked === 1, JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${C.id}/files/refs`, withCap(C.read_capability), { items: [{ run_id: A.id, file_id: u1.body.id, read_capability: A.read_capability }] });
  ok('跨 SOP 引用 → failed，整批都失败时 422', r.status === 422 && r.body?.results?.[0]?.status === 'failed' && /同一 SOP/.test(r.body.results[0].reason), JSON.stringify(r.body));

  console.log('▶ R2b 没有本 run 读权不能借引用列文件名');
  r = await call('POST', `/api/sop/runs/${A.id}/files/refs`, REMOTE, { items: [{ run_id: A.id, file_id: u1.body.id }, { run_id: A.id, file_id: u2.body.id }] });
  ok('不带本 run 读凭证自引用 → 403，响应里没有文件名', r.status === 403 && !JSON.stringify(r.body).includes('history-'), JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, withCap(Bn.read_capability), { items: [{ run_id: A.id, file_id: 99999 }, { run_id: A.id, file_id: u2.body.id }] });
  ok('没有源 run 读凭证：存在与不存在的文件给同样的回答（先核授权）', r.body?.results?.[0]?.reason === r.body?.results?.[1]?.reason && /读授权/.test(r.body?.results?.[0]?.reason ?? '') && !JSON.stringify(r.body).includes('history-'), JSON.stringify(r.body));
  console.log('▶ R3 重复、配额、下载');
  r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, withCap(Bn.read_capability), { items: [{ run_id: A.id, file_id: u1.body.id, read_capability: A.read_capability }] });
  ok('重复引用 → duplicate', r.status === 200 && r.body?.results?.[0]?.status === 'duplicate', JSON.stringify(r.body));
  r = await call('GET', `/api/sop/runs/${Bn.id}/files`, { 'x-run-read-capability': Bn.read_capability });
  const refRow = r.body?.items?.find((f) => f.ref_of === u1.body.id);
  ok('引用行带 ref_of 与 sha256；引用不占上传配额', !!refRow && refRow.sha256 === sha1 && r.body?.quota?.upload_count === 0 && r.body?.quota?.ref_count === 1, JSON.stringify(r.body));
  const dl = await fetch(`${B}/api/sop/runs/${Bn.id}/files/${refRow?.id}`, { headers: { 'x-run-read-capability': Bn.read_capability } });
  ok('下载引用文件内容与源一致', dl.status === 200 && (await dl.text()) === '历史资料一');

  console.log('▶ R4 sha256、批量上限、已完成、审计');
  r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, withCap(Bn.read_capability), { items: [{ sha256: sha2 }] });
  ok('非管理员按 sha256 引用 → failed', r.body?.results?.[0]?.status === 'failed' && /管理员/.test(r.body.results[0].reason), JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, ADM, { items: [{ sha256: sha2 }] });
  ok('管理员按 sha256 引用同 SOP 的已上传文件 → linked', r.status === 200 && r.body?.results?.[0]?.status === 'linked' && r.body.results[0].source_file_id === u2.body.id, JSON.stringify(r.body));
  r = await call('POST', `/api/sop/runs/${Bn.id}/files/refs`, withCap(Bn.read_capability), { items: Array.from({ length: 201 }, () => ({ sha256: sha1 })) });
  ok('单批超过 200 条 → 400', r.status === 400, String(r.status));
  await call('POST', `/api/sop/runs/${A.id}/finish`, CLI);
  r = await call('POST', `/api/sop/runs/${A.id}/files/refs`, withCap(A.read_capability), { items: [{ run_id: Bn.id, file_id: refRow.id, read_capability: Bn.read_capability }] });
  ok('已完成的 run 不能再关联 → 409', r.status === 409, JSON.stringify(r.body));

  if (process.env.PYTHON) {
    console.log('▶ R5 执行页多选逐个上传');
    const D = await mk('refs-sop');
    const cfg = join(DATA, 'browser.json');
    writeFileSync(cfg, JSON.stringify({ base: B, slug: 'refs-sop', run: D.id, read_capability: D.read_capability, upload_token: D.upload_token, good: join(DATA, 'good.txt'), bad: join(DATA, 'bad.exe') }));
    writeFileSync(join(DATA, 'good.txt'), '正常文件');
    writeFileSync(join(DATA, 'bad.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));
    const py = spawn(process.env.PYTHON, ['scripts/sop-run-file-refs-browser.py', cfg], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; py.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r2) => py.once('exit', r2));
    const got = (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } })();
    ok('一个成功一个失败，各自显示；成功的不受失败影响', code === 0 && got && /已上传/.test(got.rows[0]) && /失败/.test(got.rows[1]), out.slice(-400));
    ok('剩余配额可见', !!got && /还能上传 19 个文件/.test(got.quota), got?.quota);
  } else console.log('  - R5 SKIP（设 PYTHON 指向装了 Playwright 的解释器才跑）');
} catch (e) {
  fail++; console.log('  ✗ 异常 ' + (e?.stack ?? e));
} finally {
  if (child.exitCode === null) { const ex = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await Promise.race([ex, sleep(5000)]); }
  await gh.close();
}
const db = new DatabaseSync(resolve(DATA, 'workbench-market.db'), { readOnly: true });
const audit = db.prepare("SELECT source FROM sop_run_file_audit WHERE source LIKE 'ref:%'").all();
db.close();
ok('审计记 ref:<源文件 id>', audit.length === 2, JSON.stringify(audit));
rmSync(DATA, { recursive: true, force: true });
console.log(`\n===== #437② run 文件引用冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
