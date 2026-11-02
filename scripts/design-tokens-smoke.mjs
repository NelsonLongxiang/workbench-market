#!/usr/bin/env node
/** #315 token 管线冒烟：产物与 DESIGN.md 同步（--check）· 引用解析 · 改一处颜色产物随之变化 · 坏引用报错 ·
 *  main.tsx 主题与 App.tsx 侧栏不再写死色值。合成目录只放 DESIGN.md，不动仓库文件。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTokens, render } from './gen-design-tokens.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };

let checkRc = 0; try { execFileSync(process.execPath, ['scripts/gen-design-tokens.mjs', '--check'], { stdio: 'pipe' }); } catch (e) { checkRc = e.status; }
ok('--check：仓库产物与 DESIGN.md 一致', checkRc === 0);
const t = loadTokens();
const out = render(t);
const css = out['web/src/tokens.css'];
ok('tokens.css 每个颜色都有 --wm-color-* 变量', Object.keys(t.colors).every((k) => css.includes(`--wm-color-${k}:`)));
ok('引用已解析：info = primary', t.colors.info === t.colors.primary && !/\{colors\./.test(css));
ok('success 为 #047857（DESIGN.md 定的 AA 值）', t.colors.success.toUpperCase() === '#047857');
ok('契约示例变量齐全', ['--wm-color-text-secondary', '--wm-font-size-body', '--wm-line-height-body', '--wm-space-3', '--wm-radius-lg', '--wm-shadow-2', '--wm-motion-base', '--wm-font-sans'].every((v) => css.includes(v + ':')));
ok('tokens.css 带版本号', css.includes(`--wm-version: "${t.version}"`));

const tmp = 'tmp/design-tokens-fixture';
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
const design = readFileSync('DESIGN.md', 'utf8');
writeFileSync(join(tmp, 'DESIGN.md'), design.replace(/primary: "#1E3A5F"/, 'primary: "#123456"'));
const t2 = loadTokens(tmp);
const o2 = render(t2);
ok('改 DESIGN.md 一处颜色：tokens.css 与 design-tokens.ts 同步变化（引用 info 也跟着变）', o2['web/src/tokens.css'].includes('--wm-color-primary: #123456;') && o2['web/src/tokens.css'].includes('--wm-color-info: #123456;') && o2['web/src/design-tokens.ts'].includes('"primary": "#123456"'));
writeFileSync(join(tmp, 'DESIGN.md'), design.replace('info: "{colors.primary}"', 'info: "{colors.nope}"'));
ok('坏引用 → 报错点名', /colors\.nope/.test(err(() => loadTokens(tmp))?.message ?? ''));
writeFileSync(join(tmp, 'DESIGN.md'), '# 无 front matter\n');
ok('缺 front matter → 报错', /front matter/.test(err(() => loadTokens(tmp))?.message ?? ''));
rmSync(tmp, { recursive: true, force: true });

const main = readFileSync('web/src/main.tsx', 'utf8');
const theme = main.slice(main.indexOf('theme={{'), main.indexOf('<AntApp>'));
ok('main.tsx 主题不写死色值、取自 DESIGN_TOKENS', !/['"]#[0-9a-f]{3,8}['"]/i.test(theme) && theme.includes('T.colors.primary') && main.includes("import './tokens.css'"));
const app = readFileSync('web/src/App.tsx', 'utf8');
ok('App.tsx 不写死色值（侧栏改用 nav-* token）', !/'#[0-9a-f]{3,8}'/i.test(app) && app.includes("T.colors['nav-bg']"));

console.log(`design-tokens-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
