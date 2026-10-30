#!/usr/bin/env node
/** Read-only containment regressions. Historical approval-success tests are not current approval support. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lifecycleApprove } from '../server/src/lifecycle.ts';

export async function runLcApproveGroup() {
  let pass = 0, fail = 0;
  const checks = [];
  const ok = (name, value) => { checks.push({ name, ok: !!value }); if (value) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } };
  const blocked = r => r.http === 503 && r.body?.ok === false && r.body?.error?.code === 'LC_APPROVAL_READ_ONLY';
  // Getters must never be touched: no cookie, config, body or identity access needed to refuse.
  const poison = new Proxy({}, { get() { throw new Error('approval accessed request input'); } });
  try {
    ok('same-origin inputs refused before property access', blocked(await lifecycleApprove(poison, poison)));
    ok('missing inputs still refused without authentication', blocked(await lifecycleApprove({}, null)));
  } catch { ok('direct refusal before input access', false); }
  mkdirSync('tmp', { recursive: true });
  const dir = mkdtempSync(resolve('tmp/lc-readonly-'));
  const data = join(dir, 'data'); mkdirSync(data);
  const marker = join(dir, 'engine-called');
  const engine = join(dir, 'engine.cjs');
  writeFileSync(engine, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"CALLED"); console.log("0.116.1");');
  let odooCalls = 0;
  const odoo = createServer((_req, res) => { odooCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: { uid: 7, username: 'synthetic-user', is_internal_user: true } })); });
  await new Promise(r => odoo.listen(0, '127.0.0.1', r));
  const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const origin = 'http://127.0.0.1:' + port;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { PORT: String(port), DATA_DIR: data, ADMIN_TOKEN: 'SYNTHETIC_READONLY_ADMIN', MCP_GATEWAY: '', LC_ODOO_URL: 'http://127.0.0.1:' + odoo.address().port, LC_YGL_BIN: engine, LC_YGL_HOME: join(dir, 'home'), LC_WORKBENCH_KEY_FILE: join(dir, 'never-created.key') });
  // Native product entry is unchanged; harness binds only its listener to loopback.
  const preload = 'import net from "node:net";const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==="number"&&typeof a[1]!=="string")a.splice(1,0,"127.0.0.1");return l.apply(this,a)};';
  const fdout = openSync(join(dir, 'server.stdout.log'), 'wx'), fderr = openSync(join(dir, 'server.stderr.log'), 'wx');
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', fdout, fderr] });
  closeSync(fdout); closeSync(fderr);
  const hard = setTimeout(() => child.kill(), 30000);
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { if (child.exitCode !== null) throw new Error('isolated server exited'); try { const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(800) }); if (r.status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    assert.ok(ready, 'isolated fixture ready');
    const h = { 'content-type': 'application/json', 'x-wm-lifecycle': '1', cookie: 'session_id=SYNTHETIC_VALID_SESSION_123456789', origin, 'sec-fetch-site': 'same-origin' };
    const body = { proposal_id: 'synthetic-proposal', grant: 'synthetic-grant' };
    const cases = [
      ['same-origin portal script', h, body],
      ['same-origin SOP script', { ...h, referer: origin + '/sop/synthetic/' }, body],
      ['server replay without Origin', { ...h, origin: undefined }, body],
      ['opaque sandbox', { ...h, origin: 'null' }, body],
      ['cross-site', { ...h, origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' }, body],
      ['missing credentials', { 'content-type': 'application/json' }, body],
      ['malformed semantic fields', h, { proposal_id: '--json', grant: 'a b' }],
      ['attempt to enable with request flag', { ...h, 'x-wm-approve-enabled': '1' }, { ...body, enabled: true }],
    ];
    for (const [label, headers, payload] of cases) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([,v]) => v !== undefined));
      const r = await fetch(origin + '/api/lifecycle/approve', { method: 'POST', headers: clean, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      ok(label + ' -> read-only503', r.status === 503 && j.ok === false && j.error?.code === 'LC_APPROVAL_READ_ONLY');
    }
    ok('no Odoo identity request', odooCalls === 0);
    ok('no engine invocation (including version)', !existsSync(marker));
    ok('no signing key loaded or created', !existsSync(env.LC_WORKBENCH_KEY_FILE));
  } catch (e) { checks.push({ name: 'fixture execution', ok: false, error: String(e) }); fail++; }
  finally {
    clearTimeout(hard);
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await new Promise(r => odoo.close(r));
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ schema: 'lc-readonly-containment/1', pass, fail, checks, platform: process.platform, runtime: process.version, odooCalls, engineCalled: existsSync(marker), realCredentials: false, productionRequests: 0, child_pid: child.pid, child_exit: child.exitCode, child_signal: child.signalCode }, null, 2));
  console.log('S3 evidence: ' + dir);
  return { pass, fail };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) { const r = await runLcApproveGroup(); console.log('S3 read-only containment: ' + r.pass + ' passed / ' + r.fail + ' failed'); process.exitCode = r.fail ? 1 : 0; }
