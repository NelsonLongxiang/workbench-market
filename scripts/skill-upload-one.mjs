#!/usr/bin/env node
/** 单技能上架（属主批准 drawio-skill·2026-10-27）：等价导入器 A 源链路+剔除 __pycache__。
 *  幂等：同 digest skip。 */
import { readdirSync, statSync, readFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const SRC = process.env.SKILL_SRC ?? 'C:/Users/Administrator/.agents/skills/drawio-skill';
const NAME = process.env.SKILL_NAME ?? 'drawio-skill';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === '__pycache__' || e.name === '.git')) continue;
    if (!e.isDirectory() && /\.pyc$/i.test(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(SRC);
files.sort();
const h = createHash('sha256');
for (const p of files) { h.update(relative(SRC, p).split('\\').join('/')); h.update('\0'); h.update(createHash('sha256').update(readFileSync(p)).digest('hex')); h.update('\0'); }
const digest = h.digest('hex');
const totalBytes = files.reduce((n, p) => n + statSync(p).size, 0);
console.log('[one] files:', files.length, 'bytes:', totalBytes, 'digest:', digest.slice(0, 16));

const { svc } = await import('../server/src/context.ts');
await new Promise((r) => setTimeout(r, 400));
const S = svc('skill');
const slug = 'agents:' + NAME;
S.upsertSkill({ slug, name: NAME, layer: 5, layerName: 'AI 原生运营', description: 'draw.io/diagrams.net 图（架构/UML/ERD/序列/BPMN/网络/泳道）创建与编辑——可编辑 .drawio 文件·含同步/查询/测试/评审/导出/发布。', author: 'openclaw', source: 'agents-skills' });
const row = S.skillBySlug(slug);
const exist = S.versionsBySkill(row.id)[0];
if (exist?.tree_digest === digest) { console.log('[one] 已存在同 digest·skip'); process.exit(0); }
const ver = (S.versionsMax(row.id)?.v ?? 0) + 1;
const snapDir = join(process.cwd(), 'server/data/skill-snapshots', encodeURIComponent(NAME), 'v' + ver);
rmSync(snapDir, { recursive: true, force: true });
mkdirSync(snapDir, { recursive: true });
for (const p of files) {
  const rel = relative(SRC, p).split('\\').join('/');
  const dst = join(snapDir, rel);
  mkdirSync(join(dst, '..'), { recursive: true });
  cpSync(p, dst);
}
S.versionInsert({ skillId: row.id, version: ver, changelog: 'import 2026-10-27（属主批准上架·剔除 __pycache__）', treeDigest: digest, fileCount: files.length, totalBytes, snapshotPath: snapDir, reviewedBy: 'owner-approved' });
console.log('[one] 上架毕: ' + slug + ' v' + ver + ' files=' + files.length);
