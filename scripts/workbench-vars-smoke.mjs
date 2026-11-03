#!/usr/bin/env node
// #336 工作台变量与常量冒烟：隔离 DATA_DIR（空库，不读任何真实数据）+ 本机 GitHub 替身。
// 判据：
//   V1 三类台都能建/读/列/改：自产台、SOP 台、外部 Web 台（另一外部台做隔离对照）
//   V2 隔离：同名键各台各一份；自产台令牌读写别的台 403（含外部台）；列举只见本台
//   V3 权限：浏览器匿名读写 403、经反代的远程匿名写 403；管理员口令读写 200；外部台不认任何按台令牌
//   V4 常量：kind=const 后改/删 403 const_locked；按台令牌带 override 仍 403；管理员 override 200 且审计记 const_override（只记 sha256）
//   V5 并发：改已存在的键不带 revision → 428；错 revision → 409 回当前 revision；同 revision 并发两写恰一成一 409
//   V6 沙箱页面（Origin: null）：预检 204 带允许头；有效令牌带 ACAO，异台令牌不带
//   V7 MCP：tools/list 含 workbench_vars_get/set；set 带 override 被拒；get 读到 REST 写的值
//   V8 重启恢复：杀进程重启，同一 DATA_DIR 下值、revision、kind 原样
//   V9 删台：变量随台删除（审计留存）
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'wbvars-'));
const PORT = 22000 + Math.floor(Math.random() * 20000);
const B = 'http://127.0.0.1:' + PORT;
const ADMIN = 'wbvars-test';
const gh = await startFakeGithub();
const env = { ...process.env, WM_GITHUB_API: gh.api, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'off', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '' };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
async function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: 'ignore' });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const r = await fetch(B + '/api/health', { signal: AbortSignal.timeout(1500) }); if (r.ok) return; } catch { /* 未起 */ }
    await sleep(200);
  }
  throw new Error('server not ready');
}
async function stop() {
  if (!child) return;
  const c = child; child = null;
  c.kill('SIGTERM');
  await Promise.race([new Promise((r) => c.once('exit', r)), sleep(5000)]);
}

// 头形态：CLI=回环无浏览器标记；browser=同源浏览器（不再算本机 CLI）；remote=经反代转发（不算回环）；page=沙箱页面
const CLI = { 'content-type': 'application/json' };
const BROWSER = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const REMOTE = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
const ADM = { ...REMOTE, 'x-admin-token': ADMIN };
const page = (tok) => ({ 'content-type': 'application/json', origin: 'null', 'x-app-token': tok });

async function call(method, path, headers = CLI, body) {
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 204 */ }
  return { status: r.status, body: j, headers: r.headers };
}
const vpath = (id, key = '') => `/api/workbenches/${id}/vars${key ? '/' + encodeURIComponent(key) : ''}`;
const put = (id, key, body, headers = CLI) => call('PUT', vpath(id, key), headers, body);
const appToken = (slug) => createHmac('sha256', readFileSync(resolve(DATA, '.wm-app-token.key'), 'utf8').trim()).update(slug).digest('hex');

try {
  await start();
  console.log('▶ 准备三类台');
  const pa = await ghPublish(B, gh, { slug: 'vars-app-a', title: 'Vars App A', files: [{ path: 'index.html', content: '<html><head></head><body>a</body></html>' }] }, { 'x-admin-token': ADMIN });
  const pb = await ghPublish(B, gh, { slug: 'vars-app-b', title: 'Vars App B', files: [{ path: 'index.html', content: '<html><head></head><body>b</body></html>' }] }, { 'x-admin-token': ADMIN });
  const ps = await ghPublish(B, gh, { slug: 'vars-sop', kind: 'sop', title: 'Vars SOP', changelog: 'synthetic', files: [{ path: 'sop.yaml', content: JSON.stringify({ title: 'Vars SOP', steps: [{ key: 'one', title: 'One', body: '<p>x</p>' }] }) }] }, { 'x-admin-token': ADMIN });
  ok('自产台 ×2 与 SOP 台经替身仓库同步 → 201', [pa, pb, ps].every((r) => r.status === 201), [pa, pb, ps].map((r) => r.status).join(','));
  const pp = await call('POST', '/api/sops/vars-sop/publish', CLI, { changelog: 'synthetic' });
  ok('SOP 台上架（入册） → 200', pp.status === 200, `${pp.status} ${JSON.stringify(pp.body).slice(0, 120)}`);
  const e1 = await call('POST', '/api/workbenches', CLI, { name: 'Ext One', url: 'http://127.0.0.1:9/', type: 'web' });
  const e2 = await call('POST', '/api/workbenches', CLI, { name: 'Ext Two', url: 'http://127.0.0.1:10/', type: 'web' });
  ok('外部 Web 台 ×2 登记 → 201', e1.status === 201 && e2.status === 201, `${e1.status},${e2.status} ${JSON.stringify(e1.body).slice(0, 120)}`);
  const list = (await call('GET', '/api/workbenches')).body;
  const idOf = (url) => list.find((w) => w.url === url)?.id;
  const W = { appA: idOf('/apps/vars-app-a/'), appB: idOf('/apps/vars-app-b/'), sop: idOf('/sop/vars-sop/'), ext1: e1.body?.id, ext2: e2.body?.id };
  ok('五个台都有 workbench id', Object.values(W).every((v) => Number.isInteger(v)), JSON.stringify(W));
  const html = await (await fetch(B + '/apps/vars-app-a/')).text(); // 首次注入时才生成令牌密钥
  const tokA = appToken('vars-app-a'), tokB = appToken('vars-app-b'), tokS = appToken('vars-sop');
  ok('页面注入的令牌与按台令牌一致（测试按同一算法取令牌）', html.includes(tokA));

  console.log('▶ V1 三类台读写');
  let r = await put(W.appA, 'counter', { value: 1 }, page(tokA));
  ok('自产台页面凭本台令牌新建 → 201 revision=1', r.status === 201 && r.body?.revision === 1 && r.body?.created === true, JSON.stringify(r.body));
  ok('写响应带 ETag', r.headers.get('etag') === '"1"', String(r.headers.get('etag')));
  r = await put(W.appA, 'counter', { value: 2, revision: 1 }, page(tokA));
  ok('自产台带 revision 更新 → 200 revision=2', r.status === 200 && r.body?.revision === 2 && r.body?.value === 2, JSON.stringify(r.body));
  r = await put(W.sop, 'board', { value: { rows: [1, 2], title: 'x' } }, page(tokS));
  ok('SOP 台凭本台令牌写 JSON 对象 → 201', r.status === 201 && r.body?.value?.rows?.length === 2, JSON.stringify(r.body));
  r = await call('GET', vpath(W.sop, 'board'), page(tokS));
  ok('SOP 台读回原值', r.status === 200 && r.body?.value?.title === 'x' && r.headers.get('etag') === '"1"', JSON.stringify(r.body));
  r = await put(W.ext1, 'counter', { value: 'ext-one' }, ADM);
  ok('外部台：管理员（远程带口令）写 → 201', r.status === 201, JSON.stringify(r.body));
  r = await put(W.ext1, 'nullable', { value: null }, CLI);
  ok('外部台：本机命令行写 null 值 → 201', r.status === 201 && r.body?.value === null, JSON.stringify(r.body));
  r = await call('GET', vpath(W.ext1), ADM);
  ok('外部台：管理员列举 → 2 项（键序）', r.status === 200 && r.body?.class === 'external' && r.body?.items?.map((i) => i.key).join(',') === 'counter,nullable', JSON.stringify(r.body));
  r = await call('GET', vpath(W.appA) + '?prefix=cou', page(tokA));
  ok('自产台列举 class=app、prefix 过滤', r.status === 200 && r.body?.class === 'app' && r.body?.count === 1, JSON.stringify(r.body));
  r = await put(W.appA, 'bad key', { value: 1 }, page(tokA));
  ok('非法键名 → 400', r.status === 400);
  r = await put(W.appA, 'nov', {}, page(tokA));
  ok('缺 value → 400', r.status === 400);
  r = await put(W.appA, 'big', { value: 'x'.repeat(70 * 1024) }, page(tokA));
  ok('值超 64KB → 400', r.status === 400);
  r = await call('GET', vpath(W.appA, 'missing'), page(tokA));
  ok('不存在的键 → 404 current_revision=0', r.status === 404 && r.body?.current_revision === 0, JSON.stringify(r.body));
  r = await call('GET', vpath(999999), CLI);
  ok('不存在的台 → 404', r.status === 404);

  console.log('▶ V2 隔离');
  r = await put(W.appB, 'counter', { value: 'b' }, page(tokB));
  ok('另一自产台同名键独立新建 → 201 revision=1', r.status === 201 && r.body?.revision === 1);
  r = await call('GET', vpath(W.appA, 'counter'), page(tokA));
  ok('本台值不受别台同名键影响', r.body?.value === 2, JSON.stringify(r.body));
  r = await call('GET', vpath(W.appB, 'counter'), page(tokA));
  ok('A 的令牌读 B → 403', r.status === 403 && r.body?.code === 'app_token_mismatch', JSON.stringify(r.body));
  r = await put(W.appB, 'counter', { value: 'hijack', revision: 1 }, page(tokA));
  ok('A 的令牌写 B → 403', r.status === 403);
  r = await put(W.sop, 'board', { value: 0, revision: 1 }, page(tokA));
  ok('自产台令牌写 SOP 台 → 403', r.status === 403);
  r = await call('GET', vpath(W.ext1, 'counter'), page(tokA));
  ok('自产台令牌读外部台 → 403', r.status === 403);
  r = await put(W.ext1, 'counter', { value: 'x', revision: 1 }, page(tokS));
  ok('SOP 台令牌写外部台 → 403', r.status === 403);
  r = await call('GET', vpath(W.ext2), ADM);
  ok('另一外部台列举为空（外部台间隔离）', r.status === 200 && r.body?.count === 0, JSON.stringify(r.body));
  r = await call('GET', vpath(W.appB, 'counter'), CLI);
  ok('B 的值未被篡改', r.body?.value === 'b' && r.body?.revision === 1, JSON.stringify(r.body));

  console.log('▶ V3 权限');
  r = await call('GET', vpath(W.appA), BROWSER);
  ok('浏览器匿名读自产台 → 403', r.status === 403);
  r = await call('GET', vpath(W.ext1), BROWSER);
  ok('浏览器匿名读外部台 → 403', r.status === 403);
  r = await call('GET', vpath(W.ext1), REMOTE);
  ok('远程匿名读外部台 → 403', r.status === 403);
  r = await put(W.ext1, 'anon', { value: 1 }, REMOTE);
  ok('远程匿名写 → 403', r.status === 403);
  r = await put(W.appA, 'anon', { value: 1 }, BROWSER);
  ok('浏览器匿名写自产台 → 403', r.status === 403);
  r = await put(W.appA, 'anon', { value: 1 }, { ...REMOTE, 'x-admin-token': 'wrong' });
  ok('错口令写 → 403', r.status === 403);
  r = await call('GET', vpath(W.appA, 'counter'), { ...REMOTE, 'x-app-token': tokA });
  ok('远程（非浏览器）凭本台令牌读 → 200', r.status === 200 && r.body?.value === 2);
  r = await put(W.appA, 'remote', { value: 1 }, { ...REMOTE, 'x-app-token': tokA });
  ok('远程凭本台令牌写本台 → 201（写门放行）', r.status === 201, JSON.stringify(r.body));
  r = await put(W.ext1, 'remote', { value: 1 }, { ...REMOTE, 'x-app-token': 'f'.repeat(64) });
  ok('外部台带任意令牌写 → 403', r.status === 403);
  r = await call('GET', vpath(W.appB, 'counter'), ADM);
  ok('管理员可读任意自产台', r.status === 200 && r.body?.value === 'b');
  r = await call('GET', vpath(W.appA, 'counter') + '/audit', page(tokA));
  ok('按台令牌读审计 → 403', r.status === 403);

  console.log('▶ V4 常量');
  r = await put(W.ext1, 'limit', { value: 100, kind: 'const' }, ADM);
  ok('管理员新建常量 → 201 kind=const', r.status === 201 && r.body?.kind === 'const', JSON.stringify(r.body));
  r = await put(W.ext1, 'limit', { value: 200, revision: 1 }, ADM);
  ok('常量不带 override 改 → 403 const_locked', r.status === 403 && r.body?.code === 'const_locked' && r.body?.current_revision === 1, JSON.stringify(r.body));
  r = await call('DELETE', vpath(W.ext1, 'limit') + '?revision=1', ADM);
  ok('常量不带 override 删 → 403', r.status === 403 && r.body?.code === 'const_locked');
  r = await put(W.appA, 'unit', { value: 'kg', kind: 'const' }, page(tokA));
  ok('自产台页面可新建本台常量 → 201', r.status === 201 && r.body?.kind === 'const');
  r = await put(W.appA, 'unit', { value: 'g', revision: 1, override: true }, page(tokA));
  ok('按台令牌带 override 改常量 → 403 const_override_forbidden', r.status === 403 && r.body?.code === 'const_override_forbidden', JSON.stringify(r.body));
  r = await put(W.ext1, 'limit', { value: 200, revision: 1, override: true, reason: 'threshold revised' }, ADM);
  ok('管理员显式 override 修订常量 → 200 revision=2 仍为 const', r.status === 200 && r.body?.revision === 2 && r.body?.kind === 'const' && r.body?.value === 200, JSON.stringify(r.body));
  r = await call('GET', vpath(W.ext1, 'limit') + '/audit', ADM);
  const au = r.body?.items ?? [];
  ok('审计：create + const_override，带操作者与理由，只记 sha256', r.status === 200 && au[0]?.action === 'const_override' && au[0]?.actor === 'admin' && au[0]?.reason === 'threshold revised' && /^[0-9a-f]{64}$/.test(au[0]?.new_sha256 ?? '') && au[1]?.action === 'create' && !JSON.stringify(au).includes('200,'), JSON.stringify(au));
  r = await put(W.appA, 'counter', { value: 3, revision: 2, kind: 'const' }, page(tokA));
  ok('变量可冻结为常量（审计 freeze）', r.status === 200 && r.body?.kind === 'const');
  r = await put(W.appA, 'counter', { value: 4, revision: 3 }, page(tokA));
  ok('冻结后再改 → 403', r.status === 403 && r.body?.code === 'const_locked');
  r = await call('DELETE', vpath(W.appA, 'unit') + '?revision=1&override=1', CLI);
  ok('本机命令行 override 删常量 → 200', r.status === 200 && r.body?.deleted === true, JSON.stringify(r.body));

  console.log('▶ V5 并发');
  await put(W.sop, 'progress', { value: 0 }, page(tokS));
  r = await put(W.sop, 'progress', { value: 1 }, page(tokS));
  ok('改已存在的键不带 revision → 428 revision_required 回当前 revision', r.status === 428 && r.body?.code === 'revision_required' && r.body?.current_revision === 1, JSON.stringify(r.body));
  r = await put(W.sop, 'progress', { value: 1, revision: 7 }, page(tokS));
  ok('错 revision → 409 带 current_revision 与当前值', r.status === 409 && r.body?.code === 'revision_conflict' && r.body?.current_revision === 1 && r.body?.current?.value === 0, JSON.stringify(r.body));
  r = await call('PUT', vpath(W.sop, 'progress'), { ...page(tokS), 'if-match': '"1"' }, { value: 10 });
  ok('If-Match 头形态 → 200 revision=2', r.status === 200 && r.body?.revision === 2, JSON.stringify(r.body));
  const both = await Promise.all([put(W.sop, 'progress', { value: 'x', revision: 2 }, page(tokS)), put(W.sop, 'progress', { value: 'y', revision: 2 }, page(tokS))]);
  const st = both.map((x) => x.status).sort().join(',');
  ok('同 revision 并发两写 → 恰一 200 一 409', st === '200,409', st);
  const winner = both.find((x) => x.status === 200)?.body?.value;
  r = await call('GET', vpath(W.sop, 'progress'), page(tokS));
  ok('读到的是胜出那次写（revision=3）', r.body?.revision === 3 && r.body?.value === winner, JSON.stringify(r.body));
  r = await put(W.sop, 'progress', { value: 'z', revision: 0 }, page(tokS));
  ok('revision=0（仅创建）撞已存在键 → 409', r.status === 409);
  r = await call('DELETE', vpath(W.sop, 'progress'), page(tokS));
  ok('删除不带 revision → 428', r.status === 428);
  r = await call('DELETE', vpath(W.sop, 'progress') + '?revision=3', page(tokS));
  ok('删除带对的 revision → 200', r.status === 200);

  console.log('▶ V6 沙箱页面 CORS');
  r = await call('OPTIONS', vpath(W.appA, 'counter'), { origin: 'null', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-app-token,if-match' });
  ok('预检 204 + ACAO null + 允许 if-match', r.status === 204 && r.headers.get('access-control-allow-origin') === 'null' && /if-match/.test(r.headers.get('access-control-allow-headers') ?? ''), `${r.status} ${r.headers.get('access-control-allow-headers')}`);
  r = await call('GET', vpath(W.appA, 'counter'), page(tokA));
  ok('有效令牌 → ACAO null 且暴露 etag', r.headers.get('access-control-allow-origin') === 'null' && /etag/.test(r.headers.get('access-control-expose-headers') ?? ''));
  r = await call('GET', vpath(W.appB, 'counter'), page(tokA));
  ok('异台令牌 → 不发 ACAO', r.headers.get('access-control-allow-origin') !== 'null');

  console.log('▶ V7 MCP');
  const rpc = async (method, params) => (await call('POST', '/mcp', { ...CLI, accept: 'application/json, text/event-stream' }, { jsonrpc: '2.0', id: 1, method, params })).body;
  const tools = (await rpc('tools/list', {}))?.result?.tools?.map((t) => t.name) ?? [];
  ok('tools/list 含 workbench_vars_get / workbench_vars_set', tools.includes('workbench_vars_get') && tools.includes('workbench_vars_set'), tools.join(','));
  const mtext = (x) => { try { return JSON.parse(x?.result?.content?.[0]?.text ?? 'null'); } catch { return null; } };
  let m = await rpc('tools/call', { name: 'workbench_vars_set', arguments: { id: W.ext2, key: 'agent_note', value: { n: 1 } } });
  ok('MCP set 新建 → revision=1', mtext(m)?.revision === 1 && mtext(m)?.updated_by === 'anonymous', JSON.stringify(m).slice(0, 200));
  m = await rpc('tools/call', { name: 'workbench_vars_set', arguments: { id: W.ext2, key: 'agent_note', value: { n: 2 } } });
  ok('MCP set 不带 revision 改 → 错误', m?.result?.isError === true || !!m?.error, JSON.stringify(m).slice(0, 200));
  m = await rpc('tools/call', { name: 'workbench_vars_set', arguments: { id: W.ext1, key: 'limit', value: 1, revision: 2, override: true } });
  ok('MCP set 带 override → 拒绝', m?.result?.isError === true || !!m?.error, JSON.stringify(m).slice(0, 200));
  m = await rpc('tools/call', { name: 'workbench_vars_get', arguments: { id: W.ext1, key: 'limit' } });
  ok('MCP get 读到 REST 写的常量', mtext(m)?.value === 200 && mtext(m)?.kind === 'const', JSON.stringify(m).slice(0, 200));
  m = await rpc('tools/call', { name: 'workbench_vars_get', arguments: { id: W.ext2 } });
  ok('MCP get 不带 key 列举', mtext(m)?.count === 1, JSON.stringify(m).slice(0, 200));

  console.log('▶ V8 重启恢复');
  const before = (await call('GET', vpath(W.ext1))).body?.items;
  await stop();
  await start();
  const after = (await call('GET', vpath(W.ext1))).body?.items;
  ok('重启后外部台变量原样（值/revision/kind）', JSON.stringify(after) === JSON.stringify(before) && after?.find((i) => i.key === 'limit')?.revision === 2, JSON.stringify(after));
  r = await call('GET', vpath(W.appA, 'counter'), page(tokA));
  ok('重启后自产台常量仍在且仍锁定', r.body?.kind === 'const' && r.body?.value === 3);
  r = await put(W.appA, 'counter', { value: 9, revision: 3 }, page(tokA));
  ok('重启后常量保护仍生效', r.status === 403);
  r = await put(W.appA, 'remote', { value: 2, revision: 1 }, page(tokA));
  ok('重启后按 revision 继续写', r.status === 200 && r.body?.revision === 2);

  console.log('▶ V9 删台级联');
  r = await call('DELETE', `/api/workbenches/${W.ext1}`, CLI);
  ok('删外部台 → 200', r.status === 200);
  r = await call('GET', vpath(W.ext1), CLI);
  ok('删台后变量面 404', r.status === 404);
  await stop();
  const db = new DatabaseSync(resolve(DATA, 'workbench-market.db'), { readOnly: true });
  const left = db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = ?').get(W.ext1).n;
  const auditLeft = db.prepare('SELECT COUNT(*) AS n FROM workbench_var_audit WHERE workbench_id = ?').get(W.ext1).n;
  const rawLeak = db.prepare("SELECT COUNT(*) AS n FROM workbench_var_audit WHERE old_sha256 LIKE '%ext-one%' OR new_sha256 LIKE '%ext-one%' OR reason LIKE '%ext-one%'").get().n;
  db.close();
  ok('变量行随台删除、审计行保留且不含值原文', left === 0 && auditLeft >= 3 && rawLeak === 0, `left=${left} audit=${auditLeft} leak=${rawLeak}`);
} catch (e) {
  fail++; console.log('  ✗ 异常 ' + (e?.stack ?? e));
} finally {
  await stop();
  await gh.close();
}
console.log(`\n===== #336 工作台变量冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
