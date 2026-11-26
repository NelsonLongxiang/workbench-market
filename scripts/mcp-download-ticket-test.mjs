#!/usr/bin/env node
/**
 * MCP 附件短时下载票（#1055）的对抗组。独立实例：全新 DATA_DIR、合成的管理口令、MCP_GATEWAY=on、GitHub 替身仓库发两个合成自产台。
 * app_files_list 带 ticket_for_id 发一张只读的短时下载票；GET /api/mcp-rest/downloads/<票> 取回那一份文件，不用会话令牌。
 *  零、票的仓库（内存，注入时钟）：2 分钟过期、次数上限（并发各扣各的）、每会话 20 张、写法不对当不存在、只存票的 sha256、只有发票的会话能撤
 *  一、正控：一次合法取件，字节逐位一致，响应头沿用下载防线（attachment、nosniff、no-store），不带任何会话令牌
 *  二、生命周期：用一次就没了、限次（Range、条件请求也各算一次）、并发不超限、编造的和写法不对的同一句 404
 *  三、范围：别的台的文件、不存在的文件、同名台删了重建、文件被删——都拿不到内容和元数据；相邻权限（只有上传、只有数据读）发不出票；缺权限的拒绝不分文件在不在
 *  四、撤销与收回：会话吊销、授权收回、票被撤销之后再取——404；别人撤不了；撤过再撤是 false
 *  五、最小权限：票不能当会话令牌用、不能换文件、不能用于其他方法和路径；条件请求先过票
 *  六、审计与日志：取件、拒绝都记在发票的会话名下，只记编号；调用记录和服务日志里找不到票的原文
 * 测试数据都是合成的。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';
import { DownloadTickets, DOWNLOAD_TICKET_TTL_MS, DOWNLOAD_TICKETS_PER_SESSION } from '../server/src/download-tickets.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + extra); } };
const J = (x) => JSON.stringify(x);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------- 零、票的仓库 ----------
console.log('零、票的仓库');
{
  let now = 1_000_000;
  const T = new DownloadTickets(() => now);
  const base = { sessionId: 1, session: 's1', slug: 'a', appId: 1, appCreatedAt: 't', fileId: 1, size: 1, sha256: 'a'.repeat(64), storagePath: 'p', maxUses: 1 };
  const a = T.issue(base);
  ok('票是 43 个字符的 base64url；编号 dt-八位十六进制；过期 = 发票时刻 + 2 分钟', /^[A-Za-z0-9_-]{43}$/.test(a.token) && /^dt-[0-9a-f]{8}$/.test(a.ref) && a.expiresAt === now + DOWNLOAD_TICKET_TTL_MS && DOWNLOAD_TICKET_TTL_MS === 120_000);
  ok('次数 1：用一次拿得到，再用就没有了', T.take(a.token)?.session === 's1' && T.take(a.token) === null);
  const b = T.issue({ ...base, maxUses: 3 });
  ok('次数 3：拿三次，第四次没有', [1, 2, 3].every(() => T.take(b.token) !== null) && T.take(b.token) === null);
  const c = T.issue({ ...base, maxUses: 3 });
  const burst = await Promise.all(Array.from({ length: 10 }, async () => T.take(c.token)));
  ok('并发十个一起取、上限 3：恰好三个拿到', burst.filter(Boolean).length === 3);
  const d = T.issue(base);
  now += DOWNLOAD_TICKET_TTL_MS;
  ok('到点过期：拿不到', T.take(d.token) === null);
  const e = T.issue(base);
  now += DOWNLOAD_TICKET_TTL_MS - 1;
  ok('差一毫秒还拿得到', T.take(e.token)?.fileId === 1);
  ok('写法不对、不是字符串：当不存在', T.take('x') === null && T.take(undefined) === null && T.take('a'.repeat(44)) === null && T.take({ toString: () => a.token }) === null);
  let bad = 0;
  for (const maxUses of [0, 6, 1.5, -1, Number.NaN]) { try { T.issue({ ...base, maxUses }); } catch (x) { if (x?.status === 400) bad++; } }
  ok('次数 0、6、小数、负数、NaN：都拒（400）', bad === 5);
  const U = new DownloadTickets(() => now);
  for (let i = 0; i < DOWNLOAD_TICKETS_PER_SESSION; i++) U.issue(base);
  let capped = null; try { U.issue(base); } catch (x) { capped = x; }
  ok('同一会话第 ' + (DOWNLOAD_TICKETS_PER_SESSION + 1) + ' 张：429；别的会话照发', capped?.status === 429 && (() => { try { U.issue({ ...base, sessionId: 2, session: 's2' }); return true; } catch { return false; } })());
  const V = new DownloadTickets(() => now); const v = V.issue(base);
  ok('仓库里只存票的 sha256，不存原文', !J([...V['byHash'].keys()]).includes(v.token) && !J([...V['byHash'].values()]).includes(v.token));
  const R = new DownloadTickets(() => now); const r1 = R.issue(base);
  ok('撤销：别的会话、同名但编号不同的会话、编造的编号都是 false，票还在', !R.revoke(r1.ref, 2, 's1') && !R.revoke(r1.ref, 1, 's2') && !R.revoke('dt-00000000', 1, 's1') && !R.revoke('x', 1, 's1') && R.take(r1.token) === null === false);
  const R2 = new DownloadTickets(() => now); const r2 = R2.issue({ ...base, maxUses: 2 });
  ok('发票的会话撤销：true，之后拿不到；再撤是 false', R2.revoke(r2.ref, 1, 's1') === true && R2.take(r2.token) === null && R2.revoke(r2.ref, 1, 's1') === false);
}

// ---------- 实例 ----------
const PORT = 20000 + Math.floor(Math.random() * 12000);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = 'tmp/e2e-mcp-download-ticket-' + Date.now().toString(36);
const ADMIN = 'download-ticket-synthetic-admin';
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
const rpc = (method, params, token) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token ? { Authorization: 'Bearer ' + token } : {});
async function tool(token, name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const text = r.body?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 错误是一句话 */ }
  return { status: r.status, rpcError: r.body?.error ?? null, isError: !!r.body?.result?.isError, text, payload };
}
async function newSession(name, grants = []) {
  const r = await call('POST', '/api/mcp/sessions', { name }, AT);
  if (grants.length) await call('PUT', '/api/mcp/sessions/' + r.body.id + '/grants', { grants }, AT);
  return { id: r.body.id, token: r.body.token, name };
}
const pathOf = (url) => new URL(url).pathname;
const GONE = /下载票不存在、已用完、已过期或已失效/;
/** GET 票的地址：不带任何 Authorization */
async function get(path, headers = {}, method = 'GET') {
  const r = await fetch(BASE + path, { method, headers });
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* 二进制 */ }
  return { status: r.status, buf, body: j, headers: r.headers };
}
const issue = (s, slug, id, extra = {}) => tool(s.token, 'app_files_list', { slug, ticket_for_id: id, ...extra });
const upload = async (s, slug, name, bytes) => {
  const x = await tool(s.token, 'app_files_upload', { slug, name, content_base64: bytes.toString('base64'), size: bytes.length, sha256: sha(bytes) });
  return x.payload?.id;
};

try {
  const pubA = await ghPublish(BASE, gh, { slug: 'dl-app', title: '合成下载台', files: [{ path: 'index.html', content: '<h1>合成</h1>' }] }, AT);
  const pubB = await ghPublish(BASE, gh, { slug: 'dl-other', title: '合成另一个台', files: [{ path: 'index.html', content: '<h1>另一个</h1>' }] }, AT);
  ok('准备：两个合成自产台发布成功', pubA.status === 201 && pubB.status === 201, pubA.status + '/' + pubB.status);
  const reader = await newSession('dl-reader', ['app_files_list', 'app_files_upload']);
  const peer = await newSession('dl-peer', ['app_files_list']);
  const uploadOnly = await newSession('dl-upload-only', ['app_files_upload']);
  const dataOnly = await newSession('dl-data-only', ['app_data_list']);
  const bare = await newSession('dl-bare');
  const scoped = await newSession('dl-scoped');
  const toRevoke = await newSession('dl-revoke', ['app_files_list']);
  const toUngrant = await newSession('dl-ungrant', ['app_files_list']);

  const csv = Buffer.from('合成,数据\n' + '1,2\n'.repeat(500));
  const fid = await upload(reader, 'dl-app', '合成.csv', csv);
  const otherBytes = Buffer.from('另一个台的合成内容');
  const otherId = await upload(reader, 'dl-other', 'other.txt', otherBytes);
  ok('准备：两个台各有一份文件', Number.isInteger(fid) && Number.isInteger(otherId), J([fid, otherId]));

  // ---------- 一、正控 ----------
  console.log('一、正控');
  let t = await issue(reader, 'dl-app', fid);
  ok('发票：download_url、编号、2 分钟、默认 1 次、文件的名字大小 sha256', !t.isError && /\/api\/mcp-rest\/downloads\/[A-Za-z0-9_-]{43}$/.test(t.payload?.download_url ?? '') && /^dt-[0-9a-f]{8}$/.test(t.payload?.ticket_ref ?? '') && t.payload?.max_uses === 1 && t.payload?.expires_in_seconds === 120 && t.payload?.file?.sha256 === sha(csv) && t.payload?.file?.size === csv.length && t.payload?.file?.name === '合成.csv', t.text.slice(0, 200));
  let g = await get(pathOf(t.payload.download_url));
  ok('不带任何会话令牌 GET：200，字节逐位一致', g.status === 200 && g.buf.equals(csv), 'status=' + g.status);
  ok('响应头沿用下载防线：attachment、nosniff、ETag / X-Content-SHA256 = sha256，且 no-store、no-referrer', /^attachment/.test(g.headers.get('content-disposition') ?? '') && g.headers.get('x-content-type-options') === 'nosniff' && g.headers.get('x-content-sha256') === sha(csv) && g.headers.get('etag') === '"' + sha(csv) + '"' && g.headers.get('cache-control') === 'no-store' && g.headers.get('referrer-policy') === 'no-referrer');

  // ---------- 二、生命周期 ----------
  console.log('二、生命周期');
  const once = pathOf(t.payload.download_url);
  const again = await get(once);
  ok('同一张票（次数 1）再用：404，同一句话，没有文件内容', again.status === 404 && GONE.test(again.body?.error ?? '') && again.buf.length < 200);
  const forged = await get('/api/mcp-rest/downloads/' + 'A'.repeat(43));
  const shapeless = await get('/api/mcp-rest/downloads/not-a-ticket');
  ok('编造的、写法不对的：同一句 404，和用过的一样', forged.status === 404 && shapeless.status === 404 && J(forged.body) === J(again.body) && J(shapeless.body) === J(again.body));
  t = await issue(reader, 'dl-app', fid, { max_uses: 3 });
  const p3 = pathOf(t.payload.download_url);
  const r1 = await get(p3, { Range: 'bytes=0-9' });
  const r2 = await get(p3, { 'If-None-Match': '"' + sha(csv) + '"' });
  const r3 = await get(p3);
  const r4 = await get(p3);
  ok('次数 3：Range 206、条件请求 304、整份 200 各算一次，第四次 404', r1.status === 206 && r1.buf.equals(csv.subarray(0, 10)) && r2.status === 304 && r3.status === 200 && r3.buf.equals(csv) && r4.status === 404, J([r1.status, r2.status, r3.status, r4.status]));
  t = await issue(reader, 'dl-app', fid, { max_uses: 2 });
  const pc = pathOf(t.payload.download_url);
  const burst = await Promise.all(Array.from({ length: 8 }, () => get(pc)));
  ok('并发八个一起取、上限 2：恰好两个 200，其余 404', burst.filter((x) => x.status === 200).length === 2 && burst.filter((x) => x.status === 404).length === 6, J(burst.map((x) => x.status)));
  for (const [label, extra, re] of [['max_uses 0', { max_uses: 0 }, /max_uses/], ['max_uses 6', { max_uses: 6 }, /max_uses/], ['max_uses 1.5', { max_uses: 1.5 }, /max_uses/], ['带 limit', { limit: 5 }, /不翻页|limit/]]) {
    const x = await issue(reader, 'dl-app', fid, extra);
    ok('申请时 ' + label + '：拒，没有票', x.isError && re.test(x.text) && !x.payload?.download_url, x.text.slice(0, 120));
  }
  const both = await tool(reader.token, 'app_files_list', { slug: 'dl-app', ticket_for_id: fid, revoke_ticket: 'dt-00000000' });
  ok('ticket_for_id 和 revoke_ticket 一起给：拒', both.isError && /一次只能给一个/.test(both.text));
  const plainMax = await tool(reader.token, 'app_files_list', { slug: 'dl-app', max_uses: 2 });
  ok('不申请票时带 max_uses：拒', plainMax.isError && /max_uses/.test(plainMax.text));
  const plain = await tool(reader.token, 'app_files_list', { slug: 'dl-app' });
  ok('老用法照旧：列文件（不发票）', !plain.isError && Array.isArray(plain.payload?.items) && plain.payload.items.some((f) => f.id === fid) && !J(plain.payload).includes('download_url":"http'));
  let capped = null;
  for (let i = 0; i < DOWNLOAD_TICKETS_PER_SESSION + 1; i++) { capped = await issue(peer, 'dl-app', fid); }
  ok('同一会话第 ' + (DOWNLOAD_TICKETS_PER_SESSION + 1) + ' 张：拒（429）', capped.isError && /上限/.test(capped.text), capped.text.slice(0, 120));

  // ---------- 三、范围 ----------
  console.log('三、范围');
  const x1 = await issue(reader, 'dl-app', otherId);
  const x2 = await issue(reader, 'dl-app', 999999);
  ok('别的台的文件、不存在的文件：同一句 404，不泄露在不在', x1.isError && x2.isError && !x1.payload?.download_url && x1.text === x2.text.replace('999999', String(otherId)), J([x1.text.slice(0, 80), x2.text.slice(0, 80)]));
  const up = await issue(uploadOnly, 'dl-app', fid);
  const dt = await issue(dataOnly, 'dl-app', fid);
  const bs = await issue(bare, 'dl-app', fid);
  ok('相邻权限（只有 app_files_upload、只有 app_data_list、什么都没有）：发不出票（工具不存在）', [up, dt, bs].every((x) => x.rpcError?.code === -32601 && !x.payload?.download_url), J([up.rpcError, dt.rpcError, bs.rpcError]));
  const cards = await call('GET', '/api/workbenches', undefined, AT);
  const cardA = (Array.isArray(cards.body) ? cards.body : (cards.body?.items ?? [])).find((w) => String(w.url ?? '').includes('/apps/dl-app/'));
  const sg = await call('PUT', '/api/mcp/sessions/' + scoped.id + '/grants', { grants: ['app_files_list@' + cardA?.id] }, AT);
  if (sg.status === 200) {
    const inScope = await issue(scoped, 'dl-app', fid);
    const exist = await issue(scoped, 'dl-other', otherId);
    const absent = await issue(scoped, 'dl-other', 999999);
    ok('只授权了这个台的会话：台内发得出票', !inScope.isError && !!inScope.payload?.download_url, inScope.text.slice(0, 120));
    ok('只授权了这个台的会话：台外的文件在不在，拒绝都是同一个应答（未授权），不发票', !!exist.rpcError && !!absent.rpcError && !exist.payload?.download_url && J(exist.rpcError) === J(absent.rpcError), J([exist.rpcError, absent.rpcError, exist.text.slice(0, 60)]));
  } else ok('只授权单台的授权写法被接受（app_files_list@台）', false, J([cardA, sg]));
  // 同名台删了重建
  t = await issue(reader, 'dl-app', fid, { max_uses: 3 });
  const rebuilt = pathOf(t.payload.download_url);
  const del = await call('DELETE', '/api/apps/dl-app', { reviewed_by: 'synthetic-reviewer' }, AT);
  const pubA2 = await ghPublish(BASE, gh, { slug: 'dl-app', title: '合成下载台（重建）', files: [{ path: 'index.html', content: '<h1>重建</h1>' }] }, AT);
  const reUp = await upload(reader, 'dl-app', '合成.csv', csv);
  g = await get(rebuilt);
  ok('同名台删了重建（连同名文件也有）：旧票 404，拿不到新台的文件', del.status < 300 && pubA2.status === 201 && Number.isInteger(reUp) && g.status === 404 && GONE.test(g.body?.error ?? '') && g.buf.length < 200, J([del.status, pubA2.status, reUp, g.status]));
  // 文件被删
  const keepId = await upload(reader, 'dl-app', 'keep.txt', Buffer.from('keep'));
  t = await issue(reader, 'dl-app', keepId, { max_uses: 3 });
  const gp = pathOf(t.payload.download_url);
  const fdel = await call('DELETE', '/api/apps/dl-app/files/' + keepId, undefined, AT);
  g = await get(gp);
  ok('文件已删除：票 404，没有内容和元数据', fdel.status < 300 && g.status === 404 && GONE.test(g.body?.error ?? '') && g.buf.length < 200, J([fdel.status, g.status]));
  const fid2 = reUp;

  // ---------- 四、撤销与收回 ----------
  console.log('四、撤销与收回');
  t = await issue(toRevoke, 'dl-app', fid2, { max_uses: 3 });
  const pr = pathOf(t.payload.download_url);
  const rv = await call('DELETE', '/api/mcp/sessions/' + toRevoke.id, undefined, AT);
  g = await get(pr);
  ok('会话吊销之后用票：404，没有内容', rv.status < 300 && g.status === 404 && GONE.test(g.body?.error ?? '') && g.buf.length < 200, J([rv.status, g.status]));
  t = await issue(toUngrant, 'dl-app', fid2, { max_uses: 3 });
  const pu = pathOf(t.payload.download_url);
  await call('PUT', '/api/mcp/sessions/' + toUngrant.id + '/grants', { grants: [] }, AT);
  g = await get(pu);
  ok('app_files_list 授权收回之后用票：404', g.status === 404 && GONE.test(g.body?.error ?? ''), J([g.status]));
  t = await issue(reader, 'dl-app', fid2, { max_uses: 3 });
  const prr = pathOf(t.payload.download_url), ref = t.payload.ticket_ref;
  const byOther = await tool(peer.token, 'app_files_list', { slug: 'dl-app', revoke_ticket: ref });
  ok('别的会话撤不了：revoked:false，票照样能用', byOther.payload?.revoked === false && (await get(prr, { Range: 'bytes=0-0' })).status === 206);
  const mine = await tool(reader.token, 'app_files_list', { slug: 'dl-app', revoke_ticket: ref });
  g = await get(prr);
  ok('发票的会话撤销：revoked:true，之后取不了；再撤 revoked:false', mine.payload?.revoked === true && g.status === 404 && (await tool(reader.token, 'app_files_list', { slug: 'dl-app', revoke_ticket: ref })).payload?.revoked === false);
  const junk = await tool(reader.token, 'app_files_list', { slug: 'dl-app', revoke_ticket: 'whatever' });
  ok('编号写法不对：revoked:false，不报错细节', junk.payload?.revoked === false);

  // ---------- 五、最小权限 ----------
  console.log('五、最小权限');
  t = await issue(reader, 'dl-app', fid2, { max_uses: 5 });
  const tok = pathOf(t.payload.download_url).split('/').pop();
  const asBearer = await call('GET', '/api/mcp-rest/apps/dl-app/files', undefined, { Authorization: 'Bearer ' + tok });
  const asBearerMcp = await rpc('tools/list', {}, tok);
  ok('票不能当会话令牌用：列文件 401，/mcp 401', asBearer.status === 401 && (asBearerMcp.status === 401 || !!asBearerMcp.body?.error), J([asBearer.status, asBearerMcp.status]));
  const dp = '/api/mcp-rest/downloads/' + tok;
  const methods = [];
  for (const m of ['PUT', 'POST', 'DELETE', 'PATCH']) { const r = await fetch(BASE + dp, { method: m, headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Token': ADMIN }, body: m === 'DELETE' ? undefined : 'x' }); methods.push(r.status); }
  ok('别的方法不能用票（不是 2xx），而且没扣次数', methods.every((s) => s >= 400) && (await get(dp, { Range: 'bytes=0-0' })).status === 206, J(methods));
  const detour = await get(dp + '?id=' + otherId + '&slug=dl-other&file=other.txt');
  ok('请求里带别的文件、别的台：只会得到票上绑的那一份', detour.status === 200 && detour.buf.equals(csv));
  const sub = await get(dp + '/' + otherId);
  const dots = await get(dp + '/../../apps/dl-other/files/' + otherId);
  ok('票后面加路径、穿越：404 或不是别的文件的内容', sub.status === 404 && !dots.buf.equals(otherBytes));
  const forgedCond = await get('/api/mcp-rest/downloads/' + 'B'.repeat(43), { 'If-None-Match': '*', Range: 'bytes=0-1' });
  const forgedEtag = await get('/api/mcp-rest/downloads/' + 'C'.repeat(43), { 'If-None-Match': '"' + sha(csv) + '"' });
  ok('条件请求先过票：编造的票带 If-None-Match / Range 也只是 404（不是 304、206）', forgedCond.status === 404 && forgedEtag.status === 404 && forgedCond.buf.length < 200);
  const deadCond = await get(once, { 'If-None-Match': '"' + sha(csv) + '"' });
  ok('用完的票带正确的 ETag：404，不是 304', deadCond.status === 404);

  // ---------- 六、审计与日志 ----------
  console.log('六、审计与日志');
  const calls = await call('GET', '/api/mcp/calls?limit=500', undefined, AT);
  const rows = J(calls.body ?? '');
  const tokens = [once, p3, pc, pr, pu, prr, dp, gp, rebuilt].map((p) => p.split('/').pop());
  ok('调用记录里有取件（rest/ticket_download，记在发票的会话名下），也有拒绝的原因', calls.status === 200 && /rest\/ticket_download/.test(rows) && /dl-reader/.test(rows) && /dl-revoke/.test(rows) && /session revoked or replaced|grant withdrawn|app replaced|file gone/.test(rows), 'status=' + calls.status);
  ok('调用记录和服务日志里找不到任何一张票的原文', tokens.every((k) => !rows.includes(k) && !log.includes(k)), tokens.filter((k) => rows.includes(k) || log.includes(k)).join(','));

  // 审计的 ok 标志要和结果对得上：取件成功的行 ok=1、没有错误；拒绝的行 ok=0、有原因（把拒绝记成成功必须红）
  const callRows = Array.isArray(calls.body) ? calls.body : (calls.body?.calls ?? calls.body?.rows ?? []);
  const dl = callRows.filter((r) => r.method === 'rest/ticket_download');
  const dlOk = dl.filter((r) => Number(r.ok) === 1), dlBad = dl.filter((r) => Number(r.ok) === 0);
  ok('取件的审计行：ok=1 的都没有错误、ok=0 的都有原因，两种都有', dl.length > 0 && dlOk.length > 0 && dlBad.length > 0 && dlOk.every((r) => r.error === '') && dlBad.every((r) => r.error !== '') && dl.every((r) => r.session_name !== '(download-ticket)'), J([dl.length, dlOk.length, dlBad.length]));
  // 没有票可对的请求（编造的、用完的、过期的、撤销的）：有界聚合，不记在任何会话名下，没有票和路径
  const rej = callRows.filter((r) => r.method === 'rest/ticket_download_rejected');
  ok('没有票的请求留痕：一分钟窗口里（前面已有二十多次这样的请求）只有一行聚合，ok=0、会话名是占位、有次数', rej.length === 1 && Number(rej[0].ok) === 0 && rej[0].session_name === '(download-ticket)' && /^\d+ request\(s\) with no valid download ticket/.test(rej[0].error) && Number(rej[0].duration_ms) === 0, J(rej));
  const rejText = rej.length === 1 ? [rej[0].session_name, rej[0].method, rej[0].tool, rej[0].error, rej[0].channel].join(' ') : '';
  ok('聚合行里没有票、路径、来源地址（会话名、方法、错误、通道里）', rej.length === 1 && !/downloads\/|[A-Za-z0-9_-]{40,}|127\.0\.0\.1|::1/.test(rejText) && tokens.every((k) => !J(rej).includes(k)));
  const before = (await call('GET', '/api/mcp/calls?limit=500', undefined, AT)).body;
  for (let n = 0; n < 12; n++) await get('/api/mcp-rest/downloads/' + String.fromCharCode(65 + n).repeat(43));
  const after = (await call('GET', '/api/mcp/calls?limit=500', undefined, AT)).body;
  const cnt = (b) => (Array.isArray(b) ? b : (b?.calls ?? b?.rows ?? [])).filter((r) => r.method === 'rest/ticket_download_rejected').length;
  ok('再来十二次没有票的请求：窗口内不再多写行（有界）', cnt(before) === 1 && cnt(after) === 1, J([cnt(before), cnt(after)]));
  // 票不进采纳统计的键：成功用过的票的路径（下载、上传）折叠成 :ticket
  const upT = await tool(reader.token, 'app_files_upload', { slug: 'dl-app', name: 'via-ticket.txt', size: 5, sha256: sha(Buffer.from('hello')) });
  const upPath = upT.payload?.upload_path ?? upT.payload?.upload_url ?? '';
  const upTok = upPath ? pathOf(upPath.startsWith('http') ? upPath : BASE + upPath).split('/').pop() : '';
  const upPut = upTok ? await fetch(BASE + '/api/mcp-rest/uploads/' + upTok, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('hello') }) : null;
  ok('准备：上传票直传成功（用来核统计里的上传票路径）', upPut?.status === 201, J([upT.text.slice(0, 160), upPut?.status]));
  // Express routes without regard to case: a mixed-case path reaches the same route and must fold to the same key
  const mc = await issue(reader, 'dl-app', fid2, { max_uses: 2 });
  const mcTok = pathOf(mc.payload.download_url).split('/').pop();
  const mcGet = await get('/api/mcp-rest/DownLoads/' + mcTok);
  ok('准备：大小写混写的路径也到同一条路由（取件成功）', mcGet.status === 200 || mcGet.status === 206, J([mcGet.status]));
  tokens.push(mcTok);
  const stats = await call('GET', '/api/stats', undefined, AT);
  const statsText = J(stats.body ?? '');
  const endpoints = (stats.body?.endpoints ?? []).map((e) => e.endpoint);
  ok('统计里：下载票、上传票的路径折叠成 :ticket，找不到任何一张票的原文', stats.status === 200 && endpoints.includes('/api/mcp-rest/downloads/:ticket') && (!upTok || endpoints.includes('/api/mcp-rest/uploads/:ticket')) && [...tokens, upTok, tok].filter(Boolean).every((k) => !statsText.toLowerCase().includes(k.toLowerCase())) && !endpoints.some((e) => /downloads/i.test(e) && e !== '/api/mcp-rest/downloads/:ticket'), J([stats.status, endpoints.filter((e) => /mcp-rest\/(down|up)/.test(e))]));
} catch (e) {
  fail++;
  console.log('  ✗ 跑不下去：' + (e?.stack ?? e));
} finally {
  child.kill();
  await new Promise((x) => setTimeout(x, 400));
  await gh.close?.();
  rmSync(DATA, { recursive: true, force: true });
}
console.log('mcp-download-ticket-test: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
