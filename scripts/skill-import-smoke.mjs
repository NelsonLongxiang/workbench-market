#!/usr/bin/env node
/** skill-import 冒烟（源 C 起测·隔离 DATA_DIR+夹具源——不碰产库/产快照）：
 *  ① 源 C 导入：dsh:* 行 + 层2 开发运维层 + 快照落隔离区 + digest 锚
 *  ② 幂等：同 digest 重跑不升版（versions 计数不变）
 *  ③ 漂移：改夹具文件重跑 → N+1 新版，旧版不可变（v1 行原样）
 *  ④ 无 frontmatter：跳过并进报告（方案灰度容错）
 *  ⑤ 源隔离：SKILL_SRC_A/B 指空目录 → 0 导入；产快照目录无夹具名（DATA_DIR 对齐证）
 *  ⑥ 导入试跑报技能自己写的版本号（sourceVersion）：顶层 version、metadata 下的 version 都认，没写是空串，不进身份
 *  ⑦ 本仓 skills/ 每个技能导入试跑都报得出版本号
 *  ⑧ #810 跨源同名：agents:x 和 dsh:x 各落各的 slug 目录，snapshot_path 存相对形，每个目录的摘要对得上自己那一行的 tree_digest
 *  ⑨ #810 skill-upload-one：按 agents:<名> 落目录，不删别的源同名技能的快照；目标已有东西就退出 5、不写库 */
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'tmp/e2e-skimp-data');
const SRC_A = join(ROOT, 'tmp/e2e-skimp-srca');
const SRC_B = join(ROOT, 'tmp/e2e-skimp-srcb');
const SRC_C = join(ROOT, 'tmp/e2e-skimp-srcc');
const REPORT = join(ROOT, 'tmp/skill-import-report.json');
const PROD_SNAP = join(ROOT, 'tmp/e2e-skimp-unrelated-snapshots');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

for (const d of [DATA, SRC_A, SRC_B, join(SRC_C, 'zz-imp-alpha/references'), SRC_C]) rmSync(d, { recursive: true, force: true });
for (const d of [DATA, SRC_A, SRC_B, join(SRC_C, 'zz-imp-alpha/references'), join(SRC_C, 'zz-imp-beta'), SRC_C]) mkdirSync(d, { recursive: true });

writeFileSync(join(SRC_C, 'zz-imp-alpha/SKILL.md'), '---\nname: zz-imp-alpha\ndescription: smoke fixture alpha\n---\n# alpha\nbody v1\n');
writeFileSync(join(SRC_C, 'zz-imp-alpha/references/note.md'), '# note v1\n');
writeFileSync(join(SRC_C, 'zz-imp-beta/SKILL.md'), '# no frontmatter here\n');

const runImporter = () => spawnSync(process.execPath, ['scripts/skill-import.mjs','--target-mode','isolated','--isolated-root',join(ROOT,'tmp')], {
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
ok('① snapshot_path 存相对形、按全 slug', vs1[0]?.snapshot_path === 'skill-snapshots/dsh%3Azz-imp-alpha/v1', vs1[0]?.snapshot_path);
ok('① 快照落隔离区（SKILL.md+references/note.md）', existsSync(join(DATA, 'skill-snapshots/dsh%3Azz-imp-alpha/v1/SKILL.md')) && existsSync(join(DATA, 'skill-snapshots/dsh%3Azz-imp-alpha/v1/references/note.md')));
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
ok('③ v1 不可变（digest/快照原样）', vs3[0].tree_digest === vs1[0].tree_digest && existsSync(join(DATA, 'skill-snapshots/dsh%3Azz-imp-alpha/v1/SKILL.md')));
ok('③ v2 快照在隔离区', existsSync(join(DATA, 'skill-snapshots/dsh%3Azz-imp-alpha/v2/SKILL.md')));

db.close();

// ⑥ 导入试跑：版本号写在顶层、写在 metadata 下、没写，三种都要报对
const SRC_V = join(ROOT, 'tmp/e2e-skimp-srcv');
rmSync(SRC_V, { recursive: true, force: true });
for (const d of ['zz-ver-top', 'zz-ver-meta', 'zz-ver-none', 'zz-ver-both']) mkdirSync(join(SRC_V, d), { recursive: true });
writeFileSync(join(SRC_V, 'zz-ver-top/SKILL.md'), '---\nname: zz-ver-top\nversion: 1.2.3\ndescription: top-level version\n---\n# top\n');
writeFileSync(join(SRC_V, 'zz-ver-meta/SKILL.md'), '---\nname: zz-ver-meta\ndescription: metadata version\nmetadata:\n  author: synthetic\n  version: "0.4.0"\n---\n# meta\n');
writeFileSync(join(SRC_V, 'zz-ver-none/SKILL.md'), '---\nname: zz-ver-none\ndescription: no version\n---\n# none\n');
writeFileSync(join(SRC_V, 'zz-ver-both/SKILL.md'), '---\nname: zz-ver-both\nversion: 9.9.9\nmetadata:\n  version: 2.0.0\ndescription: both\n---\n# both\n');
const dryRun = (root, srcC) => {
  const r = spawnSync(process.execPath, ['scripts/skill-import.mjs', '--dry-run', '--target-mode', 'isolated', '--isolated-root', root], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, SKILL_SRC_A: SRC_A, SKILL_SRC_B: SRC_B, SKILL_SRC_C: srcC }, encoding: 'utf8', timeout: 60000,
  });
  try { return { status: r.status, out: JSON.parse(r.stdout) }; } catch { return { status: r.status, out: null, raw: (r.stdout || '') + (r.stderr || '') }; }
};
const d6 = dryRun(join(ROOT, 'tmp'), SRC_V);
ok('⑥ 导入试跑退出码 0、输出是 JSON', d6.status === 0 && !!d6.out, String(d6.raw ?? '').slice(0, 200));
const v6 = Object.fromEntries((d6.out?.c ?? []).map((r) => [r.name, r]));
ok('⑥ 顶层 version 报出来', v6['zz-ver-top']?.sourceVersion === '1.2.3', JSON.stringify(v6['zz-ver-top']));
ok('⑥ metadata 下的 version 报出来（去掉引号）', v6['zz-ver-meta']?.sourceVersion === '0.4.0', JSON.stringify(v6['zz-ver-meta']));
ok('⑥ 两处都写时取 metadata 下的', v6['zz-ver-both']?.sourceVersion === '2.0.0', JSON.stringify(v6['zz-ver-both']));
ok('⑥ 没写版本号是空串', v6['zz-ver-none']?.sourceVersion === '', JSON.stringify(v6['zz-ver-none']));
ok('⑥ 外源 version 不进身份（行里没有 version 字段）', Object.values(v6).length === 4 && Object.values(v6).every((r) => !('version' in r)));

// ⑦ 本仓 skills/：每个技能都报得出版本号，和 SKILL.md 里写的一致
const repoSkills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(ROOT, 'skills', d.name, 'SKILL.md'))).map((d) => d.name);
const d7 = dryRun(ROOT, join(ROOT, 'skills'));
const v7 = Object.fromEntries((d7.out?.c ?? []).map((r) => [r.dir, r]));
const declared = (dir) => { const t = readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8'); const m = /^(?:\s+)?version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(t.slice(0, t.indexOf('\n---', 3))); return m ? m[1].trim() : null; };
ok('⑦ 本仓技能导入试跑退出码 0', d7.status === 0 && !!d7.out, String(d7.raw ?? '').slice(0, 200));
ok('⑦ 本仓技能至少 4 个、全部扫到', repoSkills.length >= 4 && repoSkills.every((d) => v7[d]?.name), JSON.stringify(repoSkills));
for (const d of repoSkills) ok(`⑦ ${d} 报出版本号 ${declared(d)}`, !!declared(d) && v7[d]?.sourceVersion === declared(d), JSON.stringify(v7[d]?.sourceVersion));
rmSync(SRC_V, { recursive: true, force: true });

// ⑧ 跨源同名（#810）：A、C 各放一个 twin，内容不同，各带一个只有自己才有的文件
/** 和导入器同一种目录摘要（相对路径 + 每个文件的 sha256，剔除 __pycache__/.git/*.pyc） */
const dirDigest = (dir) => {
  const files = [];
  (function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && (e.name === '__pycache__' || e.name === '.git')) continue; if (!e.isDirectory() && /\.pyc$/i.test(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(dir);
  files.sort();
  const h = createHash('sha256');
  for (const p of files) { h.update(relative(dir, p).split('\\').join('/')); h.update('\0'); h.update(createHash('sha256').update(readFileSync(p)).digest('hex')); h.update('\0'); }
  return h.digest('hex');
};
const TW = join(ROOT, 'tmp/e2e-skimp-twin');
const TW_DATA = join(TW, 'data'), TW_A = join(TW, 'a'), TW_B = join(TW, 'b'), TW_C = join(TW, 'c'), TW_ONE = join(TW, 'one');
rmSync(TW, { recursive: true, force: true });
for (const d of [TW_DATA, TW_B, join(TW_A, 'twin'), join(TW_C, 'twin'), TW_ONE]) mkdirSync(d, { recursive: true });
writeFileSync(join(TW_A, 'twin/SKILL.md'), '---\nname: twin\ndescription: agents twin\n---\nagents twin\n');
writeFileSync(join(TW_A, 'twin/only-in-agents.txt'), 'a\n');
writeFileSync(join(TW_C, 'twin/SKILL.md'), '---\nname: twin\ndescription: dsh twin\n---\ndsh twin\n');
writeFileSync(join(TW_C, 'twin/only-in-dsh.txt'), 'c\n');
const r8 = spawnSync(process.execPath, ['scripts/skill-import.mjs', '--target-mode', 'isolated', '--isolated-root', TW], {
  cwd: ROOT, env: { ...process.env, DATA_DIR: TW_DATA, SKILL_SRC_A: TW_A, SKILL_SRC_B: TW_B, SKILL_SRC_C: TW_C }, encoding: 'utf8', timeout: 60000,
});
ok('⑧ 全源导入退出码 0', r8.status === 0, `stderr=${(r8.stderr || '').slice(0, 300)}`);
const twinRows = () => { const d = new DatabaseSync(join(TW_DATA, 'workbench-market.db'), { readOnly: true }); const rows = d.prepare("SELECT s.slug, v.version, v.tree_digest, v.file_count, v.snapshot_path FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.slug IN ('agents:twin','dsh:twin') ORDER BY s.slug, v.version").all(); d.close(); return rows; };
const t8 = twinRows();
const a8 = t8.find((r) => r.slug === 'agents:twin'), c8 = t8.find((r) => r.slug === 'dsh:twin');
ok('⑧ 两行版本各有各的目录（agents%3Atwin、dsh%3Atwin，相对形）', a8?.snapshot_path === 'skill-snapshots/agents%3Atwin/v1' && c8?.snapshot_path === 'skill-snapshots/dsh%3Atwin/v1', JSON.stringify(t8));
const a8dir = join(TW_DATA, a8?.snapshot_path ?? 'x'), c8dir = join(TW_DATA, c8?.snapshot_path ?? 'x');
ok('⑧ 每个目录的摘要对得上自己那一行的 tree_digest，文件数也对', existsSync(a8dir) && existsSync(c8dir) && dirDigest(a8dir) === a8.tree_digest && dirDigest(c8dir) === c8.tree_digest && a8.file_count === 2 && c8.file_count === 2);
ok('⑧ 没有混写：agents 的目录里没有 dsh 的文件，反之亦然；按 name 的旧目录没再建', !existsSync(join(a8dir, 'only-in-dsh.txt')) && !existsSync(join(c8dir, 'only-in-agents.txt')) && !existsSync(join(TW_DATA, 'skill-snapshots/twin')));

// ⑨ skill-upload-one（#810）：同名的 agents:twin 上新版，dsh:twin 的快照一个字节不动
writeFileSync(join(TW_ONE, 'SKILL.md'), '---\nname: twin\ndescription: upload one\n---\nupload-one twin v2\n');
const c8before = dirDigest(c8dir);
const one = () => spawnSync(process.execPath, ['scripts/skill-upload-one.mjs', '--target-mode', 'isolated', '--isolated-root', TW], {
  cwd: ROOT, env: { ...process.env, DATA_DIR: TW_DATA, SKILL_SRC: TW_ONE, SKILL_NAME: 'twin' }, encoding: 'utf8', timeout: 60000,
});
const r9 = one();
const t9 = twinRows();
const a9 = t9.filter((r) => r.slug === 'agents:twin');
ok('⑨ 上架成功，agents:twin 多了 v2，落在 agents%3Atwin/v2、相对形', r9.status === 0 && a9.length === 2 && a9[1].snapshot_path === 'skill-snapshots/agents%3Atwin/v2' && dirDigest(join(TW_DATA, a9[1].snapshot_path)) === a9[1].tree_digest, `${r9.status} ${(r9.stderr || '').slice(0, 300)} ${JSON.stringify(a9)}`);
ok('⑨ dsh:twin 的快照和版本行都没动', dirDigest(c8dir) === c8before && JSON.stringify(t9.filter((r) => r.slug === 'dsh:twin')) === JSON.stringify(t8.filter((r) => r.slug === 'dsh:twin')));
// 目标位置已经有东西（比如上次中断留下的）：停下、不删、不写库
appendFileSync(join(TW_ONE, 'SKILL.md'), 'v3\n');
mkdirSync(join(TW_DATA, 'skill-snapshots/agents%3Atwin/v3'), { recursive: true });
writeFileSync(join(TW_DATA, 'skill-snapshots/agents%3Atwin/v3/keep.txt'), 'leftover\n');
const r9b = one();
ok('⑨ 目标已存在：退出 5，留在那里的东西不删，库里不多版本行', r9b.status === 5 && existsSync(join(TW_DATA, 'skill-snapshots/agents%3Atwin/v3/keep.txt')) && twinRows().filter((r) => r.slug === 'agents:twin').length === 2, `${r9b.status} ${(r9b.stderr || '').slice(0, 200)}`);
rmSync(TW, { recursive: true, force: true });

console.log(`\n===== skill-import 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
