#!/usr/bin/env node
/** 安全对抗例组（总工 F5 新规·#242 根因机械化）：安全旗标 PR 闸必跑——
 *  每组 ≥5 例：正例拒 + 对照放行。当前组：S1 SSRF 注册白名单；S3 生命周期审批写面（scripts/security-lc-approve.mjs）；S4 门户 Odoo 会话转发（scripts/portal-odoo-session-smoke.mjs）。新增安全面按组追加。 */
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { runEnvFace } from './security-env-face.mjs';
import { runLcApproveGroup } from './security-lc-approve.mjs';
import { runPortalOdooSessionGroup } from './portal-odoo-session-smoke.mjs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/sec-adv-' + Date.now().toString(36);
let pass = 0, fail = 0;
let environment = { status: 'NEEDS-MATERIAL', reason: 'probe not reached' };
let lcGroup = { pass: 0, fail: 1 };
let portalGroup = { pass: 0, fail: 1 };
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', ALLOW_PUBLIC_NET: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sec' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  if (!(await waitReady(B + '/api/health'))) throw new Error('Isolated fixture server not ready');
  const reg = (url, name = 'ADV') => fetch(B + '/api/workbenches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url }) });
  // S1 SSRF：正例 5+ 拒
  // #258：未登记公网 403 url_not_allowlisted；元数据/混淆主机 403 url_hard_denied（具名码，不只看状态码）
  const NEG = [
    ['公网 CIDR 192.30.255.112', 'http://192.30.255.112/', 'url_not_allowlisted'],
    ['公网 172.217.0.1（非 172.16/12）', 'http://172.217.0.1/', 'url_not_allowlisted'],
    ['元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/', 'url_hard_denied'],
    ['IPv6 字面量公网', 'http://[2001:4860:4860::8888]/', 'url_not_allowlisted'],
    ['数值 label 域名 10.attacker.example', 'http://10.attacker.example/', 'url_hard_denied'],
    ['nip.io 变形 127.0.0.1.nip.io', 'http://127.0.0.1.nip.io/', 'url_hard_denied'],
    ['公网域名 example.com', 'http://example.com/', 'url_not_allowlisted'],
  ];
  let n = 0; const holes = [];
  for (const [label, u, code] of NEG) { const r = await reg(u); const j = await r.json().catch(() => ({})); if (r.status === 403 && j.error === code) n++; else holes.push(label + '→' + r.status + ' ' + j.error); }
  ok('S1a 对抗例全拒（' + NEG.length + ' 例）', n === NEG.length, holes.join(','));
  // S1 对照：内网/回环/localhost 放行
  const POS = ['http://192.168.3.100:8080/', 'http://10.1.2.3:8000/', 'http://127.0.0.1:4000/', 'http://localhost:4000/'];
  let m = 0; const blocked = [];
  for (const u of POS) { const r = await reg(u, 'ADV-OK'); if (r.status === 201) m++; else blocked.push(u + '→' + r.status); }
  ok('S1b 对照放行（' + POS.length + ' 例·内网/回环/localhost）', m === POS.length, blocked.join(','));
  portalGroup = await runPortalOdooSessionGroup();
  lcGroup = await runLcApproveGroup();
  environment = runEnvFace();
  console.log('  S2 ' + environment.status + ': ' + environment.reason + ' | evidence=' + environment.evidence);
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
const summary = { input: { pass, fail }, lc_approve: lcGroup, portal_odoo_session: portalGroup, environment, coverage: { PASS: Number(environment.status === 'PASS'), FAIL: Number(environment.status === 'FAIL'), SKIP: Number(environment.status === 'SKIP'), NEEDS_MATERIAL: Number(environment.status === 'NEEDS-MATERIAL') } };
writeFileSync('tmp/security-adversarial-summary.json', JSON.stringify(summary, null, 2));
console.log('S1 input: ' + pass + ' passed / ' + fail + ' failed');
console.log('S3 lc approve: ' + lcGroup.pass + ' passed / ' + lcGroup.fail + ' failed');
console.log('S4 portal odoo session: ' + portalGroup.pass + ' passed / ' + portalGroup.fail + ' failed');
console.log('S2 coverage: ' + JSON.stringify(summary.coverage));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## F5 security coverage', '| Group | PASS | FAIL | SKIP | NEEDS-MATERIAL |', '|---|---:|---:|---:|---:|', '| S1 input | ' + pass + ' | ' + fail + ' | 0 | 0 |', '| S3 lc approve | ' + lcGroup.pass + ' | ' + lcGroup.fail + ' | 0 | 0 |', '| S4 portal odoo session | ' + portalGroup.pass + ' | ' + portalGroup.fail + ' | 0 | 0 |', '| S2 Windows path shape | ' + summary.coverage.PASS + ' | ' + summary.coverage.FAIL + ' | ' + summary.coverage.SKIP + ' | ' + summary.coverage.NEEDS_MATERIAL + ' |', '', environment.reason, ''].join(String.fromCharCode(10)));
}
process.exitCode = fail || lcGroup.fail || portalGroup.fail || environment.status === 'FAIL' ? 1 : environment.status === 'NEEDS-MATERIAL' ? 2 : 0;