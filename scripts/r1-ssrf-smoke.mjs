#!/usr/bin/env node
// R2: default policy and enabled-policy startup observability, all on fresh test instances.
// #258 breaking：ALLOW_PUBLIC_NET=1 不再放行公网（只告警），公网拒 403 url_not_allowlisted，混淆/元数据 403 url_hard_denied。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';

mkdirSync('tmp', { recursive: true });
let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => { if (condition) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + ' ' + detail); } };
async function waitReady(url, child) {
  const end = Date.now() + 40000;
  while (Date.now() < end && child.exitCode === null) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('isolated server not ready: ' + url);
}
for (const enabled of [false, true]) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = mkdtempSync(join('tmp', 'r2-ssrf-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, MCP_GATEWAY: 'off', NODE_ENV: 'test', ADMIN_TOKEN: 'r2-test' };
  delete env.ALLOW_PUBLIC_NET; // default means absent, not inherited from the invoking shell
  if (enabled) env.ALLOW_PUBLIC_NET = '1';
  let logs = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c);
  child.stderr.on('data', c => logs += c);
  const base = 'http://127.0.0.1:' + port;
  try {
    await waitReady(base + '/api/health', child);
    // Before ANY register request: this distinguishes startup warning from request-time warning.
    const warning = logs.includes('legacy flag no longer grants public registration');
    ok(enabled ? 'legacy flag startup warns before registration' : 'default does not announce legacy flag', warning === enabled, logs.slice(-300));
    const reg = url => fetch(base + '/api/workbenches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'R2-test', url }) });
    const label = enabled ? 'legacy ALLOW_PUBLIC_NET=1' : 'default';
    {
      for (const url of ['http://8.8.8.8/', 'http://192.30.255.112/', 'http://172.217.0.1/', 'http://[2001:4860:4860::8888]/']) {
        const r = await reg(url); const j = await r.json().catch(() => ({}));
        ok(label + ' rejects unlisted public ' + url, r.status === 403 && j.error === 'url_not_allowlisted', r.status + ' ' + j.error);
      }
      for (const url of ['http://10.attacker.example/', 'http://127.0.0.1.nip.io/', 'http://169.254.169.254/latest/meta-data/']) {
        const r = await reg(url); const j = await r.json().catch(() => ({}));
        ok(label + ' hard-denies ' + url, r.status === 403 && j.error === 'url_hard_denied', r.status + ' ' + j.error);
      }
      for (const url of ['http://192.168.50.100:8080/', 'http://127.0.0.1:4000/']) {
        const r = await reg(url);
        ok('default permits internal control ' + url, r.status === 201, String(r.status));
      }
    }
  } finally {
    if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
}
console.log('R2 SSRF startup/default checks: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
