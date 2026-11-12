/**
 * 视图台的登记（数据视图，docs/data-views.md 第二节）：主库里的一张表，只记有这个台、叫什么、谁建的。
 * 台里的数据不在这里，在台自己的库里（services/bench-store.ts）。
 *
 * 登记过的台才有库：对外的入口先到这里核标识，没登记的一律当作不存在——
 * 否则任何人拿一个新标识来问一句，就会在数据目录里建出一个库文件。
 * 删台不在这里做（要走人审），所以没有删除。
 */
import { db } from '../db.ts';
import { BenchError } from '../bench-query.ts';
import { BENCH_SLUG_RE } from './bench-store-core.ts';

export type BenchEntry = { slug: string; title: string; created_by: string; created_at: number };
/** 登记的台最多这么多：每个台的在用数据有上限，台数也要有界 */
export const MAX_BENCHES = 500;

const row = (r: Record<string, unknown>): BenchEntry => ({ slug: String(r.slug), title: String(r.title), created_by: String(r.created_by), created_at: Number(r.created_at) });

export function listBenches(): BenchEntry[] {
  return (db.prepare('SELECT slug, title, created_by, created_at FROM bench_views ORDER BY slug').all() as Record<string, unknown>[]).map(row);
}

export function getBench(slug: unknown): BenchEntry | null {
  if (typeof slug !== 'string' || !BENCH_SLUG_RE.test(slug)) return null;
  const r = db.prepare('SELECT slug, title, created_by, created_at FROM bench_views WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

/** 登记一个新台。标识：小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符；已有的拒绝 */
export function createBench(input: unknown, actor: string, at: number): BenchEntry {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'slug' && k !== 'title');
  if (extra.length) throw new BenchError('invalid', `登记台时有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  if (typeof o.slug !== 'string' || !BENCH_SLUG_RE.test(o.slug)) throw new BenchError('invalid', '台的标识须为小写字母或数字开头，只含小写字母、数字、连字符，最多 64 个字符');
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 64) throw new BenchError('invalid', '台的名字须为 1～64 个字符');
  if (getBench(o.slug)) throw new BenchError('conflict', `已经有标识是 ${o.slug} 的台`);
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM bench_views').get() as { n: number }).n);
  if (n >= MAX_BENCHES) throw new BenchError('limit', `登记的台已经到上限 ${MAX_BENCHES} 个`);
  db.prepare('INSERT INTO bench_views (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').run(o.slug, o.title.trim(), actor, at);
  return { slug: o.slug, title: o.title.trim(), created_by: actor, created_at: at };
}
