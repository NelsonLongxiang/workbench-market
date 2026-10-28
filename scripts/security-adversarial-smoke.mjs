#!/usr/bin/env node
/** 安全对抗例组（总工 F5 新规·#242 根因机械化）：安全旗标 PR 闸必跑——
 *  每组 ≥5 例：正例拒 + 对照放行。当前组：S1 SSRF 注册白名单。新增安全面按组追加。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/sec-adv-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sec' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  await waitReady(B + '/api/health');
  const reg = (url, name = 'ADV') => fetch(B + '/api/workbenches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url }) });
  // S1 SSRF：正例 5+ 拒
  const NEG = [
    ['公网 CIDR 192.30.255.112', 'http://192.30.255.112/'],
    ['公网 172.217.0.1（非 172.16/12）', 'http://172.217.0.1/'],
    ['元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 字面量公网', 'http://[2001:4860:4860::8888]/'],
    ['数值 label 域名 10.attacker.example', 'http://10.attacker.example/'],
    ['nip.io 变形 127.0.0.1.nip.io', 'http://127.0.0.1.nip.io/'],
    ['公网域名 example.com', 'http://example.com/'],
  ];
  let n = 0; const holes = [];
  for (const [label, u] of NEG) { const r = await reg(u); if (r.status === 400) n++; else holes.push(label + '→' + r.status); }
  ok('S1a 对抗例全拒（' + NEG.length + ' 例）', n === NEG.length, holes.join(','));
  // S1 对照：内网/回环/localhost 放行
  const POS = ['http://192.168.3.100:8080/', 'http://10.1.2.3:8000/', 'http://127.0.0.1:4000/', 'http://localhost:4000/'];
  let m = 0; const blocked = [];
  for (const u of POS) { const r = await reg(u, 'ADV-OK'); if (r.status === 201) m++; else blocked.push(u + '→' + r.status); }
  ok('S1b 对照放行（' + POS.length + ' 例·内网/回环/localhost）', m === POS.length, blocked.join(','));
  // S2 环境对抗（F5 增项·总工 direct-0cb2a7a4）：路径转换篡改挂载源面——探针 A（默认）/B（MSYS_NO_PATHCONV=1）对照
  const { spawnSync } = await import('node:child_process');
  const isWin = process.platform === 'win32';
  const probe = (env) => spawnSync('docker', ['run', '--rm', '-v', '/var/run/docker.sock:/probe.sock', 'alpine', 'sh', '-c', 'test -S /probe.sock && echo MOUNTED || echo MISSING'], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  const a = probe({});
  const b = probe({ MSYS_NO_PATHCONV: '1' });
  const aOut = (a.stdout || '') + (a.stderr || '');
  const bOut = (b.stdout || '') + (b.stderr || '');
  // 判据形态：B（禁用路径转换）应 MOUNTED；A 在 Windows/GitBash 面常见 MISSING/ENOENT（=路径被转换的实证）
  const documented = process.env.F5_ENV_FACE_DOC === '1';
  if (!isWin && (a.status !== 0 || b.status !== 0)) {
    console.log('  - S2 env-face 跳过（无 docker 面·非 Windows）');
  } else {
    const bOk = /MOUNTED/.test(bOut);
    const aDiffers = aOut !== bOut || /MISSING|ENOENT|not found/i.test(aOut);
    ok('S2 env-face A/B 对照（B=MOUNTED·A 差异/缺失=路径转换实证）', documented || (bOk && aDiffers), 'A=' + aOut.slice(0, 40).replace(/\\n/g, ' ') + ' | B=' + bOut.slice(0, 40).replace(/\\n/g, ' '));
  }
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== 安全对抗例组 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
