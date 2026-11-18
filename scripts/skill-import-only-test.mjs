#!/usr/bin/env node
/**
 * 技能导入器点名导入（#783）的对抗组：隔离 DATA_DIR + 合成夹具源（三个源都有，含跨源同名、同源歧义、jf 遗产和角色束），不碰产库、产快照。
 * 每一步之后比「库的逻辑内容（skills、skill_versions、role_bundles 全部行）+ 快照目录树（路径和内容摘要）+ 固定报告文件」，
 * 证明该不动的确实没动。为什么直接开库：要逐行比对 updated_at、版本行、角色束，接口里拿不全；只读打开，不写。
 *
 *   1 写法不对、不认识、重复、有歧义、通配、缺源前缀：试跑和正式执行都在写入之前失败（退出 2），库、快照、报告不变
 *   2 试跑（--dry-run --only）：same / changed / missing 和预计新增版本数跟库的前态一致；库、快照、报告不变
 *   3 试跑时目标库不在：失败（退出 3），不报 same，也不建库
 *   4 正式执行、同内容：0 个新版本，连元数据也不碰（updated_at 不变）
 *   5 前态变了还拿旧指纹（--expect-state）：不动（退出 4）
 *   6 正式执行：只动点名的；跨源同名的另一个、别的技能、角色束、固定报告都不变
 *   7 中途失败（第二个快照位置被占）：整体回滚，第一个刚放的快照也删掉，库不变
 *   7b 事务里失败（第一个已经写进库、第二个写库时撞唯一索引）：整个事务回滚，第一个的元数据和版本行都不留，它的快照也删掉
 *   8 jf 遗产点名：已登记的不再动
 *   9 #810 跨源同名的首版：dsh:twin 先导入之后，--only agents:twin 照样能导入，各落各的 slug 目录、摘要各自对得上
 *
 *   node scripts/skill-import-only-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = join(ROOT, 'tmp', `skimp-only-${process.pid}`);
const DATA = join(BASE, 'data'), EMPTY = join(BASE, 'empty-data');
const SRC_A = join(BASE, 'src-a'), SRC_B = join(BASE, 'src-b'), SRC_C = join(BASE, 'src-c');
const REPORT = join(ROOT, 'tmp/skill-import-report.json');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };

rmSync(BASE, { recursive: true, force: true });
const skill = (root, dir, name, body) => { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, 'SKILL.md'), name ? `---\nname: ${name}\ndescription: synthetic ${name}\n---\n${body}\n` : `# ${dir}\n${body}\n`); };
skill(SRC_A, 'shared-x', 'shared-x', 'agents shared v1');
skill(SRC_A, 'only-a', 'only-a', 'only-a v1');
skill(SRC_C, 'shared-x', 'shared-x', 'dsh shared v1');
skill(SRC_C, 'only-c', 'only-c', 'only-c v1');
skill(SRC_C, 'dup1', 'dupe', 'dup one');
skill(SRC_C, 'dup2', 'dupe', 'dup two');
const JF = join(SRC_B, '.agents', 'skills');
skill(JF, 'jf-one', 'jf-one', 'jf named');
skill(JF, 'jf-legacy', null, 'legacy without frontmatter');
writeFileSync(join(SRC_B, '.agents', 'role-synth-1.json'), JSON.stringify({ role: { pack_id: 'synth-pack', member_name: 'synth' }, bundle_version: 1, roster_anchor: { manifest_sha256: 'a'.repeat(64) }, prompt_stack: { soul: 'synthetic' } }));
mkdirSync(DATA, { recursive: true }); mkdirSync(EMPTY, { recursive: true });

const run = (extra, dataDir = DATA) => {
  const r = spawnSync(process.execPath, ['scripts/skill-import.mjs', '--target-mode', 'isolated', '--isolated-root', BASE, ...extra], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, SKILL_SRC_A: SRC_A, SKILL_SRC_B: SRC_B, SKILL_SRC_C: SRC_C }, encoding: 'utf8', timeout: 90000,
  });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 不是 JSON */ }
  let err = null; try { err = JSON.parse(r.stderr.trim().split('\n').pop()); } catch { /* 不是 JSON */ }
  return { status: r.status, out, err, raw: `${r.stdout}\n${r.stderr}`.slice(-400) };
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** 库的逻辑内容（只读打开）+ 快照目录树 + 固定报告 */
function snapshotOfWorld() {
  const db = new DatabaseSync(join(DATA, 'workbench-market.db'), { readOnly: true });
  const rows = {};
  for (const t of ['skills', 'skill_versions', 'role_bundles']) rows[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
  db.close();
  const tree = [];
  const snap = join(DATA, 'skill-snapshots');
  (function walk(d) { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { tree.push(`${relative(snap, p)}/`); walk(p); } else tree.push(`${relative(snap, p)}:${statSync(p).isFile() ? sha(readFileSync(p)) : 'x'}`); } })(snap);
  return { rows, tree: tree.sort(), report: existsSync(REPORT) ? sha(readFileSync(REPORT)) : null };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idOf = (rows, slug) => rows.skills.find((r) => r.slug === slug)?.id;
/** 和导入器同一种目录摘要（#810：证明快照目录的内容就是那一行记的） */
const dirDigest = (dir) => {
  if (!existsSync(dir)) return null;
  const files = [];
  (function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && (e.name === '__pycache__' || e.name === '.git')) continue; if (!e.isDirectory() && /\.pyc$/i.test(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(dir);
  files.sort();
  const h = createHash('sha256');
  for (const p of files) { h.update(relative(dir, p).split('\\').join('/')); h.update('\0'); h.update(sha(readFileSync(p))); h.update('\0'); }
  return h.digest('hex');
};
const diffKeys = (a, b) => ['rows', 'tree', 'report'].filter((k) => !same(a[k], b[k]));

try {
  console.log('0（准备）全源导入一次做基线');
  const base = run([]);
  ok('0 全源导入成功', base.status === 0, base.raw);
  let world = snapshotOfWorld();
  const slugs = world.rows.skills.map((r) => r.slug).sort();
  ok('0 基线里两个源都有 shared-x、jf 遗产和角色束都在', slugs.includes('agents:shared-x') && slugs.includes('dsh:shared-x') && slugs.includes('jf:jf-legacy') && world.rows.role_bundles.length === 1, slugs);
  const pathOf = (rows, slug) => rows.skill_versions.find((v) => v.skill_id === idOf(rows, slug))?.snapshot_path;
  const digestOf = (rows, slug) => rows.skill_versions.find((v) => v.skill_id === idOf(rows, slug))?.tree_digest;
  ok('0（#810）跨源同名的 shared-x 各有各的快照目录（相对形、按全 slug），摘要各自对得上', pathOf(world.rows, 'agents:shared-x') === 'skill-snapshots/agents%3Ashared-x/v1' && pathOf(world.rows, 'dsh:shared-x') === 'skill-snapshots/dsh%3Ashared-x/v1'
    && dirDigest(join(DATA, pathOf(world.rows, 'agents:shared-x'))) === digestOf(world.rows, 'agents:shared-x') && dirDigest(join(DATA, pathOf(world.rows, 'dsh:shared-x'))) === digestOf(world.rows, 'dsh:shared-x'), world.rows.skill_versions.map((v) => v.snapshot_path));

  console.log('1 写法、不认识、重复、歧义：写入之前失败');
  for (const [only, why] of [['agents:*', 'only_invalid'], ['agents:', 'only_invalid'], ['shared-x', 'only_invalid'], ['agents:shared', 'only_unresolved'], ['agents:nope', 'only_unresolved'], ['dsh:dupe', 'only_unresolved'], ['agents:only-a,agents:only-a', 'only_invalid'], ['agents:only-a,agents:nope', 'only_unresolved'], [' ', 'only_empty']]) {
    for (const dry of [true, false]) {
      const r = run(['--only', only, ...(dry ? ['--dry-run'] : [])]);
      const after = snapshotOfWorld();
      ok(`1 ${dry ? '试跑' : '正式'} --only ${JSON.stringify(only)}：退出 2（${why}），什么都没动`, r.status === 2 && r.err?.error === why && diffKeys(world, after).length === 0, { status: r.status, err: r.err, diff: diffKeys(world, after) });
    }
  }
  const amb = run(['--only', 'dsh:dupe', '--dry-run']);
  ok('1 歧义要说出是哪几个目录', amb.err?.errors?.[0]?.why === 'ambiguous' && same(amb.err.errors[0].dirs.sort(), ['dup1', 'dup2']), amb.err);

  console.log('2 试跑：只读比对');
  appendFileSync(join(SRC_A, 'only-a', 'SKILL.md'), 'only-a v2\n');
  skill(SRC_A, 'new-a', 'new-a', 'brand new');
  const dry = run(['--dry-run', '--only', 'agents:only-a,agents:shared-x,agents:new-a,jf:jf-legacy']);
  const st = Object.fromEntries((dry.out?.plans ?? []).map((p) => [p.slug, p]));
  ok('2 试跑成功、带前态指纹', dry.status === 0 && /^[0-9a-f]{64}$/.test(dry.out?.state ?? ''), dry.raw);
  ok('2 改过的 changed、没改的 same、新的 missing、jf 遗产 same；预计新增 2 个版本', st['agents:only-a']?.status === 'changed' && st['agents:shared-x']?.status === 'same' && st['agents:new-a']?.status === 'missing' && st['jf:jf-legacy']?.status === 'same' && dry.out?.newVersions === 2, dry.out);
  const afterDry = snapshotOfWorld();
  ok('2 试跑之后：库、快照、固定报告都没动', diffKeys(world, afterDry).length === 0, diffKeys(world, afterDry));

  console.log('3 试跑时目标库不在：失败关闭');
  const missing = run(['--dry-run', '--only', 'agents:shared-x'], EMPTY);
  ok('3 退出 3、不报 same、也没建库', missing.status === 3 && missing.err?.error === 'target_db_missing' && !/"same"/.test(missing.raw) && !existsSync(join(EMPTY, 'workbench-market.db')), missing.raw);

  console.log('4 正式执行、同内容：一点不碰');
  const noop = run(['--only', 'agents:shared-x']);
  const afterNoop = snapshotOfWorld();
  ok('4 0 个新版本，库（含 updated_at）、快照、报告都不变', noop.status === 0 && noop.out?.newVersions === 0 && diffKeys(world, afterNoop).length === 0, { out: noop.out, diff: diffKeys(world, afterNoop) });

  console.log('5 前态变了还拿旧指纹：不动');
  const stale = dry.out.state;
  appendFileSync(join(SRC_A, 'only-a', 'SKILL.md'), 'only-a v3\n');
  const refused = run(['--only', 'agents:only-a,agents:new-a', '--expect-state', stale]);
  const afterRefused = snapshotOfWorld();
  ok('5 退出 4（state_changed），什么都没动', refused.status === 4 && refused.err?.error === 'state_changed' && diffKeys(world, afterRefused).length === 0, { status: refused.status, err: refused.err?.error, diff: diffKeys(world, afterRefused) });

  console.log('6 正式执行：只动点名的');
  const fresh = run(['--dry-run', '--only', 'agents:only-a,agents:new-a']);
  const done = run(['--only', 'agents:only-a,agents:new-a', '--expect-state', fresh.out.state]);
  const afterDone = snapshotOfWorld();
  ok('6 成功、新增 2 个版本，指纹对得上', done.status === 0 && done.out?.newVersions === 2 && done.out?.state === fresh.out.state, done.raw);
  const touched = new Set(['agents:only-a', 'agents:new-a']);
  const untouchedSkills = (rows) => rows.skills.filter((r) => !touched.has(r.slug));
  const untouchedVersions = (rows) => rows.skill_versions.filter((v) => ![idOf(rows, 'agents:only-a'), idOf(rows, 'agents:new-a')].includes(v.skill_id));
  ok('6 别的技能（含跨源同名的 dsh:shared-x）一行不变，它们的版本一行不变', same(untouchedSkills(world.rows), untouchedSkills(afterDone.rows)) && same(untouchedVersions(world.rows), untouchedVersions(afterDone.rows)));
  ok('6 角色束、固定报告不变', same(world.rows.role_bundles, afterDone.rows.role_bundles) && world.report === afterDone.report);
  const vOnlyA = afterDone.rows.skill_versions.filter((v) => v.skill_id === idOf(afterDone.rows, 'agents:only-a')).map((v) => v.version);
  const vNewA = afterDone.rows.skill_versions.filter((v) => v.skill_id === idOf(afterDone.rows, 'agents:new-a')).map((v) => v.version);
  ok('6 only-a 多了 v2、new-a 有了 v1，快照只多了这两个目录', same(vOnlyA, [1, 2]) && same(vNewA, [1]) && same(afterDone.tree.filter((p) => !world.tree.includes(p)).filter((p) => p.endsWith('/')).sort(), ['agents%3Anew-a/', 'agents%3Anew-a/v1/', 'agents%3Aonly-a/v2/']), { vOnlyA, vNewA, added: afterDone.tree.filter((p) => !world.tree.includes(p)) });
  world = afterDone;
  const again = run(['--only', 'agents:only-a,agents:new-a']);
  ok('6 再跑一次：同内容，0 个新版本，什么都没动', again.status === 0 && again.out?.newVersions === 0 && diffKeys(world, snapshotOfWorld()).length === 0, again.out);

  console.log('7 中途失败：整体回滚');
  appendFileSync(join(SRC_C, 'only-c', 'SKILL.md'), 'only-c v2\n');
  skill(SRC_C, 'fail-c', 'fail-c', 'will fail');
  writeFileSync(join(DATA, 'skill-snapshots', 'dsh%3Afail-c'), 'a file where the snapshot directory should go');
  world = snapshotOfWorld();
  const broken = run(['--only', 'dsh:only-c,dsh:fail-c']);
  const afterBroken = snapshotOfWorld();
  ok('7 退出 5（import_failed_rolled_back）', broken.status === 5 && broken.err?.error === 'import_failed_rolled_back', broken.raw);
  ok('7 库不变、第一个刚放的快照（only-c/v2）也删掉了、没有暂存目录留下', diffKeys(world, afterBroken).length === 0 && !existsSync(join(DATA, 'skill-snapshots', 'dsh%3Aonly-c', 'v2')) && !readdirSync(join(DATA, 'skill-snapshots')).some((n) => n.startsWith('.staging-')), diffKeys(world, afterBroken));
  rmSync(join(DATA, 'skill-snapshots', 'dsh%3Afail-c'), { force: true });
  world = snapshotOfWorld();

  console.log('7b 事务里失败：整体回滚');
  // only-a 现在有 v1、v2；把源改回 v1 的内容：和最新的 v2 不同（changed），插 v3 时撞 (skill_id, tree_digest) 唯一索引——写库阶段才失败。
  // new-a 排在前面、正常改了：它的 upsert 和版本行在同一个事务里先写进去，失败时要一起退回
  writeFileSync(join(SRC_A, 'only-a', 'SKILL.md'), '---\nname: only-a\ndescription: synthetic only-a\n---\nonly-a v1\n');
  appendFileSync(join(SRC_A, 'new-a', 'SKILL.md'), 'new-a v2\n');
  const midDry = run(['--dry-run', '--only', 'agents:new-a,agents:only-a']);
  ok('7b（准备）试跑：两个都是 changed，第一个能写、第二个写库时会撞唯一索引', midDry.status === 0 && (midDry.out?.plans ?? []).every((p) => p.status === 'changed'), midDry.out);
  const mid = run(['--only', 'agents:new-a,agents:only-a']);
  const afterMid = snapshotOfWorld();
  ok('7b 退出 5（import_failed_rolled_back），说的是写库时的错', mid.status === 5 && mid.err?.error === 'import_failed_rolled_back' && /UNIQUE|constraint/i.test(mid.err?.message ?? ''), mid.raw);
  ok('7b 库一行不变（new-a 已经写进事务的 updated_at 和 v2 都退回了），new-a/v2、only-a/v3 两个快照都删掉了', diffKeys(world, afterMid).length === 0 && !existsSync(join(DATA, 'skill-snapshots', 'agents%3Anew-a', 'v2')) && !existsSync(join(DATA, 'skill-snapshots', 'agents%3Aonly-a', 'v3')), { diff: diffKeys(world, afterMid), rows: same(world.rows, afterMid.rows) });
  // 收尾：源恢复成库里最新的内容，后面的步骤照旧
  writeFileSync(join(SRC_A, 'new-a', 'SKILL.md'), '---\nname: new-a\ndescription: synthetic new-a\n---\nbrand new\n');

  console.log('8 jf 遗产点名');
  const jf = run(['--only', 'jf:jf-legacy,jf:jf-one']);
  ok('8 已登记的不再动：0 个新版本，库不变', jf.status === 0 && jf.out?.newVersions === 0 && diffKeys(world, snapshotOfWorld()).length === 0, jf.out);

  console.log('9 跨源同名的首版（#810）');
  skill(SRC_C, 'twin', 'twin', 'dsh twin');
  writeFileSync(join(SRC_C, 'twin', 'only-in-dsh.txt'), 'c\n');
  const dshTwin = run(['--only', 'dsh:twin']);
  ok('9 先导 dsh:twin：成功、1 个新版本', dshTwin.status === 0 && dshTwin.out?.newVersions === 1, dshTwin.raw);
  skill(SRC_A, 'twin', 'twin', 'agents twin');
  writeFileSync(join(SRC_A, 'twin', 'only-in-agents.txt'), 'a\n');
  const before9 = snapshotOfWorld();
  const agentsTwin = run(['--only', 'agents:twin']);
  const after9 = snapshotOfWorld();
  ok('9 再导 agents:twin 首版：成功（不再撞 snapshot_target_exists）', agentsTwin.status === 0 && agentsTwin.out?.newVersions === 1, agentsTwin.raw);
  ok('9 两个各落各的目录，摘要各自对得上，没有混写', pathOf(after9.rows, 'agents:twin') === 'skill-snapshots/agents%3Atwin/v1' && pathOf(after9.rows, 'dsh:twin') === 'skill-snapshots/dsh%3Atwin/v1'
    && dirDigest(join(DATA, pathOf(after9.rows, 'agents:twin'))) === digestOf(after9.rows, 'agents:twin') && dirDigest(join(DATA, pathOf(after9.rows, 'dsh:twin'))) === digestOf(after9.rows, 'dsh:twin')
    && !existsSync(join(DATA, pathOf(after9.rows, 'agents:twin'), 'only-in-dsh.txt')), after9.rows.skill_versions.map((v) => v.snapshot_path));
  ok('9 dsh:twin 的行和快照一点没动', same(before9.rows.skill_versions.filter((v) => v.skill_id === idOf(before9.rows, 'dsh:twin')), after9.rows.skill_versions.filter((v) => v.skill_id === idOf(after9.rows, 'dsh:twin'))) && same(before9.tree.filter((p) => p.startsWith('dsh%3Atwin')), after9.tree.filter((p) => p.startsWith('dsh%3Atwin'))));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(BASE, { recursive: true, force: true });
}
console.log(`skill-import-only-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
