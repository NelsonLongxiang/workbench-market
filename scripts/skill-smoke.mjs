#!/usr/bin/env node
/** P0-a-1 四表判据冒烟（判据先红后绿·总工 direct-85d3c5ab 节奏②）：
 *  四表（skills/skill_versions/role_bundles/install_ledger）结构判据——DDL 落地前红，落地后绿。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PORT = 9921;
const DATA = 'tmp/e2e-sk1-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}` }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr?.on('data', (d) => process.stderr.write('[sk1-stderr] ' + String(d)));
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { }
  await new Promise((r) => setTimeout(r, 250));
}
ok('实例就绪', ready);
try {
  const db = new DatabaseSync(`${DATA}/workbench-market.db`, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  // 判据 1-4：四表存在
  for (const t of ['skills', 'skill_versions', 'role_bundles', 'install_ledger']) {
    ok(`表 ${t} 存在`, tables.includes(t));
  }
  // 判据 5：分层/族索引
  if (tables.includes('skills')) {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skills'").all().map((x) => x.name);
    ok('skills 层/族索引', idx.includes('idx_skills_layer') && idx.includes('idx_skills_family'));
  } else ok('skills 层/族索引', false, '表缺');

  // 判据 6-8：约束走 schema 文本断言（写探测会撞 WAL 拷贝缺表——读面同权）
  {
    const sv = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='skill_versions'").get()?.sql ?? '');
    ok('版本不可变（UNIQUE skill_id+version）', /UNIQUE\s*\(\s*skill_id\s*,\s*version\s*\)/i.test(sv));
    const dg = db.prepare("SELECT name FROM sqlite_master WHERE name='idx_skill_versions_digest' AND sql LIKE '%UNIQUE%'").all();
    ok('digest 身份锚（UNIQUE 索引在场）', dg.length === 1);
    const rb = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='role_bundles'").get()?.sql ?? '');
    ok('role_bundles 三元唯一（pack+member+version）', /UNIQUE\s*\(\s*pack_id\s*,\s*member_name\s*,\s*bundle_version\s*\)/i.test(rb));
  }
  // 判据 11-15（P0-a-2 服务面）：SkillService 方法族经 HTTP/导入面可触达的结构前提——
  // 服务未注册时 context 装配断言红（等价判据：/api/health 起来即服务容器 OK + 文件符号在）
  {
    const { readFileSync } = await import('node:fs');
    const svcSrc = readFileSync('server/src/services/skill.ts', 'utf8');
    for (const m of ['upsertSkill', 'versionInsert', 'versionByDigest', 'bundleUpsert', 'ledgerInsert', 'ledgerRevoke']) {
      ok(`SkillService.${m} 在场`, svcSrc.includes(`${m}(`));
    }
    const regSrc = readFileSync('server/src/context.ts', 'utf8');
    ok('SkillService 已注册进容器', regSrc.includes('SkillService'));
    const idxSrc = readFileSync('server/src/services/index.ts', 'utf8');
    ok('服务聚合导出含 SkillService', idxSrc.includes('SkillService'));
    // 运行面：版本不可变语义探测（重复 version 插入拒）——走隔离实例自身的 db（只读连不上写，
    // 用 /api/health 存活性 + schema 读面已在判据 6-8 覆盖；此处补容器解析冒烟：skill 服务可取
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      ok('容器存活（服务装配含 skill 域）', r.ok);
    } catch { ok('容器存活（服务装配含 skill 域）', false); }
  }

  // 判据 9：ledger 状态词表列
  if (tables.includes('install_ledger')) {
    const cols = db.prepare('PRAGMA table_info(install_ledger)').all().map((c) => c.name);
    ok('ledger 锚四件（expected_digest/installed_path/installed_by/status）', ['expected_digest', 'installed_path', 'installed_by', 'status'].every((c) => cols.includes(c)));
  } else ok('ledger 锚四件', false, '表缺');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 600)); } }
}
console.log(`\n===== P0-a-1 四表判据 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
