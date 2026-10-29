#!/usr/bin/env node
/** 生命周期签发入口单测（server/src/lifecycle.ts · 不起服务、不要引擎，CI 可跑）：
 *  ① req 哈希与断言与 lifecycle-os tools/assert.cjs 逐字节一致——冻结金向量（由参考实现生成）+ 本机有参考实现时随机对拍
 *  ② 断言结构与签名（插件同款核验）③ 只为人签、有效期 ≤600、nonce 每张新生成
 *  ④ 命令行组装（旗标值不许被插件解析成下一个旗标）⑤ 私钥文件门（绝对路径/仓库外/600/ed25519）⑥ 审批写面请求门
 *  ⑦ 配置门（测试模式不许指向运行工作区 ~/.ygl-trees-lc、工作区须绝对路径）
 *  参考实现路径：LC_OS_DIR（缺省 ~/workspace/lifecycle-os）；缺失时只跑金向量并标 SKIP。 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lcArgv, lcReqHash, lcWriteGuard, lifecycleConfigProblem, loadIssuerKey, signLcAssertion } from '../server/src/lifecycle.ts';

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };

// 金向量：lifecycle-os 03f173c tools/assert.cjs 生成（RFC 8032 测试 1 私钥种子，仅作测试向量）
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBKEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const REQ = [
  ['inbox', {}, 'c165dbd003446a4b0ad20d199bd2c04357bc3916c5ded10866a45bfbf7485790'],
  ['approve', { proposal: 'p-0a1b2c3d4e5f', grant: 'g-pm' }, '10920328b56b728e03c2b990bb1e0fc26a5ad005aade59eed4bae30d2f3639e7'],
  ['approve', { grant: 'g-pm', proposal: 'p-0a1b2c3d4e5f' }, '10920328b56b728e03c2b990bb1e0fc26a5ad005aade59eed4bae30d2f3639e7'],
  ['approve', { proposal: 'p-1', grant: 'g-pm', 'trace-id': 'tr-x', json: true }, 'b54bc3ae1a5cdaed1583b826460e71f58c71a25f539cd2dc2cd8a9a9135514f8'],
  ['approve', { proposal: 'p-1', grant: 'g-pm', 'idempotency-key': 'k-1' }, '3d87f4eb63234bee733993be82ac287d42bc09dbe079fe5a1364c370030ea31c'],
  ['observe', { source: 'odoo.res_users', object: 'user:pm-a', field: 'account', value: '{"account_type":"人","active":true}' }, '1ccce5f5bba6e91d8a24457ceb78c7e30ce4c7c700ed4bfb497a37ee606235dc'],
  ['grant', { id: 'g-产品', grantee: 'user:张三', 'grantee-kind': '人', domain: '产品', from: '2026-01-01T00:00:00+08:00' }, 'c3896feef16fe0886bbac2608bae55539a8b61259640c7d70c88b8965f07c739'],
  ['x', { a: '1', 'a,b': '2', ab: true, 'a-b': 'x,y', A: '007', z: '' }, '65b106f3fec3781929b6da183ff27d04fed1bf3aa38e02ed62755fd9b422757e'],
];
const SIGN = [
  ['user:pm-a', 'inbox', {}, 1793260000, 300, '0123456789abcdef0123456789abcdef', 'eyJpc3MiOiJ3b3JrYmVuY2giLCJzdWIiOiJ1c2VyOnBtLWEiLCJhdWQiOiJsYyIsInJlcSI6ImMxNjVkYmQwMDM0NDZhNGIwYWQyMGQxOTliZDJjMDQzNTdiYzM5MTZjNWRlZDEwODY2YTQ1YmZiZjc0ODU3OTAiLCJpYXQiOjE3OTMyNjAwMDAsImV4cCI6MTc5MzI2MDMwMCwibm9uY2UiOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiJ9.Vh9iQuVtOrjEo9j_0p6bn1l1oojNUT684FpzqvMGS59I9pFO7PR6OD4KHrZUFRD4rTKibLQKsyB_SKmwSJLNBA'],
  ['user:pm-a', 'approve', { proposal: 'p-0a1b2c3d4e5f', grant: 'g-pm' }, 1793260000, 300, 'AbC_dEf-0123456789', 'eyJpc3MiOiJ3b3JrYmVuY2giLCJzdWIiOiJ1c2VyOnBtLWEiLCJhdWQiOiJsYyIsInJlcSI6IjEwOTIwMzI4YjU2YjcyOGUwM2MyYjk5MGJiMWUwZmMyNmE1YWQwMDVhYWRlNTllZWQ0YmFlMzBkMmYzNjM5ZTciLCJpYXQiOjE3OTMyNjAwMDAsImV4cCI6MTc5MzI2MDMwMCwibm9uY2UiOiJBYkNfZEVmLTAxMjM0NTY3ODkifQ.h1frHsDU5quiaCTJnfZb9vn8jRuxFX3fsigwc46sEtTINS3PgcAQksCP89xgb2OnMvMsMtOZ5wuXW3Dte7ZHBA'],
  ['user:张三@corp.example', 'approve', { proposal: 'p-1', grant: 'g-产品' }, 1793260123, 600, 'n'.repeat(64), 'eyJpc3MiOiJ3b3JrYmVuY2giLCJzdWIiOiJ1c2VyOuW8oOS4iUBjb3JwLmV4YW1wbGUiLCJhdWQiOiJsYyIsInJlcSI6ImRhZmU3MTBiZjk0MTk1MjUzMWQ4N2RhMzdkY2JlZjA0NTMxYmMzOGQxM2QwMzYxZWE5NmY0ZmJiMzI2NzIwZjgiLCJpYXQiOjE3OTMyNjAxMjMsImV4cCI6MTc5MzI2MDcyMywibm9uY2UiOiJubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5uIn0.wuwOoZZ8gRPYXGj-TcWfrH5Mmf9qUEuC3D2Z18iuqKx9gCv1V0KWWIH3cf1v7hiJqhlKMU8G_pcuf4nB62YSCg'],
];
const seedKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'hex')]), format: 'der', type: 'pkcs8' });
const pubOf = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(12).toString('hex');
// 插件同款核验（plugins/ygl-lc resolveCaller 的签名段）
const pluginVerify = (token, pubHex) => {
  const [p64, s64] = token.split('.');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
  return !!s64 && verify(null, Buffer.from(p64), key, Buffer.from(s64, 'base64url'));
};
const claimOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

console.log('① 与参考实现逐字节一致');
ok('金向量：测试私钥公钥 = 参考实现公钥', pubOf(seedKey) === PUBKEY);
ok(`金向量：req 哈希 ${REQ.length} 例逐一相等`, REQ.every(([a, f, h]) => lcReqHash(a, f) === h), REQ.filter(([a, f, h]) => lcReqHash(a, f) !== h).map(([a]) => a).join(','));
ok(`金向量：整张断言 ${SIGN.length} 例逐字节相等（ed25519 确定性签名）`, SIGN.every(([sub, action, flags, now, ttl, nonce, want]) => signLcAssertion(seedKey, { sub, action, flags, now, ttl, nonce }) === want));
const LC_OS = resolve(process.env.LC_OS_DIR || join(homedir(), 'workspace/lifecycle-os'));
const refFile = join(LC_OS, 'tools/assert.cjs');
if (existsSync(refFile)) {
  const ref = createRequire(import.meta.url)(refFile);
  const rnd = (n) => randomBytes(n).toString('base64url');
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const vals = () => pick([rnd(6), '中文值', 'a,b', '[1,"x"]', '007', '1.50', '', 'x=y', ' 空 格 ', 'emoji😀', true]);
  let same = 0, firstDiff = '';
  const N = 300;
  for (let i = 0; i < N; i++) {
    const flags = {};
    for (let j = Math.floor(Math.random() * 6); j > 0; j--) flags[pick(['proposal', 'grant', 'a', 'a-b', 'a,b', 'idempotency-key', 'trace-id', 'json', 'Z', rnd(3)])] = vals();
    const action = pick(['inbox', 'approve', 'observe', 'grant', rnd(4)]);
    const o = { sub: pick(['user:pm-a', 'user:张三@corp.example']), action, flags, now: 1700000000 + i, ttl: pick([1, 300, 600]), nonce: rnd(16) };
    const k = i % 10 === 0 ? generateKeyPairSync('ed25519').privateKey : seedKey;
    const pem = k.export({ type: 'pkcs8', format: 'pem' });
    if (lcReqHash(action, flags) === ref.reqHash(action, flags) && signLcAssertion(k, o) === ref.sign(pem, { iss: 'workbench', ...o })) same++;
    else if (!firstDiff) firstDiff = JSON.stringify([action, flags]);
  }
  ok(`对拍参考实现 ${refFile}：${N} 例随机请求的 req 哈希与整张断言全等`, same === N, firstDiff);
  const argv = lcArgv('approve', { proposal: 'p-0a1b2c3d4e5f', grant: 'g-pm' });
  const [a2, f2] = ref.parseRequest(argv.slice(1));
  ok('工作台组装的命令行经参考 parseRequest 解析后哈希不变', ref.reqHash(a2, f2) === lcReqHash('approve', { proposal: 'p-0a1b2c3d4e5f', grant: 'g-pm' }));
} else {
  skip++; console.log(`  - SKIP 对拍参考实现（${refFile} 不存在；仅金向量）`);
}

console.log('② 断言结构与签名');
const fresh = generateKeyPairSync('ed25519').privateKey;
const t1 = signLcAssertion(fresh, { sub: 'user:pm-a', action: 'approve', flags: { proposal: 'p-1', grant: 'g-pm' } });
const t2 = signLcAssertion(fresh, { sub: 'user:pm-a', action: 'approve', flags: { proposal: 'p-1', grant: 'g-pm' } });
const c1 = claimOf(t1);
ok('插件同款核验：签名对得上签发公钥', pluginVerify(t1, pubOf(fresh)));
ok('换一把公钥核验失败', !pluginVerify(t1, PUBKEY));
ok('篡改声明（改 sub）后签名失败', !pluginVerify(Buffer.from(JSON.stringify({ ...c1, sub: 'user:boss' })).toString('base64url') + '.' + t1.split('.')[1], pubOf(fresh)));
ok('声明七键按契约顺序：iss sub aud req iat exp nonce', Object.keys(c1).join(',') === 'iss,sub,aud,req,iat,exp,nonce', Object.keys(c1).join(','));
ok('iss=workbench aud=lc，缺省有效期 300 秒', c1.iss === 'workbench' && c1.aud === 'lc' && c1.exp - c1.iat === 300 && Math.abs(c1.iat - Date.now() / 1000) < 5);
ok('req = sha256(规范串) 独立重算相等', c1.req === createHash('sha256').update(JSON.stringify(['approve', [['grant', 'g-pm'], ['proposal', 'p-1']]])).digest('hex'));
ok('同一请求连签两张：nonce 不同（每张新生成）且合规', claimOf(t2).nonce !== c1.nonce && /^[A-Za-z0-9_-]{16,64}$/.test(c1.nonce) && t1 !== t2);
ok('为 P1 签的断言 req ≠ P2 的请求哈希', c1.req !== lcReqHash('approve', { proposal: 'p-2', grant: 'g-pm' }));
ok('inbox 断言 req ≠ approve 请求哈希', claimOf(signLcAssertion(fresh, { sub: 'user:pm-a', action: 'inbox', flags: {} })).req !== c1.req);

console.log('③ 只为人签、有效期与 nonce');
const S = (o) => () => signLcAssertion(fresh, { sub: 'user:pm-a', action: 'inbox', flags: {}, ...o });
ok('拒 agent 主体', throws(S({ sub: 'agent:bot' }), /只为人签/));
ok('拒系统主体', throws(S({ sub: 'system:odoo-sync' }), /只为人签/));
ok('拒空登录名 user:', throws(S({ sub: 'user:' }), /只为人签/));
ok('拒带控制字符的登录名', throws(S({ sub: 'user:a\nb' }), /只为人签/));
ok('拒有效期 601 秒', throws(S({ ttl: 601 }), /有效期/));
ok('拒有效期 0 秒', throws(S({ ttl: 0 }), /有效期/));
ok('600 秒放行（契约上限）', !throws(S({ ttl: 600 }), /./));
ok('拒 15 位 nonce', throws(S({ nonce: 'a'.repeat(15) }), /nonce/));
ok('拒含非法字符的 nonce', throws(S({ nonce: 'a'.repeat(20) + '.' }), /nonce/));

console.log('④ 命令行组装');
ok('approve 命令行恰为 lc approve --proposal P --grant G', JSON.stringify(lcArgv('approve', { proposal: 'p-1', grant: 'g-pm' })) === JSON.stringify(['lc', 'approve', '--proposal', 'p-1', '--grant', 'g-pm']));
ok('inbox 命令行恰为 lc inbox', JSON.stringify(lcArgv('inbox', {})) === JSON.stringify(['lc', 'inbox']));
ok('不带值的旗标记为 --k（值 true）', JSON.stringify(lcArgv('x', { k: true })) === JSON.stringify(['lc', 'x', '--k']));
ok('拒以 -- 开头的值（会被解析成旗标）', throws(() => lcArgv('approve', { proposal: '--json', grant: 'g' }), /值非法/));
ok('拒以 - 开头的值', throws(() => lcArgv('approve', { proposal: '-1', grant: 'g' }), /值非法/));
ok('拒空值', throws(() => lcArgv('approve', { proposal: '', grant: 'g' }), /值非法/));
ok('拒带换行的值', throws(() => lcArgv('approve', { proposal: 'p\n1', grant: 'g' }), /值非法/));
ok('拒 trace-id/json（不入 req 哈希，不许混进命令行）', throws(() => lcArgv('approve', { 'trace-id': 't' }), /旗标名非法/) && throws(() => lcArgv('approve', { json: true }), /旗标名非法/));
ok('拒含 = 的旗标名', throws(() => lcArgv('approve', { 'proposal=x': 'p' }), /旗标名非法/));

console.log('⑤ 私钥文件门');
const out = mkdtempSync(join(tmpdir(), 'wm-lc-unit-'));
const repoTmp = resolve('tmp'); mkdirSync(repoTmp, { recursive: true });
const inRepo = join(repoTmp, `lc-unit-${Date.now().toString(36)}.key`);
try {
  const pem = fresh.export({ type: 'pkcs8', format: 'pem' });
  const good = join(out, 'workbench.key'); writeFileSync(good, pem, { mode: 0o600 }); chmodSync(good, 0o600);
  const loaded = loadIssuerKey(good);
  ok('仓库外 600 的 ed25519 私钥可读，公钥十六进制正确', loaded.pubkey === pubOf(fresh) && /^[0-9a-f]{64}$/.test(loaded.pubkey));
  ok('拒相对路径', throws(() => loadIssuerKey('workbench.key'), /绝对路径/));
  if (process.platform !== 'win32') {
    const loose = join(out, 'loose.key'); writeFileSync(loose, pem); chmodSync(loose, 0o644);
    ok('拒权限 644', throws(() => loadIssuerKey(loose), /权限须为 600/));
    const grp = join(out, 'grp.key'); writeFileSync(grp, pem); chmodSync(grp, 0o640);
    ok('拒权限 640', throws(() => loadIssuerKey(grp), /权限须为 600/));
  } else { skip += 2; console.log('  - SKIP 权限位（Windows）'); }
  writeFileSync(inRepo, pem, { mode: 0o600 });
  ok('拒仓库内私钥', throws(() => loadIssuerKey(inRepo), /仓库内/));
  const link = join(out, 'link.key');
  try { symlinkSync(inRepo, link); ok('拒指向仓库内的软链', throws(() => loadIssuerKey(link), /仓库内/)); } catch { skip++; console.log('  - SKIP 软链（无权限）'); }
  const rsa = join(out, 'rsa.key');
  writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  ok('拒非 ed25519 私钥', throws(() => loadIssuerKey(rsa), /ed25519/));
  ok('拒不存在的文件', throws(() => loadIssuerKey(join(out, 'missing.key')), /ENOENT|no such/i));
} finally { rmSync(out, { recursive: true, force: true }); rmSync(inRepo, { force: true }); }

console.log('⑥ 审批写面请求门');
const H = { 'x-wm-lifecycle': '1', 'content-type': 'application/json', host: 'wm.local:9800' };
ok('同源 JSON + X-WM-Lifecycle 放行', lcWriteGuard({ ...H, origin: 'http://wm.local:9800', 'sec-fetch-site': 'same-origin' }) === null);
ok('无 Origin（非浏览器）放行到会话核验', lcWriteGuard(H) === null);
ok('拒缺 X-WM-Lifecycle', /X-WM-Lifecycle/.test(lcWriteGuard({ ...H, 'x-wm-lifecycle': undefined }) ?? ''));
ok('拒 text/plain（跨站表单形态）', /application\/json/.test(lcWriteGuard({ ...H, 'content-type': 'text/plain' }) ?? ''));
ok('拒 Sec-Fetch-Site=cross-site', /跨站/.test(lcWriteGuard({ ...H, 'sec-fetch-site': 'cross-site' }) ?? ''));
ok('拒 Sec-Fetch-Site=same-site（同主机别的端口）', /跨站/.test(lcWriteGuard({ ...H, 'sec-fetch-site': 'same-site' }) ?? ''));
ok('拒 Origin: null（sandbox 自产台）', /跨源/.test(lcWriteGuard({ ...H, origin: 'null' }) ?? ''));
ok('拒外域 Origin', /跨源/.test(lcWriteGuard({ ...H, origin: 'http://evil.example' }) ?? ''));
ok('拒同主机别端口 Origin', /跨源/.test(lcWriteGuard({ ...H, origin: 'http://wm.local:8069' }) ?? ''));

console.log('⑦ 配置门');
const LC_ENV = ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'LC_TEST'];
const saved = Object.fromEntries(LC_ENV.map((k) => [k, process.env[k]]));
const withEnv = (env, fn) => { for (const k of LC_ENV) delete process.env[k]; Object.assign(process.env, env); try { return fn(); } finally { for (const k of LC_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const full = { LC_YGL_BIN: '/opt/ygl/bin.cjs', LC_WORKBENCH_KEY_FILE: '/etc/wm/workbench.key', LC_ODOO_URL: 'http://odoo.local:8069' };
const runtime = join(homedir(), '.ygl-trees-lc');
ok('未配置任何 LC_* → 无问题（源缺席）', withEnv({}, lifecycleConfigProblem) === null);
ok('缺项 → 点名缺哪几个', /缺 LC_YGL_BIN、LC_WORKBENCH_KEY_FILE、LC_ODOO_URL/.test(withEnv({ LC_YGL_HOME: '/srv/lc' }, lifecycleConfigProblem) ?? ''));
ok('LC_YGL_HOME 相对路径 → 拒', /绝对路径/.test(withEnv({ ...full, LC_YGL_HOME: 'lc-home' }, lifecycleConfigProblem) ?? ''));
ok('LC_TEST=1 + 运行工作区 → 拒', /运行工作区/.test(withEnv({ ...full, LC_YGL_HOME: runtime, LC_TEST: '1' }, lifecycleConfigProblem) ?? ''));
ok('LC_TEST=1 + 运行工作区子目录 → 拒', /运行工作区/.test(withEnv({ ...full, LC_YGL_HOME: join(runtime, 'x'), LC_TEST: '1' }, lifecycleConfigProblem) ?? ''));
ok('非测试模式指向运行工作区 → 放行（生产形态）', withEnv({ ...full, LC_YGL_HOME: runtime }, lifecycleConfigProblem) === null);
ok('LC_TEST=1 + 全新测试工作区 → 放行', withEnv({ ...full, LC_YGL_HOME: join(tmpdir(), 'lc-test-home'), LC_TEST: '1' }, lifecycleConfigProblem) === null);

// Read-only delivery must also cover the full-page heading, not only TasksView.
const tasksUi = readFileSync(new URL('../web/src/pages/Tasks.tsx', import.meta.url), 'utf8');
ok('任务页副标题明确只读且不再声称可批准', tasksUi.includes('生命周期当前仅供查看，工作台审批已停用') && !tasksUi.includes('生命周期提议可在此批准'));
ok('任务页无批准请求或批准确认CTA', !tasksUi.includes("fetch('/api/lifecycle/approve'") && !tasksUi.includes('批准这条生命周期提议？') && !tasksUi.includes('>批准</Button>'));
console.log(`lc-issuer-unit: ${pass} passed / ${fail} failed / ${skip} skipped`);
process.exitCode = fail ? 1 : 0;
