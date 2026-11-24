/**
 * 任务图（轻量版 trees）的纯函数：解析依赖、定输入范围、核对、派生状态、必需闭包、分层布局。
 * 规格见 docs/task-graph-step1.md 第三节之二、第五节。不碰 DOM、不碰取数，页面和单测都直接调。
 * 依赖写法：a 必需、?a 可选、a|b 任一、a=说法（流程图边上的字）；逗号分隔。
 */

export const TASK_GRAPH_LIMITS = { nodes: 500, depsPerCell: 50, edges: 5000, placeholders: 100, idChars: 64, visits: 50_000 } as const;
const RESERVED = /[,=|?]/;

export type DepKind = 'req' | 'opt' | 'any';
export type DepItem = { kind: DepKind; ids: string[]; label?: string };
export type ParsedDeps = { items: DepItem[]; bad: string[]; selfDropped: boolean; cut: boolean };

export function validId(id: string): boolean {
  return id.length > 0 && [...id].length <= TASK_GRAPH_LIMITS.idChars && !RESERVED.test(id) && id.trim() === id;
}

/** 解析一格依赖。self 是本节点编号：指向自己的项去掉并记 selfDropped */
export function parseDeps(cell: unknown, self: string): ParsedDeps {
  const out: ParsedDeps = { items: [], bad: [], selfDropped: false, cut: false };
  if (cell === null || cell === undefined || cell === '') return out;
  const seen = new Set<string>();
  for (const raw0 of String(cell).split(',')) {
    const raw = raw0.trim();
    if (!raw) continue;
    let body = raw, label: string | undefined;
    const eq = body.indexOf('=');
    if (eq >= 0) { label = body.slice(eq + 1).trim(); body = body.slice(0, eq).trim(); if (!label || RESERVED.test(label)) { out.bad.push(raw); continue; } }
    const opt = body.startsWith('?');
    if (opt) body = body.slice(1).trim();
    let ids = body.includes('|') ? body.split('|').map((x) => x.trim()) : [body];
    if (ids.some((x) => !validId(x)) || (opt && ids.length > 1)) { out.bad.push(raw); continue; }
    const before = ids.length;
    ids = [...new Set(ids)].filter((x) => x !== self);
    if (ids.length < before && ids.length < new Set(body.split('|').map((x) => x.trim())).size) out.selfDropped = true;
    if (!ids.length) { out.selfDropped = true; continue; }
    const kind: DepKind = opt ? 'opt' : ids.length > 1 ? 'any' : 'req';
    const key = kind + ':' + [...ids].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.items.length >= TASK_GRAPH_LIMITS.depsPerCell) { out.cut = true; continue; }
    out.items.push({ kind, ids, ...(label ? { label } : {}) });
  }
  return out;
}

export type GraphSpec = {
  kind: 'dag' | 'flow';
  id_col: string; label_col: string; deps_col: string; role_col: string;
  status_col?: string; done_values?: string[]; progress_col?: string; source_col?: string; group_col?: string;
};
export type Role = 'start' | 'end' | 'branch_end' | '';
export type GNode = {
  id: string; label: string; role: Role; status: string | null; progress: number | null; group: string;
  placeholder?: 'missing' | 'outside'; row?: Record<string, unknown>;
};
export type GEdge = { from: string; to: string; kind: DepKind; label?: string; back?: boolean };
export type GraphHighlight = { nodes: Set<string>; edges: Set<string> };

// 编号不允许包含竖线，因此三段可区分同一对节点之间不同种类的边。
export const graphEdgeKey = ({ from, to, kind }: GEdge): string => `${from}|${to}|${kind}`;
export type Derived = 'done' | 'ready' | 'waiting' | null;
export type Diagnostic =
  | { code: 'cycle'; path: string[] } | { code: 'bad-id'; rows: number } | { code: 'bad-deps'; node: string; items: string[] }
  | { code: 'self-dep'; nodes: string[] } | { code: 'missing'; ids: string[] } | { code: 'start-count'; ids: string[] } | { code: 'end-count'; ids: string[] }
  | { code: 'start-has-deps'; id: string } | { code: 'unconfirmed-leaf'; ids: string[] } | { code: 'cannot-reach-end'; ids: string[] }
  | { code: 'unreachable-from-start'; ids: string[] } | { code: 'too-complex' } | { code: 'early-start'; ids: string[] } | { code: 'done-without-source'; ids: string[] };

export type GraphModel = {
  nodes: GNode[]; edges: GEdge[];
  /** 全量：没有筛选、没有任何截断；部分时不核终点、不算完成率 */
  full: boolean;
  partialReasons: ('filtered' | 'rows' | 'deps' | 'edges' | 'placeholders')[];
  drawn: number; placeholderOverflow: number;
  /** dag 有环时整块不画 */
  blocked: boolean;
  diagnostics: Diagnostic[];
  derived: Map<string, Derived>;
  missingReq: Map<string, string[]>; missingOpt: Map<string, string[]>;
  /** 标红：支线没确认终点、走不到终点、从起点走不到 */
  red: Set<string>;
  terminalPath: (id: string) => GraphHighlight | null;
  summary: { total: number; done: number | null; ready: number | null; waiting: number | null; errors: number;
    rate: number | null; remaining: number | null; branches: { id: string; done: number; size: number }[]; note?: string };
};

const strOf = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const roleOf = (v: unknown): Role => { const s = strOf(v).trim(); return s === 'start' || s === 'end' || s === 'branch_end' ? s : ''; };

/** meta：服务端回的 truncated、以及查询带不带 filter（current_only 不算） */
export function buildGraph(rows: Record<string, unknown>[], spec: GraphSpec, meta: { filtered: boolean; truncated: boolean }): GraphModel {
  const L = TASK_GRAPH_LIMITS;
  const diagnostics: Diagnostic[] = [];
  const partialReasons: GraphModel['partialReasons'] = [];
  if (meta.filtered) partialReasons.push('filtered');
  if (meta.truncated) partialReasons.push('rows');
  const nodes: GNode[] = [];
  const byId = new Map<string, GNode>();
  let badIds = 0;
  for (const row of rows.slice(0, L.nodes)) {
    const id = strOf(row[spec.id_col]);
    if (!validId(id) || byId.has(id)) { badIds++; continue; }
    const p = spec.progress_col ? row[spec.progress_col] : null;
    const n: GNode = { id, label: strOf(row[spec.label_col]) || id, role: roleOf(row[spec.role_col]), status: spec.status_col ? (row[spec.status_col] === null || row[spec.status_col] === undefined ? null : strOf(row[spec.status_col])) : null,
      progress: typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null, group: spec.group_col ? strOf(row[spec.group_col]) : '', row };
    nodes.push(n); byId.set(id, n);
  }
  if (rows.length > L.nodes && !partialReasons.includes('rows')) partialReasons.push('rows');
  if (badIds) diagnostics.push({ code: 'bad-id', rows: badIds });
  // 依赖与边
  const depsOf = new Map<string, DepItem[]>();
  const edges: GEdge[] = [];
  const selfDeps: string[] = [];
  let depsCut = false, edgesCut = false;
  for (const n of nodes) {
    const p = parseDeps(n.row?.[spec.deps_col], n.id);
    if (p.bad.length) diagnostics.push({ code: 'bad-deps', node: n.id, items: p.bad });
    if (p.selfDropped) selfDeps.push(n.id);
    if (p.cut) depsCut = true;
    depsOf.set(n.id, p.items);
    for (const it of p.items) for (const d of it.ids) {
      if (edges.length >= L.edges) { edgesCut = true; continue; }
      edges.push({ from: d, to: n.id, kind: it.kind, ...(it.label ? { label: it.label } : {}) });
    }
  }
  if (selfDeps.length) diagnostics.push({ code: 'self-dep', nodes: selfDeps });
  if (depsCut) partialReasons.push('deps');
  if (edgesCut) partialReasons.push('edges');
  // 占位：依赖指向结果之外的编号
  const unknown = [...new Set(edges.map((e) => e.from).filter((id) => !byId.has(id)))];
  const placeholderOverflow = Math.max(0, unknown.length - L.placeholders);
  if (placeholderOverflow) partialReasons.push('placeholders');
  const full = partialReasons.length === 0;
  const kept = new Set(unknown.slice(0, L.placeholders));
  const all: GNode[] = [...nodes, ...[...kept].map((id): GNode => ({ id, label: id, role: '', status: null, progress: null, group: '', placeholder: full ? 'missing' : 'outside' }))];
  const shownEdges = edges.filter((e) => byId.has(e.from) || kept.has(e.from));
  if (full && unknown.length) diagnostics.push({ code: 'missing', ids: unknown });
  const succ = new Map<string, string[]>(), pred = new Map<string, string[]>();
  for (const n of all) { succ.set(n.id, []); pred.set(n.id, []); }
  for (const e of shownEdges) { succ.get(e.from)!.push(e.to); pred.get(e.to)!.push(e.from); }
  // 环（只在真实节点之间；占位没有前置，不会在环里）
  const cyc = findCycle(nodes.map((n) => n.id), succ);
  const blocked = spec.kind === 'dag' && !!cyc;
  if (cyc && spec.kind === 'dag') diagnostics.push({ code: 'cycle', path: cyc });
  const red = new Set<string>();
  // 起点终点与支线终点（只在全量时核）
  let startId: string | null = null, endId: string | null = null, endpointsOk = false;
  if (full && !blocked) {
    const starts = nodes.filter((n) => n.role === 'start').map((n) => n.id), ends = nodes.filter((n) => n.role === 'end').map((n) => n.id);
    if (starts.length !== 1) diagnostics.push({ code: 'start-count', ids: starts });
    if (ends.length !== 1) diagnostics.push({ code: 'end-count', ids: ends });
    if (starts.length === 1 && pred.get(starts[0])!.length) diagnostics.push({ code: 'start-has-deps', id: starts[0] });
    endpointsOk = starts.length === 1 && ends.length === 1 && !pred.get(starts[0])!.length;
    if (starts.length === 1) startId = starts[0];
    if (ends.length === 1) endId = ends[0];
    const isEnd = (n: GNode) => n.role === 'end' || n.role === 'branch_end';
    const leaves = nodes.filter((n) => !succ.get(n.id)!.length && !isEnd(n)).map((n) => n.id);
    if (leaves.length) {
      diagnostics.push({ code: 'unconfirmed-leaf', ids: leaves });
      for (const leaf of leaves) {
        const branch = new Set([leaf]); let grew = true;
        while (grew) { grew = false; for (const id of [...branch]) for (const p of pred.get(id)!) if (!branch.has(p) && byId.has(p) && succ.get(p)!.every((s) => branch.has(s))) { branch.add(p); grew = true; } }
        for (const id of branch) red.add(id);
      }
    }
    const canEnd = reach(nodes.filter(isEnd).map((n) => n.id), pred);
    const noEnd = nodes.filter((n) => !canEnd.has(n.id)).map((n) => n.id);
    if (noEnd.length) { diagnostics.push({ code: 'cannot-reach-end', ids: noEnd }); for (const id of noEnd) red.add(id); }
    if (startId) {
      const fromStart = reach([startId], succ);
      const lost = nodes.filter((n) => !fromStart.has(n.id)).map((n) => n.id);
      if (lost.length) { diagnostics.push({ code: 'unreachable-from-start', ids: lost }); for (const id of lost) red.add(id); }
    }
  }
  // 派生状态
  const hasStatus = !!spec.status_col;
  const doneSet = new Set(spec.done_values?.length ? spec.done_values : ['done']);
  const isDone = (id: string) => { const n = byId.get(id); return !!n && n.status !== null && doneSet.has(n.status); };
  const derived = new Map<string, Derived>(), missingReq = new Map<string, string[]>(), missingOpt = new Map<string, string[]>();
  const early: string[] = [];
  for (const n of nodes) {
    if (!hasStatus) { derived.set(n.id, null); continue; }
    const items = depsOf.get(n.id) ?? [];
    const mr: string[] = [], mo: string[] = [];
    for (const it of items) {
      if (it.kind === 'req' && !isDone(it.ids[0])) mr.push(it.ids[0]);
      if (it.kind === 'any' && !it.ids.some(isDone)) mr.push(it.ids.join('|'));
      if (it.kind === 'opt' && !isDone(it.ids[0])) mo.push(it.ids[0]);
    }
    missingReq.set(n.id, mr); missingOpt.set(n.id, mo);
    const d: Derived = isDone(n.id) ? 'done' : mr.length ? 'waiting' : 'ready';
    derived.set(n.id, d);
    if (d === 'waiting' && n.status === 'doing') early.push(n.id);
  }
  if (early.length) diagnostics.push({ code: 'early-start', ids: early });
  if (hasStatus && spec.source_col) {
    const ids = nodes.filter((n) => isDone(n.id) && !strOf(n.row?.[spec.source_col!]).trim()).map((n) => n.id);
    if (ids.length) diagnostics.push({ code: 'done-without-source', ids });
  }
  // 摘要
  const count = (d: Derived) => (hasStatus ? nodes.filter((n) => derived.get(n.id) === d).length : null);
  const summary: GraphModel['summary'] = { total: nodes.length, done: count('done'), ready: count('ready'), waiting: count('waiting'),
    errors: diagnostics.filter((x) => x.code !== 'early-start' && x.code !== 'done-without-source').length, rate: null, remaining: null, branches: [] };
  if (full && !blocked && hasStatus && endpointsOk && endId) {
    try {
      const budget = { n: 0 };
      const main = requiredClosure(endId, depsOf, byId, isDone, budget);
      const doneN = [...main].filter(isDone).length;
      summary.rate = main.size ? doneN / main.size : null;
      summary.remaining = main.size - doneN;
      for (const b of nodes.filter((n) => n.role === 'branch_end')) {
        const c = requiredClosure(b.id, depsOf, byId, isDone, budget);
        summary.branches.push({ id: b.id, done: [...c].filter(isDone).length, size: c.size });
      }
    } catch (e) {
      if (!(e instanceof TooComplex)) throw e;
      diagnostics.push({ code: 'too-complex' }); summary.note = '依赖太复杂，未算完成率'; summary.rate = null; summary.remaining = null; summary.branches = [];
    }
  }
  const terminalPath = (id: string): GraphHighlight | null => {
    const role = byId.get(id)?.role;
    if (blocked || (role !== 'end' && role !== 'branch_end')) return null;
    try {
      return collectRequiredPath(id, depsOf, byId, isDone, { n: 0 });
    } catch (e) {
      if (!(e instanceof TooComplex)) throw e;
      return null;
    }
  };
  return { nodes: all, edges: shownEdges, full, partialReasons, drawn: nodes.length, placeholderOverflow, blocked, diagnostics, derived, missingReq, missingOpt, red, terminalPath, summary };
}

function reach(from: string[], next: Map<string, string[]>): Set<string> {
  const seen = new Set(from), q = [...from];
  while (q.length) for (const x of next.get(q.pop()!) ?? []) if (!seen.has(x)) { seen.add(x); q.push(x); }
  return seen;
}

/** 有向图里找一条环；找到回节点序列（首尾相同），没有回 null */
export function findCycle(ids: string[], succ: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(), stack: string[] = [];
  const idSet = new Set(ids);
  for (const root of ids) {
    if (state.has(root)) continue;
    const it: { id: string; i: number }[] = [{ id: root, i: 0 }];
    state.set(root, 1); stack.push(root);
    while (it.length) {
      const top = it[it.length - 1];
      const nx = (succ.get(top.id) ?? []).filter((x) => idSet.has(x));
      if (top.i < nx.length) {
        const x = nx[top.i++];
        if (state.get(x) === 1) return [...stack.slice(stack.indexOf(x)), x];
        if (!state.has(x)) { state.set(x, 1); stack.push(x); it.push({ id: x, i: 0 }); }
      } else { state.set(top.id, 2); stack.pop(); it.pop(); }
    }
  }
  return null;
}

class TooComplex extends Error {}

/**
 * 必需闭包（第三节之二「三种边各管什么」「有环时怎么收」）：带当前路径的深度优先。
 * 必需前置撞上当前路径不展开；任一组已满足取书写在前的已完成成员，未满足比较候选（撞上路径的排除），取未完成最少的，平手取书写在前；
 * 全部排除取书写在前的成员。可选前置不收；结果外的编号不收。访问超 50000 次抛 TooComplex。
 */
export function requiredClosure(target: string, depsOf: Map<string, DepItem[]>, byId: Map<string, unknown>, isDone: (id: string) => boolean, budget = { n: 0 }): Set<string> {
  return collectRequiredPath(target, depsOf, byId, isDone, budget).nodes;
}

function collectRequiredPath(target: string, depsOf: Map<string, DepItem[]>, byId: Map<string, unknown>, isDone: (id: string) => boolean, budget: { n: number }): GraphHighlight {
  const result: GraphHighlight = { nodes: new Set(), edges: new Set() };
  const path = new Set<string>();
  collect(target, result);
  return result;

  function collect(id: string, into: GraphHighlight): boolean {
    if (path.has(id)) return true;
    if (into.nodes.has(id) || !byId.has(id)) return false;
    if (++budget.n > TASK_GRAPH_LIMITS.visits) throw new TooComplex();
    into.nodes.add(id);
    path.add(id);
    let hit = false;
    for (const it of depsOf.get(id) ?? []) {
      if (it.kind === 'opt') continue;
      const members = it.ids.filter((m) => byId.has(m));
      if (!members.length) continue;
      const chosen = it.kind === 'req' ? members[0] : members.find(isDone);
      if (chosen !== undefined) {
        into.edges.add(graphEdgeKey({ from: chosen, to: id, kind: it.kind }));
        if (collect(chosen, into)) hit = true;
        continue;
      }

      // 候选独立计分，仍共享当前路径与访问预算。选定后才并入并列依赖的结果。
      let best: { member: string; trial: GraphHighlight; cost: number } | undefined;
      let fallback: GraphHighlight | undefined;
      for (const member of members) {
        const trial: GraphHighlight = { nodes: new Set(), edges: new Set() };
        const revisited = collect(member, trial);
        fallback ??= trial;
        if (revisited) continue;
        const cost = [...trial.nodes].filter((x) => !isDone(x)).length;
        if (!best || cost < best.cost) best = { member, trial, cost };
      }
      const selected = best?.trial ?? fallback!;
      into.edges.add(graphEdgeKey({ from: best?.member ?? members[0], to: id, kind: it.kind }));
      for (const node of selected.nodes) into.nodes.add(node);
      for (const edge of selected.edges) into.edges.add(edge);
      if (!best) hit = true;
    }
    path.delete(id);
    return hit;
  }
}

/** 前置与后继分别遍历，汇合点的其它支路不会随悬停一起高亮。终点只高亮闭包选中的边。 */
export function graphHighlight(model: GraphModel, hovered: string | null, terminal: string | null): GraphHighlight | null {
  if (model.blocked) return null;
  const root = hovered ?? terminal;
  if (root === null || !model.nodes.some((n) => n.id === root)) return null;
  const required = hovered === null ? model.terminalPath(root) : null;
  if (hovered === null && !required) return null;
  const highlight: GraphHighlight = { nodes: new Set([root]), edges: new Set() };
  const predecessors = new Map<string, GEdge[]>(), successors = new Map<string, GEdge[]>();
  for (const e of model.edges) {
    if (required && !required.edges.has(graphEdgeKey(e))) continue;
    const incoming = predecessors.get(e.to) ?? [];
    incoming.push(e);
    predecessors.set(e.to, incoming);
    const outgoing = successors.get(e.from) ?? [];
    outgoing.push(e);
    successors.set(e.from, outgoing);
  }
  trace(predecessors, 'from');
  if (hovered !== null) trace(successors, 'to');
  return highlight;

  function trace(next: Map<string, GEdge[]>, side: 'from' | 'to') {
    const seen = new Set([root!]);
    const pending = [root!];
    while (pending.length) {
      for (const e of next.get(pending.pop()!) ?? []) {
        highlight.edges.add(graphEdgeKey(e));
        const id = e[side];
        if (seen.has(id)) continue;
        seen.add(id);
        highlight.nodes.add(id);
        pending.push(id);
      }
    }
  }
}

export type Placed = { id: string; layer: number; index: number; x: number; y: number };
export const LAYOUT_GAP = { layer: 220, row: 84 } as const;

/** 分层布局：flow 先缩强连通分量；层号 = 最长前置链（三种边都算）；层内两遍重心法；有分组先按组排 */
export function layoutGraph(model: Pick<GraphModel, 'nodes' | 'edges'>, direction: 'LR' | 'TB' = 'LR'): { placed: Map<string, Placed>; edges: GEdge[] } {
  const ids = model.nodes.map((n) => n.id), order = new Map(ids.map((id, i) => [id, i]));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of model.edges) succ.get(e.from)?.push(e.to);
  const comp = scc(ids, succ);
  const compSucc = new Map<number, Set<number>>(), indeg = new Map<number, number>();
  for (const c of new Set(comp.values())) { compSucc.set(c, new Set()); indeg.set(c, 0); }
  for (const e of model.edges) { const a = comp.get(e.from)!, b = comp.get(e.to)!; if (a !== b && !compSucc.get(a)!.has(b)) { compSucc.get(a)!.add(b); indeg.set(b, indeg.get(b)! + 1); } }
  const layerOfComp = new Map<number, number>(), q = [...indeg].filter(([, d]) => d === 0).map(([c]) => c).sort((a, b) => a - b);
  for (const c of q) layerOfComp.set(c, 0);
  while (q.length) { const c = q.shift()!; for (const d of compSucc.get(c)!) { layerOfComp.set(d, Math.max(layerOfComp.get(d) ?? 0, layerOfComp.get(c)! + 1)); indeg.set(d, indeg.get(d)! - 1); if (indeg.get(d) === 0) q.push(d); } }
  const layers: string[][] = [];
  for (const id of ids) { const l = layerOfComp.get(comp.get(id)!) ?? 0; (layers[l] ??= []).push(id); }
  const group = new Map(model.nodes.map((n) => [n.id, n.group]));
  const groups = [...new Set(model.nodes.map((n) => n.group))];
  const pos = new Map<string, number>();
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of model.edges) preds.get(e.to)?.push(e.from);
  layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  for (let pass = 0; pass < 2; pass++) for (const l of layers.slice(1)) {
    if (!l) continue;
    const bary = (id: string) => { const ps = preds.get(id)!.filter((p) => pos.has(p)); return ps.length ? ps.reduce((s, p) => s + pos.get(p)!, 0) / ps.length : pos.get(id)!; };
    const key = new Map(l.map((id) => [id, bary(id)]));
    l.sort((a, b) => groups.indexOf(group.get(a)!) - groups.indexOf(group.get(b)!) || key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
    l.forEach((id, i) => pos.set(id, i));
  }
  if (layers[0]) layers[0].sort((a, b) => groups.indexOf(group.get(a)!) - groups.indexOf(group.get(b)!) || order.get(a)! - order.get(b)!);
  const placed = new Map<string, Placed>();
  layers.forEach((l, li) => l?.forEach((id, i) => {
    const along = li * LAYOUT_GAP.layer, across = i * LAYOUT_GAP.row;
    placed.set(id, { id, layer: li, index: i, x: direction === 'LR' ? along : across, y: direction === 'LR' ? across : along });
  }));
  const edges = model.edges.map((e) => ({ ...e, back: comp.get(e.from) === comp.get(e.to) || (placed.get(e.from)!.layer >= placed.get(e.to)!.layer) }));
  return { placed, edges };
}

/** Tarjan 强连通分量（迭代写法，节点多也不爆栈）；回节点 → 分量编号 */
export function scc(ids: string[], succ: Map<string, string[]>): Map<string, number> {
  let index = 0, compN = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = [], comp = new Map<string, number>();
  for (const root of ids) {
    if (idx.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    idx.set(root, index); low.set(root, index); index++; st.push(root); on.add(root);
    while (work.length) {
      const top = work[work.length - 1], nx = succ.get(top.id) ?? [];
      if (top.i < nx.length) {
        const w = nx[top.i++];
        if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; st.push(w); on.add(w); work.push({ id: w, i: 0 }); }
        else if (on.has(w)) low.set(top.id, Math.min(low.get(top.id)!, idx.get(w)!));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].id; low.set(p, Math.min(low.get(p)!, low.get(top.id)!)); }
        if (low.get(top.id) === idx.get(top.id)) { let w: string; do { w = st.pop()!; on.delete(w); comp.set(w, compN); } while (w !== top.id); compN++; }
      }
    }
  }
  return comp;
}

/** 等价表格的行：名称、状态、派生状态、进度、前置、后继、角色 */
export function graphTableRows(model: GraphModel): { id: string; label: string; status: string; derived: string; progress: string; preds: string; succs: string; role: string }[] {
  const p = new Map<string, string[]>(), s = new Map<string, string[]>();
  for (const e of model.edges) { (p.get(e.to) ?? p.set(e.to, []).get(e.to)!).push(e.from); (s.get(e.from) ?? s.set(e.from, []).get(e.from)!).push(e.to); }
  const derivedText: Record<string, string> = { done: '已完成', ready: '可开始', waiting: '等前置' };
  const roleText: Record<string, string> = { start: '起点', end: '主线终点', branch_end: '支线终点', '': '' };
  return model.nodes.filter((n) => !n.placeholder).map((n) => ({ id: n.id, label: n.label, status: n.status ?? '', derived: derivedText[model.derived.get(n.id) ?? ''] ?? '',
    progress: n.progress === null ? '' : `${n.progress}%`, preds: (p.get(n.id) ?? []).join('、'), succs: (s.get(n.id) ?? []).join('、'), role: roleText[n.role] }));
}

/**
 * 实时刷新后「刚刚动了」的任务（设计稿第五节之六第 4 条）：和上一次画的相比，状态或进度变了的任务。
 * prev 为 null（第一次画）时不算变化；新出现的任务不算（它本来就没画过）。返回这一次的指纹，留给下一次比。
 */
export function changedNodes(prev: Map<string, string> | null, model: Pick<GraphModel, 'nodes'>): { fingerprints: Map<string, string>; changed: Set<string> } {
  const fingerprints = new Map<string, string>(), changed = new Set<string>();
  for (const n of model.nodes) {
    if (n.placeholder) continue;
    const fp = JSON.stringify([n.status, n.progress]);
    fingerprints.set(n.id, fp);
    if (prev && prev.has(n.id) && prev.get(n.id) !== fp) changed.add(n.id);
  }
  return { fingerprints, changed };
}
