#!/usr/bin/env node
/** 凭据库板块冒烟（融合 dsh-vault）：全新 DATA_DIR + 临时库文件 + 随机回环端口，合成口令与合成主密码，不碰真实 ~/.dsh。
 *  ① 门：读也要口令；业务面浏览器读写一律 403；控制面同源 GET（无 Origin）凭口令放行；跨站 GET 拒。
 *  ② 锁：未解锁 423；错主密码 401；连错 5 次进 30s 冷却 429。
 *  ③ 数据面：列表/回收站/健康/历史不出现任何明文密钥；完整条目只在单条读出；TOTP 6 位；软删→恢复→再删→清除。
 *  ④ 互通：磁盘文件无明文；上游 openVault 用同一主密码读得到；模拟 DSH 插件在外部写入后，市场列表能看见。
 *  ⑩ 主密码门槛：新建库拒短/全数字/常见/弱口令且不落盘；强口令能建；旧的弱主密码库照常解锁并带提示。
 *  收尾：每个实例按进程组停（SIGTERM，10s 后 SIGKILL），已被信号杀掉的不再等；整套 180s 看门狗，超时报出卡在哪一步并 exit 1。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/vault-smoke-' + Date.now().toString(36));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const servers = [];
let step = '启动';
const section = (t) => { step = t; console.log(t); };

/** 给实例所在进程组发信号（连带它可能拉起的孙进程）；组不在了就退回只发给子进程 */
const signal = (sv, sig) => { try { process.kill(-sv.child.pid, sig); } catch { try { sv.child.kill(sig); } catch { /* 已退 */ } } };
const exited = (sv) => sv.child.exitCode !== null || sv.child.signalCode !== null;
/** 停一个实例并等它真退出：被信号杀掉时 exitCode 为 null（只有 signalCode），不能拿 exitCode 判断，否则会等一个永远不来的 exit */
async function stop(sv) {
  if (!exited(sv)) {
    const ex = new Promise((x) => sv.child.once('exit', x));
    signal(sv, 'SIGTERM');
    const hard = setTimeout(() => signal(sv, 'SIGKILL'), 10_000);
    await ex;
    clearTimeout(hard);
  }
  signal(sv, 'SIGKILL'); // 收掉组里残留的孙进程
}
const watchdog = setTimeout(() => {
  console.log(`  ✗ vault-smoke 超过 180s 未结束（卡在：${step}）`);
  for (const sv of servers) signal(sv, 'SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
  console.log(`vault-smoke: ${pass} passed / ${fail + 1} failed`);
  process.exit(1);
}, 180_000);

function boot(tag, extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = join(TMP, `data-${tag}`); mkdirSync(data, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: String(port), DATA_DIR: data, ...extraEnv };
  for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_DEV_ORIGIN', 'WM_CONTROL_PORT']) if (!(k in extraEnv)) delete env[k];
  if (!('DSH_VAULT_PASSWORD' in extraEnv)) delete env.DSH_VAULT_PASSWORD;
  if (!('DSH_VAULT_PASSWORD_FILE' in extraEnv)) delete env.DSH_VAULT_PASSWORD_FILE;
  if (!('WM_VAULT_HOST' in extraEnv)) delete env.WM_VAULT_HOST;
  if (!('WM_VAULT_SERVER_PASSWORD_ON_MAIN' in extraEnv)) delete env.WM_VAULT_SERVER_PASSWORD_ON_MAIN;
  if (!('WM_CONTROL_PORT' in extraEnv)) env.WM_CONTROL_PORT = String(port + 1); // 控制面缺省已不开；本冒烟显式开一个，同时覆盖业务面与控制面两种页面
  // Child-origin IPC proves this test owns each listening port before any HTTP request.
  const preload = "import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>{const a=this.address();if(a&&typeof a==='object')process.send?.({kind:'synthetic-owned-listener',port:a.port});});return listen.apply(this,args)};";
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env, detached: true }); // 独立进程组，收尾整组停
  let err = ''; child.stderr.on('data', (c) => (err += c));
  const ownedPorts = new Set();
  child.on('message', (m) => { if (m?.kind === 'synthetic-owned-listener' && Number.isInteger(m.port)) ownedPorts.add(m.port); });
  const s = { port, control: port + 1, child, ownedPorts, err: () => err };
  servers.push(s);
  return s;
}
const http = (port, method, path, headers = {}, body) => new Promise((done, reject) => {
  const owner = servers.find(s => (s.port === port || s.control === port) && s.ownedPorts.has(port));
  if (!owner || exited(owner)) return reject(Error('synthetic_listener_ownership_missing'));
  const h = { ...headers }; if (body !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
  const rq = request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (rs) => { // 不复用连接：收尾时没有挂着的 keep-alive
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j, text: s }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) }, text: '' }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const up = async (port) => { const end = Date.now() + 40_000; const owner = servers.find(s => s.port === port || s.control === port); if (!owner) throw Error('unknown_synthetic_port'); while (Date.now() < end) { if (exited(owner)) throw Error('owned_synthetic_server_exited: ' + owner.err().slice(-200)); if (owner.ownedPorts.has(port) && (await http(port, 'GET', '/api/health')).status === 200) return true; await new Promise((x) => setTimeout(x, 100)); } throw Error('owned_synthetic_listener_not_ready'); };

const TOK = 'synthetic-vault-admin-token';
const MASTER = 'synthetic-master-pass-42';
const SECRET_PW = 'Synthetic-Pw-Do-Not-Leak-7731';
const SECRET_KEY = 'sk-synthetic-apikey-0099887766';
const OTP = 'JBSWY3DPEHPK3PXP';

try {
  const vaultFile = join(TMP, 'vault', 'default.json');
  const A = boot('a', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile });
  ok('业务面与控制面都起来', (await up(A.port)) && (await up(A.control)), A.err().slice(-300));
  const C = `http://127.0.0.1:${A.control}`;
  // 控制面浏览器：写带 Origin；同源 GET 只带 Sec-Fetch-Site（浏览器真实形态）
  const cw = { origin: C, host: `127.0.0.1:${A.control}`, 'x-admin-token': TOK };
  const cr = { 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${A.control}`, 'x-admin-token': TOK };
  const get = (p) => http(A.control, 'GET', p, cr);
  const send = (m, p, b) => http(A.control, m, p, cw, b === undefined ? undefined : JSON.stringify(b));

  section('① 门');
  let r = await http(A.port, 'GET', '/api/vault/status');
  ok('本机 CLI 无口令读 status → 403（读也要口令）', r.status === 403, `${r.status}`);
  r = await http(A.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('本机 CLI 带口令读 status → 200 且 no-store', r.status === 200 && r.headers['cache-control'] === 'no-store' && r.body?.upstream === 'dsh-vault@1.10.75', `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(A.port, 'GET', '/api/vault/status', { 'sec-fetch-site': 'same-origin', 'x-admin-token': TOK });
  ok('业务面浏览器同源 GET 带口令 → 200（属主 2026-11-02：口令即可，不再限控制面）', r.status === 200 && r.headers['cache-control'] === 'no-store', `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(A.port, 'GET', '/api/vault/status', { 'sec-fetch-site': 'same-origin' });
  ok('业务面浏览器同源 GET 无口令 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'POST', '/api/vault/lock', { origin: `http://127.0.0.1:${A.port}`, 'x-admin-token': TOK });
  ok('业务面浏览器带口令写（上锁）→ 200', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(A.port, 'POST', '/api/vault/lock', { origin: 'http://evil.example', 'x-admin-token': TOK });
  ok('跨源页面带口令写 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'GET', '/API/VAULT/STATUS', { 'sec-fetch-site': 'same-origin' });
  ok('大写变体 /API/VAULT/STATUS 无口令同样拦', r.status === 403, `${r.status}`);
  r = await http(A.control, 'GET', '/api/vault/status', { 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${A.control}` });
  ok('控制面同源 GET 无口令 → 403', r.status === 403, `${r.status}`);
  r = await http(A.control, 'GET', '/api/vault/status', { 'sec-fetch-site': 'cross-site', host: `127.0.0.1:${A.control}`, 'x-admin-token': TOK });
  ok('控制面跨站 GET（无 Origin）→ 403', r.status === 403, `${r.status}`);
  r = await get('/api/vault/status');
  ok('控制面同源 GET 带口令 → 200，库文件尚不存在、未解锁', r.status === 200 && r.body.exists === false && r.body.unlocked === false, `${r.status} ${r.text.slice(0, 160)}`);

  r = await http(A.port, 'POST', '/api/vault/unlock', { 'content-type': 'application/json' }, `{"password": "${MASTER}"`);
  ok('坏 JSON（含主密码）→ 400 固定文案，响应不回显', r.status === 400 && !r.text.includes(MASTER), `${r.status} ${r.text.slice(0, 120)}`);
  await new Promise((x) => setTimeout(x, 200));
  ok('坏 JSON 的原始请求体不进服务日志', !A.err().includes(MASTER));

  section('② 锁');
  r = await get('/api/vault/entries');
  ok('未解锁读条目 → 423 vault_locked', r.status === 423 && r.body?.code === 'vault_locked', `${r.status}`);
  r = await send('POST', '/api/vault/unlock', { password: MASTER });
  ok('首次解锁 = 用该主密码建库', r.status === 200 && r.body?.unlocked === true, `${r.status} ${r.text.slice(0, 160)}`);
  await send('POST', '/api/vault/lock');
  r = await send('POST', '/api/vault/unlock', { password: 'wrong-pass' });
  ok('错主密码 → 401', r.status === 401 && r.body?.code === 'vault_bad_password', `${r.status}`);
  for (let k = 0; k < 4; k++) await send('POST', '/api/vault/unlock', { password: 'wrong-pass' });
  r = await send('POST', '/api/vault/unlock', { password: MASTER });
  ok('连错 5 次后进入冷却 → 429（对的也先拒）', r.status === 429, `${r.status}`);

  // 冷却 30s 太长，换一个实例继续（同一库文件 → 顺带验证跨实例可重开）
  await stop(A);
  const B = boot('b', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile });
  ok('第二实例起来', (await up(B.port)) && (await up(B.control)));
  const CB = `http://127.0.0.1:${B.control}`;
  const cwB = { origin: CB, host: `127.0.0.1:${B.control}`, 'x-admin-token': TOK };
  const crB = { 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${B.control}`, 'x-admin-token': TOK };
  const g = (p) => http(B.control, 'GET', p, crB);
  const s = (m, p, b) => http(B.control, m, p, cwB, b === undefined ? undefined : JSON.stringify(b));
  r = await s('POST', '/api/vault/unlock', { password: MASTER });
  ok('同一主密码重开已有库', r.status === 200 && r.body?.count === 0, `${r.status} ${r.text.slice(0, 160)}`);

  section('③ 数据面');
  r = await s('POST', '/api/vault/entries', { title: 'GitHub 合成', kind: 'login', username: 'syn-user', password: SECRET_PW, url: 'http://github.example.test/login', otpSecret: OTP, tags: ['dev'] });
  ok('新增 login → 201', r.status === 201 && r.body?.id, `${r.status} ${r.text.slice(0, 160)}`);
  const id1 = r.body?.id;
  r = await s('POST', '/api/vault/entries', { title: 'API 合成', kind: 'api-key', apiKey: SECRET_KEY, tags: ['dev'] });
  const id2 = r.body?.id;
  await s('POST', '/api/vault/entries', { title: 'Reuse 合成', password: SECRET_PW });
  r = await s('POST', '/api/vault/entries', { title: 'x', bogus: 1 });
  ok('未知字段 → 400', r.status === 400, `${r.status}`);
  r = await s('POST', '/api/vault/entries', { title: 'x', kind: 'nope' });
  ok('坏 kind → 400', r.status === 400, `${r.status}`);
  r = await s('POST', '/api/vault/entries', { title: 'x', otpSecret: '!!!' });
  ok('坏 otpSecret → 400', r.status === 400, `${r.status}`);
  r = await s('POST', '/api/vault/entries', { kind: 'login' });
  ok('缺 title → 400', r.status === 400, `${r.status}`);

  const noLeak = (txt) => !txt.includes(SECRET_PW) && !txt.includes(SECRET_KEY) && !txt.includes(OTP);
  r = await g('/api/vault/entries');
  ok('列表 3 条、带统计、不含明文', r.status === 200 && r.body?.entries?.length === 3 && r.body?.stats?.total === 3 && noLeak(r.text), `${r.status} ${r.text.slice(0, 200)}`);
  r = await g('/api/vault/entries?q=github');
  ok('检索命中 1 条（hasOtp 标记）', r.body?.entries?.length === 1 && r.body.entries[0].hasOtp === true);
  r = await g('/api/vault/entries?kind=api-key');
  ok('按 kind 过滤', r.body?.entries?.length === 1 && r.body.entries[0].id === id2);
  r = await g(`/api/vault/entries/${id1}`);
  ok('单条读出完整密钥', r.status === 200 && r.body?.password === SECRET_PW && r.body?.otpSecret === OTP, `${r.status}`);
  r = await g(`/api/vault/entries/${id1}/totp`);
  ok('TOTP 6 位 + 剩余秒数', /^\d{6}$/.test(r.body?.code ?? '') && r.body.period === 30 && r.body.remaining > 0 && r.body.remaining <= 30, r.text);
  r = await g('/api/vault/health');
  ok('健康报告：识别复用、http 站点，且不含明文', r.status === 200 && r.body?.reused?.length === 1 && r.body.reused[0].count === 2 && r.body.httpSites?.length === 1 && noLeak(r.text), r.text.slice(0, 300));
  r = await s('PUT', `/api/vault/entries/${id1}`, { password: 'Changed-Synthetic-Pw-1', notes: '' });
  ok('更新密码', r.status === 200 && r.body?.passwordHistoryCount === 1 && !('passwordHistory' in r.body), r.text.slice(0, 200));
  r = await s('PUT', `/api/vault/entries/${id1}`, { title: '' });
  ok('清空 title → 400', r.status === 400, `${r.status}`);
  r = await s('POST', '/api/vault/generate', { length: 24, symbols: true });
  ok('生成密码 + 强度', r.body?.password?.length === 24 && typeof r.body?.strength?.score === 'number', r.text);
  r = await s('POST', '/api/vault/generate', { passphrase: true, words: 5 });
  ok('生成口令短语', (r.body?.password ?? '').split('-').length >= 5, r.text);
  r = await s('POST', '/api/vault/strength', { password: 'password123' });
  ok('强度评估：常见密码判 weak', r.body?.verdict === 'weak', r.text);

  r = await s('DELETE', `/api/vault/trash/${id2}`);
  ok('未软删的条目不能直接永久删除 → 404', r.status === 404, `${r.status}`);
  r = await s('DELETE', `/api/vault/entries/${id2}`);
  ok('软删 → 回收站', r.status === 200 && r.body?.trashed === true);
  r = await g('/api/vault/trash');
  ok('回收站 1 条且不含明文', r.body?.length === 1 && r.body[0].id === id2 && noLeak(r.text), r.text.slice(0, 200));
  r = await s('POST', `/api/vault/trash/${id2}/restore`);
  ok('恢复', r.status === 200 && (await g('/api/vault/entries')).body.entries.length === 3);
  await s('DELETE', `/api/vault/entries/${id2}`);
  r = await s('DELETE', `/api/vault/trash/${id2}`);
  ok('回收站里永久删除', r.status === 200 && r.body?.purged === true && (await g('/api/vault/trash')).body.length === 0);
  r = await g('/api/vault/history');
  ok('活动记录有 add/read/totp 且不含明文', Array.isArray(r.body) && ['add', 'read', 'totp'].every((a) => r.body.some((h) => h.action === a)) && noLeak(r.text), r.text.slice(0, 200));

  r = await s('POST', '/api/vault/entries', { title: 'PIN 合成', fields: { pin: 'SECRET-PIN-9931' } });
  const idPin = r.body?.id;
  r = await g('/api/vault/entries?q=PIN');
  ok('摘要里自定义字段只给键名、不给值', r.body?.entries?.[0]?.fieldKeys?.[0] === 'pin' && !r.text.includes('SECRET-PIN-9931'), r.text.slice(0, 200));
  ok('单条详情才有自定义字段的值', (await g(`/api/vault/entries/${idPin}`)).body?.fields?.pin === 'SECRET-PIN-9931');
  await s('DELETE', `/api/vault/entries/${idPin}`); await s('DELETE', `/api/vault/trash/${idPin}`);
  r = await g('/api/vault/history');
  ok('活动记录新→旧（首条是刚才的永久删除）', r.body?.[0]?.action === 'purge' && r.body[0].at >= r.body[r.body.length - 1].at, JSON.stringify(r.body?.slice(0, 2)));
  r = await s('POST', '/api/vault/generate', { length: 1e9 });
  ok('生成长度被钳到 128', r.body?.password?.length === 128, `${r.status} ${r.body?.password?.length}`);
  r = await s('POST', '/api/vault/unlock', { password: 'wrong-again' });
  ok('已解锁时输错主密码 → 401 但会话仍解锁', r.status === 401 && (await g('/api/vault/entries')).status === 200);

  section('④ 与 DSH 插件互通');
  const disk = readFileSync(vaultFile, 'utf8');
  ok('磁盘文件不含任何明文', !disk.includes('Changed-Synthetic-Pw-1') && noLeak(disk) && !disk.includes('syn-user'));
  const { openVault } = await import('../server/src/vault/store.ts');
  const ext = await openVault({ masterPassword: MASTER, path: vaultFile });
  ok('上游 openVault 用同一主密码读得到市场写的条目', ext.list().some((e) => e.id === id1 && e.password === 'Changed-Synthetic-Pw-1'));
  await ext.add({ title: '来自 DSH 插件', kind: 'ssh', host: 'db.internal.test', port: '2222' });
  r = await g('/api/vault/entries?q=DSH');
  ok('外部（DSH 插件）写入后市场列表立即可见', r.body?.entries?.length === 1 && r.body.entries[0].host === 'db.internal.test', r.text.slice(0, 200));
  r = await s('POST', '/api/vault/entries', { title: '市场再写一条' });
  const ext2 = await openVault({ masterPassword: MASTER, path: vaultFile });
  ok('市场随后写入不覆盖外部条目', ext2.list().some((e) => e.title === '来自 DSH 插件') && ext2.list().some((e) => e.title === '市场再写一条'));

  const lockFile = `${vaultFile}.lock`;
  const ext3 = await openVault({ masterPassword: MASTER, path: vaultFile });
  await ext3.add({ title: '外部写入·持锁前' });
  writeFileSync(lockFile, '99999\n'); // 模拟别的进程正持有写锁
  r = await g('/api/vault/entries?q=' + encodeURIComponent('持锁前'));
  ok('外部改动后重开：读得到新条目，且不删别人持有的写锁', r.body?.entries?.length === 1 && existsSync(lockFile), `${r.status}`);
  const before = (await g('/api/vault/entries')).body.entries.length;
  r = await s('POST', '/api/vault/entries', { title: '锁被占时写入' });
  ok('写锁被占 → 503 vault_busy（锁文件保留）', r.status === 503 && r.body?.code === 'vault_busy' && existsSync(lockFile), `${r.status} ${r.text.slice(0, 120)}`);
  rmSync(lockFile);
  r = await g('/api/vault/entries');
  ok('没落盘的那次写入不留在内存里', r.body.entries.length === before && !r.body.entries.some((e) => e.title === '锁被占时写入'), `${r.body.entries.length} vs ${before}`);
  ok('锁释放后可再写', (await s('POST', '/api/vault/entries', { title: '锁释放后写入' })).status === 201);

  r = await s('POST', '/api/vault/lock');
  ok('上锁后读条目 → 423', r.status === 200 && (await g('/api/vault/entries')).status === 423);

  section('⑤ 环境变量主密码');
  await stop(B);
  const D = boot('d', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD: MASTER });
  ok('第三实例起来', await up(D.port));
  r = await http(D.control, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('DSH_VAULT_PASSWORD 存在时控制面按需自动解锁', r.status === 200 && r.body?.entries?.length === 6, `${r.status} ${r.text.slice(0, 160)}`);
  r = await http(D.port, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('服务端持有主密码时业务面一律 403（vault_control_only）', r.status === 403 && r.body?.code === 'vault_control_only', `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(D.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('业务面状态只报 control_only，不给库信息', r.status === 200 && r.body?.control_only === true && r.body?.path === undefined && r.body?.count === undefined, JSON.stringify(r.body).slice(0, 120));
  await stop(D);

  section('⑤b 主密码文件（DSH_VAULT_PASSWORD_FILE）：管理员免输入');
  const pwFile = join(TMP, 'vault-master.txt');
  writeFileSync(pwFile, MASTER + '\n', { mode: 0o600 });
  // 文件为准：同时配了错的环境变量也不回落
  const PF = boot('pf', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD_FILE: pwFile, DSH_VAULT_PASSWORD: 'wrong-env-master-not-used' });
  ok('主密码文件实例起来', await up(PF.port));
  r = await http(PF.control, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('状态报 password_source=file、页面不出解锁框', r.status === 200 && r.body?.password_source === 'file' && r.body?.env_password === true, JSON.stringify(r.body).slice(0, 160));
  r = await http(PF.control, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('管理员直接读条目，无需输入主密码（文件优先于环境变量）', r.status === 200 && r.body?.entries?.length === 6, `${r.status} ${r.text.slice(0, 160)}`);
  r = await http(PF.control, 'GET', '/api/vault/entries');
  ok('不是管理员仍 403', r.status === 403, `${r.status}`);
  r = await http(PF.control, 'POST', '/api/vault/lock', { 'x-admin-token': TOK });
  r = await http(PF.control, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('上锁后下一次访问自动重开', r.status === 200 && r.body?.entries?.length === 6, `${r.status}`);
  await stop(PF);
  const PG = boot('pg', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD_FILE: join(TMP, 'no-such-master.txt'), DSH_VAULT_PASSWORD: MASTER });
  ok('缺文件实例起来', await up(PG.port));
  r = await http(PG.control, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('主密码文件读不到 → 503，不回落环境变量', r.status === 503 && r.body?.code === 'vault_password_file', `${r.status} ${r.text.slice(0, 120)}`);
  await stop(PG);

  section('⑤c 凭据库专用域名（WM_VAULT_HOST）：主域名 403、专用域名免输入、围栏');
  const VH = boot('vh', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD_FILE: pwFile, WM_VAULT_HOST: 'Vault.Synthetic.Test' });
  ok('专用域名实例起来', await up(VH.port));
  const onHost = (h) => ({ 'x-admin-token': TOK, host: h });
  r = await http(VH.port, 'GET', '/api/vault/entries', onHost(`127.0.0.1:${VH.port}`));
  ok('主域名上凭据库 403 vault_control_only', r.status === 403 && r.body?.code === 'vault_control_only', `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(VH.port, 'GET', '/api/vault/entries', onHost('vault.synthetic.test.evil'));
  ok('Host 不匹配（后缀拼接）拒绝', r.status === 403 && r.body?.code === 'vault_control_only', `${r.status}`);
  r = await http(VH.port, 'GET', '/api/vault/entries', onHost('VAULT.synthetic.test:8443'));
  ok('专用域名上管理员直接读（不分大小写、不看端口）', r.status === 200 && r.body?.entries?.length === 6, `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(VH.port, 'GET', '/api/vault/entries', { host: 'vault.synthetic.test' });
  ok('专用域名上不是管理员仍 403', r.status === 403 && r.body?.code !== 'vault_control_only', `${r.status}`);
  r = await http(VH.port, 'GET', '/api/vault/status', onHost(`127.0.0.1:${VH.port}`));
  ok('主域名状态脱敏（只 control_only）', r.status === 200 && r.body?.control_only === true && r.body?.path === undefined && r.body?.count === undefined, JSON.stringify(r.body).slice(0, 120));
  for (const p of ['/go/1/', '/sop/demo/', '/apps/demo/', '/mcp', '/a2a/direct', '/openapi.json']) {
    r = await http(VH.port, 'GET', p, { host: 'vault.synthetic.test' });
    ok(`专用域名上 ${p} → 404`, r.status === 404, `${r.status}`);
  }
  r = await http(VH.port, 'GET', '/api/vault/status', onHost('vault.synthetic.test'));
  ok('专用域名禁止被嵌（frame-ancestors none / DENY）', /frame-ancestors 'none'/.test(String(r.headers['content-security-policy'] ?? '')) && r.headers['x-frame-options'] === 'DENY', JSON.stringify(r.headers['content-security-policy']));
  r = await http(VH.port, 'GET', '/go/1/', { host: `127.0.0.1:${VH.port}` });
  ok('主域名 /go/ 不受围栏影响（不是 404 围栏文案）', !/凭据库域名不提供此路径/.test(r.text), `${r.status}`);
  await stop(VH);
  {
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: '0', WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data-badhost'), WM_VAULT_HOST: 'https://vault.x/' };
    mkdirSync(env.DATA_DIR, { recursive: true });
    const b = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, timeout: 30_000, encoding: 'utf8' });
    ok('WM_VAULT_HOST 带协议/路径拒绝启动', b.status === 1 && /WM_VAULT_HOST/.test(b.stderr), `status=${b.status} ${String(b.stderr).slice(-120)}`);
  }

  section('⑤d 主域名开放开关（WM_VAULT_SERVER_PASSWORD_ON_MAIN=accept-same-origin-risk）');
  const VM = boot('vm', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD_FILE: pwFile, WM_VAULT_SERVER_PASSWORD_ON_MAIN: 'accept-same-origin-risk' });
  ok('开关实例起来', await up(VM.port));
  r = await http(VM.port, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('开关打开：主域名上管理员直接读', r.status === 200 && r.body?.entries?.length === 6, `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(VM.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('开关打开：主域名状态完整（不再只报 control_only）', r.status === 200 && r.body?.control_only === undefined && r.body?.password_source === 'file', JSON.stringify(r.body).slice(0, 120));
  r = await http(VM.port, 'GET', '/api/vault/entries');
  ok('开关打开：非管理员仍 403', r.status === 403 && r.body?.code !== 'vault_control_only', `${r.status}`);
  await stop(VM);
  const VN = boot('vn', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD_FILE: pwFile });
  ok('无开关实例起来', await up(VN.port));
  r = await http(VN.port, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('开关没开：主域名仍 403 vault_control_only', r.status === 403 && r.body?.code === 'vault_control_only', `${r.status}`);
  await stop(VN);
  {
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: '0', WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data-badmain'), WM_VAULT_SERVER_PASSWORD_ON_MAIN: '1' };
    mkdirSync(env.DATA_DIR, { recursive: true });
    const b = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, timeout: 30_000, encoding: 'utf8' });
    ok('开关取值不是 accept-same-origin-risk 拒绝启动', b.status === 1 && /WM_VAULT_SERVER_PASSWORD_ON_MAIN/.test(b.stderr), `status=${b.status}`);
  }

  section('⑥ 未设口令 = 凭据库休眠');
  const E = boot('e', { WM_VAULT_PATH: join(TMP, 'vault-e', 'default.json') });
  ok('第四实例起来', await up(E.port));
  r = await http(E.port, 'GET', '/api/vault/status', { 'x-admin-token': 'anything' });
  ok('无 ADMIN_TOKEN 时一律 403', r.status === 403, `${r.status}`);

  section('⑦ 缺省库文件不是 DSH 插件那份');
  const dshHome = join(TMP, 'dsh-home');
  const F = boot('f', { ADMIN_TOKEN: TOK, DSH_HOME: dshHome });
  ok('第五实例起来', await up(F.port));
  r = await http(F.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('缺省路径在 DATA_DIR 下、shared_with_dsh=false', r.body?.path === join(TMP, 'data-f', 'vault', 'default.json') && r.body.shared_with_dsh === false, r.text.slice(0, 200));
  await stop(F);
  const G = boot('g', { ADMIN_TOKEN: TOK, DSH_HOME: dshHome, WM_VAULT_PATH: join(dshHome, 'vault', 'default.json') });
  ok('第六实例起来', await up(G.port));
  r = await http(G.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('显式指向 DSH 插件库文件 → shared_with_dsh=true', r.body?.shared_with_dsh === true, r.text.slice(0, 200));

  section('⑧ 并发错密码不能绕过限流');
  const cli = (port, m, p, b) => http(port, m, p, { 'x-admin-token': TOK }, b === undefined ? undefined : JSON.stringify(b));
  await cli(G.port, 'POST', '/api/vault/unlock', { password: MASTER }); // 先建库，后面的才是真错密码
  const res = await Promise.all(Array.from({ length: 9 }, () => cli(G.port, 'POST', '/api/vault/unlock', { password: 'nope' })));
  const n401 = res.filter((x) => x.status === 401).length, n429 = res.filter((x) => x.status === 429).length;
  ok('9 个并发错密码：最多 5 个被真正尝试，其余 429', n401 === 5 && n429 === 4, `401=${n401} 429=${n429}`);
  await stop(G);

  section('⑨ 闲置上锁：取验证码不算活动');
  const H = boot('h', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: join(TMP, 'vault-h', 'default.json'), WM_VAULT_IDLE_MIN: '0.03' });
  ok('第七实例起来', await up(H.port));
  await cli(H.port, 'POST', '/api/vault/unlock', { password: MASTER });
  const idOtp = (await cli(H.port, 'POST', '/api/vault/entries', { title: 'otp', otpSecret: OTP })).body?.id;
  let last = 0;
  for (let k = 0; k < 7; k++) { last = (await cli(H.port, 'GET', `/api/vault/entries/${idOtp}/totp`)).status; await new Promise((x) => setTimeout(x, 400)); }
  ok('一直轮询验证码也会在闲置 1.8s 后上锁', last === 423 && (await cli(H.port, 'GET', '/api/vault/entries')).status === 423, `last=${last}`);
  await stop(H);

  section('⑩ 主密码门槛（只管新建库）');
  const pDir = join(TMP, 'vault-p'), pFile = join(pDir, 'default.json');
  const P = boot('p', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: pFile });
  ok('第八实例起来', await up(P.port));
  const nothingOnDisk = () => !existsSync(pDir) || readdirSync(pDir).length === 0;
  for (const [label, pw, want] of [
    ['4 位数字「1234」', '1234', '至少 12 个字符'],
    ['11 个字符', 'zq8!Lm2#vR7', '至少 12 个字符'],
    ['12 位全数字', '202611011234', '不能全是数字'],
    ['常见口令原样（≥12 字符，在 1 万条表里）', 'unbelievable', '常见弱口令'],
    ['常见口令加数字', 'password1234', '常见弱口令'],
    ['常见口令变形（大写 + l33t + 符号）', 'P@ssw0rd2024!', '常见弱口令'],
    ['重复字符', 'aaaaaaaaaaaa', '强度评估为「弱」'],
  ]) {
    r = await cli(P.port, 'POST', '/api/vault/unlock', { password: pw });
    ok(`新建库拒${label} → 400 且说明原因、不落盘`, r.status === 400 && r.body?.code === 'vault_weak_master' && r.body.reasons?.some((x) => x.includes(want)) && nothingOnDisk(), `${r.status} ${r.text.slice(0, 200)}`);
  }
  r = await cli(P.port, 'GET', '/api/vault/status');
  ok('被拒后 status 仍是「库不存在、未解锁」', r.body?.exists === false && r.body.unlocked === false && r.body.master_policy?.min_length === 12 && r.body.master_policy.common_list >= 10000, r.text.slice(0, 200));
  r = await cli(P.port, 'POST', '/api/vault/master-check', { password: '1234' });
  ok('master-check：弱口令 ok=false 带原因与强度', r.status === 200 && r.body?.ok === false && r.body.reasons.length > 0 && r.body.strength?.verdict === 'weak', r.text.slice(0, 200));
  r = await cli(P.port, 'POST', '/api/vault/master-check', { password: MASTER });
  ok('master-check：强口令 ok=true', r.body?.ok === true && r.body.reasons.length === 0, r.text.slice(0, 200));
  r = await cli(P.port, 'POST', '/api/vault/unlock', { password: MASTER });
  ok('强口令能建库，且不带弱主密码提示', r.status === 200 && r.body?.unlocked === true && r.body.weak_master === false && existsSync(pFile), `${r.status} ${r.text.slice(0, 160)}`);
  await stop(P);

  // 旧库：用上游 openVault 直接建一个 4 位主密码的库（模拟门槛上线前就存在的库）
  const oFile = join(TMP, 'vault-old', 'default.json');
  const legacy = await openVault({ masterPassword: '1234', path: oFile });
  await legacy.add({ title: '旧库里的条目', password: 'Synthetic-Legacy-Pw' });
  await legacy.lock();
  const O = boot('o', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: oFile });
  ok('第九实例起来', await up(O.port));
  r = await cli(O.port, 'POST', '/api/vault/unlock', { password: '1234' });
  ok('旧的弱主密码库照常解锁，并提示低于新标准', r.status === 200 && r.body?.unlocked === true && r.body.count === 1 && r.body.weak_master === true && r.body.weak_reasons.length > 0, `${r.status} ${r.text.slice(0, 200)}`);
  r = await cli(O.port, 'GET', '/api/vault/status');
  ok('status 也带 weak_master 提示（不强制）', r.body?.weak_master === true && r.body.weak_reasons.some((x) => x.includes('至少 12 个字符')), r.text.slice(0, 200));
  ok('旧库解锁后读写照常', (await cli(O.port, 'GET', '/api/vault/entries')).body?.entries?.length === 1 && (await cli(O.port, 'POST', '/api/vault/entries', { title: '解锁后新增' })).status === 201);
  await stop(O);

  const qDir = join(TMP, 'vault-q');
  const Q = boot('q', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: join(qDir, 'default.json'), DSH_VAULT_PASSWORD: '1234' });
  ok('第十实例起来', await up(Q.port));
  r = await cli(Q.control, 'GET', '/api/vault/entries');
  ok('环境变量弱主密码也不能新建库（400、不落盘）', r.status === 400 && r.body?.code === 'vault_weak_master' && /DSH_VAULT_PASSWORD/.test(r.body.error) && (!existsSync(qDir) || readdirSync(qDir).length === 0), `${r.status} ${r.text.slice(0, 200)}`);
} finally {
  step = '收尾';
  await Promise.all(servers.map(stop));
  clearTimeout(watchdog);
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`vault-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
