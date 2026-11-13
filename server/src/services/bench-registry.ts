/**
 * 视图台的登记（数据视图，docs/data-views.md 第二节）：主库里的一张表，只记有这个台、叫什么、谁建的。
 * 台里的数据不在这里，在台自己的库里（services/bench-store.ts）。
 *
 * 登记过的台才有库：对外的入口先到这里核标识，没登记的一律当作不存在——
 * 否则任何人拿一个新标识来问一句，就会在数据目录里建出一个库文件。
 * 删台不在这里做（要走人审），所以没有删除。
 *
 * 台可以绑到一个部门（必要时细到这个部门下的一个团队）：绑了，这个部门里有已放行授予的人才进得来（判断在路由里，问 scopedVerdict）；
 * 没绑，只有管理层。绑定的改动都留痕。
 *
 * 卡片 id 为主、台标识为别名（docs/data-views.md 第十三节第 5 条第 3 步）：台对应市场上的哪张卡片记在 workbench_id。
 * 对外的入口写卡片 id（纯数字）或台标识都认，先经 resolveBenchRef 换成台标识；台库文件、授予照旧按台标识记，不改名、不搬数据。
 * 给一张卡片开台库时不用起名字：标识由服务端定成 wb-<卡片 id>。纯数字的标识不许登记（会和卡片 id 混）。
 * 删卡片时这里的登记、授予一起删（removeCardBench），台库文件和 Redis 键由删卡片的那一处接着清。
 */
import { db } from '../db.ts';
import { BenchError } from '../bench-query.ts';
import { BENCH_SLUG_RE } from './bench-store-core.ts';
import { benchStoreExists } from './bench-store.ts';

export type BenchBinding = { department_id: string; team_host: string; team: string };
export type BenchEntry = { slug: string; title: string; created_by: string; created_at: number; workbench_id: number | null } & BenchBinding;
/** 登记的台最多这么多：每个台的在用数据有上限，台数也要有界 */
export const MAX_BENCHES = 500;
const DEPARTMENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
/** 写成卡片 id 的台的引用 */
const CARD_REF_RE = /^[1-9]\d{0,15}$/;
/** 服务端给卡片定的台标识 */
const CARD_SLUG_RE = /^wb-([1-9]\d{0,15})$/;
export const cardSlug = (workbenchId: number): string => `wb-${workbenchId}`;
// workbench_id：对应的登记台还在才给，删了按没有对应（null）
const COLS = 'slug, title, created_by, created_at, department_id, team_host, team, (SELECT w.id FROM workbenches w WHERE w.id = bench_views.workbench_id) AS workbench_id';

const row = (r: Record<string, unknown>): BenchEntry => ({ slug: String(r.slug), title: String(r.title), created_by: String(r.created_by), created_at: Number(r.created_at), department_id: String(r.department_id ?? ''), team_host: String(r.team_host ?? ''), team: String(r.team ?? ''), workbench_id: r.workbench_id === null || r.workbench_id === undefined ? null : Number(r.workbench_id) });
const bindingText = (b: BenchBinding): string => (b.department_id ? `${b.department_id}${b.team ? ` / ${b.team_host} ${b.team}` : ''}` : '');

export function listBenches(): BenchEntry[] {
  return (db.prepare(`SELECT ${COLS} FROM bench_views ORDER BY slug`).all() as Record<string, unknown>[]).map(row);
}

/**
 * 把对外写的台的引用换成台标识：纯数字是卡片 id（换成对应的台；这张卡片没有台、或卡片已删时原样返回，按台标识找也找不到），
 * 别的原样。只换写法，不核权限、不核存不存在
 */
export function resolveBenchRef(ref: string): string {
  if (!CARD_REF_RE.test(ref)) return ref;
  const r = db.prepare('SELECT b.slug FROM bench_views b JOIN workbenches w ON w.id = b.workbench_id WHERE b.workbench_id = ?').get(Number(ref)) as { slug: string } | undefined;
  return r ? r.slug : ref;
}
/** 这张卡片对应的台（没有是 null） */
export function benchOfCard(workbenchId: number): BenchEntry | null {
  const r = db.prepare(`SELECT ${COLS} FROM bench_views WHERE workbench_id = ?`).get(workbenchId) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

export function getBench(slug: unknown): BenchEntry | null {
  if (typeof slug !== 'string' || !BENCH_SLUG_RE.test(slug)) return null;
  const r = db.prepare(`SELECT ${COLS} FROM bench_views WHERE slug = ?`).get(slug) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

/**
 * 核一份绑定的写法：department 是部门表里有的标识（不写或空串是不绑）；team 要写就得连 team_host 一起写，而且这个团队已经认领到这个部门。
 * 只核「写得对不对、指的东西在不在」；这个人能不能绑到这个部门，路由里判。
 */
export function parseBinding(o: Record<string, unknown>): BenchBinding {
  const dep = o.department === undefined || o.department === null ? '' : o.department;
  if (typeof dep !== 'string' || (dep !== '' && !DEPARTMENT_ID_RE.test(dep))) throw new BenchError('invalid', 'department 要是部门的标识');
  const host = o.team_host === undefined || o.team_host === null ? '' : o.team_host, team = o.team === undefined || o.team === null ? '' : o.team;
  if (typeof host !== 'string' || typeof team !== 'string' || host.length > 200 || team.length > 200) throw new BenchError('invalid', 'team_host、team 要是文字');
  if ((host === '') !== (team === '')) throw new BenchError('invalid', 'team_host 和 team 要一起给');
  if (team && !dep) throw new BenchError('invalid', '细到团队的台要先绑到部门');
  if (dep && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(dep)) throw new BenchError('not_found', `没有部门 ${dep}`);
  if (team) {
    const t = db.prepare('SELECT department_id, claimed FROM teams WHERE host = ? AND team = ?').get(host, team) as { department_id: string; claimed: number } | undefined;
    if (!t || !t.claimed || t.department_id !== dep) throw new BenchError('invalid', '这个团队没有认领到这个部门');
  }
  return { department_id: dep, team_host: host, team };
}

/** 核对应的登记台号：null 是不对应；给了就要是正整数，而且市场里登记着这个台 */
export function parseWorkbenchId(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new BenchError('invalid', 'workbench_id 要是登记的台号（正整数），或者 null');
  if (!db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(v)) throw new BenchError('not_found', `没有登记的台 ${v}`);
  return v;
}
const workbenchTaken = (id: number, slug: string): boolean => !!db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ? AND slug <> ?').get(id, slug);
/**
 * 以前登记过纯数字标识的旧台（那时还许）：卡片 n 一旦对应了别的台，写 n 就认成那个台，旧台「n」用数字的写法再也取不到。
 * 所以要给卡片 n 对应一个台时，已经有标识正好是「n」的旧台，就拒绝——除非对应的就是这个旧台本身（这正好消除了歧义）
 */
function shadowCheck(workbenchId: number, slug: string): void {
  const legacy = String(workbenchId);
  if (slug !== legacy && getBench(legacy)) throw new BenchError('conflict', `已经有一个标识是 ${legacy} 的旧台：卡片 ${workbenchId} 对应别的台以后，写 ${legacy} 就再也取不到那个旧台。先把旧台 ${legacy} 对应到卡片 ${workbenchId}，或者给它另登记一个台`);
}
/** 纯数字标识的旧台（现在不许登记，以前登记过的还在）：启动时报出来，由管理层处理 */
export function numericSlugs(): string[] {
  return (db.prepare('SELECT slug FROM bench_views ORDER BY slug').all() as { slug: string }[]).map((r) => r.slug).filter((x) => /^\d+$/.test(x));
}

/** 登记一个新台。标识：小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符；已有的拒绝。可以同时绑到部门 */
export function createBench(input: unknown, actor: string, at: number): BenchEntry {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['slug', 'title', 'department', 'team_host', 'team', 'workbench_id'].includes(k));
  if (extra.length) throw new BenchError('invalid', `登记台时有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  const wb = o.workbench_id === undefined ? null : parseWorkbenchId(o.workbench_id);
  // 给卡片开台库：不给标识就是 wb-<卡片 id>，不给名字就用卡片的名字
  if (o.slug === undefined && wb !== null) o.slug = cardSlug(wb);
  if (o.title === undefined && wb !== null) o.title = String((db.prepare('SELECT name FROM workbenches WHERE id = ?').get(wb) as { name: string }).name).trim().slice(0, 64) || `台 ${wb}`;
  if (typeof o.slug !== 'string' || !BENCH_SLUG_RE.test(o.slug)) throw new BenchError('invalid', '台的标识须为小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符');
  if (/^\d+$/.test(o.slug)) throw new BenchError('invalid', '台的标识不能全是数字（全是数字的写法留给卡片 id）');
  const own = CARD_SLUG_RE.exec(o.slug);
  if (own && Number(own[1]) !== wb) throw new BenchError('invalid', `标识 ${o.slug} 留给卡片 ${own[1]}：要用它，workbench_id 写 ${own[1]}`);
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 64) throw new BenchError('invalid', '台的名字须为 1～64 个字符');
  const b = parseBinding(o);
  if (getBench(o.slug)) throw new BenchError('conflict', `已经有标识是 ${o.slug} 的台`);
  // 以前删过的同名台，库文件还没清掉（清扫会补上）：不能让新台接着用旧数据
  if (benchStoreExists(o.slug)) throw new BenchError('conflict', `标识 ${o.slug} 以前用过，它的库还在清理，稍后再登记或换一个标识`);
  if (wb !== null && workbenchTaken(wb, o.slug)) throw new BenchError('conflict', `登记的台 ${wb} 已经对应了别的视图台`);
  if (wb !== null) shadowCheck(wb, o.slug);
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM bench_views').get() as { n: number }).n);
  if (n >= MAX_BENCHES) throw new BenchError('limit', `登记的台已经到上限 ${MAX_BENCHES} 个`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO bench_views (slug, title, created_by, created_at, department_id, team_host, team, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(o.slug, o.title.trim(), actor, at, b.department_id, b.team_host, b.team, wb);
    if (wb !== null) db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(o.slug, 'workbench', '', String(wb), actor, at);
    if (b.department_id) db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(o.slug, 'bind', '', bindingText(b), actor, at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { slug: o.slug, title: o.title.trim(), created_by: actor, created_at: at, workbench_id: wb, ...b };
}

/**
 * 改一个台绑到哪里（整份替换；department 给空串就是解绑）。和现在一样的不留痕。
 * 部门变了（含解绑、从没绑到绑上）：这个台上已经批给 MCP 会话的授予全部收回、没定的申请全部驳回——
 * 那些是原来管这个台的人批的，台换了主人，不该原样带过去；要用的重新申请，由新部门的人批。只是在同一个部门里细到团队或放开，不动。
 */
export function bindBench(slug: string, input: unknown, actor: string, at: number): { bench: BenchEntry; changed: boolean; revoked_mcp_grants: number; rejected_mcp_requests: number } {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['department', 'team_host', 'team', 'note'].includes(k));
  if (extra.length) throw new BenchError('invalid', `改绑时有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  if (o.department === undefined) throw new BenchError('invalid', '要给 department（部门的标识；空串是解绑）');
  const b = parseBinding(o);
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = getBench(slug);
    if (!cur) throw new BenchError('not_found', '没有这个台');
    const changed = cur.department_id !== b.department_id || cur.team_host !== b.team_host || cur.team !== b.team;
    if (changed) {
      db.prepare('UPDATE bench_views SET department_id = ?, team_host = ?, team = ? WHERE slug = ?').run(b.department_id, b.team_host, b.team, slug);
      db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, b.department_id ? 'bind' : 'unbind', bindingText(cur), bindingText(b), actor, note, at);
    }
    let revoked = 0, rejected = 0;
    if (cur.department_id !== b.department_id) {
      const why = `台改绑（${bindingText(cur) || '没绑'} → ${bindingText(b) || '没绑'}），原来的授予收回`;
      const held = db.prepare('SELECT session_id, tool FROM bench_mcp_grants WHERE bench = ? ORDER BY session_id, tool').all(slug) as { session_id: number; tool: string }[];
      const bySession = new Map<number, string[]>();
      for (const g of held) bySession.set(g.session_id, [...(bySession.get(g.session_id) ?? []), g.tool]);
      for (const [sessionId, tools] of bySession) db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, sessionId, 'revoke', JSON.stringify(tools), actor, why, at);
      revoked = Number(db.prepare('DELETE FROM bench_mcp_grants WHERE bench = ?').run(slug).changes);
      // 没定的申请逐条驳回，各留一行痕（和人手驳回的留痕同一个样子）
      for (const q of db.prepare("SELECT id, session_id, tools FROM bench_mcp_requests WHERE bench = ? AND status = 'pending' ORDER BY id").all(slug) as { id: number; session_id: number; tools: string }[]) {
        db.prepare("UPDATE bench_mcp_requests SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(actor, at, '台改绑了，请重新申请', q.id);
        db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, request_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slug, q.session_id, 'reject', q.tools, actor, q.id, why, at);
        rejected++;
      }
    }
    db.exec('COMMIT');
    return { bench: { ...cur, ...b }, changed, revoked_mcp_grants: revoked, rejected_mcp_requests: rejected };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * 改一个台对应市场登记的哪个台（null 是去掉对应）。一个登记的台最多对应一个视图台：已经被别的视图台占着的拒绝（409）。
 * 和现在一样的不留痕；变了在绑定的留痕表里记一行（action = workbench）。只是对应关系，不动谁进得来，所以不收授予。
 */
export function linkWorkbench(slug: string, input: unknown, actor: string, at: number): { bench: BenchEntry; changed: boolean } {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['workbench_id', 'note'].includes(k));
  if (extra.length) throw new BenchError('invalid', `有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  if (o.workbench_id === undefined) throw new BenchError('invalid', '要给 workbench_id（登记的台号；null 是去掉对应）');
  const wb = parseWorkbenchId(o.workbench_id);
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = getBench(slug);
    if (!cur) throw new BenchError('not_found', '没有这个台');
    if (wb !== null && workbenchTaken(wb, slug)) throw new BenchError('conflict', `登记的台 ${wb} 已经对应了别的视图台`);
    if (wb !== null) shadowCheck(wb, slug);
    const changed = cur.workbench_id !== wb;
    if (changed) {
      db.prepare('UPDATE bench_views SET workbench_id = ? WHERE slug = ?').run(wb, slug);
      db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, 'workbench', cur.workbench_id === null ? '' : String(cur.workbench_id), wb === null ? '' : String(wb), actor, note, at);
    }
    db.exec('COMMIT');
    return { bench: getBench(slug)!, changed };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * 删卡片时用：在一个事务里删掉这张卡片对应的台的登记、收回台上的全部 MCP 授予、驳回没定的申请（各留一行痕），
 * 再调 deleteCard（删卡片本身和它在主库里的别的东西），一起提交。返回被删的台的标识（没有台是 null）。
 * 台库文件和 Redis 键不在事务里，由调用方在提交之后清（清不掉的由清扫补上）。
 */
export function removeCardBench(workbenchId: number, actor: string, at: number, note: string, deleteCard: (slug: string | null) => void): string | null {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = benchOfCard(workbenchId);
    const slug = cur?.slug ?? null;
    if (slug) {
      const why = `卡片 ${workbenchId} 已删${note ? `：${note}` : ''}`;
      const held = db.prepare('SELECT session_id, tool FROM bench_mcp_grants WHERE bench = ? ORDER BY session_id, tool').all(slug) as { session_id: number; tool: string }[];
      const bySession = new Map<number, string[]>();
      for (const g of held) bySession.set(g.session_id, [...(bySession.get(g.session_id) ?? []), g.tool]);
      for (const [sessionId, tools] of bySession) db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, sessionId, 'revoke', JSON.stringify(tools), actor, why, at);
      db.prepare('DELETE FROM bench_mcp_grants WHERE bench = ?').run(slug);
      for (const q of db.prepare("SELECT id, session_id, tools FROM bench_mcp_requests WHERE bench = ? AND status = 'pending' ORDER BY id").all(slug) as { id: number; session_id: number; tools: string }[]) {
        db.prepare("UPDATE bench_mcp_requests SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(actor, at, '卡片已删', q.id);
        db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, request_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slug, q.session_id, 'reject', q.tools, actor, q.id, why, at);
      }
      db.prepare('DELETE FROM bench_views WHERE slug = ?').run(slug);
      db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, 'delete', String(workbenchId), '', actor, note.slice(0, 500), at);
    }
    deleteCard(slug);
    db.exec('COMMIT');
    return slug;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** 清扫用：登记着的台的标识，和还在的卡片 id */
export function registeredSlugs(): Set<string> {
  return new Set((db.prepare('SELECT slug FROM bench_views').all() as { slug: string }[]).map((r) => r.slug));
}
export function liveCardIds(): Set<number> {
  return new Set((db.prepare('SELECT id FROM workbenches').all() as { id: number }[]).map((r) => Number(r.id)));
}

