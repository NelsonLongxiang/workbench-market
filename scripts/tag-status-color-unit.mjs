#!/usr/bin/env node
/** 守门：表示状态的地方不手写 antd 预设色（DESIGN.md「状态标签用 tag-success / tag-warning / tag-danger，不手写 color」）。
 *  web/src 里出现 orange / green / red / gold / volcano / lime / yellow 这类预设色的字符串就报错——它们不走主题，
 *  主题里的状态色（#774 对齐设计稿）管不到。状态一律用 success / warning / error / processing（info），跟着主题走。
 *  放行的只有下面白名单里的「类别色」（标的是哪一类，不是好坏）和不是 Tag 的地方（时间线圆点）；白名单每条要写理由，
 *  对不上任何一行的白名单条目也报错（删了代码要把白名单一起删，免得白名单越攒越宽）。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../web/src/', import.meta.url).pathname;
const PRESET = /["'](orange|green|red|gold|volcano|lime|yellow)["']/g;

/** 白名单：文件（相对 web/src）+ 这一行里认得出来的一段 + 理由 */
const ALLOW = [
  { file: 'cockpit-attention.ts', has: 'export const TAG_COLOR', why: '「关注」卡片的类别（在问 / 等验收 / 核准…），区分是哪一类，不是好坏' },
  { file: 'components/DecisionCard.tsx', has: 'const COLOR: Record<string, string> = { ask:', why: '同上，卡片头上的类别标签' },
  { file: 'pages/WorkItem.tsx', has: 'const CATEGORY: Record<string, { label: string; color: string }>', why: '事项详情里「关注」条目的类别，同上' },
  { file: 'pages/Market.tsx', has: 'const TYPE_COLORS = [', why: '台的类型轮换色，区分类型，不是状态' },
  { file: 'pages/Vault.tsx', has: 'const KIND_COLOR: Record<VaultKind, string>', why: '凭据的种类（登录 / SSH / Cookie…），类别色' },
  { file: 'pages/knowledge/Knowledge.tsx', has: 'const KIND_COLOR: Record<string, string> = { claim:', why: '经验库条目的种类，类别色' },
  { file: 'components/WorkItemTimeline.tsx', has: "color: g.row.rejected ? 'gray'", why: '时间线圆点（antd Timeline），不是标签；Timeline 只认这几种颜色名' },
  { file: 'components/WorkItemTimeline.tsx', has: "color: g.kind === 'rejected' ? 'gray'", why: '同上，时间线圆点' },
  { file: 'pages/market/SkillDetail.tsx', has: "color: v.breaking ? 'red'", why: '历次版本时间线的圆点（antd Timeline），不是标签' },
];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) && n !== 'design-tokens.ts' ? [p] : [];
  });
}

const hits = [];
const used = new Set();
for (const abs of files(ROOT)) {
  const rel = abs.slice(ROOT.length);
  readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    if (!PRESET.test(line)) return;
    PRESET.lastIndex = 0;
    const a = ALLOW.findIndex((x) => x.file === rel && line.includes(x.has));
    if (a >= 0) { used.add(a); return; }
    hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
  });
}
const stale = ALLOW.filter((_, i) => !used.has(i)).map((x) => `${x.file}「${x.has}」`);

let fail = 0;
if (hits.length) { fail++; console.log(`  ✗ 手写了表示状态的预设色（改用 success / warning / error / processing；确实是类别色的加进白名单、写理由）：\n    ${hits.join('\n    ')}`); }
else console.log('  ✓ web/src 里没有手写的状态预设色（白名单里的类别色、时间线圆点除外）');
if (stale.length) { fail++; console.log(`  ✗ 白名单里对不上任何一行的条目（代码删了白名单也删）：\n    ${stale.join('\n    ')}`); }
else console.log(`  ✓ 白名单 ${ALLOW.length} 条都还对得上`);
console.log(`\ntag-status-color-unit: ${2 - fail} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
