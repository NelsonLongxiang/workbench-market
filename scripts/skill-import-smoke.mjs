#!/usr/bin/env node
/** skill-import 冒烟（源 C 起测·隔离 DATA_DIR+夹具源——不碰产库/产快照）：
 *  ① 源 C 导入：dsh:* 行 + 层2 开发运维层 + 快照落隔离区 + digest 锚
 *  ② 幂等：同 digest 重跑不升版（versions 计数不变）
 *  ③ 漂移：改夹具文件重跑 → N+1 新版，旧版不可变（v1 行原样）
 *  ④ 无 frontmatter：跳过并进报告（方案灰度容错）
 *  ⑤ 源隔离：SKILL_SRC_A/B 指空目录 → 0 导入；产快照目录无夹具名（DATA_DIR 对齐证） */
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'tmp/e2e-skimp-data');
const SRC_A = join(ROOT, 'tmp/e2e-skimp-srca');
const SRC_B = join(ROOT, 'tmp/e2e-skimp-srcb');
const SRC_C = join(ROOT, 'tmp/e2e-skimp-srcc');
const REPORT = join(ROOT, 'tmp/skill-import-report.json');
const PROD_SNAP = join(ROOT, 'server/data/skill-snapshots');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

for (const d of [DATA, SRC_A, SRC_B, join(SRC_C, 'zz-imp-alpha/references'), SRC_C]) rmSync(d, { recursive: true, force: true });
for (const d of [DATA, SRC_A, SRC_B, join(SRC_C, 'zz-imp-alpha/references'), join(SRC_C, 'zz-imp-beta'), SRC_C]) mkdirSync(d, { recursive: true });

writeFileSync(join(SRC_C, 'zz-imp-alpha/SKILL.md'), '---\nname: zz-imp-alpha\ndescription: smoke fixture alpha\n---\n# alpha\nbody v1\n');
writeFileSync(join(SRC_C, 'zz-imp-alpha/references/note.md'), '# note v1\n');
writeFileSync(join(SRC_C, 'zz-imp-beta/SKILL.md'), '# no frontmatter here\n');

const runImporter = () => spawnSync(process.execPath, ['scripts/skill-import.mjs'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: DATA, SKILL_SRC_A: SRC_A, SKILL_SRC_B: SRC_B, SKILL_SRC_C: SRC_C },
  encoding: 'utf8', timeout: 60000,
});

let r1 = runImporter();
ok('① 导入器退出码 0', r1.status === 0, `stderr=${(r1.stderr || '').slice(0, 200)}`);
const db = new DatabaseSync(join(DATA, 'workbench-market.db'));
const sk = db.prepare("SELECT * FROM skills WHERE slug = 'dsh:zz-imp-alpha'").get();
ok('① dsh:zz-imp-alpha 行建立', !!sk);
ok('① 层2 开发运维层', sk?.layer === 2 && sk?.layer_name === '开发运维层', `layer=${sk?.layer}/${sk?.layer_name}`);
ok('① source=dsh-skills', sk?.source === 'dsh-skills');
const vs1 = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version').all(sk?.id);
ok('① v1 建立且 digest 非空', vs1.length === 1 && vs1[0].tree_digest.length === 64, `n=${vs1.length}`);
ok('① 快照落隔离区（SKILL.md+references/note.md）', existsSync(join(DATA, 'skill-snapshots/zz-imp-alpha/v1/SKILL.md')) && existsSync(join(DATA, 'skill-snapshots/zz-imp-alpha/v1/references/note.md')));
const rep1 = JSON.parse((await import('node:fs')).readFileSync(REPORT, 'utf8'));
ok('④ 无 frontmatter 跳过并报告', rep1.c.skipped.includes('zz-imp-beta'), JSON.stringify(rep1.c));
ok('⑤ 源 A/B 零导入（夹具隔离）', rep1.a.imported === 0 && rep1.b.imported === 0);
ok('⑤ 产快照目录无夹具名（DATA_DIR 对齐）', !existsSync(join(PROD_SNAP, 'zz-imp-alpha')));

const r2 = runImporter();
ok('② 幂等重跑退出 0', r2.status === 0);
const vs2 = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version').all(sk.id);
ok('② 同 digest 不升版', vs2.length === 1, `n=${vs2.length}`);

appendFileSync(join(SRC_C, 'zz-imp-alpha/SKILL.md'), 'body v2 line\n');
writeFileSync(join(SRC_C, 'zz-imp-alpha/references/note.md'), '# note v2\n');
const r3 = runImporter();
ok('③ 漂移重跑退出 0', r3.status === 0);
const vs3 = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version').all(sk.id);
ok('③ 漂移 → v2 新版', vs3.length === 2 && vs3[1].version === 2, `n=${vs3.length}`);
ok('③ v1 不可变（digest/快照原样）', vs3[0].tree_digest === vs1[0].tree_digest && existsSync(join(DATA, 'skill-snapshots/zz-imp-alpha/v1/SKILL.md')));
ok('③ v2 快照在隔离区', existsSync(join(DATA, 'skill-snapshots/zz-imp-alpha/v2/SKILL.md')));

db.close();
console.log(`\n===== skill-import 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
