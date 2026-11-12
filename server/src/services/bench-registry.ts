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
 */
import { db } from '../db.ts';
import { BenchError } from '../bench-query.ts';
import { BENCH_SLUG_RE } from './bench-store-core.ts';

export type BenchBinding = { department_id: string; team_host: string; team: string };
export type BenchEntry = { slug: string; title: string; created_by: string; created_at: number } & BenchBinding;
/** 登记的台最多这么多：每个台的在用数据有上限，台数也要有界 */
export const MAX_BENCHES = 500;
const DEPARTMENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const COLS = 'slug, title, created_by, created_at, department_id, team_host, team';

const row = (r: Record<string, unknown>): BenchEntry => ({ slug: String(r.slug), title: String(r.title), created_by: String(r.created_by), created_at: Number(r.created_at), department_id: String(r.department_id ?? ''), team_host: String(r.team_host ?? ''), team: String(r.team ?? '') });
const bindingText = (b: BenchBinding): string => (b.department_id ? `${b.department_id}${b.team ? ` / ${b.team_host} ${b.team}` : ''}` : '');

export function listBenches(): BenchEntry[] {
  return (db.prepare(`SELECT ${COLS} FROM bench_views ORDER BY slug`).all() as Record<string, unknown>[]).map(row);
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

/** 登记一个新台。标识：小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符；已有的拒绝。可以同时绑到部门 */
export function createBench(input: unknown, actor: string, at: number): BenchEntry {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['slug', 'title', 'department', 'team_host', 'team'].includes(k));
  if (extra.length) throw new BenchError('invalid', `登记台时有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  if (typeof o.slug !== 'string' || !BENCH_SLUG_RE.test(o.slug)) throw new BenchError('invalid', '台的标识须为小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符');
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 64) throw new BenchError('invalid', '台的名字须为 1～64 个字符');
  const b = parseBinding(o);
  if (getBench(o.slug)) throw new BenchError('conflict', `已经有标识是 ${o.slug} 的台`);
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM bench_views').get() as { n: number }).n);
  if (n >= MAX_BENCHES) throw new BenchError('limit', `登记的台已经到上限 ${MAX_BENCHES} 个`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO bench_views (slug, title, created_by, created_at, department_id, team_host, team) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.slug, o.title.trim(), actor, at, b.department_id, b.team_host, b.team);
    if (b.department_id) db.prepare('INSERT INTO bench_bind_audit (slug, action, before, after, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(o.slug, 'bind', '', bindingText(b), actor, at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { slug: o.slug, title: o.title.trim(), created_by: actor, created_at: at, ...b };
}

/** 改一个台绑到哪里（整份替换；department 给空串就是解绑）。和现在一样的不留痕 */
export function bindBench(slug: string, input: unknown, actor: string, at: number): { bench: BenchEntry; changed: boolean } {
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
    db.exec('COMMIT');
    return { bench: { ...cur, ...b }, changed };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
