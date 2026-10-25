#!/usr/bin/env node
/** P0-b 发布面冒烟（判据先红 · direct-3017ec1f 五项断言族）：
 *  人审门 / 口令门 / N+1 快照 / digest 锚 / 同 slug 二发 409 ——发布端点未实现时全红。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = 9941;
const DATA = 'tmp/e2e-p0b-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'p0b-tok' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { } await new Promise((r) => setTimeout(r, 250)); }
ok('实例就绪', ready);

const B = `http://127.0.0.1:${PORT}`;
const call = async (u, m = 'GET', b, h = {}) => {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
};
const AT = { 'X-Admin-Token': 'p0b-tok' };
const DG = (s) => 'sha256-' + createHash('sha256').update(s).digest('hex');

try {
  // 准备：登记一个待发布技能（走导入器同构 upsert——直接用发布面自身首版）
  const slug = 'p0b:probe';
  const files = [{ path: 'SKILL.md', content: '---\nname: p0b-probe\ndescription: probe\n---\nbody' }];

  // ① 人审门：首版发布无 reviewed_by → 拒
  let r = await call(`/api/skills/${encodeURIComponent(slug)}/versions`, 'POST', { files, changelog: '首版' }, AT);
  ok('① 首版人审门（无 reviewed_by 拒 4xx）', r.status === 400 || r.status === 422, `status=${r.status}`);

  // ② 口令门：无口令发布 → 401/403
  r = await call(`/api/skills/${encodeURIComponent(slug)}/versions`, 'POST', { files, changelog: 'x', reviewed_by: 'dev' });
  ok('② 口令门（无口令拒）', r.status === 401 || r.status === 403, `status=${r.status}`);

  // 合法首版（带人审+口令）→ 201 + v1
  r = await call(`/api/skills/${encodeURIComponent(slug)}/versions`, 'POST', { files, changelog: '首版', reviewed_by: 'dev-p0b' }, AT);
  ok('首版发布 201 → v1', r.status === 201 && r.body?.version === 1, JSON.stringify(r.body).slice(0, 120));

  // ③ N+1 快照：再发一版 → v2，snapshot_path 指向 v2 目录
  files.push({ path: 'extra.md', content: 'v2 增量' });
  r = await call(`/api/skills/${encodeURIComponent(slug)}/versions`, 'POST', { files, changelog: '二版', reviewed_by: 'dev-p0b' }, AT);
  ok('③ N+1 递增（v2）', r.status === 201 && r.body?.version === 2, `status=${r.status}`);

  // ④ digest 锚：同内容重复发布 → 409（digest 已存在）
  const sameFiles = [{ path: 'SKILL.md', content: '---\nname: p0b-probe\ndescription: probe\n---\nbody' }];
  r = await call(`/api/skills/${encodeURIComponent('p0b:dup')}/versions`, 'POST', { files: sameFiles, changelog: '与首版同内容', reviewed_by: 'dev-p0b' }, AT);
  ok('④ digest 锚（同内容拒 409）', r.status === 409, `status=${r.status}`);

  // ⑤ 版本不可变：同 slug 同 version 重发路径不存在（N+1 自动），改为同 slug 二发不同内容应 201 v3 而非覆盖——
  //    真正的不可变断言：v1 内容入库后无法被修改（无 UPDATE 面）——用「版本链长度=2 且 v1 changelog 未变」
  const detail = await call(`/api/skills/${encodeURIComponent(slug)}/versions`);
  const vs = detail.body?.versions ?? detail.body ?? [];
  const v1 = Array.isArray(vs) ? vs.find((x) => x.version === 1) : null;
  ok('⑤ 版本链在案（v1 changelog 未被二发覆盖）', v1?.changelog === '首版', JSON.stringify(vs).slice(0, 140));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
}
console.log(`\n===== P0-b 发布面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
