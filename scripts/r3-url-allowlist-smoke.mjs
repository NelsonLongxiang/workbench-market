#!/usr/bin/env node
// #258 R3 业务 URL 登记准入（docs/r3-url-allowlist-design.md v2 · U1–U15）：
// 纯解析层（分类 fixture、key 等价、配置拒启、deny 限量、审计降级）+ 隔离实例全入口（REST/MCP/自动登记/import 事务注错/审计日志）。
// 全部合成：随机端口、tmp/ 专属 DATA_DIR，公网地址只登记不访问（不发任何外网或元数据请求）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const m = await import(pathToFileURL(resolve('server/src/url-admission.ts')).href);
let pass = 0, fail = 0;
const check = async (name, f) => {
  try { await f(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + (e?.message ?? e).split('\n')[0]); }
};
const kindOf = (u) => { try { return m.analyzeUrl(u).kind; } catch (e) { return 'invalid'; } };
const keyOf = (u) => m.analyzeUrl(u).key;

// ---------- 纯解析层 ----------
await check('U5 §3.4 等价组与边界 fixture', () => {
  const table = {
    'http://10.1.2.3/': 'private', 'http://[::ffff:10.1.2.3]/': 'private', 'http://[::ffff:a01:203]/': 'private',
    'http://127.0.0.1/': 'private', 'http://[::ffff:127.0.0.1]/': 'private', 'http://[::1]/': 'private',
    'http://169.254.169.254/': 'hard', 'http://[::ffff:169.254.169.254]/': 'hard', 'http://[::ffff:a9fe:a9fe]/': 'hard',
    'http://8.8.8.8/': 'public', 'http://[::ffff:8.8.8.8]/': 'public',
    'http://172.15.255.255/': 'public', 'http://172.16.0.0/': 'private', 'http://172.31.255.255/': 'private', 'http://172.32.0.0/': 'public',
    'http://[fbff::1]/': 'hard', 'http://[fc00::1]/': 'private', 'http://[fdff::1]/': 'private', 'http://[fe00::1]/': 'hard', 'http://[fe80::1]/': 'hard', 'http://[ff02::1]/': 'hard',
    'http://[2001:4860:4860::8888]/': 'public', 'http://[2001:db8::1]/': 'hard', 'http://[2002::1]/': 'hard', 'http://[3fff::1]/': 'hard',
    'http://0.0.0.0/': 'hard', 'http://[::]/': 'hard', 'http://[::ffff:0.0.0.0]/': 'hard', 'http://255.255.255.255/': 'hard', 'http://198.18.0.1/': 'hard',
    'http://2130706433/': 'invalid', 'http://0177.0.0.1/': 'invalid', 'http://0x7f000001/': 'invalid', 'http://[fe80::1%25eth0]/': 'invalid',
  };
  for (const [u, want] of Object.entries(table)) assert.equal(kindOf(u), want, u);
});
await check('U5 H4 逐 CIDR 代表 + H6 逐前缀 + 补集类别全硬拒', () => {
  const h4 = ['0.1.2.3', '100.64.0.1', '100.127.255.254', '169.254.1.1', '192.0.0.8', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.175.48.1', '198.19.255.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1'];
  for (const ip of h4) assert.equal(kindOf(`http://${ip}/`), 'hard', ip);
  const h6 = ['2001::1', '2001:1ff::1', '2001:db8:1::1', '2002:c000:204::1', '2620:4f:8000::1', '3fff:fff::1', '::2', '::1.2.3.4', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', 'fec0::1', 'fe80::a9fe:a9fe', 'ff00::1', '4000::1', 'e000::1'];
  for (const ip of h6) assert.equal(kindOf(`http://[${ip}]/`), 'hard', ip);
  for (const ip of ['2001:200::1', '2400:cb00::1', '2a00:1450::1', '3ffe::1']) assert.equal(kindOf(`http://[${ip}]/`), 'public', ip);
});
await check('U7 数值 label / 少段与整数 IPv4 / 全角 / 尾点 / 通配 / userinfo / 控制符 / 反斜杠', () => {
  for (const u of ['http://10.attacker.example/', 'http://127.0.0.1.nip.io/', 'http://web.163.com/']) assert.equal(kindOf(u), 'hard', u);
  for (const u of ['http://127.1/', 'http://1.2.3/', 'http://０x7f.0.0.1/', 'http://１２７.0.0.1/', 'http://example.com./', 'http://*.example.com/', 'http://a..b/',
    'http://user:pw@example.com/', 'http://ex\u0007ample.com/', 'http://example.com\\@evil/', 'http://exa mple.com/', 'ftp://example.com/', 'http://[::1/', 'http://::1/', 'http://example.com:0/', 'http://example.com:99999/'])
    assert.equal(kindOf(u), 'invalid', u);
  assert.equal(kindOf('http://localhost:8080/'), 'private');
  assert.equal(kindOf('http://intranet-wiki/'), 'private');
  assert.equal(kindOf('http://例子.测试/'), 'public'); // IDNA → xn-- ASCII 后同规则
});
await check('U6 key 等价：host 大小写 / 显式缺省端口 / mapped 归 v4；非等价：path 大小写 / 尾斜杠 / 端口 / query / scheme', () => {
  assert.equal(keyOf('http://EXAMPLE.com/tool/'), keyOf('http://example.com:80/tool/'));
  assert.equal(keyOf('https://example.com/'), keyOf('https://example.com:443'));
  assert.equal(keyOf('http://[::ffff:8.8.8.8]:8080/a'), keyOf('http://8.8.8.8:8080/a'));
  assert.equal(keyOf('http://example.com/a%2a'), keyOf('http://example.com/a%2A')); // 非分隔编码只做 hex 大写
  const base = keyOf('http://example.com/tool/');
  for (const u of ['http://example.com/Tool/', 'http://example.com/tool', 'http://example.com/tool/a', 'http://example.com/tool-evil', 'http://example.com:8080/tool/', 'http://example.com/tool/?x=1', 'https://example.com/tool/'])
    assert.notEqual(keyOf(u), base, u);
  assert.notEqual(keyOf('http://example.com/?a=1&b=2'), keyOf('http://example.com/?b=2&a=1')); // query 保序不排序
});
const policy = m.loadAllowPolicy(JSON.stringify(['http://example.com/tool/', 'https://[2001:4860:4860::8888]/', 'http://8.8.8.8:8080/a?x=1']));
await check('U1/U2/U3 单核判定：未登记公网 403、已登记放行、硬拒压过许可、严格形态 400', () => {
  const t = () => true;
  const code = (u) => { try { m.admitUrl(u, policy, t); return 'ok'; } catch (e) { return `${e.status} ${e.code}`; } };
  assert.equal(code('http://example.com/tool/'), 'ok');
  assert.equal(code('http://EXAMPLE.COM:80/tool/'), 'ok');
  assert.equal(code('http://[::ffff:8.8.8.8]:8080/a?x=1'), 'ok');
  assert.equal(code('https://[2001:4860:4860::8888]:443/'), 'ok');
  for (const u of ['http://example.com/tool', 'http://example.com/tool/x', 'http://example.com:81/tool/', 'http://8.8.8.8:8080/a', 'http://8.8.8.8:8080/a?x=2', 'http://1.1.1.1/'])
    assert.equal(code(u), '403 url_not_allowlisted', u);
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://10.attacker.example/']) assert.equal(code(u), '403 url_hard_denied', u);
  for (const u of ['http://example.com/tool/#x', 'http://example.com/tool/../tool/', 'http://example.com/tool%2f/', 'http://example.com/%2e%2e/tool/', 'http://example.com/tool/%zz'])
    assert.equal(code(u), '400 invalid_url', u);
  assert.equal(code('http://10.0.0.5/#/spa'), 'ok'); // 私网沿原准入：fragment 等严格形态只约束许可 key
});
await check('U4 内部路径：/apps/<slug>/ 与 /sop/<slug>/ 子路径收；//evil、任意内路径、点段、编码分隔、不存在的台拒', () => {
  const exists = (area, slug) => slug === 'real';
  const code = (u) => { try { m.admitUrl(u, policy, exists); return 'ok'; } catch (e) { return `${e.status} ${e.code}`; } };
  for (const u of ['/apps/real/', '/sop/real/', '/apps/real/index.html', '/apps/real/assets/a.js']) assert.equal(code(u), 'ok', u);
  for (const u of ['//evil.example/', '/\\evil', '/admin', '/apps/', '/apps/real', '/apps/Real/', '/apps/real/../x', '/apps/real/a%2fb', '/apps/real/?x=1', '/apps/real/#x', '/apps/real//x', '/apps/ghost/', '/go/1/'])
    assert.equal(code(u), '400 invalid_url', u);
});
await check('U13 配置坏项整体拒：非数组/非字符串/通配/硬拒/私网/敏感 query/fragment/userinfo；重复去重计数', () => {
  for (const bad of ['{', '"x"', '{"a":1}', '[1]', '[""]', '["http://*.example.com/"]', '["http://169.254.169.254/"]', '["http://10.0.0.1/"]', '["http://intranet/"]', '["/apps/x/"]',
    '["http://example.com/?token=abc"]', '["http://example.com/?API_KEY=1"]', '["http://example.com/#f"]', '["http://u:p@example.com/"]', '["example.com"]'])
    assert.throws(() => m.loadAllowPolicy(bad), undefined, bad);
  const p = m.loadAllowPolicy('["http://Example.com/x","http://example.com:80/x"]');
  assert.equal(p.size, 1); assert.equal(p.duplicates, 1);
  assert.equal(m.loadAllowPolicy(undefined).size, 0);
  assert.notEqual(m.loadAllowPolicy('[]').digest, p.digest);
});
await check('U15 health_path：相对收；同 origin 绝对收；协议相对/跨 origin/反斜杠/内部台绝对拒', () => {
  m.checkHealthPath('http://10.0.0.1:8080/app/', '/healthz');
  m.checkHealthPath('http://10.0.0.1:8080/app/', 'http://10.0.0.1:8080/ping');
  for (const hp of ['//evil.example/x', 'http://10.0.0.2:8080/ping', 'https://10.0.0.1:8080/ping', '\\\\evil', 'javascript:alert(1)'])
    assert.throws(() => m.checkHealthPath('http://10.0.0.1:8080/app/', hp), undefined, hp);
  assert.throws(() => m.checkHealthPath('/apps/real/', 'http://10.0.0.1/'));
});
await check('U11 deny 限量：每 reason 每 60s 至多 10 条，窗口重置后带丢弃数；无原 URL', () => {
  const lines = [];
  let t = 1_000_000;
  m._setAuditWriter((l) => lines.push(JSON.parse(l)));
  m._setAuditClock(() => t);
  for (let i = 0; i < 25; i++) m.auditDeny('register', 'url_not_allowlisted', 'http://secret.example:80/?k=SECRET');
  for (let i = 0; i < 3; i++) m.auditDeny('register', 'url_hard_denied', null);
  assert.equal(lines.filter((x) => x.reason === 'url_not_allowlisted').length, 10);
  assert.equal(lines.filter((x) => x.reason === 'url_hard_denied').length, 3);
  t += 60_000;
  m.auditDeny('register', 'url_not_allowlisted', null);
  assert.equal(lines.at(-1).dropped_previous_window, 15);
  assert.ok(!JSON.stringify(lines).includes('SECRET') && !JSON.stringify(lines).includes('secret.example'));
  assert.equal(lines[0].url_digest.length, 64);
});
await check('U12 审计写失败：auditAllow 返回 false 不抛、另发 audit_failure', () => {
  const lines = [];
  m._setAuditWriter((l) => { if (l.includes('"workbench_url_allowlist"')) throw new Error('EPIPE'); lines.push(JSON.parse(l)); });
  assert.equal(m.auditAllow('register', policy, 'http://example.com:80/tool/', 7, 'anonymous'), false);
  assert.equal(lines.at(-1).event, 'workbench_url_audit_failure');
  m._setAuditWriter(() => { throw new Error('closed'); });
  assert.equal(m.auditAllow('register', policy, 'http://example.com:80/tool/', 7, 'anonymous'), false); // 渠道全断也不抛
});

// ---------- 隔离实例 ----------
mkdirSync('tmp', { recursive: true });
const ALLOW = ['http://example.com/tool/', 'http://8.8.8.8:8080/a', 'https://[2001:4860:4860::8888]/'];
const preload = join(resolve('tmp'), `r3-preload-${process.pid}.mjs`);
// U12 实例级注错夹具：测试启动命令显式 --import，按开关文件让 allow 行写 stderr 抛错（生产代码无此分支）
writeFileSync(preload, `import { existsSync } from 'node:fs';
const w = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).includes('"workbench_url_allowlist"') && existsSync(process.env.R3_FIXTURE_FAIL_FLAG)) throw new Error('fixture: audit channel broken');
  return w(chunk, ...rest);
};`);
const tmps = [];
async function startServer(extraEnv = {}, { expectExit = false } = {}) {
  const port = 21000 + Math.floor(Math.random() * 18000);
  const data = extraEnv.DATA_DIR ?? mkdtempSync(join('tmp', 'r3-allow-'));
  if (!extraEnv.DATA_DIR) tmps.push(data);
  const env = { ...process.env, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, MCP_GATEWAY: '', ADMIN_TOKEN: 'r3-test', R3_FIXTURE_FAIL_FLAG: join(data, '.fail-audit'), ...extraEnv };
  for (const k of ['ALLOW_PUBLIC_NET', 'WM_REGISTER_URL_ALLOWLIST']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { child, port, data, base: `http://127.0.0.1:${port}`, out: '', err: '' };
  child.stdout.on('data', (c) => (s.out += c));
  child.stderr.on('data', (c) => (s.err += c));
  if (expectExit) {
    const t = setTimeout(() => child.kill(), 30000);
    const [code] = await once(child, 'exit'); clearTimeout(t);
    s.code = code; return s;
  }
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('server exited: ' + s.err.slice(-400));
    try { if ((await fetch(s.base + '/api/health')).ok) return s; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server not ready');
}
async function stop(s) { if (s.child.exitCode === null) { const e = once(s.child, 'exit'); s.child.kill(); await e; } }
const call = async (s, method, path, body) => {
  const r = await fetch(s.base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
};
const mcp = async (s, name, args) => (await call(s, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body?.result;
const allowLines = (s) => s.err.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.event === 'workbench_url_allowlist');
const snapshot = async (s) => {
  const e = (await call(s, 'GET', '/api/export?reveal=1')).body;
  const c = (await call(s, 'GET', '/api/cockpits')).body;
  return JSON.stringify({ w: e.workbenches.map(({ last_checked_at, ...r }) => r), t: e.types, c });
};

try {
  await check('U13 实例：坏配置拒启动（非数组 / 硬拒 / 通配）', async () => {
    for (const bad of ['{"x":1}', '["http://169.254.169.254/"]', '["http://*.example.com/"]']) {
      const s = await startServer({ WM_REGISTER_URL_ALLOWLIST: bad }, { expectExit: true });
      assert.equal(s.code, 1, bad + ' ' + s.err.slice(-200));
      assert.ok(s.err.includes('[R3] 拒绝启动'), s.err.slice(-200));
    }
  });

  const s = await startServer({ WM_REGISTER_URL_ALLOWLIST: JSON.stringify(ALLOW), ALLOW_PUBLIC_NET: '1' });
  await check('U3 旧 flag=1 启动告警且不再放行', async () => {
    assert.ok(s.out.includes('legacy flag no longer grants public registration') || s.err.includes('legacy flag no longer grants public registration'));
    const r = await call(s, 'POST', '/api/workbenches', { name: 'x', url: 'http://1.1.1.1/' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'url_not_allowlisted'); assert.ok(r.body.message);
  });
  await check('U1/U2 REST：未登记公网 403 零写；已登记 201 且 commit 后恰一条 allow；私网/回环/短名照旧', async () => {
    const before = (await call(s, 'GET', '/api/workbenches')).body.length;
    for (const u of ['http://example.com/tool', 'http://example.com:8080/tool/', 'http://8.8.8.8:8080/a?x=1', 'http://[2001:4860:4860::8888]/']) {
      const r = await call(s, 'POST', '/api/workbenches', { name: 'deny', url: u });
      assert.equal(r.status, 403, u); assert.equal(r.body.error, 'url_not_allowlisted', u);
      assert.ok(!JSON.stringify(r.body).includes('example.com'), '不回显原 URL');
    }
    assert.equal((await call(s, 'GET', '/api/workbenches')).body.length, before);
    assert.equal(allowLines(s).length, 0);
    const ok = await call(s, 'POST', '/api/workbenches', { name: 'allowed', url: 'http://EXAMPLE.com:80/tool/' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const v6 = await call(s, 'POST', '/api/workbenches', { name: 'v6', url: 'https://[2001:4860:4860::8888]/' });
    assert.equal(v6.status, 201, JSON.stringify(v6.body));
    await new Promise((r) => setTimeout(r, 100));
    const al = allowLines(s);
    assert.equal(al.length, 2);
    assert.deepEqual(al.map((x) => x.workbench_id), [ok.body.id, v6.body.id]);
    assert.ok(al.every((x) => x.operation === 'register' && x.outcome === 'allow' && x.subject === 'anonymous' && /^[0-9a-f]{64}$/.test(x.policy_digest) && /^[0-9a-f]{64}$/.test(x.url_digest)));
    assert.ok(!s.err.includes('/tool/'), '审计日志不含原 URL');
    for (const u of ['http://192.168.3.100:8080/', 'http://127.0.0.1:4000/', 'http://intranet/', 'http://[fd00::5]/', 'http://localhost:3000/#/x'])
      assert.equal((await call(s, 'POST', '/api/workbenches', { name: 'priv', url: u })).status, 201, u);
    assert.equal(allowLines(s).length, 2, '私网不冒充 allowlist 命中');
  });
  await check('U5 实例：元数据 / 链路本地 / 数值 label 硬拒 403，许可与 flag 都不救', async () => {
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fe80::a9fe:a9fe]/', 'http://127.0.0.1.nip.io/', 'http://0.0.0.0:9800/']) {
      const r = await call(s, 'POST', '/api/workbenches', { name: 'h', url: u });
      assert.equal(r.status, 403, u); assert.equal(r.body.error, 'url_hard_denied', u);
    }
    assert.equal((await call(s, 'POST', '/api/workbenches', { name: 'h', url: 'http://0x7f000001/' })).body.error, 'invalid_url');
  });
  await check('U8 MCP workbench_register / update 同核', async () => {
    const d = await mcp(s, 'workbench_register', { name: 'm', url: 'http://1.1.1.1/' });
    assert.ok(d.isError && d.content[0].text.includes('url_not_allowlisted'), JSON.stringify(d));
    const h = await mcp(s, 'workbench_register', { name: 'm', url: 'http://169.254.169.254/' });
    assert.ok(h.isError && h.content[0].text.includes('url_hard_denied'));
    const ok = await mcp(s, 'workbench_register', { name: 'm', url: 'http://8.8.8.8:8080/a' });
    assert.ok(!ok.isError, JSON.stringify(ok));
    const id = JSON.parse(ok.content[0].text).id;
    const u = await mcp(s, 'workbench_update', { id, url: 'http://8.8.8.8:8080/b' });
    assert.ok(u.isError && u.content[0].text.includes('url_not_allowlisted'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(allowLines(s).filter((x) => x.workbench_id === id).length, 1);
  });
  await check('U4/U8 内部路径与自动登记：存在的台可登记，不存在 / 任意内路径 / //evil 拒', async () => {
    const pub = await call(s, 'POST', '/api/apps', { slug: 'r3-real', title: 'R3', files: [{ path: 'index.html', content: '<p>x</p>' }] });
    assert.ok(pub.status === 200 || pub.status === 201, JSON.stringify(pub.body));
    assert.equal((await call(s, 'POST', '/api/workbenches', { name: 'i', url: '/apps/r3-real/' })).status, 201);
    for (const u of ['/apps/ghost/', '//evil.example/', '/admin/x', '/sop/r3-real/'])
      assert.equal((await call(s, 'POST', '/api/workbenches', { name: 'i', url: u })).body?.error, 'invalid_url', u);
  });
  await check('U14 update：原 url 不变的元数据更新照收；新公网 key 需准入；被拒不删行', async () => {
    const list = (await call(s, 'GET', '/api/workbenches')).body;
    const row = list.find((w) => w.name === 'allowed');
    const r1 = await call(s, 'PUT', `/api/workbenches/${row.id}`, { name: 'allowed-renamed', url: row.url });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await call(s, 'PUT', `/api/workbenches/${row.id}`, { url: 'http://example.com/tool/x' });
    assert.equal(r2.status, 403);
    assert.equal((await call(s, 'GET', `/api/workbenches/${row.id}`)).body.name, 'allowed-renamed');
    const r3 = await call(s, 'PUT', `/api/workbenches/${row.id}`, { health_path: '//evil.example/' });
    assert.equal(r3.status, 400); assert.equal(r3.body.error, 'invalid_health_path');
  });
  await check('U9 import：结构 400 / 掩码 400 / 未登记 403 / 硬拒 403，row_index 具名，replace 不先清库（零写）', async () => {
    const before = await snapshot(s);
    const okRow = { name: 'ok', url: 'http://10.0.0.9/' };
    const cases = [
      [{ workbenches: [okRow, 'x'] }, 400, 'invalid_import', 1],
      [{ workbenches: [okRow, { name: 'm', url: 'http://10.0.0.1/?token=****' }] }, 400, 'masked_import_value', 1],
      [{ workbenches: [{ name: 'a', url: 'http://10.0.0.1/', auth: { type: 'bearer', value: '****' } }] }, 400, 'masked_import_value', 0],
      [{ workbenches: [okRow, okRow, { name: 'p', url: 'http://1.1.1.1/' }] }, 403, 'url_not_allowlisted', 2],
      [{ workbenches: [{ name: 'h', url: 'http://169.254.169.254/' }] }, 403, 'url_hard_denied', 0],
      [{ workbenches: [{ name: 'f', url: 'http://0177.0.0.1/' }] }, 400, 'invalid_url', 0],
      [{ workbenches: [{ name: 'g', url: '/apps/ghost/' }] }, 400, 'invalid_url', 0],
    ];
    for (const [body, st, code, idx] of cases) {
      const r = await call(s, 'POST', '/api/import?mode=replace', body);
      assert.equal(r.status, st, code + JSON.stringify(r.body)); assert.equal(r.body.error, code); assert.equal(r.body.row_index, idx, code);
    }
    assert.equal(await snapshot(s), before);
  });
  await check('U10 import 写期注错（行 / 类型 / 布局触发器 RAISE(ABORT)）：整体回滚，快照逐项不变；去掉触发器同请求成功', async () => {
    const w1 = (await call(s, 'GET', '/api/workbenches')).body[0];
    assert.equal((await call(s, 'POST', '/api/cockpits', { name: 'r3', panels: [{ i: 'p', workbenchId: w1.id, x: 0, y: 0, w: 2, h: 2 }] })).status, 201);
    const db = new DatabaseSync(join(s.data, 'workbench-market.db'));
    const before = await snapshot(s);
    const exp = (await call(s, 'GET', '/api/export?reveal=1')).body;
    const rows = exp.workbenches.map(({ name, url, type, health_path }) => ({ name, url, type, health_path }));
    const triggers = {
      row: `CREATE TRIGGER r3_u10_row BEFORE INSERT ON workbenches WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'r3 u10 row'); END`,
      types: `CREATE TRIGGER r3_u10_types BEFORE INSERT ON types WHEN NEW.key = 'boomtype' BEGIN SELECT RAISE(ABORT, 'r3 u10 types'); END`,
      layout: `CREATE TRIGGER r3_u10_layout BEFORE UPDATE ON cockpits BEGIN SELECT RAISE(ABORT, 'r3 u10 layout'); END`,
    };
    const bodies = {
      row: { workbenches: [...rows.slice(0, 1), { name: 'boom', url: 'http://10.0.0.7/' }] },
      types: { workbenches: rows, types: [{ key: 'boomtype', name: 'boom' }] },
      layout: { workbenches: rows.slice(1) }, // replace 后 id 重排 → 布局引用要剔除 → 触发器拦下
    };
    for (const k of ['row', 'types', 'layout']) {
      db.exec(triggers[k]);
      const r = await call(s, 'POST', '/api/import?mode=replace', bodies[k]);
      assert.equal(r.status, 500, k + JSON.stringify(r.body)); assert.equal(r.body.error, 'import_failed', k);
      assert.equal(await snapshot(s), before, k + ' 回滚后快照不变');
      db.exec(`DROP TRIGGER r3_u10_${k}`);
    }
    const okr = await call(s, 'POST', '/api/import?mode=merge', bodies.row);
    assert.equal(okr.status, 200, JSON.stringify(okr.body)); assert.equal(okr.body.imported, 2);
    db.close();
  });
  await check('U11 import 每个命中许可的行 commit 后恰一条 allow；失败批零 allow', async () => {
    const n0 = allowLines(s).length;
    await call(s, 'POST', '/api/import?mode=merge', { workbenches: [{ name: 'a', url: 'http://example.com/tool/' }, { name: 'b', url: 'http://8.8.8.8:8080/a' }, { name: 'c', url: 'http://1.1.1.1/' }] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(allowLines(s).length, n0, '预检失败零 allow');
    const r = await call(s, 'POST', '/api/import?mode=merge', { workbenches: [{ name: 'a', url: 'http://example.com/tool/' }, { name: 'p', url: 'http://10.1.1.1/' }, { name: 'b', url: 'http://8.8.8.8:8080/a' }] });
    assert.equal(r.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const added = allowLines(s).slice(n0);
    assert.equal(added.length, 2); assert.ok(added.every((x) => x.operation === 'import'));
  });
  await check('U12 实例：allow 写 stderr 抛错 → 201 + X-WM-Audit-State: degraded，行只一条、不重试、服务仍活', async () => {
    writeFileSync(join(s.data, '.fail-audit'), '1');
    const n = (await call(s, 'GET', '/api/workbenches')).body.length;
    const r = await call(s, 'POST', '/api/workbenches', { name: 'deg', url: 'http://example.com/tool/' });
    assert.equal(r.status, 201); assert.equal(r.headers.get('x-wm-audit-state'), 'degraded');
    assert.equal((await call(s, 'GET', '/api/workbenches')).body.length, n + 1);
    assert.ok(s.err.includes('workbench_url_audit_failure'));
    rmSync(join(s.data, '.fail-audit'));
    assert.equal((await call(s, 'GET', '/api/health')).status, 200);
  });
  await stop(s);

  await check('U14 存量公网行：去掉许可后重启不删行、启动列迁移缺口（只出摘要）、改名照收、新 url 拒', async () => {
    const s2 = await startServer({ DATA_DIR: s.data });
    try {
      assert.ok(s2.err.includes('workbench_url_legacy_gap'), s2.err.slice(-300));
      const gapLine = s2.err.split('\n').find((l) => l.includes('workbench_url_legacy_gap'));
      assert.ok(!gapLine.includes('example.com') && !gapLine.includes('8.8.8.8'), '缺口清单不含原 URL');
      const row = (await call(s2, 'GET', '/api/workbenches')).body.find((w) => w.name === 'allowed-renamed');
      assert.ok(row, '存量公网行仍在');
      assert.equal((await call(s2, 'PUT', `/api/workbenches/${row.id}`, { name: 'again', url: row.url })).status, 200);
      assert.equal((await call(s2, 'POST', '/api/workbenches', { name: 'copy', url: row.url })).status, 403, '复制 = 新登记，必须准入');
    } finally { await stop(s2); }
  });
} finally {
  for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(preload, { force: true });
}
console.log(`r3-url-allowlist-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
