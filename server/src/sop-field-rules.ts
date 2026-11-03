/** SOP 字段规则：从 sop.yaml 步骤 HTML 里的 data-field 控件读取原生校验属性
 *  （required / pattern / minlength / maxlength / type=url|number|date|month / min / max），
 *  完成（finish）时在服务端按同一套规则校验 run 数据。执行页边填边存草稿，所以只在完成时拦。
 *  没写这些属性的 SOP 不受影响。 */
import type { SopManifest } from './sop-types.ts';

export interface FieldRule {
  step: string; field: string; label: string;
  required: boolean; pattern?: string; minlength?: number; maxlength?: number;
  type?: string; min?: number; max?: number; message?: string;
}

const TAG_RE = /<(input|textarea|select)\b([^>]*)>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const MAX_PATTERN_INPUT = 20000;

function attrs(src: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const m of src.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? true;
  return out;
}
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function extractFieldRules(manifest: SopManifest): FieldRule[] {
  const rules: FieldRule[] = [];
  for (const step of manifest.steps ?? []) {
    for (const m of String(step.body ?? '').matchAll(TAG_RE)) {
      const a = attrs(m[2]);
      const field = typeof a['data-field'] === 'string' ? a['data-field'] : '';
      if (!field) continue;
      const num = (k: string) => (typeof a[k] === 'string' && a[k] !== '' && Number.isFinite(Number(a[k])) ? Number(a[k]) : undefined);
      const r: FieldRule = { step: step.key, field, label: typeof a['data-label'] === 'string' ? decode(a['data-label']) : field, required: a.required !== undefined };
      if (typeof a.pattern === 'string') { try { new RegExp(`^(?:${decode(a.pattern)})$`, 'u'); r.pattern = decode(a.pattern); } catch { /* 坏正则：浏览器也会忽略，这里同样忽略 */ } }
      r.minlength = num('minlength'); r.maxlength = num('maxlength'); r.min = num('min'); r.max = num('max');
      if (m[1].toLowerCase() === 'input' && typeof a.type === 'string') r.type = a.type.toLowerCase();
      if (typeof a['data-error'] === 'string') r.message = decode(a['data-error']);
      if (r.required || r.pattern || r.minlength !== undefined || r.maxlength !== undefined || ['url', 'number', 'date', 'month', 'email'].includes(r.type ?? '')) rules.push(r);
    }
  }
  return rules;
}

/** data 形态与执行页一致：{ [stepKey]: { [field]: value } }。返回违约说明（空 = 通过）。 */
export function checkRunData(rules: FieldRule[], data: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const r of rules) {
    const stepVal = data?.[r.step];
    const raw = stepVal && typeof stepVal === 'object' ? (stepVal as Record<string, unknown>)[r.field] : undefined;
    const v = raw === undefined || raw === null || raw === false ? '' : raw === true ? 'true' : String(raw).trim();
    const name = `${r.step}.${r.label}`;
    const why = (msg: string) => errs.push(`${name}：${r.message ?? msg}`);
    if (!v) { if (r.required) errs.push(`${name}：必填`); continue; }  // 自定义提示（data-error）只用于格式错误
    if (r.minlength !== undefined && v.length < r.minlength) why(`至少 ${r.minlength} 字`);
    if (r.maxlength !== undefined && v.length > r.maxlength) why(`最多 ${r.maxlength} 字`);
    if (r.pattern) {
      if (v.length > MAX_PATTERN_INPUT) why(`超过 ${MAX_PATTERN_INPUT} 字，未做格式核对`);
      else if (!new RegExp(`^(?:${r.pattern})$`, 'u').test(v)) why('格式不符');
    }
    if (r.type === 'url') { try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) why('须为 http(s) 链接'); } catch { why('不是合法链接'); } }
    if (r.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) why('不是合法邮箱');
    if (r.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) why('日期须为 YYYY-MM-DD');
    if (r.type === 'month' && !/^\d{4}-\d{2}$/.test(v)) why('月份须为 YYYY-MM');
    if (r.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) why('须为数字');
      else { if (r.min !== undefined && n < r.min) why(`不小于 ${r.min}`); if (r.max !== undefined && n > r.max) why(`不大于 ${r.max}`); }
    }
  }
  return errs;
}
