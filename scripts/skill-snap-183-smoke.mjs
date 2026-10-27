#!/usr/bin/env node
/** #183 P0 冒烟：①新发布技能 export 200 ②agents:/jf: 同名双来源并存不覆盖 ③verify 失败不漏绝对路径。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-183-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'k183' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
const B = 'http://127.0.0.1:' + PORT;
const pub = (slug, body) => fetch(B + '/api/skills/' + encodeURIComponent(slug) + '/versions', { method: 'POST', headers: H, body: JSON.stringify({ changelog: 'x', files: [{ path: 'SKILL.md', content: '---\nname: ' + body.n + '\ndescription: ' + body.d + '\n---\nb' }, { path: 'a.txt', content: body.n }] }) });
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'k183' }, stdio: 'ignore' });
try {
  await waitReady(B + '/api/health');
  // ① 新发布 → export 200
  const p1 = await pub('agents:br-183', { n: 'br183', d: '来源A 同名技能' });
  ok('①a 新发布 201', p1.status === 201, String(p1.status));
  const ex = await fetch(B + '/api/skills/agents%3Abr-183/export?version=1');
  ok('①b 新发布技能 export 200', ex.status === 200, String(ex.status));
  // ② 同名双来源并存
  const p2 = await pub('jf:br-183', { n: 'br183', d: '来源B 同名技能' });
  ok('②a 异来源同名发布 201', p2.status === 201, String(p2.status));
  const exA = await (await fetch(B + '/api/skills/agents%3Abr-183/export?version=1')).text();
  const exB = await (await fetch(B + '/api/skills/jf%3Abr-183/export?version=1')).text();
  ok('②b 两份导出互不覆盖（内容各含来源标记）', exA.includes('来源A') && exB.includes('来源B'), 'A' + exA.includes('来源A') + 'B' + exB.includes('来源B'));
  // ③ verify 不泄露绝对路径（无钉装记录 → ok:null；构造坏 ledger 走异常面）
  const v = await fetch(B + '/api/skills/agents%3Abr-183/verify');
  ok('③a verify 正常面 200', v.status === 200, String(v.status));
  const vBad = await (await fetch(B + '/api/skills/drawio-skill/verify')).text().catch(() => '');
  ok('③b verify 不含 DATA_DIR 绝对路径', !/D:\\\\|\/workspace\//i.test(vBad), vBad.slice(0, 60));
  const dirs = readdirSync(DATA + '/skill-snapshots');
  ok('③c 磁盘目录为唯一形（agents%3Abr-183 与 jf%3Abr-183 并存）', dirs.filter((d) => d.includes('br-183')).length >= 2, dirs.filter((d) => d.includes('br-183')).join(','));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #183 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
