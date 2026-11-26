#!/usr/bin/env node
/** #1098 台页、报告页顶栏的纯函数（web/src/use-topbar-view.ts）：面包屑每一级去哪、「上一页」去哪。 */
import { backTarget, topCrumbs } from '../web/src/use-topbar-view.ts';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = JSON.stringify;
ok('台页：全景（能点，回首页）/ 台名（当前，不能点）', J(topCrumbs('42', '合成台', 'bench').map((c) => [c.label, c.to])) === J([['全景', '/'], ['合成台', null]]));
ok('报告页：全景 / 台名（能点，回台页）/ 报告（当前）', J(topCrumbs('42', '合成台', 'reports').map((c) => [c.label, c.to])) === J([['全景', '/'], ['合成台', '/use/42'], ['报告', null]]));
ok('嵌入使用页：全景 / 卡片名', J(topCrumbs('7', '合成卡', 'card').map((c) => c.to)) === J(['/', null]));
ok('台的地址按卡片 id 编码', topCrumbs('a/b', 'x', 'reports')[1].to === '/use/a%2Fb');
ok('上一页：本站里有上一页就退一步；直接打开（key 是 default、没有 key）回全景', backTarget('k3x9a') === -1 && backTarget('default') === '/' && backTarget('') === '/' && backTarget(undefined) === '/' && backTarget(null) === '/');
console.log(`\nuse-topbar-unit: ${pass} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
