#!/usr/bin/env node
/** #320 驾驶舱布局吸附单测：宽度只取 3/4/6/12、x 越界收回、不丢面板、其余字段不变、已合规布局原样返回（同一对象）。 */
import { COCKPIT_COLS, PANEL_WIDTHS, snapPanels, snapW } from '../web/src/cockpit-layout.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const cases = [[1, 3], [2, 3], [3, 3], [3.5, 4], [4, 4], [5, 6], [6, 6], [7, 6], [8, 6], [9, 12], [10, 12], [11, 12], [12, 12], [24, 12], [0, 3], [-2, 3], [NaN, 6]];
for (const [w, want] of cases) ok(`snapW(${w}) = ${want}`, snapW(w) === want, String(snapW(w)));
ok('所有结果都在 3/4/6/12', Array.from({ length: 30 }, (_, i) => snapW(i - 5)).every((w) => PANEL_WIDTHS.includes(w)));
const saved = [
  { i: 'wb-1', workbenchId: 1, x: 0, y: 0, w: 5, h: 8 },
  { i: 'wb-2', workbenchId: 2, x: 10, y: 0, w: 7, h: 10 },
  { i: 'tasks', workbenchId: 0, kind: 'tasks', x: 11, y: 8, w: 1, h: 12 },
  { i: 'wb-3', workbenchId: 3, x: 0, y: 20, w: 6, h: 6 },
];
const out = snapPanels(saved);
ok('旧布局迁移后面板数不变、顺序与 i 不变', out.length === saved.length && out.every((p, k) => p.i === saved[k].i));
ok('宽度全部吸附到 4 档', out.every((p) => PANEL_WIDTHS.includes(p.w)), JSON.stringify(out.map((p) => p.w)));
ok('x + w 不超出 12 列', out.every((p) => p.x >= 0 && p.x + p.w <= COCKPIT_COLS), JSON.stringify(out.map((p) => [p.x, p.w])));
ok('y / h / workbenchId / kind 不变', out.every((p, k) => p.y === saved[k].y && p.h === saved[k].h && p.workbenchId === saved[k].workbenchId && p.kind === saved[k].kind));
ok('已合规面板原样返回（同一对象，渲染不触发保存）', out[3] === saved[3]);
ok('不改原数组（读时迁移不回写）', saved[0].w === 5 && saved[1].x === 10);
console.log(`cockpit-layout-unit: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
