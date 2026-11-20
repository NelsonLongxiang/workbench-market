/** Saved-table access contract. Never accepts an arbitrary dataset, query or URL from a browser. */
import { createHash } from 'node:crypto';
import { BenchError } from './bench-query.ts';

export type TableTarget = { view: string; block: number; version: number; revision: string; params?: Record<string, unknown> };
export function tableTarget(value: unknown): TableTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BenchError('invalid', '要给表格上下文');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['view','block','version','revision','params'].includes(k)) || typeof v.view !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(v.view) || !Number.isSafeInteger(v.block) || Number(v.block) < 0 || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision)) throw new BenchError('invalid', '表格需要有效的视图、块、版本和读取修订');
  if (v.params !== undefined && (!v.params || typeof v.params !== 'object' || Array.isArray(v.params))) throw new BenchError('invalid', '筛选参数须为对象');
  return v as TableTarget;
}
/** Stable hashes do not depend on object insertion order (PostgreSQL JSON objects may arrive in another order). */
const stable = (v: unknown): string => v === undefined ? 'null' : v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
export const tableDigest = (v: unknown): string => createHash('sha256').update(stable(v)).digest('hex');

/** CSV is quoted RFC4180, with formula-shaped text neutralized (numeric values remain numeric). */
export function tableCsv(columns: { name: string; label?: string }[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown): string => {
    let text = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[\s\u0000-\u0020]*[=+@-]/u.test(v)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\ufeff' + [columns.map((c, i) => cell(c.label || `第 ${i + 1} 列`)).join(','), ...rows.map(row => columns.map(c => cell(row[c.name])).join(','))].join('\r\n') + '\r\n';
}
