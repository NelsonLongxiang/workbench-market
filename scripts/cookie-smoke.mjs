#!/usr/bin/env node
/** Cookie 池冒烟（独立实例）：导入→挂接→注入→过期过滤→掩码→删除全链。 */
import { spawn } from 'node:child_process';

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
import { rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9814;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-cookie-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

// 目标 echo 站（回显 Cookie 头）
const target = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise((r) => target.listen(9815, '127.0.0.1', r));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // ① 导入（浏览器扩展标准导出格式）
  const cookies = [
    { name: 'session', value: 'sess-abc-123', domain: '.127.0.0.1', path: '/', expirationDate: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, sameSite: 'Lax' },
    { name: 'theme', value: 'dark', domain: '127.0.0.1', path: '/', expirationDate: Math.floor(Date.now() / 1000) + 3600 },
    { name: 'expired_tok', value: 'old', domain: '127.0.0.1', path: '/', expirationDate: Math.floor(Date.now() / 1000) - 100 },
  ];
  let r = await call('POST', '/api/cookies', { label: '探针池', cookies });
  ok('导入 201', r.status === 201 && r.body.ok);
  ok('cookie_count=3 active=2（过期过滤）', r.body.cookie_count === 3 && r.body.active === 2);
  ok('value 全掩码', r.body.cookies.every((c) => c.value === '****'));
  const csid = r.body.id;
  // ② 坏导入拒
  r = await call('POST', '/api/cookies', { label: 'x', cookies: [{ name: '', value: 'y' }] });
  ok('空 name 400', r.status === 400);
  // ③ 列表
  r = await call('GET', '/api/cookies');
  ok('列表含过期信息', r.body[0].all_expired === false && r.body[0].active === 2 && r.body[0].cookies.every((c) => c.value === '****'));
  // ④ 建台 + 挂接
  r = await call('POST', '/api/workbenches', { name: 'Cookie 台', url: 'http://127.0.0.1:9815/app', type: 'web', category: 'probe' });
  const wid = r.body.id;
  r = await call('PUT', `/api/workbenches/${wid}`, { cookie_set_id: csid });
  ok('挂接 cookie_set', r.status === 200);
  // ⑤ 经门户注入（未过期+域匹配的 cookie 到达上游）
  const pr = await fetch(`${BASE}/go/${wid}/test`);
  const body = await pr.json();
  ok('Cookie 注入到达上游', body.cookie && body.cookie.includes('session=sess-abc-123') && body.cookie.includes('theme=dark'), body.cookie);
  ok('过期 cookie 被过滤', !body.cookie.includes('expired_tok'), body.cookie);
  // ⑥ 取消挂接 → 恢复浏览器透传
  r = await call('PUT', `/api/workbenches/${wid}`, { cookie_set_id: 0 });
  const pr2 = await fetch(`${BASE}/go/${wid}/test2`);
  const body2 = await pr2.json();
  ok('取消挂接后无注入', body2.cookie === null, body2.cookie);
  // ⑦ 删池
  r = await call('DELETE', `/api/cookies/${csid}`);
  ok('删池 200', r.status === 200);
  // ⑧ 全过期池
  const expCookies = [{ name: 'dead', value: 'x', domain: '127.0.0.1', expirationDate: Math.floor(Date.now() / 1000) - 1 }];
  r = await call('POST', '/api/cookies', { label: '过期池', cookies: expCookies });
  ok('全过期 all_expired=true', r.body.ok && (await call('GET', '/api/cookies')).body[0].all_expired === true);
  await call('DELETE', `/api/cookies/${r.body.id}`);
  // 清理
  await call('DELETE', `/api/workbenches/${wid}`);
} finally {
  child.kill();
  target.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== Cookie 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
