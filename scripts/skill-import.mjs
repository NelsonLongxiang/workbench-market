#!/usr/bin/env node
/** 技能市场双源导入器（P0-a-3 · 方案 PR#57 §3）：
 *  源 A ~/.agents/skills：SKILL.md frontmatter（name/description/argument-hint/metadata{author,version}）
 *  源 B jf-tech：.agents/skills 主 + .agents/role-*.json 角色束收编（遗产只登记不快照）
 *  幂等：by (source,name) 已存在→比树 digest，同 skip / 异报 diff 待发布门（不自动升版）
 *  判据先红：--selftest 跑导入判据族（导入器未实现时红）。 */
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
// #94 S0⑦：cwd 相对路径→脚本目录锚定（任意 cwd 运行都落在仓库真位）
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const SELFTEST = args.includes('--selftest');
const DRY = args.includes('--dry-run') || SELFTEST;
const AGENTS_SKILLS = process.env.SKILL_SRC_A ?? 'C:/Users/Administrator/.agents/skills';
// (relocated) { fileURLToPath as _fu2 } from 'node:url';
const JF_ROOT = process.env.SKILL_SRC_B ?? fileURLToPath(new URL('../../jf-tech-expert-agents', import.meta.url)); // 相对化（隐私门红线）
const DSH_SKILLS = process.env.SKILL_SRC_C ?? 'C:/Users/Administrator/.dsh/skills'; // 源 C：DSH 平台技能（开发运维层）
/** 快照根与 DB 同 DATA_DIR（#94 S4 隔离语义对齐：隔离实例的导入不再落产库快照目录；缺省=server/data 不变） */
const SNAP_ROOT = join(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(REPO_ROOT, 'server/data'), 'skill-snapshots');

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
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '' });
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
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '' });
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
    rows.push({ dir: d.name, name: fm.name, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ?? '', author: fm.metadata?.author ?? '' });
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

// ---- 正式导入（写库走 SkillService）----
const { svc } = await import('../server/src/context.ts');
await new Promise((r) => setTimeout(r, 400));
const S = svc('skill');
if (!S) { console.error('skill 服务未就绪'); process.exit(1); }
const LAYER = { A: 5, B: 1, C: 2 }; // 源级赋层：agents→5 AI原生运营 / jf→1 业务角色 / dsh→2 开发运维（WM-SKILL-SRC-LAYER-1）
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
    const snapDir = join(SNAP_ROOT, encodeURIComponent(r.name), `v${ver}`); // S0⑦ 锚定 + DATA_DIR 对齐
    // cpSync(dereference) 自带建目录（junction 源复制内容非链接）
    cpSync(join(AGENTS_SKILLS, r.dir), snapDir, { recursive: true, dereference: true }); // junction 源复制内容（drawio-skill 实测）
    S.versionInsert({ skillId: row.id, version: ver, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: snapDir, reviewedBy: 'importer' });
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
    const snapDir = join(SNAP_ROOT, encodeURIComponent(r.name), `v${ver}`);
    cpSync(join(DSH_SKILLS, r.dir), snapDir, { recursive: true, dereference: true }); // junction 源复制内容（ponytail 族同 drawio-skill 先例）
    S.versionInsert({ skillId: row.id, version: ver, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: snapDir, reviewedBy: 'importer' });
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
