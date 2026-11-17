#!/usr/bin/env node
/** 技能市场双源导入器（P0-a-3 · 方案 PR#57 §3）：
 *  源 A ~/.agents/skills：SKILL.md frontmatter（name/description/argument-hint/metadata{author,version}）
 *  技能自己写的版本号：metadata 下的 version 和顶层 version 都认（本仓 skills/ 写在顶层），报成 sourceVersion，只用来显示；
 *  市场的版本号仍由导入器按 digest 递增，外源 version 不进身份。
 *  源 B jf-tech：.agents/skills 主 + .agents/role-*.json 角色束收编（遗产只登记不快照）
 *  幂等：by (source,name) 已存在→比树 digest，同 skip / 异报 diff 待发布门（不自动升版）
 *  判据先红：--selftest 跑导入判据族（导入器未实现时红）。
 *
 *  --only <完整 slug,…>（#783）：只处理点名的技能。slug 写全（agents:<名> / dsh:<名> / jf:<名>，jf 无 frontmatter 的遗产用 jf:<目录>），
 *    不认前缀、通配、同名目录推断；不认识、写法不对、重复、有歧义（同一个源里两个目录报同一个名字）的，任何写入之前失败（退出 2）。
 *    · 带 --dry-run：只读打开显式目标库（不加载应用、不建库、不迁移），逐个报 same / changed / missing 和预计新增的版本数，
 *      外加这一批的前态指纹 state；库不在或读不了就失败（退出 3），不报 same。不写库、快照、固定报告。
 *    · 不带 --dry-run：只动点名的技能——同内容的不碰（连元数据也不 upsert），要导的先把快照放好、再在一个事务里写库；
 *      任何一步失败：事务回滚、刚放的快照删掉，库和快照目录回到前态。不处理角色束，不写固定的全源报告（结果打在标准输出）。
 *      带 --expect-state <指纹>：执行前重算前态，和试跑时的不一样就不动（退出 4），不拿过期的试跑结果求过。 */
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { scriptOptions, explicitPath, validatePathParents } from './explicit-data-target.mjs';
// #810：快照目录和服务端发布同一个函数（按全 slug），存进库的 snapshot_path 也是这个相对形
import { skillSnapRel } from '../server/src/skill-snap-path.ts';
const targetOptions = scriptOptions({ selftest: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, only: { type: 'string' }, 'expect-state': { type: 'string' } });
const args = process.argv.slice(2);
const TARGET_DATA = explicitPath(targetOptions['data-dir'] ?? process.env.DATA_DIR, targetOptions);
const SOURCES = ['a','b','c'].map(key => explicitPath(targetOptions['source-'+key] ?? process.env['SKILL_SRC_'+key.toUpperCase()], targetOptions));
for (const path of [TARGET_DATA,...SOURCES]) validatePathParents(path,targetOptions);
process.env.DATA_DIR = TARGET_DATA;
// #94 S0⑦：cwd 相对路径→脚本目录锚定（任意 cwd 运行都落在仓库真位）
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const SELFTEST = args.includes('--selftest');
const DRY = args.includes('--dry-run') || SELFTEST;
const AGENTS_SKILLS = SOURCES[0];
// (relocated) { fileURLToPath as _fu2 } from 'node:url';
const JF_ROOT = SOURCES[1];
const DSH_SKILLS = SOURCES[2];
/** 快照根与 DB 同 DATA_DIR（#94 S4 隔离语义对齐：隔离实例的导入不再落产库快照目录；缺目标必拒，禁止隐式server/data） */
const SNAP_ROOT = join(TARGET_DATA, 'skill-snapshots');

// ---- 工具 ----
/** 目录或指向目录的 junction/符号链接（readdirSync dirent.isDirectory 对链接返 false） */
function isDirLike(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function parseFrontmatter(textRaw) {
  // #drawio 上架（属主批准）：CRLF 归一——Windows 源 frontmatter 以 \r\n 结尾时原解析器整块失配（A=0 根因）
  const text = String(textRaw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const lines = text.slice(4, end).split('\n');
  const out = {}; const stack = [out];
  for (const ln of lines) {
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(ln);
    if (!m) continue;
    const [, sp, k, v] = m; const depth = sp.length / 2;
    while (stack.length > depth + 1) stack.pop();
    const tgt = stack[stack.length - 1];
    if (v === '') { const o = {}; tgt[k] = o; stack.push(o); }
    else tgt[k] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}
/** 技能自己写的版本号：metadata.version 优先，没有就取顶层 version；都没有是空串。只显示，不进身份。 */
function sourceVersionOf(fm) {
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata.version : undefined;
  const v = typeof meta === 'string' && meta !== '' ? meta : fm.version;
  return typeof v === 'string' ? v : '';
}
function treeDigest(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // 上架剔除：__pycache__ 目录与 *.pyc 编译缓存（属主令·不上架）
      if (e.isDirectory() && (e.name === '__pycache__' || e.name === '.git')) continue;
      if (!e.isDirectory() && /\.pyc$/i.test(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  })(dir);
  files.sort();
  const h = createHash('sha256');
  for (const p of files) {
    h.update(relative(dir, p).split('\\').join('/')); h.update('\0');
    h.update(createHash('sha256').update(readFileSync(p)).digest('hex')); h.update('\0');
  }
  return { digest: h.digest('hex'), fileCount: files.length, totalBytes: files.reduce((n, p) => n + statSync(p).size, 0) };
}

// ---- 源 A 导入 ----
function scanAgentsSkills() {
  const rows = [];
  for (const d of readdirSync(AGENTS_SKILLS, { withFileTypes: true })) {
    if (!d.isDirectory() && !isDirLike(join(AGENTS_SKILLS, d.name))) continue; // junction/符号链接目录也算（drawio-skill 实测）
    const sk = join(AGENTS_SKILLS, d.name, 'SKILL.md');
    if (!existsSync(sk)) continue;
    const fm = parseFrontmatter(readFileSync(sk, 'utf8'));
    if (!fm || !fm.name) { rows.push({ dir: d.name, skipped: 'no-frontmatter' }); continue; }
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '', sourceVersion: sourceVersionOf(fm) });
  }
  return rows;
}
// ---- 源 C 扫描（.dsh/skills：DSH 平台技能）----
function scanDshSkills() {
  const rows = [];
  if (!existsSync(DSH_SKILLS)) return rows;
  for (const d of readdirSync(DSH_SKILLS, { withFileTypes: true })) {
    if (d.name === '_templates') continue; // 模板骨架不是技能
    if (!d.isDirectory() && !isDirLike(join(DSH_SKILLS, d.name))) continue; // junction/符号链接目录也算（ponytail 族）
    const sk = join(DSH_SKILLS, d.name, 'SKILL.md');
    if (!existsSync(sk)) continue;
    const fm = parseFrontmatter(readFileSync(sk, 'utf8'));
    if (!fm || !fm.name) { rows.push({ dir: d.name, skipped: 'no-frontmatter' }); continue; }
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '', sourceVersion: sourceVersionOf(fm) });
  }
  return rows;
}
// ---- 源 B 导入（jf）----
function scanJfSkills() {
  const root = join(JF_ROOT, '.agents', 'skills');
  const rows = [];
  if (!existsSync(root)) return rows;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() && !isDirLike(join(root, d.name))) continue; // junction/符号链接目录也算（drawio-skill 实测）
    const sk = join(root, d.name, 'SKILL.md');
    if (!existsSync(sk)) continue;
    const fm = parseFrontmatter(readFileSync(sk, 'utf8'));
    if (!fm || !fm.name) { rows.push({ dir: d.name, skipped: 'no-frontmatter' }); continue; }
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '', sourceVersion: sourceVersionOf(fm) });
  }
  return rows;
}
function scanJfBundles() {
  const dir = join(JF_ROOT, '.agents');
  const rows = [];
  if (!existsSync(dir)) return rows;
  for (const f of readdirSync(dir)) {
    if (!/^role-.*\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      rows.push({
        packId: j.role?.pack_id ?? 'unknown', memberName: j.role?.member_name ?? f.replace(/^role-|-\d+\.json$/g, ''),
        bundleVersion: j.bundle_version ?? 1, rosterDigest: j.roster_anchor?.manifest_sha256 ?? '',
        promptSoul: String(j.prompt_stack?.soul ?? '').slice(0, 2000), snapshotJson: JSON.stringify(j).slice(0, 60000),
      });
    } catch { rows.push({ file: f, skipped: 'bad-json' }); }
  }
  return rows;
}

// ---- 判据自检（--selftest：导入器契约断言族）----
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
  const A = scanAgentsSkills(); const B = scanJfSkills(); const C = scanDshSkills(); const bundles = scanJfBundles();
  ok('源 A 扫描出技能（>40 严格解析）', A.filter((r) => r.name).length > 40, `解析=${A.filter((r) => r.name).length}/目录=${A.length}`);
  ok('源 A 未解析项有 skip 报告（宽 frontmatter 变体待 P0-b 人审）', A.some((r) => r.skipped));
  ok('源 A frontmatter 字段吸收（name/description）', A.some((r) => r.name && r.description));
  ok('源 A 跳过项有报告', Array.isArray(A));
  ok('源 B 目录扫描在案（frontmatter 变体走 skip 报告，P0-b 登记路径）', B.length >= 5 && Array.isArray(B), `目录=${B.length} 解析=${B.filter((r) => r.name).length}`);
  ok('源 C 扫描出 DSH 平台技能（>20 严格解析）', C.filter((r) => r.name).length > 20, `解析=${C.filter((r) => r.name).length}/目录=${C.length}`);
  ok('源 C _templates 不入列', !C.some((r) => r.dir === '_templates'));
  ok('源 B 角色束收编（apollo/dionysus）', bundles.some((b) => /apollo|dionysus/i.test(b.memberName ?? '')), JSON.stringify(bundles.map((b) => b.memberName)));
  ok('角色束 roster_digest 吸收', bundles.every((b) => !b.packId || b.rosterDigest !== ''));
  ok('treeDigest 确定性（同目录两次一致）', (() => { const a = treeDigest(AGENTS_SKILLS + '/brand'); const b = treeDigest(AGENTS_SKILLS + '/brand'); return a.digest === b.digest && a.fileCount > 0; })());
  const fm = parseFrontmatter(readFileSync(AGENTS_SKILLS + '/brand/SKILL.md', 'utf8'));
  ok('frontmatter 解析（brand：name+metadata.author）', fm?.name === 'brand' && !!fm?.metadata?.author);
  ok('外源 version 不进身份（吸收映射无 version 字段）', !('version' in (A.find((r) => r.name) ?? {})));
  console.log(`\n===== P0-a-3 导入器判据 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}
if (SELFTEST) { await selftest(); process.exit(0); }

// ---- --only：点名导入（#783） ----
const ONLY = targetOptions.only;
const EXPECT_STATE = targetOptions['expect-state'];
const ONLY_SLUG_RE = /^(agents|dsh|jf):([A-Za-z0-9][A-Za-z0-9._@-]{0,127})$/;
const fail = (code, error, detail = {}) => { console.error(JSON.stringify({ ok: false, error, ...detail })); process.exit(code); };
/** 把 --only 解析成要处理的技能；写法、不认识、重复、歧义一律在任何写入之前失败 */
function resolveOnly(raw) {
  if (typeof raw !== 'string' || !raw.trim()) fail(2, 'only_empty');
  const asked = raw.split(',').map((x) => x.trim());
  const errors = [];
  const seen = new Set();
  for (const slug of asked) {
    if (!ONLY_SLUG_RE.test(slug)) errors.push({ slug, why: 'bad_slug' });
    else if (seen.has(slug)) errors.push({ slug, why: 'duplicate' });
    seen.add(slug);
  }
  if (errors.length) fail(2, 'only_invalid', { errors });
  // 各源扫出来的候选：slug → [候选]
  const cand = new Map();
  const add = (slug, c) => { if (!cand.has(slug)) cand.set(slug, []); cand.get(slug).push(c); };
  for (const r of scanAgentsSkills()) if (r.name) add(`agents:${r.name}`, { src: 'A', dir: r.dir, row: r, root: AGENTS_SKILLS });
  for (const r of scanDshSkills()) if (r.name) add(`dsh:${r.name}`, { src: 'C', dir: r.dir, row: r, root: DSH_SKILLS });
  for (const r of scanJfSkills()) add(r.name ? `jf:${r.name}` : `jf:${r.dir}`, { src: 'B', dir: r.dir, row: r, legacy: !r.name, root: join(JF_ROOT, '.agents', 'skills') });
  const picked = [];
  for (const slug of asked) {
    const c = cand.get(slug) ?? [];
    if (c.length === 0) errors.push({ slug, why: 'unknown' });
    else if (c.length > 1) errors.push({ slug, why: 'ambiguous', dirs: c.map((x) => x.dir) });
    else picked.push({ slug, ...c[0] });
  }
  if (errors.length) fail(2, 'only_unresolved', { errors });
  // 要比内容的（源 A、C）现在就算树摘要：之后试跑、前态、正式执行都用这一份
  for (const p of picked) p.tree = p.src === 'B' ? null : treeDigest(join(p.root, p.dir));
  return picked;
}
/** 一个点名技能的前态和结论。read：{ skill(slug), versions(skillId) }，试跑走只读库、正式执行走服务——同一套判断 */
function planOf(p, read) {
  const skill = read.skill(p.slug);
  const vs = skill ? read.versions(skill.id) : [];
  const latest = vs[0] ?? null;
  let status, newVersions;
  if (!skill) { status = 'missing'; newVersions = p.src === 'B' && p.legacy ? 0 : 1; }
  else if (p.src === 'B') { status = vs.length || p.legacy ? 'same' : 'changed'; newVersions = vs.length || p.legacy ? 0 : 1; } // jf 不比内容：只登记首版
  else if (latest?.tree_digest === p.tree.digest) { status = 'same'; newVersions = 0; }
  else { status = 'changed'; newVersions = 1; }
  return { slug: p.slug, status, newVersions, skillId: skill?.id ?? null, latestVersion: latest?.version ?? null, latestDigest: latest?.tree_digest ?? null, sourceDigest: p.tree?.digest ?? null };
}
const stateOf = (plans) => createHash('sha256').update(JSON.stringify(plans.map((x) => [x.slug, x.skillId, x.latestVersion, x.latestDigest, x.sourceDigest]))).digest('hex');

if (ONLY !== undefined && DRY) {
  const picked = resolveOnly(ONLY);
  const dbPath = join(TARGET_DATA, 'workbench-market.db');
  if (!existsSync(dbPath)) fail(3, 'target_db_missing', { db: dbPath });
  let ro;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    ro = new DatabaseSync(dbPath, { readOnly: true });
    ro.prepare('SELECT 1 FROM skills LIMIT 1').all();
    ro.prepare('SELECT 1 FROM skill_versions LIMIT 1').all();
  } catch (e) { fail(3, 'target_db_unreadable', { db: dbPath, message: String(e?.message ?? e) }); }
  let plans;
  try {
    plans = picked.map((p) => planOf(p, {
      skill: (slug) => ro.prepare('SELECT id FROM skills WHERE slug = ?').get(slug),
      versions: (id) => ro.prepare('SELECT version, tree_digest FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(id),
    }));
  } catch (e) { fail(3, 'target_db_unreadable', { db: dbPath, message: String(e?.message ?? e) }); }
  finally { try { ro.close(); } catch { /* 只读句柄 */ } }
  console.log(JSON.stringify({ ok: true, dry: true, only: plans.map((x) => x.slug), plans, newVersions: plans.reduce((n, x) => n + x.newVersions, 0), state: stateOf(plans) }));
  process.exit(0); // 只读：没有加载应用、没有写库、快照和报告
}
if (DRY) {
  console.log(JSON.stringify({ dry: true, a: scanAgentsSkills(), b: scanJfSkills(), c: scanDshSkills(), bundles: scanJfBundles() }));
  process.exit(0); // no context import, database creation, snapshots or report writes in dry mode
}

// ---- 正式导入（写库走 SkillService）----
const { svc } = await import('../server/src/context.ts');
await new Promise((r) => setTimeout(r, 400));
const S = svc('skill');
if (!S) { console.error('skill 服务未就绪'); process.exit(1); }
const LAYER = { A: 5, B: 1, C: 2 }; // 源级赋层：agents→5 AI原生运营 / jf→1 业务角色 / dsh→2 开发运维（WM-SKILL-SRC-LAYER-1）

if (ONLY !== undefined) {
  const picked = resolveOnly(ONLY);
  const read = { skill: (slug) => S.skillBySlug(slug), versions: (id) => S.versionsBySkill(id) };
  const plans = picked.map((p) => planOf(p, read));
  const state = stateOf(plans);
  if (EXPECT_STATE !== undefined && EXPECT_STATE !== state) fail(4, 'state_changed', { expected: EXPECT_STATE, actual: state, plans });
  const meta = { A: { layerName: 'AI 原生运营', source: 'agents-skills' }, B: { layerName: '业务角色层', source: 'jf-tech' }, C: { layerName: '开发运维层', source: 'dsh-skills' } };
  const { cpSync, renameSync, mkdirSync, rmSync } = await import('node:fs');
  const todo = picked.map((p, i) => ({ p, plan: plans[i] })).filter((x) => x.plan.newVersions > 0 || x.plan.status === 'missing');
  const staging = join(SNAP_ROOT, `.staging-${process.pid}-${Date.now().toString(36)}`);
  const placed = []; // 已经挪到位的快照目录：失败时删掉
  const { db } = await import('../server/src/db.ts');
  let began = false;
  try {
    // ① 快照：先放进暂存区，再一个个挪到位（目标已经有东西就不动它、整体失败）
    for (const x of todo) {
      if (x.p.src === 'B') continue;
      x.version = (x.plan.latestVersion ?? 0) + 1;
      x.snapRel = skillSnapRel(x.p.slug, x.version);
      x.snapDir = join(TARGET_DATA, x.snapRel);
      if (existsSync(x.snapDir)) throw new Error(`snapshot_target_exists ${x.snapDir}`);
      x.staged = join(staging, String(todo.indexOf(x)));
      cpSync(join(x.p.root, x.p.dir), x.staged, { recursive: true, dereference: true });
    }
    for (const x of todo) {
      if (!x.staged) continue;
      mkdirSync(join(x.snapDir, '..'), { recursive: true });
      renameSync(x.staged, x.snapDir);
      placed.push(x.snapDir);
    }
    // ② 库：一个事务写完这一批
    db.exec('BEGIN IMMEDIATE'); began = true;
    for (const x of todo) {
      const { p } = x;
      const m = meta[p.src];
      if (p.src === 'B' && p.legacy) { S.upsertSkill({ slug: p.slug, name: p.dir, layer: LAYER.B, layerName: m.layerName, source: m.source, legacy: 1 }); continue; }
      S.upsertSkill({ slug: p.slug, name: p.row.name, layer: LAYER[p.src], layerName: m.layerName, description: p.row.description, argumentHint: p.row.argumentHint, author: p.row.author, source: m.source });
      const row = S.skillBySlug(p.slug);
      if (p.src === 'B') { S.versionInsert({ skillId: row.id, version: 1, changelog: 'jf 首版登记（遗产不快照）', treeDigest: '', reviewedBy: 'importer' }); continue; }
      S.versionInsert({ skillId: row.id, version: x.version, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: p.tree.digest, fileCount: p.tree.fileCount, totalBytes: p.tree.totalBytes, snapshotPath: x.snapRel, reviewedBy: 'importer' });
    }
    db.exec('COMMIT'); began = false;
  } catch (e) {
    if (began) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在 */ } }
    for (const d of placed) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
    rmSync(staging, { recursive: true, force: true });
    fail(5, 'import_failed_rolled_back', { message: String(e?.message ?? e), plans });
  }
  rmSync(staging, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, dry: false, only: plans.map((x) => x.slug), plans, newVersions: plans.reduce((n, x) => n + x.newVersions, 0), state }));
  process.exit(0);
}
const report = { a: { imported: 0, skipped: [] }, b: { imported: 0, skipped: [] }, c: { imported: 0, skipped: [] }, bundles: 0, digests: [] };
if (!DRY) {
  for (const r of scanAgentsSkills()) {
    if (!r.name) { report.a.skipped.push(r.dir); continue; }
    const t = treeDigest(join(AGENTS_SKILLS, r.dir));
    S.upsertSkill({ slug: `agents:${r.name}`, name: r.name, layer: LAYER.A, layerName: 'AI 原生运营', description: r.description, argumentHint: r.argumentHint, author: r.author, source: 'agents-skills' });
    const row = S.skillBySlug(`agents:${r.name}`);
    const exist = S.versionsBySkill(row.id)[0];
    if (exist?.tree_digest === t.digest) continue;
    const ver = (S.versionsMax(row.id)?.v ?? 0) + 1;
    // 快照落盘（方案 §1 P0-b 语义前置到种子导入：首版即快照）
    const { cpSync, mkdirSync } = await import('node:fs');
    const snapRel = skillSnapRel(`agents:${r.name}`, ver); // #810：按全 slug，和 dsh: 同名的不共用目录
    const snapDir = join(TARGET_DATA, snapRel); // S0⑦ 锚定 + DATA_DIR 对齐
    if (existsSync(snapDir)) throw new Error(`snapshot_target_exists ${snapDir}`); // 不往已有的快照里混写
    // cpSync(dereference) 自带建目录（junction 源复制内容非链接）
    cpSync(join(AGENTS_SKILLS, r.dir), snapDir, { recursive: true, dereference: true }); // junction 源复制内容（drawio-skill 实测）
    S.versionInsert({ skillId: row.id, version: ver, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: snapRel, reviewedBy: 'importer' });
    report.a.imported++;
  }
  for (const r of scanDshSkills()) {
    if (!r.name) { report.c.skipped.push(r.dir); continue; }
    const t = treeDigest(join(DSH_SKILLS, r.dir));
    S.upsertSkill({ slug: `dsh:${r.name}`, name: r.name, layer: LAYER.C, layerName: '开发运维层', description: r.description, argumentHint: r.argumentHint, author: r.author, source: 'dsh-skills' });
    const row = S.skillBySlug(`dsh:${r.name}`);
    const exist = S.versionsBySkill(row.id)[0];
    if (exist?.tree_digest === t.digest) continue;
    const ver = (S.versionsMax(row.id)?.v ?? 0) + 1;
    const { cpSync } = await import('node:fs');
    const snapRel = skillSnapRel(`dsh:${r.name}`, ver); // #810：按全 slug
    const snapDir = join(TARGET_DATA, snapRel);
    if (existsSync(snapDir)) throw new Error(`snapshot_target_exists ${snapDir}`);
    cpSync(join(DSH_SKILLS, r.dir), snapDir, { recursive: true, dereference: true }); // junction 源复制内容（ponytail 族同 drawio-skill 先例）
    S.versionInsert({ skillId: row.id, version: ver, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: snapRel, reviewedBy: 'importer' });
    report.c.imported++;
  }
  for (const r of scanJfSkills()) {
    if (!r.name) { // markdown 标题式变体：legacy 元数据登记（方案「遗产只登记不快照」）
      S.upsertSkill({ slug: `jf:${r.dir}`, name: r.dir, layer: LAYER.B, layerName: '业务角色层', source: 'jf-tech', legacy: 1 });
      report.b.imported++;
      continue;
    }
    S.upsertSkill({ slug: `jf:${r.name}`, name: r.name, layer: LAYER.B, layerName: '业务角色层', description: r.description, argumentHint: r.argumentHint, author: r.author, source: 'jf-tech' });
    const row = S.skillBySlug(`jf:${r.name}`);
    if ((S.versionsMax(row.id)?.v ?? 0) === 0) {
      S.versionInsert({ skillId: row.id, version: 1, changelog: 'jf 首版登记（遗产不快照）', treeDigest: '', reviewedBy: 'importer' }); // legacy 无快照·digest 空
      report.b.imported++;
    }
  }
  for (const b of scanJfBundles()) {
    if (!b.packId) continue;
    S.bundleUpsert(b); report.bundles++;
  }
}
writeFileSync(join(REPO_ROOT, 'tmp/skill-import-report.json'), JSON.stringify(report, null, 2)); // S0⑦ 锚定
console.log(`导入完成（dry=${DRY}）：A=${report.a.imported} C=${report.c.imported} B=${report.b.imported} bundles=${report.bundles} 跳过=${report.a.skipped.length + report.b.skipped.length + report.c.skipped.length}`);
