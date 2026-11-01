#!/usr/bin/env node
/** 凭据库板块冒烟（融合 dsh-vault）：全新 DATA_DIR + 临时库文件 + 随机回环端口，合成口令与合成主密码，不碰真实 ~/.dsh。
 *  ① 门：读也要口令；业务面浏览器读写一律 403；控制面同源 GET（无 Origin）凭口令放行；跨站 GET 拒。
 *  ② 锁：未解锁 423；错主密码 401；连错 5 次进 30s 冷却 429。
 *  ③ 数据面：列表/回收站/健康/历史不出现任何明文密钥；完整条目只在单条读出；TOTP 6 位；软删→恢复→再删→清除。
 *  ④ 互通：磁盘文件无明文；上游 openVault 用同一主密码读得到；模拟 DSH 插件在外部写入后，市场列表能看见。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/vault-smoke-' + Date.now().toString(36));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const servers = [];

function boot(tag, extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = join(TMP, `data-${tag}`); mkdirSync(data, { recursive: true });
  const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(port), DATA_DIR: data, ...extraEnv };
  for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_DEV_ORIGIN', 'WM_CONTROL_PORT']) if (!(k in extraEnv)) delete env[k];
  if (!('DSH_VAULT_PASSWORD' in extraEnv)) delete env.DSH_VAULT_PASSWORD;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
  let err = ''; child.stderr.on('data', (c) => (err += c));
  const s = { port, control: port + 1, child, err: () => err };
  servers.push(s);
  return s;
}
const http = (port, method, path, headers = {}, body) => new Promise((done) => {
  const h = { ...headers }; if (body !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
  const rq = request({ host: '127.0.0.1', port, method, path, headers: h }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j, text: s }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) }, text: '' }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const up = async (port) => { const end = Date.now() + 40_000; while (Date.now() < end) { if ((await http(port, 'GET', '/api/health')).status === 200) return true; await new Promise((x) => setTimeout(x, 250)); } return false; };

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

  console.log('① 门');
  let r = await http(A.port, 'GET', '/api/vault/status');
  ok('本机 CLI 无口令读 status → 403（读也要口令）', r.status === 403, `${r.status}`);
  r = await http(A.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('本机 CLI 带口令读 status → 200 且 no-store', r.status === 200 && r.headers['cache-control'] === 'no-store' && r.body?.upstream === 'dsh-vault@1.10.75', `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(A.port, 'GET', '/api/vault/status', { 'sec-fetch-site': 'same-origin', 'x-admin-token': TOK });
  ok('业务面浏览器同源 GET 带口令 → 403 指向控制面', r.status === 403 && r.body?.control_surface_required === true, `${r.status} ${r.text.slice(0, 120)}`);
  r = await http(A.port, 'POST', '/api/vault/unlock', { origin: `http://127.0.0.1:${A.port}`, 'x-admin-token': TOK }, JSON.stringify({ password: MASTER }));
  ok('业务面浏览器解锁 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'GET', '/API/VAULT/STATUS', { 'sec-fetch-site': 'same-origin', 'x-admin-token': TOK });
  ok('大写变体 /API/VAULT/STATUS 同样拦', r.status === 403, `${r.status}`);
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

  console.log('② 锁');
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
  A.child.kill();
  const B = boot('b', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile });
  ok('第二实例起来', (await up(B.port)) && (await up(B.control)));
  const CB = `http://127.0.0.1:${B.control}`;
  const cwB = { origin: CB, host: `127.0.0.1:${B.control}`, 'x-admin-token': TOK };
  const crB = { 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${B.control}`, 'x-admin-token': TOK };
  const g = (p) => http(B.control, 'GET', p, crB);
  const s = (m, p, b) => http(B.control, m, p, cwB, b === undefined ? undefined : JSON.stringify(b));
  r = await s('POST', '/api/vault/unlock', { password: MASTER });
  ok('同一主密码重开已有库', r.status === 200 && r.body?.count === 0, `${r.status} ${r.text.slice(0, 160)}`);

  console.log('③ 数据面');
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

  console.log('④ 与 DSH 插件互通');
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

  console.log('⑤ 环境变量主密码');
  B.child.kill();
  const D = boot('d', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: vaultFile, DSH_VAULT_PASSWORD: MASTER });
  ok('第三实例起来', await up(D.port));
  r = await http(D.port, 'GET', '/api/vault/entries', { 'x-admin-token': TOK });
  ok('DSH_VAULT_PASSWORD 存在时按需自动解锁', r.status === 200 && r.body?.entries?.length === 6, `${r.status} ${r.text.slice(0, 160)}`);

  console.log('⑥ 未设口令 = 凭据库休眠');
  const E = boot('e', { WM_VAULT_PATH: join(TMP, 'vault-e', 'default.json') });
  ok('第四实例起来', await up(E.port));
  r = await http(E.port, 'GET', '/api/vault/status', { 'x-admin-token': 'anything' });
  ok('无 ADMIN_TOKEN 时一律 403', r.status === 403, `${r.status}`);

  console.log('⑦ 缺省库文件不是 DSH 插件那份');
  const dshHome = join(TMP, 'dsh-home');
  const F = boot('f', { ADMIN_TOKEN: TOK, DSH_HOME: dshHome });
  ok('第五实例起来', await up(F.port));
  r = await http(F.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('缺省路径在 DATA_DIR 下、shared_with_dsh=false', r.body?.path === join(TMP, 'data-f', 'vault', 'default.json') && r.body.shared_with_dsh === false, r.text.slice(0, 200));
  F.child.kill();
  const G = boot('g', { ADMIN_TOKEN: TOK, DSH_HOME: dshHome, WM_VAULT_PATH: join(dshHome, 'vault', 'default.json') });
  ok('第六实例起来', await up(G.port));
  r = await http(G.port, 'GET', '/api/vault/status', { 'x-admin-token': TOK });
  ok('显式指向 DSH 插件库文件 → shared_with_dsh=true', r.body?.shared_with_dsh === true, r.text.slice(0, 200));

  console.log('⑧ 并发错密码不能绕过限流');
  const cli = (port, m, p, b) => http(port, m, p, { 'x-admin-token': TOK }, b === undefined ? undefined : JSON.stringify(b));
  await cli(G.port, 'POST', '/api/vault/unlock', { password: MASTER }); // 先建库，后面的才是真错密码
  const res = await Promise.all(Array.from({ length: 9 }, () => cli(G.port, 'POST', '/api/vault/unlock', { password: 'nope' })));
  const n401 = res.filter((x) => x.status === 401).length, n429 = res.filter((x) => x.status === 429).length;
  ok('9 个并发错密码：最多 5 个被真正尝试，其余 429', n401 === 5 && n429 === 4, `401=${n401} 429=${n429}`);
  G.child.kill();

  console.log('⑨ 闲置上锁：取验证码不算活动');
  const H = boot('h', { ADMIN_TOKEN: TOK, WM_VAULT_PATH: join(TMP, 'vault-h', 'default.json'), WM_VAULT_IDLE_MIN: '0.03' });
  ok('第七实例起来', await up(H.port));
  await cli(H.port, 'POST', '/api/vault/unlock', { password: MASTER });
  const idOtp = (await cli(H.port, 'POST', '/api/vault/entries', { title: 'otp', otpSecret: OTP })).body?.id;
  let last = 0;
  for (let k = 0; k < 7; k++) { last = (await cli(H.port, 'GET', `/api/vault/entries/${idOtp}/totp`)).status; await new Promise((x) => setTimeout(x, 400)); }
  ok('一直轮询验证码也会在闲置 1.8s 后上锁', last === 423 && (await cli(H.port, 'GET', '/api/vault/entries')).status === 423, `last=${last}`);
} finally {
  for (const sv of servers) if (sv.child.exitCode === null) { const ex = new Promise((x) => sv.child.once('exit', x)); sv.child.kill(); await ex; }
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`vault-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
