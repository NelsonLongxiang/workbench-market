#!/usr/bin/env node
/** 任务图纯函数（web/src/bench-blocks/task-graph.ts）的单测，对应 docs/task-graph-step1.md 第八节 A 的「纯函数单测」，外加页面组件的源码检查 */
import { readFileSync } from 'node:fs';
const g = await import('../web/src/bench-blocks/task-graph.ts');
let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info === undefined ? '' : '（' + JSON.stringify(info).slice(0, 400) + '）')); } };
const spec = (extra = {}) => ({ kind: 'dag', id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role', status_col: 'st', ...extra });
const FULL = { filtered: false, truncated: false };
const codes = (m) => m.diagnostics.map((d) => d.code);
const diag = (m, c) => m.diagnostics.find((d) => d.code === c);

console.log('解析依赖');
{
  const p = g.parseDeps('a, ?b, c|d, e=是, ?f=否, a, ??z, x=, self, self|q', 'self');
  ok('四种写法：必需、可选、任一、边上的字（含可选带字）；重复去掉', JSON.stringify(p.items) === JSON.stringify([{ kind: 'req', ids: ['a'] }, { kind: 'opt', ids: ['b'] }, { kind: 'any', ids: ['c', 'd'] }, { kind: 'req', ids: ['e'], label: '是' }, { kind: 'opt', ids: ['f'], label: '否' }, { kind: 'req', ids: ['q'] }]), p.items);
  ok('看不懂的项列出来（??z、x=）', JSON.stringify(p.bad) === JSON.stringify(['??z', 'x=']), p.bad);
  ok('自己指自己的项去掉并提示；组里的自己去掉、剩下的照用', p.selfDropped === true);
  const many = g.parseDeps(Array.from({ length: 51 }, (_, i) => 'n' + i).join(','), 'x');
  ok('每格最多 50 项，多的截掉并标 cut', many.items.length === 50 && many.cut === true);
  ok('空格、null 都是没有前置', g.parseDeps('', 'x').items.length === 0 && g.parseDeps(null, 'x').items.length === 0);
  ok('编号不合规：含保留符号、超 64 字', !g.validId('a=b') && !g.validId('x'.repeat(65)) && g.validId('任务-1'));
}

const chain = [
  { id: 'S', name: '开始', role: 'start', st: 'done' },
  { id: 'A', name: '设计', deps: 'S', st: 'done' },
  { id: 'B', name: '实现', deps: 'A', st: 'doing' },
  { id: 'E', name: '上线', deps: 'B', role: 'end', st: 'todo' },
];
console.log('全量与部分');
{
  const m = g.buildGraph(chain, spec(), FULL);
  ok('没有筛选、没有截断：全量，无诊断', m.full && m.diagnostics.length === 0, m.diagnostics);
  const rows500 = Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i, name: 'n' + i, deps: i ? 'n' + (i - 1) : '', role: i === 0 ? 'start' : i === 499 ? 'end' : '', st: 'todo' }));
  ok('恰好 500 行、没截断：全量', g.buildGraph(rows500, spec(), FULL).full === true);
  const m501 = g.buildGraph(rows500, spec(), { filtered: false, truncated: true });
  ok('501 行（服务端标 truncated）：部分，不核终点、不算完成率，写明画了 500 个', !m501.full && m501.partialReasons.includes('rows') && m501.summary.rate === null && m501.drawn === 500 && !codes(m501).includes('unconfirmed-leaf'), m501.partialReasons);
  const m502 = g.buildGraph([...rows500, { id: 'x1' }, { id: 'x2' }], spec(), FULL);
  ok('页面拿到多于 500 行（502）也只画 500 个、按部分', !m502.full && m502.drawn === 500);
  const filtered = g.buildGraph(chain.slice(1), spec(), { filtered: true, truncated: false });
  ok('有筛选：部分；前置在结果外画「范围外」占位，不报缺失、不核起点终点', !filtered.full && filtered.nodes.some((n) => n.placeholder === 'outside' && n.id === 'S') && !codes(filtered).includes('missing') && !codes(filtered).includes('start-count'), filtered.diagnostics);
  const deps51 = g.buildGraph([...chain, { id: 'Z', name: 'z', deps: Array.from({ length: 51 }, () => 'S').map((s, i) => s + (i ? i : '')).join(','), role: 'branch_end' }], spec(), FULL);
  ok('某格依赖超 50 项：整块按部分', !deps51.full && deps51.partialReasons.includes('deps'));
  const ph = g.buildGraph([...chain, { id: 'Z', name: 'z', deps: Array.from({ length: 50 }, (_, i) => 'm' + i).join(','), role: 'branch_end' }, { id: 'Y', name: 'y', deps: Array.from({ length: 50 }, (_, i) => 'k' + i).join(','), role: 'branch_end' }, { id: 'W', name: 'w', deps: 'q1,q2', role: 'branch_end' }], spec(), FULL);
  ok('范围外或缺失的占位超 100：合并计数、整块按部分', !ph.full && ph.partialReasons.includes('placeholders') && ph.placeholderOverflow === 2 && ph.nodes.filter((n) => n.placeholder).length === 100);
}

console.log('环、缺失、起点终点、支线');
{
  const cyc = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'A', deps: 'S,B' }, { id: 'B', deps: 'A' }, { id: 'E', deps: 'B', role: 'end' }], spec(), FULL);
  ok('dag 有环：整块不画，列出一条环', cyc.blocked && diag(cyc, 'cycle').path.join('>') === 'A>B>A', diag(cyc, 'cycle'));
  const optCyc = g.buildGraph([{ id: 'S', role: 'start' }, { id: 'A', deps: 'S,?B' }, { id: 'B', deps: 'A', role: 'end' }], spec(), FULL);
  ok('可选边也算结构：成环同样报', optCyc.blocked);
  const miss = g.buildGraph([...chain, { id: 'Q', name: 'q', deps: 'nope', role: 'branch_end' }], spec(), FULL);
  ok('全量时依赖找不到：画「缺失」占位并报', diag(miss, 'missing')?.ids.join() === 'nope' && miss.nodes.some((n) => n.placeholder === 'missing'));
  const noStart = g.buildGraph(chain.map((r) => ({ ...r, role: r.role === 'start' ? '' : r.role })), spec(), FULL);
  ok('缺起点：报错，不算完成率，图照画', codes(noStart).includes('start-count') && noStart.summary.rate === null && !noStart.blocked);
  const twoEnds = g.buildGraph([...chain, { id: 'E2', name: 'e2', deps: 'A', role: 'end' }], spec(), FULL);
  ok('两个主线终点：报错并列出', diag(twoEnds, 'end-count')?.ids.join() === 'E,E2');
  const startDeps = g.buildGraph(chain.map((r) => (r.id === 'S' ? { ...r, deps: 'A' } : r)), spec(), FULL);
  ok('起点有前置：报（与环同在时 dag 先挡住）', startDeps.blocked || codes(startDeps).includes('start-has-deps'));
  const leaf = g.buildGraph([...chain, { id: 'X', name: '调研', deps: 'A' }, { id: 'X2', name: '调研续', deps: 'X' }], spec(), FULL);
  ok('支线没确认终点：报出叶子，往回标红到分叉处（A 不标红）', diag(leaf, 'unconfirmed-leaf')?.ids.join() === 'X2' && leaf.red.has('X2') && leaf.red.has('X') && !leaf.red.has('A'), [...leaf.red]);
  const merged = g.buildGraph([...chain.map((r) => (r.id === 'E' ? { ...r, deps: 'B,X' } : r)), { id: 'X', name: '调研', deps: 'A' }], spec(), FULL);
  ok('支线汇合回主线：不需要支线终点', !codes(merged).includes('unconfirmed-leaf') && merged.diagnostics.length === 0, merged.diagnostics);
  const be = g.buildGraph([...chain, { id: 'X', name: '调研', deps: 'A', role: 'branch_end', st: 'done' }], spec(), FULL);
  ok('支线标了 branch_end：通过，摘要单列支线完成情况', be.diagnostics.length === 0 && be.summary.branches.length === 1 && be.summary.branches[0].id === 'X' && be.summary.branches[0].done === 3, be.summary.branches);
  const island = g.buildGraph([...chain, { id: 'I', name: '孤岛', role: 'branch_end' }], spec(), FULL);
  ok('从起点走不到：标出来', diag(island, 'unreachable-from-start')?.ids.join() === 'I' && island.red.has('I'));
  const loop = g.buildGraph([{ id: 'S', role: 'start' }, { id: 'A', deps: 'S,B' }, { id: 'B', deps: 'A' }, { id: 'E', deps: 'S', role: 'end' }], spec({ kind: 'flow' }), FULL);
  ok('flow 没有出口的循环：报「走不到终点」', diag(loop, 'cannot-reach-end')?.ids.sort().join() === 'A,B' && !loop.blocked, loop.diagnostics);
  const exitLoop = g.buildGraph([{ id: 'S', role: 'start' }, { id: 'A', deps: 'S,B' }, { id: 'B', deps: 'A' }, { id: 'E', deps: 'B', role: 'end' }], spec({ kind: 'flow' }), FULL);
  ok('flow 有出口的循环：照画不报错', exitLoop.diagnostics.length === 0 && !exitLoop.blocked, exitLoop.diagnostics);
  const rewrite = g.buildGraph(chain.map((r) => (r.id === 'E' ? { ...r, role: '' } : r.id === 'B' ? { ...r, role: 'end' } : r)), spec(), FULL);
  ok('改写终点（终点从 E 换到 B）后重画：E 成了没确认终点的叶子', diag(rewrite, 'unconfirmed-leaf')?.ids.join() === 'E');
}

console.log('派生状态与完成率');
{
  const m = g.buildGraph([...chain, { id: 'O', name: '可选准备', deps: '', role: 'branch_end' }].map((r) => (r.id === 'B' ? { ...r, deps: 'A,?O' } : r)), spec(), FULL);
  ok('可开始：必需前置都完成；可选前置不挡，详情里分列', m.derived.get('B') === 'ready' && m.missingOpt.get('B').join() === 'O' && m.missingReq.get('B').length === 0);
  const anyG = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'P', deps: 'S', st: 'done' }, { id: 'Q', deps: 'S' }, { id: 'R', deps: 'P|Q', role: 'end' }, ], spec(), FULL);
  ok('任一组：一个成员完成就可开始', anyG.derived.get('R') === 'ready');
  const early = g.buildGraph(chain.map((r) => (r.id === 'E' ? { ...r, st: 'doing' } : r)), spec(), FULL);
  ok('前置没完成却写着 doing：提示提前开工，不计入出错', diag(early, 'early-start')?.ids.join() === 'E' && early.summary.errors === 0);
  const rate = g.buildGraph(chain, spec(), FULL);
  ok('完成率 = 主线终点必需闭包里已完成的占比；还差 N 个', rate.summary.rate === 0.5 && rate.summary.remaining === 2, rate.summary);
  const rev = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'A', deps: 'S' }, { id: 'B', deps: 'A' }, { id: 'C', deps: 'S', st: 'done' }, { id: 'E', deps: 'B|C', role: 'end' }], spec(), FULL);
  ok('评审例子（E 依赖 B|C，C 已完成）：E 可开始；闭包 {E,C,S}，A、B 不进分母也不算还差；B 有后继不是叶子', rev.derived.get('E') === 'ready' && rev.summary.rate === 2 / 3 && rev.summary.remaining === 1 && rev.diagnostics.length === 0, { s: rev.summary, d: rev.diagnostics });
  const flowEx = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'C', deps: 'S' }, { id: 'A', deps: 'B|C' }, { id: 'B', deps: 'A' }, { id: 'E', deps: 'A', role: 'end' }], spec({ kind: 'flow' }), FULL);
  ok('「有环时怎么收」例子：B 被排除，闭包 {E,A,C,S}，完成率 1/4，还差 3，A 等前置，终点诊断通过', flowEx.summary.rate === 0.25 && flowEx.summary.remaining === 3 && flowEx.derived.get('A') === 'waiting' && flowEx.diagnostics.length === 0, { s: flowEx.summary, d: flowEx.diagnostics });
  const prefer = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'P', deps: 'S' }, { id: 'Q', deps: 'S' }, { id: 'X', deps: 'P,Q', st: 'done' }, { id: 'Y', deps: 'S' }, { id: 'E', deps: 'X|Y', role: 'end' }], spec(), FULL);
  ok('任一组已满足：取已完成的成员（即便它的前置没完成、比另一个成员「贵」），闭包 {E,X,P,Q,S}', prefer.summary.remaining === 3 && prefer.summary.rate === 2 / 5, prefer.summary);
  const allExcluded = g.requiredClosure('A', new Map([['A', [{ kind: 'any', ids: ['B', 'C'] }]], ['B', [{ kind: 'req', ids: ['A'] }]], ['C', [{ kind: 'req', ids: ['A'] }]]]), new Map([['A', 1], ['B', 1], ['C', 1]]), () => false);
  ok('候选全被排除：取书写在前的成员（B），且一定终止', [...allExcluded].sort().join() === 'A,B', [...allExcluded]);
  let threw = false; try { g.requiredClosure('E', new Map([['E', [{ kind: 'req', ids: ['A'] }]]]), new Map([['E', 1], ['A', 1]]), () => false, { n: 50_000 }); } catch { threw = true; }
  ok('访问超 50000 次：停下（不出完成率）', threw);
  const overlap = g.buildGraph([{ id: 'S', role: 'start', st: 'done' }, { id: 'A', deps: 'S' }, { id: 'B', deps: 'S' }, { id: 'E', deps: 'A,A|B,B|A', role: 'end' }], spec(), FULL);
  ok('组员同时是必需前置、多个组重叠：去重只算一次', overlap.summary.remaining === 2 && overlap.summary.rate === 1 / 3, overlap.summary);
  const shared = [
    { id: 'S', role: 'start', st: 'done' },
    { id: 'P', deps: 'S' }, { id: 'Q', deps: 'S' }, { id: 'B', deps: 'P,Q' },
    { id: 'R', deps: 'S' }, { id: 'C', deps: 'R' },
  ];
  const sharedGraphs = ['P,Q,B|C', 'B|C,P,Q'].map((deps) => g.buildGraph([...shared, { id: 'E', role: 'end', deps }], spec(), FULL));
  ok('并列依赖换序：候选按自己的闭包计分，完成率都为 1/6、还差 5', sharedGraphs.every((m) => m.summary.rate === 1 / 6 && m.summary.remaining === 5 && !m.diagnostics.length), sharedGraphs.map((m) => m.summary));
  ok('候选未完成数相同时保留组内书写顺序', ['P|Q', 'Q|P'].every((deps) => {
    const byId = new Map(['E', 'P', 'Q'].map((id) => [id, true]));
    const items = new Map([['E', g.parseDeps(deps, 'E').items]]);
    const chosen = g.requiredClosure('E', items, byId, () => false);
    return chosen.size === 2 && chosen.has(deps[0]);
  }));
  const noStatus = g.buildGraph(chain, spec({ status_col: undefined }), FULL);
  ok('没配 status_col：不出派生状态、完成率、还差，只出结构与诊断', noStatus.summary.done === null && noStatus.summary.rate === null && noStatus.summary.remaining === null && [...noStatus.derived.values()].every((x) => x === null) && noStatus.summary.total === 4);
  const src = g.buildGraph(chain.map((r) => ({ ...r, src: r.id === 'S' ? 'ygl:node-1' : '' })), spec({ source_col: 'src' }), FULL);
  ok('已完成没留来源：计数提示（不算出错）', diag(src, 'done-without-source')?.ids.join() === 'A' && src.summary.errors === 0);
}

console.log('悬停与终点高亮');
{
  const graph = g.buildGraph([
    { id: 'S', role: 'start', st: 'done' },
    { id: 'A', deps: 'S', st: 'done' }, { id: 'B', deps: 'S' },
    { id: 'C', deps: 'A|B' }, { id: 'D', deps: 'B' },
    { id: 'E', role: 'end', deps: 'C,D,?B' },
  ], spec(), FULL);
  const focus = (hovered, terminal) => g.graphHighlight(graph, hovered, terminal);
  const includesEdge = (h, from, to, kind) => h?.edges.has(g.graphEdgeKey({ from, to, kind }));
  const hovered = focus('A', 'E');
  ok('悬停分别高亮完整前置和后继，汇合点的其它支路不被点亮', [...hovered.nodes].sort().join() === 'A,C,E,S' && hovered.edges.size === 3
    && includesEdge(hovered, 'S', 'A', 'req') && includesEdge(hovered, 'A', 'C', 'any') && includesEdge(hovered, 'C', 'E', 'req'));
  const pinned = focus(null, 'E');
  ok('离开节点恢复选定终点，只高亮必需闭包选中的边', [...pinned.nodes].sort().join() === 'A,B,C,D,E,S' && pinned.edges.size === 6
    && includesEdge(pinned, 'A', 'C', 'any') && includesEdge(pinned, 'B', 'D', 'req')
    && !includesEdge(pinned, 'B', 'C', 'any') && !includesEdge(pinned, 'B', 'E', 'opt'));
  ok('无选定终点或目标已不在结果中时清除高亮', focus(null, null) === null && focus(null, 'A') === null && focus(null, 'gone') === null);
  const branch = g.buildGraph([...chain, { id: 'X', role: 'branch_end', deps: 'A' }], spec(), FULL);
  ok('支线终点可选定且只高亮自己的闭包', [...g.graphHighlight(branch, null, 'X').nodes].sort().join() === 'A,S,X');
}

console.log('布局与等价表格');
{
  const m = g.buildGraph([...chain, { id: 'X', name: '调研', deps: 'S', role: 'branch_end' }, { id: 'Z', name: '汇总', deps: 'S,B', role: 'branch_end' }], spec(), FULL);
  const lay = g.layoutGraph(m, 'LR');
  const L = (id) => lay.placed.get(id).layer;
  ok('层号 = 最长前置链（Z 的前置 S 在 0 层、B 在 2 层：Z 在 3 层）', L('S') === 0 && L('A') === 1 && L('X') === 1 && L('B') === 2 && L('E') === 3 && L('Z') === 3, [...lay.placed.values()].map((p) => [p.id, p.layer]));
  ok('从左到右：横坐标随层递增；TB 互换', lay.placed.get('E').x > lay.placed.get('S').x && g.layoutGraph(m, 'TB').placed.get('E').y > g.layoutGraph(m, 'TB').placed.get('S').y);
  const loop = g.buildGraph([{ id: 'S', role: 'start' }, { id: 'A', deps: 'S,B' }, { id: 'B', deps: 'A' }, { id: 'E', deps: 'B', role: 'end' }], spec({ kind: 'flow' }), FULL);
  const ll = g.layoutGraph(loop);
  ok('flow 先缩强连通分量再分层：A、B 同层，回边标 back', ll.placed.get('A').layer === ll.placed.get('B').layer && ll.edges.filter((e) => e.back).length === 2);
  const rows = g.graphTableRows(m);
  const b = rows.find((r) => r.id === 'B');
  ok('等价表格：名称、状态、派生状态、前置、后继、角色', b.label === '实现' && b.derived === '可开始' && b.preds === 'A' && b.succs === 'E、Z' && rows.find((r) => r.id === 'E').role === '主线终点' && rows.length === 6, b);
}

console.log('页面组件源码');
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const dag = read('../web/src/bench-blocks/DagBlock.tsx'), bv = read('../web/src/bench-blocks/BenchView.tsx'), lite = read('../web/src/bench-blocks/echarts-lite.ts');
  ok('DagBlock 不写内联样式、不写死颜色（颜色只取 DESIGN_TOKENS）', !/style=\{\{/.test(dag) && !/#[0-9A-Fa-f]{3,6}\b|rgba?\(/.test(dag) && /DESIGN_TOKENS/.test(dag));
  ok('图和等价表格两种模式；画不出（有环）时给说明；有部分结果说明和诊断', /'graph' \| 'table'/.test(dag) && /data-testid="dag-cycle"/.test(dag) && /data-testid="dag-partial"/.test(dag) && /data-testid="dag-table"/.test(dag));
  ok('键盘：任务清单可 Tab 聚焦、回车看详情；表格行可聚焦、回车看详情', /<nav className="wm-dag-keys"/.test(dag) && /onKeyDown: \(e\) => \{ if \(e\.key === 'Enter'\) pickNode/.test(dag) && /tabIndex: 0/.test(dag));
  ok('BenchView 认 dag；不认识的组件画「要新版页面」，不再静默不画', /b\.type === 'dag'\) return <DagBlock/.test(bv) && /data-testid="block-unknown"/.test(bv) && !/return null; \/\/ 不认识/.test(bv));
  ok('画布绑定悬停、离开和节点点击，并把边及节点高亮交给图表', [
    "c.on('mouseover', (p) => callbacks.current.onHover(nodeId(p)))",
    "c.on('mouseout', () => callbacks.current.onHover(null))",
    "c.on('click', (p) => { const id = nodeId(p); if (id !== null) callbacks.current.onPick(id); })",
    'onPick={pickNode} onHover=', 'highlight?.edges.has(graphEdgeKey(e))', 'highlight.nodes.has(n.id)',
  ].every((part) => dag.includes(part)));
  ok('图表库只多注册关系图', /GraphChart/.test(lite));
}

console.log('实时刷新后刚刚动了的任务');
{
  const m1 = g.buildGraph(chain, spec(), FULL);
  const first = g.changedNodes(null, m1);
  ok('第一次画：不算变化', first.changed.size === 0 && first.fingerprints.size === 4);
  const m2 = g.buildGraph([...chain.map((r) => (r.id === 'B' ? { ...r, st: 'done' } : r)), { id: 'N', name: '新任务', deps: 'E', role: 'branch_end' }], spec(), FULL);
  const second = g.changedNodes(first.fingerprints, m2);
  ok('状态变了的算；没变的、新出现的不算', [...second.changed].join() === 'B', [...second.changed]);
  const m3 = g.buildGraph(chain.map((r) => (r.id === 'A' ? { ...r, pct: 40 } : r)), spec({ progress_col: 'pct' }), FULL);
  ok('进度变了也算', [...g.changedNodes(g.changedNodes(null, g.buildGraph(chain, spec({ progress_col: 'pct' }), FULL)).fingerprints, m3).changed].join() === 'A');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const dag = read('../web/src/bench-blocks/DagBlock.tsx');
  ok('页面：变了的任务描边，定时收回；描边颜色只取 token', /changedNodes\(prints\.current, model\)/.test(dag) && /setTimeout\(\(\) => setFlash\(new Set\(\)\), FLASH_MS\)/.test(dag) && /shadowColor: T\.colors\.primary/.test(dag));
}

console.log(`\ntask-graph-unit: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
