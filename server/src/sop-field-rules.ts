/** SOP 字段规则：从 sop.yaml 步骤 HTML 里的 data-field 控件读取原生校验属性
 *  （required / pattern / minlength / maxlength / type=url|number|date|month / min / max），
 *  以及条件必填 data-required-if="<字段>=<值1>|<值2>"（字段写 <步骤>.<字段> 可跨步；条件成立才必填，不成立时只核格式），
 *  完成（finish）时在服务端按同一套规则校验 run 数据。执行页边填边存草稿，所以只在完成时拦。
 *  #437① 文件清单字段：<textarea data-field data-type="file-list" data-roles="a|b" data-statuses="x|y" data-min-items data-max-items>，
 *  值是行对象数组 [{file_id, name, role, source, period, status, sha256, size, mime}]；这里核结构，完成时另按文件面实际 hash 逐行核。
 *  data-void-statuses="作废" 标出「不算数」的状态：这些行照样核结构，但不计入必填与 data-min-items。
 *  #471 字段间数值关系 data-check="<表达式>"：如 public_count <= public_target、overlap + only_a = count_a。
 *  表达式只认字段名（同步的 field，跨步写 step.field）、数字、+ - 和一个比较（<= >= < > =），不执行任意脚本；
 *  控件自己为空、或引用的字段有空值或不是数字时跳过（必填与数字格式由已有规则管）；写错的表达式当作没有这条规则。
 *  提示用 data-check-error，没写就给默认文案。执行页嵌入下面同一份 parseCheckExpr / evalCheckExpr 源码，两边同一语义。
 *  没写这些属性的 SOP 不受影响。 */
import type { SopManifest } from './sop-types.ts';

export interface FieldRule {
  step: string; field: string; label: string;
  required: boolean; pattern?: string; minlength?: number; maxlength?: number;
  type?: string; min?: number; max?: number; message?: string;
  /** 条件必填：只有 requiredIf.step 步骤里 requiredIf.field 的值在 values 里时才必填 */
  requiredIf?: { step: string; field: string; values: string[] };
  /** #437① 文件清单（type === 'file-list'）：可选角色、状态清单与行数上下限 */
  roles?: string[]; statuses?: string[]; minItems?: number; maxItems?: number;
  /** 不计数的状态（如「作废」）：必填与最少行数只数其余的行 */
  voidStatuses?: string[];
  /** #471 字段间数值关系：parsed 为 parseCheckExpr 的结果；message 来自 data-check-error */
  check?: { expr: string; parsed: CheckExpr; message?: string };
  /** 默认提示里把字段名换成 label 用 */
  checkLabels?: (step: string | null | undefined, field: string) => string;
}

/** parseCheckExpr 的结果：两边各是带符号的项（数字或字段引用），中间一个比较符 */
export interface CheckExpr {
  left: CheckTerm[]; op: string; right: CheckTerm[];
}
export interface CheckTerm { sign: number; num?: number; step?: string | null; field?: string }

// —— 下面三个函数会被原样嵌进执行页脚本（sop-runner.ts 用 String(fn)），所以只写浏览器能跑的纯 JS：不加类型标注、不用外部变量 ——

/** 解析 data-check 表达式；写法不对返回 null（当作没有这条规则，不让 SOP 因笔误整页失效） */
export function parseCheckExpr(src) {
  var s = String(src == null ? '' : src);
  if (!s.trim() || s.length > 200) return null;
  var toks = [], i = 0, n = s.length;
  var isD = function (c) { return c >= '0' && c <= '9'; };
  var isA = function (c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; };
  while (i < n) {
    var c = s.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isD(c)) {
      var j = i; while (j < n && isD(s.charAt(j))) j++;
      if (s.charAt(j) === '.' && isD(s.charAt(j + 1))) { j++; while (j < n && isD(s.charAt(j))) j++; }
      toks.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (isA(c)) {
      var k = i; while (k < n && (isA(s.charAt(k)) || isD(s.charAt(k)))) k++;
      var name = s.slice(i, k), step = null;
      if (s.charAt(k) === '.' && isA(s.charAt(k + 1))) { step = name; var k2 = k + 1; while (k2 < n && (isA(s.charAt(k2)) || isD(s.charAt(k2)))) k2++; name = s.slice(k + 1, k2); k = k2; }
      toks.push({ t: 'ref', step: step, field: name }); i = k; continue;
    }
    var two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==') { toks.push({ t: 'cmp', v: two === '==' ? '=' : two }); i += 2; continue; }
    if (c === '<' || c === '>' || c === '=') { toks.push({ t: 'cmp', v: c }); i++; continue; }
    if (c === '+' || c === '-') { toks.push({ t: 'sign', v: c === '-' ? -1 : 1 }); i++; continue; }
    return null;
  }
  var sides = [[], []], side = 0, op = '', want = 'term', sign = 1;
  for (var q = 0; q < toks.length; q++) {
    var tk = toks[q];
    if (want === 'term') {
      if (tk.t === 'sign') { sign = sign * tk.v; continue; }
      if (tk.t === 'num') sides[side].push({ sign: sign, num: tk.v });
      else if (tk.t === 'ref') sides[side].push({ sign: sign, step: tk.step, field: tk.field });
      else return null;
      sign = 1; want = 'op';
    } else {
      if (tk.t === 'sign') { sign = tk.v; want = 'term'; continue; }
      if (tk.t === 'cmp' && !op) { op = tk.v; side = 1; want = 'term'; continue; }
      return null;
    }
  }
  if (!op || want !== 'op' || !sides[0].length || !sides[1].length || sides[0].length + sides[1].length > 12) return null;
  var refs = sides[0].concat(sides[1]).filter(function (x) { return x.field; });
  if (!refs.length) return null;
  return { left: sides[0], op: op, right: sides[1] };
}

/** 求值：get(step, field) 取字段的文本值（step 为 null 表示控件自己所在的步骤）。
 *  有引用为空或不是数字 → 返回 null（跳过）；否则返回 { ok, a, b }（a、b 为两边的值） */
export function evalCheckExpr(p, get) {
  var sum = function (terms) {
    var t = 0;
    for (var i = 0; i < terms.length; i++) {
      var x = terms[i], v;
      if (x.field) {
        var raw = get(x.step, x.field);
        var str = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!str) return null;
        v = Number(str);
        if (!isFinite(v)) return null;
      } else v = x.num;
      t += x.sign * v;
    }
    return t;
  };
  var a = sum(p.left), b = sum(p.right);
  if (a === null || b === null) return null;
  var eps = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  var ok = p.op === '<=' ? a <= b + eps : p.op === '>=' ? a >= b - eps : p.op === '<' ? a < b - eps : p.op === '>' ? a > b + eps : Math.abs(a - b) <= eps;
  return { ok: ok, a: Math.round(a * 1e9) / 1e9, b: Math.round(b * 1e9) / 1e9 };
}

/** 默认提示：把字段名换成 label，如「须满足 实际条数 ≤ 应取条数（现为 101 与 100）」 */
export function checkMessage(p, res, labelOf) {
  var sym = { '<=': '≤', '>=': '≥', '<': '<', '>': '>', '=': '=' };
  var side = function (terms) {
    return terms.map(function (x, i) {
      var name = x.field ? labelOf(x.step, x.field) : String(x.num);
      return (i === 0 ? (x.sign < 0 ? '-' : '') : (x.sign < 0 ? ' - ' : ' + ')) + name;
    }).join('');
  };
  return '须满足 ' + side(p.left) + ' ' + sym[p.op] + ' ' + side(p.right) + '（现为 ' + res.a + ' 与 ' + res.b + '）';
}

export interface FileListRow { file_id: number; name?: string; role?: string; source?: string; period?: string; status?: string; sha256: string; size?: number; mime?: string }
/** 文件清单的值：数组，或执行页早期存成的 JSON 文本；取不出数组返回 null */
export function fileListRows(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { const t = raw.trim(); if (!t) return []; try { const v = JSON.parse(t); return Array.isArray(v) ? v : null; } catch { return null; } }
  return raw === undefined || raw === null ? [] : null;
}
const listOf = (v: unknown) => (typeof v === 'string' ? v.split('|').map((x) => x.trim()).filter(Boolean) : undefined);

/** 解析 data-required-if="<字段>=<值1>|<值2>"；坏写法返回 undefined（当作没有条件，不让 SOP 因笔误整页失效） */
export function parseRequiredIf(src: string, step: string): FieldRule['requiredIf'] {
  const m = /^\s*(?:([A-Za-z0-9_-]+)\.)?([A-Za-z0-9_-]+)\s*=(.*)$/s.exec(src);
  if (!m) return undefined;
  const values = m[3].split('|').map((v) => v.trim()).filter(Boolean);
  return values.length ? { step: m[1] ?? step, field: m[2], values } : undefined;
}

const TAG_RE = /<(input|textarea|select)\b([^>]*)>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const MAX_PATTERN_INPUT = 20000;
/** 格式对了再核日历：2026-02-30、2026-13-01 这类不存在的日子拒掉（浏览器日期控件拦得住，agent 直接写数据拦不住） */
const realDate = (v: string) => { const [y, m, d] = v.split('-').map(Number); const t = new Date(Date.UTC(2000, m - 1, d)); t.setUTCFullYear(y); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

function attrs(src: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const m of src.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? true;
  return out;
}
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function extractFieldRules(manifest: SopManifest): FieldRule[] {
  const rules: FieldRule[] = [];
  const labels = new Map<string, string>();
  for (const step of manifest.steps ?? []) for (const m of String(step.body ?? '').matchAll(TAG_RE)) {
    const a = attrs(m[2]);
    if (typeof a['data-field'] === 'string') labels.set(`${step.key}.${a['data-field']}`, typeof a['data-label'] === 'string' ? decode(a['data-label']) : a['data-field']);
  }
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
      if (typeof a['data-required-if'] === 'string') r.requiredIf = parseRequiredIf(decode(a['data-required-if']), step.key);
      if (typeof a['data-check'] === 'string' && a['data-type'] !== 'file-list') {
        const expr = decode(a['data-check']), parsed = parseCheckExpr(expr) as CheckExpr | null;
        if (parsed) r.check = { expr, parsed, message: typeof a['data-check-error'] === 'string' ? decode(a['data-check-error']) : undefined };
      }
      if (m[1].toLowerCase() === 'textarea' && a['data-type'] === 'file-list') {
        r.type = 'file-list'; r.pattern = undefined; r.minlength = undefined; r.maxlength = undefined;
        r.roles = listOf(typeof a['data-roles'] === 'string' ? decode(a['data-roles']) : undefined);
        r.statuses = listOf(typeof a['data-statuses'] === 'string' ? decode(a['data-statuses']) : undefined);
        r.voidStatuses = listOf(typeof a['data-void-statuses'] === 'string' ? decode(a['data-void-statuses']) : undefined);
        r.minItems = num('data-min-items'); r.maxItems = num('data-max-items');
        rules.push(r); continue;
      }
      if (r.check) r.checkLabels = (s: string | null | undefined, f: string) => labels.get(`${s ?? step.key}.${f}`) ?? f;
      if (r.check || r.required || r.requiredIf || r.pattern || r.minlength !== undefined || r.maxlength !== undefined || ['url', 'number', 'date', 'month', 'email'].includes(r.type ?? '')) rules.push(r);
    }
  }
  return rules;
}

/** data 形态与执行页一致：{ [stepKey]: { [field]: value } }。返回违约说明（空 = 通过）。 */
export function checkRunData(rules: FieldRule[], data: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const valueOf = (step: string, field: string) => {
    const stepVal = data?.[step];
    const raw = stepVal && typeof stepVal === 'object' ? (stepVal as Record<string, unknown>)[field] : undefined;
    return raw === undefined || raw === null || raw === false ? '' : raw === true ? 'true' : String(raw).trim();
  };
  const rawOf = (step: string, field: string) => { const sv = data?.[step]; return sv && typeof sv === 'object' ? (sv as Record<string, unknown>)[field] : undefined; };
  for (const r of rules) {
    if (r.type === 'file-list') {
      const name = `${r.step}.${r.label}`;
      const required = r.requiredIf ? r.requiredIf.values.includes(valueOf(r.requiredIf.step, r.requiredIf.field)) : r.required;
      const rows = fileListRows(rawOf(r.step, r.field));
      if (rows === null) { errs.push(`${name}：不是文件清单（应为行对象数组）`); continue; }
      if (!rows.length) { if (required || (r.minItems ?? 0) > 0) errs.push(`${name}：必填（至少 ${Math.max(1, r.minItems ?? 1)} 行）`); continue; }
      // 作废行照样核结构，但不算数：全是作废行等于没填
      const live = r.voidStatuses ? rows.filter((o) => !(o && typeof o === 'object' && r.voidStatuses!.includes(String((o as Record<string, unknown>).status ?? '')))).length : rows.length;
      const voidNote = r.voidStatuses && live < rows.length ? `不算「${r.voidStatuses.join(' / ')}」的行` : '';
      if (!live && (required || (r.minItems ?? 0) > 0)) errs.push(`${name}：必填（至少 ${Math.max(1, r.minItems ?? 1)} 行${voidNote ? `，${voidNote}` : ''}）`);
      else if (r.minItems !== undefined && live < r.minItems) errs.push(`${name}：至少 ${r.minItems} 行${voidNote ? `（${voidNote}）` : ''}`);
      if (r.maxItems !== undefined && rows.length > r.maxItems) errs.push(`${name}：最多 ${r.maxItems} 行`);
      rows.forEach((row, i) => {
        const at = `${name} 第 ${i + 1} 行`;
        const o = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null;
        if (!o) { errs.push(`${at}：不是对象`); return; }
        if (!Number.isInteger(Number(o.file_id)) || Number(o.file_id) <= 0) errs.push(`${at}：没有选文件（file_id）`);
        if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) errs.push(`${at}：缺 sha256`);
        if (r.roles && !r.roles.includes(String(o.role ?? ''))) errs.push(`${at}：角色须为 ${r.roles.join(' / ')}`);
        if (r.statuses && !r.statuses.includes(String(o.status ?? ''))) errs.push(`${at}：状态须为 ${r.statuses.join(' / ')}`);
      });
      continue;
    }
    const v = valueOf(r.step, r.field);
    const name = `${r.step}.${r.label}`;
    const why = (msg: string) => errs.push(`${name}：${r.message ?? msg}`);
    // 有条件时以条件为准（静态 required 一并让位），条件字段的值在列表里才必填
    const required = r.requiredIf ? r.requiredIf.values.includes(valueOf(r.requiredIf.step, r.requiredIf.field)) : r.required;
    if (!v) { if (required) errs.push(`${name}：必填${r.requiredIf ? `（${r.requiredIf.field} 为 ${valueOf(r.requiredIf.step, r.requiredIf.field)} 时）` : ''}`); continue; }  // 自定义提示（data-error）只用于格式错误
    if (r.minlength !== undefined && v.length < r.minlength) why(`至少 ${r.minlength} 字`);
    if (r.maxlength !== undefined && v.length > r.maxlength) why(`最多 ${r.maxlength} 字`);
    if (r.pattern) {
      if (v.length > MAX_PATTERN_INPUT) why(`超过 ${MAX_PATTERN_INPUT} 字，未做格式核对`);
      else if (!new RegExp(`^(?:${r.pattern})$`, 'u').test(v)) why('格式不符');
    }
    if (r.type === 'url') { try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) why('须为 http(s) 链接'); } catch { why('不是合法链接'); } }
    if (r.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) why('不是合法邮箱');
    if (r.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) why('日期须为 YYYY-MM-DD'); else if (!realDate(v)) why('日历上没有这一天'); }
    if (r.type === 'month') { if (!/^\d{4}-\d{2}$/.test(v)) why('月份须为 YYYY-MM'); else if (!realDate(`${v}-01`)) why('月份须在 01–12'); }
    if (r.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) why('须为数字');
      else { if (r.min !== undefined && n < r.min) why(`不小于 ${r.min}`); if (r.max !== undefined && n > r.max) why(`不大于 ${r.max}`); }
    }
    // #471 字段间数值关系：控件自己有值才核；引用的字段有空值或不是数字时跳过
    if (r.check) {
      const res = evalCheckExpr(r.check.parsed, (s: string | null, f: string) => valueOf(s ?? r.step, f));
      if (res && !res.ok) errs.push(`${name}：${r.check.message ?? checkMessage(r.check.parsed, res, r.checkLabels ?? ((_s: string | null, f: string) => f))}`);
    }
  }
  return errs;
}
