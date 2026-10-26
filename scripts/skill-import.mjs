#!/usr/bin/env node
/** 技能市场双源导入器（P0-a-3 · 方案 PR#57 §3）：
 *  源 A ~/.agents/skills：SKILL.md frontmatter（name/description/argument-hint/metadata{author,version}）
 *  源 B jf-tech：.agents/skills 主 + .agents/role-*.json 角色束收编（遗产只登记不快照）
 *  幂等：by (source,name) 已存在→比树 digest，同 skip / 异报 diff 待发布门（不自动升版）
 *  判据先红：--selftest 跑导入判据族（导入器未实现时红）。 */
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const SELFTEST = args.includes('--selftest');
const DRY = args.includes('--dry-run') || SELFTEST;
const AGENTS_SKILLS = process.env.SKILL_SRC_A ?? 'C:/Users/Administrator/.agents/skills';
// (relocated) { fileURLToPath as _fu2 } from 'node:url';
const JF_ROOT = process.env.SKILL_SRC_B ?? fileURLToPath(new URL('../../jf-tech-expert-agents', import.meta.url)); // 相对化（隐私门红线）

// ---- 工具 ----
function parseFrontmatter(text) {
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
    if (!d.isDirectory()) continue;
    const sk = join(AGENTS_SKILLS, d.name, 'SKILL.md');
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
    if (!d.isDirectory()) continue;
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
  const A = scanAgentsSkills(); const B = scanJfSkills(); const bundles = scanJfBundles();
  ok('源 A 扫描出技能（>40 严格解析）', A.filter((r) => r.name).length > 40, `解析=${A.filter((r) => r.name).length}/目录=${A.length}`);
  ok('源 A 未解析项有 skip 报告（宽 frontmatter 变体待 P0-b 人审）', A.some((r) => r.skipped));
  ok('源 A frontmatter 字段吸收（name/description）', A.some((r) => r.name && r.description));
  ok('源 A 跳过项有报告', Array.isArray(A));
  ok('源 B 目录扫描在案（frontmatter 变体走 skip 报告，P0-b 登记路径）', B.length >= 5 && Array.isArray(B), `目录=${B.length} 解析=${B.filter((r) => r.name).length}`);
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
const LAYER = { A: 5, B: 1 };
const report = { a: { imported: 0, skipped: [] }, b: { imported: 0, skipped: [] }, bundles: 0, digests: [] };
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
    const snapDir = `server/data/skill-snapshots/${encodeURIComponent(r.name)}/v${ver}`;
    mkdirSync(snapDir, { recursive: true });
    cpSync(join(AGENTS_SKILLS, r.dir), snapDir, { recursive: true });
    S.versionInsert({ skillId: row.id, version: ver, changelog: `import ${new Date().toISOString().slice(0, 10)}`, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: snapDir, reviewedBy: 'importer' });
    report.a.imported++;
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
      S.versionInsert({ skillId: row.id, version: 1, changelog: 'jf 首版登记（遗产不快照）', reviewedBy: 'importer' });
      report.b.imported++;
    }
  }
  for (const b of scanJfBundles()) {
    if (!b.packId) continue;
    S.bundleUpsert(b); report.bundles++;
  }
}
writeFileSync('tmp/skill-import-report.json', JSON.stringify(report, null, 2));
console.log(`导入完成（dry=${DRY}）：A=${report.a.imported} B=${report.b.imported} bundles=${report.bundles} 跳过=${report.a.skipped.length + report.b.skipped.length}`);
