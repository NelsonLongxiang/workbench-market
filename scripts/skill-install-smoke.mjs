#!/usr/bin/env node
/** P1-b 钉装与审计冒烟（判据先红 · 方案 §1 P1-b 四面）：
 *  钉装（ledger 行 expected=digest）/ 装载校验（篡改红）/ 回撤 / role-pack 展开清单 ——端点未实现时红。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9961;
const DATA = 'tmp/e2e-p1b-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'p1b-tok' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { } await new Promise((r) => setTimeout(r, 250)); }
ok('实例就绪', ready);
try {
  const B = `http://127.0.0.1:${PORT}`;
  const call = async (u, m = 'GET', b, h = {}) => {
    const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch { }
    return { status: r.status, body: j };
  };
  const AT = { 'X-Admin-Token': 'p1b-tok' };
  // 种子：发布一个技能 + 装到 DATA 内目标路径
  const files = [{ path: 'SKILL.md', content: '---\nname: p1b-probe\n---\nbody' }];
  let r = await call(`/api/skills/p1b%3Aprobe/versions`, 'POST', { files, changelog: 'v1', reviewed_by: 'dev' }, AT);
  ok('种子 v1', r.status === 201 && r.body.version === 1);
  const snapPath = r.body?.snapshot_path ?? '';

  // ① 钉装：install → ledger 行 expected=digest
  r = await call(`/api/skills/p1b%3Aprobe/install`, 'POST', { installed_path: snapPath, installed_by: 'p1b-smoke' }, AT);
  ok('① 钉装 201（ledger 建行）', r.status === 201 && !!r.body?.expected_digest, JSON.stringify(r.body).slice(0, 120));

  // ② 装载校验（绿）：verify → ok
  r = await call(`/api/skills/p1b%3Aprobe/verify`);
  ok('② 装载校验绿（快照与库 digest 一致）', r.body?.ok === true, JSON.stringify(r.body).slice(0, 140));

  // ③ 装载校验（红）：篡改快照 → verify 红出 diff
  const { writeFileSync, readFileSync } = await import('node:fs');
  const snap = `${snapPath}/SKILL.md`;
  writeFileSync(snap, '---\nname: p1b-probe\n---\ntampered');
  r = await call(`/api/skills/p1b%3Aprobe/verify`);
  ok('③ 篡改后校验红（ok=false + 实测 digest 不同于 expected）', r.body?.ok === false && r.body?.expected !== r.body?.actual, JSON.stringify(r.body).slice(0, 160));
  writeFileSync(snap, files[0].content); // 还原

  // ④ 回撤：revoke → ledger status=revoked
  r = await call(`/api/skills/p1b%3Aprobe/install/1/revoke`, 'POST', {}, AT);
  ok('④ 回撤（status=revoked）', r.status === 200 && r.body?.status === 'revoked', JSON.stringify(r.body).slice(0, 100));

  // ⑤ role-pack 展开清单（自带种子：经服务面插一条测试 bundle）
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${DATA}/workbench-market.db`);
    db.prepare(`INSERT OR REPLACE INTO role_bundles (pack_id, member_name, bundle_version, roster_digest, skill_slugs) VALUES ('p1b-pack', 'probe-member', 1, 'dg-x', '["agents:brand"]')`).run();
    db.close();
  }
  r = await call(`/api/skills/role-packs`);
  const packs = r.body ?? [];
  ok('⑤ role-pack 列表含 bundle（skill_slugs 展开）', Array.isArray(packs) && packs.length >= 1 && Array.isArray(packs[0].skill_slugs), JSON.stringify(packs).slice(0, 140));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
}
console.log(`\n===== P1-b 钉装审计冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
