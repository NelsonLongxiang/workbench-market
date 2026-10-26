#!/usr/bin/env node
/** 隐私门（监督席处置单·判据先红）——暂存文件隐私模式扫描。
 *  扫描 git 暂存区（git diff --cached --name-only + git show :file），或命令行给定路径。
 *  命中即 exit 2 拒提交——接入 make-submission preflight。
 *  模式：P1 内网子网 192.168.3.x/29.x · P2 redis 带凭据 · P3 私钥块。
 *  --selftest：阳性必拦 + 阴性必放。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { id: 'P1-LAN', re: /192\.168\.(3|29)\.\d{1,3}/, desc: '内网子网地址' },
  { id: 'P2-REDIS', re: /redis:\/\/[^\s]*:[^\s@]*@/, desc: 'redis 带凭据 URL' },
  { id: 'P3-PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, desc: '私钥块' },
];
const SKIP_GLOBS = [/node_modules/, /[/\\]tmp[/\\]/, /dist[/\\]/, /\.yglverify\.zip$/, /\.tar\.gz$/];

function scanText(name, text, hits) {
  for (const p of PATTERNS) {
    if (p.re.test(text)) hits.push({ file: name, pattern: p.id, desc: p.desc });
  }
}

export function selftest() {
  const positives = [
    ['lan', 'http://192.168.3.156:9800/x'],
    ['lan29', 'bridge at 192.168.29.136'],
    ['redis', 'redis://:secret123@127.0.0.1:6379'],
    ['pem', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'],
  ];
  const negatives = [
    ['loop', 'http://127.0.0.1:9800/'],
    ['redis-plain', 'redis://127.0.0.1:6379'],
    ['comment', '// 内网 trust model'],
  ];
  let fail = 0;
  for (const [nm, text] of positives) {
    const hits = [];
    scanText(nm, text, hits);
    if (hits.length === 0) { console.log('  ✗ 阳性[' + nm + ']未拦'); fail++; }
    else console.log('  ✓ 阳性[' + nm + ']已拦 (' + hits.map(h => h.pattern).join(',') + ')');
  }
  for (const [nm, text] of negatives) {
    const hits = [];
    scanText(nm, text, hits);
    if (hits.length !== 0) { console.log('  ✗ 阴性[' + nm + ']误拦 (' + hits.map(h => h.pattern).join(',') + ')'); fail++; }
    else console.log('  ✓ 阴性[' + nm + ']放行');
  }
  console.log(fail ? '===== 隐私门自测：' + fail + ' 失败 =====' : '===== 隐私门自测：全过 =====');
  return fail;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  let files = [];
  if (argv.length > 0 && !argv[0].startsWith('--')) {
    files = argv;
  } else {
    // name-status：只扫 A/M（新增/修改）——D（删除，如 untrack 清理）跳过：
    // 删除面是移除隐私的正当动作，扫其本地残余会挡住清理本身。
    try {
      files = execSync('git diff --cached --name-status', { encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean)
        .filter(s => s.startsWith('A\t') || s.startsWith('M\t'))
        .map(s => s.slice(2).trim());
    } catch { files = []; }
  }
  if (files.length === 0) { console.log('[privacy-gate] 暂存区空——无可扫描'); return 0; }
  const hits = [];
  for (const f of files) {
    if (SKIP_GLOBS.some(re => re.test(f)) || f.endsWith('privacy-gate.mjs')) continue; // 自跳：本文件的模式样例/文档即命中源
    let text = '';
    try { text = execSync('git show :' + f, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { try { text = readFileSync(f, 'utf8'); } catch { continue; } }
    scanText(f, text, hits);
  }
  if (hits.length > 0) {
    console.error('[privacy-gate] 隐私命中（拒）：');
    for (const h of hits) console.error('  ✗ ' + h.file + ' — ' + h.desc + ' [' + h.pattern + ']');
    return 2;
  }
  console.log('[privacy-gate] 通过（' + files.length + ' 文件零命中）');
  return 0;
}
const code = main();
process.exit(typeof code === 'number' ? code : 0);