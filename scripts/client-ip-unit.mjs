#!/usr/bin/env node
/** 来源 IP 单测（server/src/login-gate.ts clientIp / trustedProxies · WM_TRUSTED_PROXIES）：
 *  缺省只认回环写入的 X-Real-IP/XFF；容器里 nginx 经 docker 网桥（如 172.17.0.1）转进来时，配了可信网段才按 X-Real-IP 分开计来源；
 *  不可信对端伪造的 X-Real-IP/XFF 一律不生效；IPv6 与 ::ffff: 映射；非法项列出且服务端拒绝启动。 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { clientIp, trustedProxies } = await import('../server/src/login-gate.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const withProxies = (v, fn) => { const old = process.env.WM_TRUSTED_PROXIES; if (v === undefined) delete process.env.WM_TRUSTED_PROXIES; else process.env.WM_TRUSTED_PROXIES = v; try { return fn(); } finally { if (old === undefined) delete process.env.WM_TRUSTED_PROXIES; else process.env.WM_TRUSTED_PROXIES = old; } };

withProxies(undefined, () => {
  ok('缺省：回环对端认 X-Real-IP', clientIp(req('127.0.0.1', { 'x-real-ip': '203.0.113.5' })) === '203.0.113.5');
  ok('缺省：回环对端没有 X-Real-IP 时取 XFF 最右项', clientIp(req('::1', { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' })) === '203.0.113.7');
  ok('缺省：docker 网桥对端不认转发头（全体访客会算成网关）', clientIp(req('172.17.0.1', { 'x-real-ip': '203.0.113.5' })) === '172.17.0.1');
});
withProxies('172.16.0.0/12, 10.20.30.40, fd00::/8', () => {
  ok('可信网段内的反代：按 X-Real-IP 分开计来源（A）', clientIp(req('172.17.0.1', { 'x-real-ip': '203.0.113.5' })) === '203.0.113.5');
  ok('可信网段内的反代：按 X-Real-IP 分开计来源（B）', clientIp(req('172.17.0.1', { 'x-real-ip': '198.51.100.77' })) === '198.51.100.77');
  ok('可信单个地址：认 XFF 最右项', clientIp(req('10.20.30.40', { 'x-forwarded-for': '1.2.3.4, 203.0.113.8' })) === '203.0.113.8');
  ok('::ffff: 映射的对端按 IPv4 判', clientIp(req('::ffff:172.18.0.1', { 'x-real-ip': '203.0.113.9' })) === '203.0.113.9');
  ok('可信 IPv6 网段', clientIp(req('fd12::3', { 'x-real-ip': '2001:db8::5' })) === '2001:db8::5');
  ok('不可信对端伪造的 X-Real-IP 不生效', clientIp(req('203.0.113.66', { 'x-real-ip': '198.51.100.1' })) === '203.0.113.66');
  ok('不可信对端伪造的 XFF 不生效', clientIp(req('10.20.30.41', { 'x-forwarded-for': '198.51.100.2' })) === '10.20.30.41');
  ok('可信对端写入的非法 X-Real-IP：回落对端', clientIp(req('172.17.0.1', { 'x-real-ip': 'not-an-ip' })) === '172.17.0.1');
});
const t = trustedProxies('172.17.0.1, 10.0.0.0/8, fd00::/8, bad, 10.0.0.0/33, 1.2.3.4/8/1, ::1/129');
ok('trustedProxies：合法项收下，非法项列出', t.entries.length === 3 && t.invalid.join('|') === 'bad|10.0.0.0/33|1.2.3.4/8/1|::1/129', JSON.stringify(t));

// 非法值拒绝启动
const dir = mkdtempSync(join(tmpdir(), 'wm-trusted-proxies-'));
const port = 20000 + Math.floor(Math.random() * 12000);
const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: dir, WM_TRUSTED_PROXIES: '172.17.0.0/12, nope' };
const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; p.stderr.on('data', (c) => (err += c));
const code = await Promise.race([new Promise((r) => p.on('exit', r)), new Promise((r) => setTimeout(() => r('timeout'), 40000))]);
if (code === 'timeout') p.kill();
ok('WM_TRUSTED_PROXIES 有非法项：拒绝启动并点名', code === 1 && /WM_TRUSTED_PROXIES 有非法项.*nope/.test(err), `code=${code} ${err.slice(-200)}`);
rmSync(dir, { recursive: true, force: true });

console.log(`client-ip-unit: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
