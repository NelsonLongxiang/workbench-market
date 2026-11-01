#!/usr/bin/env node
/** #315 token 管线：仓库根 DESIGN.md 的 YAML front matter → web/src/tokens.css（--wm-* 变量）+ web/src/design-tokens.ts（antd 主题映射用）。
 *  改 token 只改 DESIGN.md，再跑 `node scripts/gen-design-tokens.mjs`；`--check` 只比对不写，产物过期则 exit 1。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parse: parseYaml } = createRequire(join(ROOT, 'server/package.json'))('yaml');
const OUT_CSS = 'web/src/tokens.css';
const OUT_TS = 'web/src/design-tokens.ts';

export function loadTokens(root = ROOT) {
  const text = readFileSync(join(root, 'DESIGN.md'), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error('DESIGN.md 缺 YAML front matter');
  const meta = parseYaml(m[1]);
  // 解析 "{colors.primary}" 这类引用（可多层）
  const resolve = (v, depth = 0) => {
    if (typeof v !== 'string') return v;
    const r = /^\{([\w-]+)\.([\w-]+)\}$/.exec(v);
    if (!r) return v;
    if (depth > 8) throw new Error(`token 引用成环：${v}`);
    const target = meta[r[1]]?.[r[2]];
    if (target === undefined) throw new Error(`token 引用不存在：${v}`);
    return resolve(target, depth + 1);
  };
  const group = (name) => Object.fromEntries(Object.entries(meta[name] ?? {}).map(([k, v]) => [k, resolve(v)]));
  return {
    version: String(meta.version),
    colors: group('colors'),
    typography: group('typography'),
    spacing: group('spacing'),
    rounded: group('rounded'),
    elevation: group('elevation'),
    motion: group('motion'),
  };
}

export function render(t) {
  const head = `由 scripts/gen-design-tokens.mjs 从 DESIGN.md v${t.version} 生成，勿手改；改 token 请改 DESIGN.md 后重新生成。`;
  const css = [`/* ${head}`, '   变量契约见 DESIGN.md「CSS 变量契约」：名字稳定、值可变。 */', ':root {', `  --wm-version: "${t.version}";`];
  for (const [k, v] of Object.entries(t.colors)) css.push(`  --wm-color-${k}: ${v};`);
  css.push(`  --wm-font-sans: ${t.typography['family-sans']};`, `  --wm-font-mono: ${t.typography['family-mono']};`);
  for (const [k, v] of Object.entries(t.typography)) {
    if (typeof v !== 'object' || !v) continue;
    if (v.fontSize) css.push(`  --wm-font-size-${k}: ${v.fontSize};`);
    if (v.lineHeight) css.push(`  --wm-line-height-${k}: ${v.lineHeight};`);
    if (v.fontWeight) css.push(`  --wm-font-weight-${k}: ${v.fontWeight};`);
  }
  for (const [k, v] of Object.entries(t.spacing)) css.push(`  --wm-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.rounded)) css.push(`  --wm-radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.elevation)) css.push(`  --wm-shadow-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.motion)) css.push(`  --wm-motion-${k}: ${v};`);
  css.push('}', '');
  const ts = `/** ${head} */\nexport const DESIGN_TOKENS = ${JSON.stringify(t, null, 2)} as const;\n`;
  return { [OUT_CSS]: css.join('\n'), [OUT_TS]: ts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = render(loadTokens());
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, body] of Object.entries(out)) {
    const p = join(ROOT, rel);
    let cur = null; try { cur = readFileSync(p, 'utf8'); } catch {}
    if (cur === body) continue;
    if (check) { stale++; console.error(`过期：${rel}（DESIGN.md 改过但没重新生成，跑 node scripts/gen-design-tokens.mjs）`); }
    else { writeFileSync(p, body); console.log(`写入 ${rel}`); }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('design tokens 产物与 DESIGN.md 一致');
}
