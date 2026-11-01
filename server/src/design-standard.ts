/** 工作台 design token 标准的只读读取（MCP design_standard 工具）。
 *  唯一事实源：仓库根 DESIGN.md（YAML front matter = token）+ design-system/workbench-market/PATTERNS.md（页面模式）。
 *  每次调用现读文件（文件小、改标准不需重启）；读不到/解析失败一律 503，不返回空内容冒充成功。 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { HttpError } from './errors.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DESIGN_FILES = { design: 'DESIGN.md', patterns: 'design-system/workbench-market/PATTERNS.md' } as const;
export const DESIGN_PARTS = ['all', 'tokens', 'guide', 'patterns'] as const;
type Part = (typeof DESIGN_PARTS)[number];

interface Doc { path: string; sha256: string; text: string }
interface Section { doc: 'design' | 'patterns'; heading: string; body: string }

function readDoc(rel: string, root: string): Doc {
  let text: string;
  try { text = readFileSync(join(root, rel), 'utf8'); }
  catch { throw new HttpError(503, `design standard unavailable: ${rel} 不在运行目录（打包须带上 DESIGN.md 与 design-system/）`); }
  return { path: rel, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), text };
}

function splitFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new HttpError(503, 'design standard unavailable: DESIGN.md 缺 YAML front matter');
  let meta: unknown;
  try { meta = parseYaml(m[1]); } catch (e) { throw new HttpError(503, `design standard unavailable: DESIGN.md front matter 解析失败：${(e as Error).message}`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new HttpError(503, 'design standard unavailable: DESIGN.md front matter 不是对象');
  return { meta: meta as Record<string, unknown>, body: text.slice(m[0].length) };
}

/** 按 `## ` 二级标题切节（一级标题与其后的引言并入第一节之前，不单列）。 */
function sections(doc: 'design' | 'patterns', body: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { if (cur) out.push(cur); cur = { doc, heading: h[1], body: '' }; continue; }
    if (cur) cur.body += line + '\n';
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

export function designStandard(args: { part?: unknown; section?: unknown } = {}, root = ROOT): Record<string, unknown> {
  const part = (args.part === undefined || args.part === null || args.part === '' ? 'all' : args.part) as Part;
  if (!DESIGN_PARTS.includes(part)) throw new HttpError(400, `part 只接受 ${DESIGN_PARTS.join(' / ')}`);
  if (args.section !== undefined && (typeof args.section !== 'string' || !args.section.trim())) throw new HttpError(400, 'section 须为非空字符串');
  const design = readDoc(DESIGN_FILES.design, root);
  const patterns = readDoc(DESIGN_FILES.patterns, root);
  const { meta, body } = splitFrontMatter(design.text);
  const { name, version, description, ...tokens } = meta;
  const out: Record<string, unknown> = {
    name, version, description,
    sources: [design, patterns].map(({ path, sha256 }) => ({ path, sha256 })),
  };
  let secs: Section[] = [];
  if (part === 'all' || part === 'guide') secs = secs.concat(sections('design', body));
  if (part === 'all' || part === 'patterns') secs = secs.concat(sections('patterns', patterns.text));
  if (typeof args.section === 'string') {
    const k = args.section.trim().toLowerCase();
    secs = (part === 'tokens' ? sections('design', body).concat(sections('patterns', patterns.text)) : secs)
      .filter((s) => s.heading.toLowerCase().includes(k));
    if (!secs.length) throw new HttpError(404, `没有标题含「${args.section.trim()}」的章节`);
    out.sections = secs;
    return out;
  }
  if (part === 'all' || part === 'tokens') out.tokens = tokens;
  if (part !== 'tokens') out.sections = secs;
  return out;
}
