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

/** 表格「取值 → 说法」对照（value_labels：列名 → 取值 → 说法）。与页面用的那份（web/src/bench-blocks/blocks-view.ts 的 valueLabel）等价：
 *  只认对照自己带的键；说法可以只写文字，也可以是 { text, tone }，这里只取文字。没给对照的返回 null。 */
export function tableValueLabel(labels: unknown, column: string, value: unknown): string | null {
  if (!labels || typeof labels !== 'object' || !Object.hasOwn(labels, column)) return null;
  const map = (labels as Record<string, unknown>)[column], key = String(value);
  if (!map || typeof map !== 'object' || !Object.hasOwn(map, key)) return null;
  const hit = (map as Record<string, unknown>)[key];
  if (typeof hit === 'string' && hit) return hit;
  if (hit && typeof hit === 'object' && typeof (hit as { text?: unknown }).text === 'string' && (hit as { text: string }).text) return (hit as { text: string }).text;
  return null;
}
/** 说明列的表头：原表头后面加「（说明）」，一眼能看出它不是原值。 */
export const wordingHead = (head: string): string => head + '（说明）';

/** CSV is quoted RFC4180, with formula-shaped text neutralized (numeric values remain numeric).
 *  原值列的表头与内容原样不动。传了 value_labels 时，配了对照的列在后面各追加一列说明（页面显示的说法），
 *  取值没有对照的说明格留空——这样读 CSV 的人既能拿到原值，也能看懂它的意思。 */
export function tableCsv(columns: { name: string; label?: string }[], rows: Record<string, unknown>[], valueLabels?: unknown): string {
  const cell = (v: unknown): string => {
    let text = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[\s\u0000-\u0020]*[=+@-]/u.test(v)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const labelled = valueLabels && typeof valueLabels === 'object' ? columns.filter(c => Object.hasOwn(valueLabels, c.name)) : [];
  const head = (c: { name: string; label?: string }, i: number): string => cell(c.label || `第 ${i + 1} 列`);
  const header = [...columns.map(head), ...labelled.map(c => wordingHead(c.label || `第 ${columns.indexOf(c) + 1} 列`))];
  const line = (row: Record<string, unknown>): string => [
    ...columns.map(c => cell(row[c.name])),
    ...labelled.map(c => cell(tableValueLabel(valueLabels, c.name, row[c.name]) ?? '')),
  ].join(',');
  return '\ufeff' + [header.join(','), ...rows.map(line)].join('\r\n') + '\r\n';
}
