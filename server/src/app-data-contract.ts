/** 自产台数据契约（可选）：台在源码里放 `data-contract.json`，POST /api/apps/:slug/data 按它校验，违约 400。
 *  没有契约的台行为不变（只限 1MB）。页面上的校验可被直接 POST 绕过，契约是服务端的权威校验。
 *
 *  契约形态（version 1）：
 *  {
 *    "version": 1,
 *    "type_fields": ["record_type", "type"],      // 依次取，第一个命中已声明类型的字段值即本条记录的类型
 *    "unknown_types": "allow" | "reject",         // 没声明的类型：放行（默认，兼容存量提交方）或拒绝
 *    "types": {
 *      "<type>": {
 *        "required": ["field", ...],              // 必填：非空字符串 / 非空数组 / 数字 / 布尔
 *        "enum": { "field": ["a", "b"] },          // 有值时必须在列表内
 *        "pattern": { "field": "^regex$" },        // 有值时（字符串）必须匹配
 *        "when": [{ "if": { "field": ["v1"] }, "require": ["f"], "equals": { "f": true }, "pattern": { "f": "^regex$" } }],  // 条件成立时再加的规则
 *        "file_ids": true,                         // file_ids 必须是本台已登记文件的 id 数组
 *        "items": { "refs": { "required": [..], "enum": {..}, "pattern": {..}, "when": [..], "max_items": 30 } }  // 数组里每个对象的规则（when 按元素自己的字段判）
 *      }
 *    }
 *  }
 */

/** 条件规则：if 里每个字段的值都在列表内时，require 必填、equals 恒等、pattern 有值时须匹配 */
export interface WhenRule { if: Record<string, unknown[]>; require?: string[]; equals?: Record<string, unknown>; pattern?: Record<string, string> }
export interface ContractType {
  required?: string[];
  enum?: Record<string, unknown[]>;
  pattern?: Record<string, string>;
  when?: WhenRule[];
  file_ids?: boolean;
  /** 数组字段里每个对象的规则（嵌套一层）：有值时必须是对象数组 */
  items?: Record<string, { required?: string[]; enum?: Record<string, unknown[]>; pattern?: Record<string, string>; when?: WhenRule[]; max_items?: number }>;
}
export interface DataContract {
  version: 1;
  type_fields: string[];
  unknown_types: 'allow' | 'reject';
  types: Record<string, ContractType>;
  /** 解析时预编译的正则：types.<type>.pattern.<field>；数组对象字段记为 <field>[].<sub>；条件规则记为 when[i].<field> / <field>[].when[i].<sub> */
  re: Record<string, Record<string, RegExp>>;
}

// 一张台常有十几种记录类型（按主题分），每种的必填/枚举/格式加起来就上百条；200 曾卡住真实台的新类型。
// 解析时逐条预编译、按 台@版本 缓存，核对时每条记录只走自己那一型的规则，500 条的开销仍可忽略
const MAX_RULES = 500;
const MAX_PATTERN_INPUT = 4096;  // 参与正则匹配的单值上限，防回溯型正则被超长输入拖慢
const MAX_VIOLATIONS = 50;

/** 解析并检查契约文件本身；契约写错时抛错（同步时就拦下，不留到提交时才发现）。 */
export function parseContract(text: string): DataContract {
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`data-contract.json 不是合法 JSON：${(e as Error).message}`); }
  if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('data-contract.json 需 version: 1');
  const typeFields = raw.type_fields ?? ['record_type', 'type'];
  if (!Array.isArray(typeFields) || !typeFields.length || !typeFields.every((f: unknown) => typeof f === 'string' && f)) throw new Error('type_fields 必须是非空字符串数组');
  const unknown = raw.unknown_types ?? 'allow';
  if (unknown !== 'allow' && unknown !== 'reject') throw new Error('unknown_types 只能是 allow 或 reject');
  if (!raw.types || typeof raw.types !== 'object' || Array.isArray(raw.types)) throw new Error('types 必须是对象');
  let rules = 0;
  const re: Record<string, Record<string, RegExp>> = {};
  const strArr = (v: unknown, what: string) => { if (v !== undefined && (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))) throw new Error(`${what} 必须是字符串数组`); };
  for (const [name, t] of Object.entries<any>(raw.types)) {
    if (!t || typeof t !== 'object') throw new Error(`types.${name} 必须是对象`);
    strArr(t.required, `types.${name}.required`); rules += t.required?.length ?? 0;
    for (const [f, vals] of Object.entries<any>(t.enum ?? {})) { if (!Array.isArray(vals) || !vals.length) throw new Error(`types.${name}.enum.${f} 必须是非空数组`); rules++; }
    for (const [f, rx] of Object.entries<any>(t.pattern ?? {})) {
      if (typeof rx !== 'string') throw new Error(`types.${name}.pattern.${f} 必须是字符串`);
      try { (re[name] ??= {})[f] = new RegExp(rx); } catch { throw new Error(`types.${name}.pattern.${f} 不是合法正则`); }
      rules++;
    }
    for (const [f, it] of Object.entries<any>(t.items ?? {})) {
      if (!it || typeof it !== 'object') throw new Error(`types.${name}.items.${f} 必须是对象`);
      strArr(it.required, `types.${name}.items.${f}.required`); rules += it.required?.length ?? 0;
      for (const [sf, vals] of Object.entries<any>(it.enum ?? {})) { if (!Array.isArray(vals) || !vals.length) throw new Error(`types.${name}.items.${f}.enum.${sf} 必须是非空数组`); rules++; }
      for (const [sf, rx] of Object.entries<any>(it.pattern ?? {})) {
        if (typeof rx !== 'string') throw new Error(`types.${name}.items.${f}.pattern.${sf} 必须是字符串`);
        try { (re[name] ??= {})[`${f}[].${sf}`] = new RegExp(rx); } catch { throw new Error(`types.${name}.items.${f}.pattern.${sf} 不是合法正则`); }
        rules++;
      }
      rules += parseWhen(it.when, `types.${name}.items.${f}`, (re[name] ??= {}), `${f}[].`);
      if (it.max_items !== undefined && !(Number.isInteger(it.max_items) && it.max_items > 0)) throw new Error(`types.${name}.items.${f}.max_items 必须是正整数`);
    }
    rules += parseWhen(t.when, `types.${name}`, (re[name] ??= {}), '');
  }
  if (rules > MAX_RULES) throw new Error(`契约规则数 ${rules} 超过上限 ${MAX_RULES}`);
  return { version: 1, type_fields: typeFields, unknown_types: unknown, types: raw.types, re };
}

/** 检查并预编译一组条件规则（顶层与数组对象共用）；返回计入上限的规则数 */
function parseWhen(list: unknown, at: string, re: Record<string, RegExp>, prefix: string): number {
  if (list === undefined) return 0;
  if (!Array.isArray(list)) throw new Error(`${at}.when 必须是数组`);
  let rules = 0;
  for (const [i, w] of list.entries()) {
    if (!w || typeof w.if !== 'object' || Array.isArray(w.if) || !Object.values(w.if).every(Array.isArray)) throw new Error(`${at}.when[${i}].if 必须是 {字段: [取值...]}`);
    if (w.require !== undefined && (!Array.isArray(w.require) || !w.require.every((x: unknown) => typeof x === 'string'))) throw new Error(`${at}.when[${i}].require 必须是字符串数组`);
    for (const [f, rx] of Object.entries<any>(w.pattern ?? {})) {
      if (typeof rx !== 'string') throw new Error(`${at}.when[${i}].pattern.${f} 必须是字符串`);
      try { re[`${prefix}when[${i}].${f}`] = new RegExp(rx); } catch { throw new Error(`${at}.when[${i}].pattern.${f} 不是合法正则`); }
      rules++;
    }
    rules++;
  }
  return rules;
}

/** 单值或数组逐个按正则核对：返回违约说明，通过返回空串 */
function patternErr(v: unknown, rx: RegExp, at: string): string {
  const vals = Array.isArray(v) ? v : [v];
  if (vals.some((x) => typeof x === 'string' && x.length > MAX_PATTERN_INPUT)) return `${at} 超过 ${MAX_PATTERN_INPUT} 字符`;
  if (!vals.every((x) => (typeof x === 'string' || typeof x === 'number') && rx.test(String(x)))) return `${at} 格式不符（${rx.source}）`;
  return '';
}

/** 按条件规则核对一个对象（顶层记录或数组里的一个元素） */
function applyWhen(rules: WhenRule[] | undefined, o: Record<string, unknown>, at: string, re: Record<string, RegExp> | undefined, prefix: string, errs: string[]): void {
  for (const [i, w] of (rules ?? []).entries()) {
    if (!Object.entries(w.if).every(([f, vals]) => (vals as unknown[]).includes(o[f]))) continue;
    const cond = Object.entries(w.if).map(([f, vals]) => `${f}=${(vals as unknown[]).join('/')}`).join(' 且 ');
    for (const f of w.require ?? []) if (!present(o[f])) errs.push(`${cond} 时 ${at}.${f} 必填`);
    for (const [f, v] of Object.entries(w.equals ?? {})) if (o[f] !== v) errs.push(`${cond} 时 ${at}.${f} 必须为 ${JSON.stringify(v)}`);
    for (const f of Object.keys(w.pattern ?? {})) {
      const rx = re?.[`${prefix}when[${i}].${f}`];
      if (!rx || !present(o[f])) continue;
      const e = patternErr(o[f], rx, `${at}.${f}`);
      if (e) errs.push(`${cond} 时 ${e}`);
    }
  }
}

const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);

/** 按契约检查一条提交；返回违约说明（空数组 = 通过）。fileExists 用于核对 file_ids 属于本台。 */
export function checkRecord(c: DataContract, data: unknown, fileExists: (id: number) => boolean): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['data 必须是 JSON 对象'];
  const d = data as Record<string, unknown>;
  let typeName = '';
  for (const f of c.type_fields) { const v = d[f]; if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(c.types, v)) { typeName = v; break; } }
  if (!typeName) {
    if (c.unknown_types === 'reject') return [`记录类型未声明（${c.type_fields.join(' / ')} 需取：${Object.keys(c.types).join('、')}）`];
    return [];
  }
  const t = c.types[typeName], errs: string[] = [];
  for (const f of t.required ?? []) if (!present(d[f])) errs.push(`${typeName}.${f} 必填`);
  for (const [f, vals] of Object.entries(t.enum ?? {})) if (present(d[f]) && !vals.includes(d[f])) errs.push(`${typeName}.${f} 取值不在允许范围（${vals.join('、')}）`);
  for (const [f, rx] of Object.entries(c.re[typeName] ?? {})) {
    if (f.includes('[].') || f.startsWith('when[')) continue;  // 数组对象字段与条件规则在下面另核
    const v = d[f];
    if (!present(v)) continue;
    const vals = Array.isArray(v) ? v : [v];
    if (vals.some((x) => typeof x === 'string' && x.length > MAX_PATTERN_INPUT)) { errs.push(`${typeName}.${f} 超过 ${MAX_PATTERN_INPUT} 字符`); continue; }
    if (!vals.every((x) => typeof x === 'string' && rx.test(x))) errs.push(`${typeName}.${f} 格式不符（${rx.source}）`);
  }
  applyWhen(t.when, d, typeName, c.re[typeName], '', errs);
  for (const [f, it] of Object.entries(t.items ?? {})) {
    const arr = d[f];
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr)) { errs.push(`${typeName}.${f} 必须是数组`); continue; }
    if (it.max_items !== undefined && arr.length > it.max_items) errs.push(`${typeName}.${f} 最多 ${it.max_items} 项`);
    arr.forEach((el, i) => {
      const at = `${typeName}.${f}[${i}]`;
      if (!el || typeof el !== 'object' || Array.isArray(el)) { errs.push(`${at} 必须是对象`); return; }
      const o = el as Record<string, unknown>;
      for (const sf of it.required ?? []) if (!present(o[sf])) errs.push(`${at}.${sf} 必填`);
      for (const [sf, vals] of Object.entries(it.enum ?? {})) if (present(o[sf]) && !vals.includes(o[sf])) errs.push(`${at}.${sf} 取值不在允许范围（${vals.join('、')}）`);
      for (const sf of Object.keys(it.pattern ?? {})) {
        const rx = c.re[typeName]?.[`${f}[].${sf}`];
        if (!rx || !present(o[sf])) continue;
        const e = patternErr(o[sf], rx, `${at}.${sf}`);
        if (e) errs.push(e);
      }
      applyWhen(it.when, o, at, c.re[typeName], `${f}[].`, errs);
    });
  }
  if (t.file_ids && d.file_ids !== undefined) {
    const ids = d.file_ids;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x) && (x as number) > 0)) errs.push(`${typeName}.file_ids 必须是正整数数组`);
    else for (const id of ids as number[]) if (!fileExists(id)) errs.push(`${typeName}.file_ids 含本台不存在的文件 ${id}`);
  }
  // 大数组逐元素出错时可能上千条：响应只列前 MAX_VIOLATIONS 条并附总数
  return errs.length > MAX_VIOLATIONS ? [...errs.slice(0, MAX_VIOLATIONS), `……共 ${errs.length} 条违约，只列前 ${MAX_VIOLATIONS} 条`] : errs;
}
