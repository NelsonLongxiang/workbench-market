#!/usr/bin/env node
/**
 * MCP 上传票（先申请、再直传）的对抗组。独立实例：全新 DATA_DIR、合成的管理口令、MCP_GATEWAY=on、GitHub 替身仓库发一个合成自产台。
 * skill_file_put / app_files_upload 不带内容、只给 size + sha256 时发一张上传票（upload_url）；PUT /api/mcp-rest/uploads/<票> 收原始字节。
 *  零、票的仓库（内存，注入时钟）：10 分钟过期、只能用一次、每会话 20 张、写法不对当不存在、只存票的 sha256
 *  一、正常：台文件、技能文件（含 200KB 二进制，正是不该走 base64 的那种）都能传上，应答和原工具一样，技能文件能在 skill_publish 里按 sha256 引用
 *  二、票只能用一次：用过的、编造的、写法不对的一律同一句 404
 *  三、字节不对就什么都不留：sha256 不符、少字节、多字节（带 Content-Length 的在读之前就拒，分块传的边收边数）——都拒，票作废，台的文件和暂存都没多出东西
 *  四、用票时再核：发票的会话吊销了、这项授权被收回了 → 403，不保存
 *  五、发票照旧要授权：没有 app_files_upload / skill_file_put 授权的会话拿不到票；申请时缺 size、缺 sha256、超上限、台不存在、文件名不合法都拒
 *  六、审计不记票：调用记录里找不到票的原文
 * 测试数据都是合成的。
 */
import { freePort } from './lib/free-port.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';
import { UploadTickets, UPLOAD_TICKET_TTL_MS, UPLOAD_TICKETS_PER_SESSION } from '../server/src/upload-tickets.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------- 零、票的仓库 ----------
console.log('零、票的仓库');
{
  let now = 1_000_000;
  const T = new UploadTickets(() => now);
  const base = { kind: 'skill_file', session: 's1', name: 'a', size: 1, sha256: 'a'.repeat(64) };
  const a = T.issue(base);
  ok('票是 43 个字符的 base64url，过期时刻 = 发票时刻 + 10 分钟', /^[A-Za-z0-9_-]{43}$/.test(a.token) && a.expiresAt === now + UPLOAD_TICKET_TTL_MS);
  ok('用一次拿得到，再用就没有了', T.take(a.token)?.session === 's1' && T.take(a.token) === null);
  const b = T.issue(base);
  now += UPLOAD_TICKET_TTL_MS;
  ok('到点过期：拿不到', T.take(b.token) === null);
  const c = T.issue(base);
  now += UPLOAD_TICKET_TTL_MS - 1;
  ok('差一毫秒还拿得到', T.take(c.token)?.kind === 'skill_file');
  ok('写法不对、不是字符串：当不存在', T.take('x') === null && T.take(undefined) === null && T.take('a'.repeat(44)) === null && T.take({ toString: () => a.token }) === null);
  const U = new UploadTickets(() => now);
  for (let i = 0; i < UPLOAD_TICKETS_PER_SESSION; i++) U.issue(base);
  let capped = null; try { U.issue(base); } catch (e) { capped = e; }
  ok(`同一会话第 ${UPLOAD_TICKETS_PER_SESSION + 1} 张：429；别的会话照发`, capped?.status === 429 && (() => { try { U.issue({ ...base, session: 's2' }); return true; } catch { return false; } })());
  now += UPLOAD_TICKET_TTL_MS;
  ok('过期的在下次发票时清掉，不占名额', (() => { try { U.issue(base); return U.outstanding() === 1; } catch { return false; } })());
  const leak = JSON.stringify([...new UploadTickets(() => now).issue(base).token]);
  const V = new UploadTickets(() => now); const v = V.issue(base);
  ok('仓库里只存票的 sha256，不存原文', !JSON.stringify([...V['byHash'].keys()]).includes(v.token) && leak.length > 0);
}

// ---------- 实例 ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-upload-ticket-' + Date.now().toString(36);
const ADMIN = 'upload-ticket-synthetic-admin';
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const gh = await startFakeGithub();
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { PATH: process.env.PATH, HOME: join(DATA, 'home'), NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', REDIS_URL: '', WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const end = Date.now() + 60000;
let up = false;
while (!up && Date.now() < end && child.exitCode === null) {
  try { up = (await fetch(BASE + '/api/health')).status === 200; } catch { /* 还没起来 */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.log('  ✗ 实例没起来\n' + log.slice(-1500)); child.kill(); await gh.close?.(); process.exit(1); }

const AT = { 'X-Admin-Token': ADMIN };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, body: j };
}
const rpc = (method, params, token) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token ? { Authorization: `Bearer ${token}` } : {});
async function tool(token, name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const text = r.body?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 错误是一句话 */ }
  return { status: r.status, rpcError: r.body?.error ?? null, isError: !!r.body?.result?.isError, text, payload };
}
async function newSession(name, grants = []) {
  const r = await call('POST', '/api/mcp/sessions', { name }, AT);
  if (grants.length) await call('PUT', `/api/mcp/sessions/${r.body.id}/grants`, { grants }, AT);
  return { id: r.body.id, token: r.body.token };
}
/** PUT 原始字节到票的地址（只取 path，不信任 upload_url 里的主机） */
async function put(ticketOrPath, bytes, headers = {}) {
  const path = ticketOrPath.startsWith('/') ? ticketOrPath : `/api/mcp-rest/uploads/${ticketOrPath}`;
  const r = await fetch(BASE + path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: bytes });
  let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, body: j };
}
const pathOf = (url) => new URL(url).pathname;
const appFiles = async (token) => (await tool(token, 'app_files_list', { slug: 'ticket-app', limit: 100 })).payload?.items ?? [];
const uploadsLeft = () => { const d = join(DATA, 'uploads'); if (!existsSync(d)) return 0; let n = 0; (function walk(p) { for (const e of readdirSync(p, { withFileTypes: true })) { if (e.isDirectory()) walk(join(p, e.name)); else n++; } })(d); return n; };
const incomingLeft = () => { const d = join(DATA, 'skill-staging'); return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith('.incoming-')).length : 0; };

try {
  const pub = await ghPublish(BASE, gh, { slug: 'ticket-app', title: '合成上传台', files: [{ path: 'index.html', content: '<h1>合成</h1>' }] }, AT);
  ok('准备：合成自产台发布成功', pub.status === 201, `status=${pub.status}`);
  const full = await newSession('ticket-full', ['app_files_upload', 'app_files_list', 'skill_file_put', 'skill_publish']);
  const appOnly = await newSession('ticket-app-only', ['app_files_upload', 'app_files_list']);
  const bare = await newSession('ticket-bare');
  const toRevoke = await newSession('ticket-revoke', ['app_files_upload']);
  const toUngrant = await newSession('ticket-ungrant', ['skill_file_put']);

  // ---------- 一、正常 ----------
  console.log('一、正常');
  const csv = Buffer.from('合成,数据\n1,2\n');
  let t = await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: '合成.csv', size: csv.length, sha256: sha(csv), mime: 'text/csv', note: ' 合成备注 ' });
  ok('台文件：不带 content_base64 → 发票：upload_url、PUT、10 分钟、现成的 curl', !t.isError && /\/api\/mcp-rest\/uploads\/[A-Za-z0-9_-]{43}$/.test(t.payload?.upload_url ?? '') && t.payload?.method === 'PUT' && t.payload?.expires_in_seconds === 600 && t.payload?.curl?.includes('--data-binary') && t.payload?.size === csv.length, t.text.slice(0, 200));
  let p = await put(pathOf(t.payload.upload_url), csv);
  ok('PUT 原始字节 → 201：和原工具同样的应答（id、sha256、REST url、download_url），integrity=sha256-verified', p.status === 201 && Number.isInteger(p.body?.id) && p.body?.sha256 === sha(csv) && p.body?.integrity === 'sha256-verified' && /\/api\/mcp-rest\/apps\/ticket-app\/files\/\d+$/.test(p.body?.url ?? '') && p.body?.download_url, J(p));
  const files1 = await appFiles(full.token);
  const mine = files1.find((f) => f.id === p.body?.id);
  ok('文件进了台的文件面：名字、备注（两头空白去掉）、创建者缺省 mcp:<会话名>', mine?.original_name === '合成.csv' && mine?.note === '合成备注' && mine?.created_by === 'mcp:ticket-full', J(mine));
  const dl = await fetch(`${BASE}/api/mcp-rest/apps/ticket-app/files/${p.body.id}`, { headers: { Authorization: `Bearer ${full.token}` } });
  ok('下载回来逐字节一样', dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(csv));

  const big = randomBytes(200 * 1024);
  t = await tool(full.token, 'skill_file_put', { name: 'assets/big.bin', size: big.length, sha256: sha(big) });
  ok('技能文件：不带 content → 发票', !t.isError && !!t.payload?.upload_url, t.text.slice(0, 160));
  p = await put(pathOf(t.payload.upload_url), big);
  ok('200KB 二进制 PUT → 201：暂存好了，应答和 skill_file_put 一样（sha256、size、24 小时、sha256-verified）', p.status === 201 && p.body?.sha256 === sha(big) && p.body?.size === big.length && p.body?.expires_in_hours === 24 && p.body?.integrity === 'sha256-verified', J(p));
  const md = Buffer.from('---\nname: ticket-skill\ndescription: 合成技能\n---\n# 合成\n');
  const tm = await tool(full.token, 'skill_file_put', { size: md.length, sha256: sha(md) });
  ok('不带 name 也能发票（暂存按内容寻址）', !tm.isError && (await put(pathOf(tm.payload.upload_url), md)).status === 201);
  const pubSkill = await tool(full.token, 'skill_publish', { slug: 'ticket-skill', files: [{ path: 'SKILL.md', sha256: sha(md) }, { path: 'assets/big.bin', sha256: sha(big) }], changelog: '合成' });
  ok('skill_publish 按 sha256 引用经票传上的文件 → 成版 v1', !pubSkill.isError && pubSkill.payload?.version === 1, pubSkill.text.slice(0, 200));
  ok('暂存目录里没有留下 .incoming 临时文件', incomingLeft() === 0);

  // ---------- 二、只能用一次 ----------
  console.log('二、只能用一次');
  t = await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: 'once.txt', size: 4, sha256: sha(Buffer.from('once')) });
  const once = pathOf(t.payload.upload_url);
  ok('第一次 201', (await put(once, Buffer.from('once'))).status === 201);
  const again = await put(once, Buffer.from('once'));
  ok('同一张票再用：404，不保存第二份', again.status === 404 && /不存在、已用过或已过期/.test(again.body?.error ?? '') && (await appFiles(full.token)).filter((f) => f.original_name === 'once.txt').length === 1, J(again));
  const forged = await put('A'.repeat(43), Buffer.from('x'));
  const shapeless = await put('not-a-ticket', Buffer.from('x'));
  ok('编造的、写法不对的：同一句 404', forged.status === 404 && shapeless.status === 404 && forged.body?.error === again.body?.error && shapeless.body?.error === again.body?.error);

  // ---------- 三、字节不对就什么都不留 ----------
  console.log('三、字节不对就什么都不留');
  const filesBefore = (await appFiles(full.token)).length, diskBefore = uploadsLeft();
  const good = Buffer.from('0123456789');
  const ticket = async () => pathOf((await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: 'bad.bin', size: good.length, sha256: sha(good) })).payload.upload_url);
  let k = await ticket();
  let r = await put(k, Buffer.from('9876543210'));
  ok('同样长度、内容不同（sha256 不符）：400', r.status === 400 && /sha256/.test(r.body?.error ?? ''), J(r));
  ok('  这张票也作废了（重传 404）', (await put(k, good)).status === 404);
  r = await put(await ticket(), Buffer.from('01234'));
  ok('少字节（带 Content-Length）：400', r.status === 400 && /Content-Length 5|5 字节/.test(r.body?.error ?? ''), J(r));
  // 不带 Content-Length（分块传）：只能等字节收完再数
  const chunked = (buf) => new ReadableStream({ start(c) { c.enqueue(buf); c.close(); } });
  k = await ticket();
  r = await fetch(BASE + k, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunked(Buffer.from('01234')), duplex: 'half' }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  ok('少字节（分块、不带 Content-Length）：收完再数，400', r.status === 400 && /收到 5 字节/.test(r.body?.error ?? ''), J(r));
  k = await ticket();
  r = await fetch(BASE + k, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunked(Buffer.from('0123456789ABCDEF')), duplex: 'half' }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch((e) => ({ status: 0, body: String(e) }));
  ok('多字节（分块、不带 Content-Length）：超出 size 就停，413', r.status === 413, J(r));
  r = await put(await ticket(), Buffer.from('0123456789ABCDEF'));
  ok('多字节（带 Content-Length）：Content-Length 和 size 不符就拒，400', r.status === 400 && /Content-Length 16/.test(r.body?.error ?? ''), J(r));
  ok('上面这些一个都没进台的文件面，磁盘上也没留下半个文件', (await appFiles(full.token)).length === filesBefore && uploadsLeft() === diskBefore, `${filesBefore}→${(await appFiles(full.token)).length} / disk ${diskBefore}→${uploadsLeft()}`);
  const tk = await tool(full.token, 'skill_file_put', { size: good.length, sha256: sha(good) });
  ok('技能文件 sha256 不符：400，暂存里没有它、也没有 .incoming 残留', (await put(pathOf(tk.payload.upload_url), Buffer.from('9876543210'))).status === 400 && !existsSync(join(DATA, 'skill-staging', sha(good))) && incomingLeft() === 0);

  // ---------- 四、用票时再核 ----------
  console.log('四、用票时再核');
  t = await tool(toRevoke.token, 'app_files_upload', { slug: 'ticket-app', name: 'revoked.txt', size: 3, sha256: sha(Buffer.from('abc')) });
  ok('（准备）会话吊销前拿到票', !t.isError && !!t.payload?.upload_url, t.text.slice(0, 120));
  const rv = await call('DELETE', `/api/mcp/sessions/${toRevoke.id}`, undefined, AT);
  r = await put(pathOf(t.payload.upload_url), Buffer.from('abc'));
  ok('会话吊销之后用票：403，不保存', rv.status < 300 && r.status === 403 && !(await appFiles(full.token)).some((f) => f.original_name === 'revoked.txt'), `revoke=${rv.status} ${J(r)}`);
  t = await tool(toUngrant.token, 'skill_file_put', { size: 3, sha256: sha(Buffer.from('xyz')) });
  ok('（准备）授权收回前拿到票', !t.isError && !!t.payload?.upload_url);
  await call('PUT', `/api/mcp/sessions/${toUngrant.id}/grants`, { grants: [] }, AT);
  r = await put(pathOf(t.payload.upload_url), Buffer.from('xyz'));
  ok('授权收回之后用票：403，暂存里没有', r.status === 403 && !existsSync(join(DATA, 'skill-staging', sha(Buffer.from('xyz')))), J(r));

  // ---------- 五、发票照旧要授权，申请时的校验 ----------
  console.log('五、发票照旧要授权');
  let n = await tool(bare.token, 'app_files_upload', { slug: 'ticket-app', name: 'x.txt', size: 1, sha256: 'a'.repeat(64) });
  let s = await tool(appOnly.token, 'skill_file_put', { size: 1, sha256: 'a'.repeat(64) });
  ok('没有授权的会话拿不到票（照旧按工具不存在应答）', n.rpcError?.code === -32601 && s.rpcError?.code === -32601, J([n.rpcError, s.rpcError]));
  const bad = async (args, re) => { const x = await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: 'x.txt', ...args }); return x.isError && re.test(x.text) && !x.payload?.upload_url; };
  ok('缺 size：拒', await bad({ sha256: 'a'.repeat(64) }, /size/));
  ok('缺 sha256、sha256 写法不对：拒', await bad({ size: 1 }, /sha256/) && await bad({ size: 1, sha256: 'xyz' }, /sha256/));
  ok('size 是 0、负数、小数：拒', await bad({ size: 0, sha256: 'a'.repeat(64) }, /size/) && await bad({ size: -1, sha256: 'a'.repeat(64) }, /size/) && await bad({ size: 1.5, sha256: 'a'.repeat(64) }, /size/));
  ok('台文件超 100MB 上限：拒', await bad({ size: 100 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) }, /上限/));
  const sk = await tool(full.token, 'skill_file_put', { size: 10 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) });
  ok('技能文件超 10MB 上限：拒', sk.isError && /上限/.test(sk.text));
  const nf = await tool(full.token, 'app_files_upload', { slug: 'no-such-app', name: 'x.txt', size: 1, sha256: 'a'.repeat(64) });
  ok('台不存在：拒', nf.isError && !nf.payload?.upload_url, nf.text.slice(0, 120));
  ok('文件名带路径分隔符：拒', await bad({ name: '../x.txt', size: 1, sha256: 'a'.repeat(64) }, /文件名/));
  const tk2 = await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: 'ok.txt', content_base64: Buffer.from('hi').toString('base64') });
  ok('带 content_base64 的老用法照旧（不发票，直接存）', !tk2.isError && Number.isInteger(tk2.payload?.id) && !tk2.payload?.upload_url, tk2.text.slice(0, 120));

  // ---------- 六、审计不记票 ----------
  console.log('六、审计不记票');
  t = await tool(full.token, 'app_files_upload', { slug: 'ticket-app', name: 'audit.txt', size: 2, sha256: sha(Buffer.from('au')) });
  const token = pathOf(t.payload.upload_url).split('/').pop();
  await put(pathOf(t.payload.upload_url), Buffer.from('au'));
  const calls = await call('GET', '/api/mcp/calls?limit=200', undefined, AT);
  const rows = JSON.stringify(calls.body ?? '');
  ok('调用记录里有直传这一笔（rest/ticket_upload，记在发票的会话名下），找不到票的原文', calls.status === 200 && /rest\/ticket_upload/.test(rows) && /ticket-full/.test(rows) && !rows.includes(token), `status=${calls.status}`);
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  child.kill();
  await new Promise((x) => setTimeout(x, 400));
  await gh.close?.();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`mcp-upload-ticket-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
