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
 *        "when": [{ "if": { "field": ["v1"] }, "require": ["f"], "equals": { "f": true } }],
 *        "file_ids": true                          // file_ids 必须是本台已登记文件的 id 数组
 *      }
 *    }
 *  }
 */

export interface ContractType {
  required?: string[];
  enum?: Record<string, unknown[]>;
  pattern?: Record<string, string>;
  when?: { if: Record<string, unknown[]>; require?: string[]; equals?: Record<string, unknown> }[];
  file_ids?: boolean;
}
export interface DataContract {
  version: 1;
  type_fields: string[];
  unknown_types: 'allow' | 'reject';
  types: Record<string, ContractType>;
  /** 解析时预编译的正则：types.<type>.pattern.<field> */
  re: Record<string, Record<string, RegExp>>;
}

const MAX_RULES = 200;
const MAX_PATTERN_INPUT = 4096;  // 参与正则匹配的单值上限，防回溯型正则被超长输入拖慢

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
    if (t.when !== undefined && !Array.isArray(t.when)) throw new Error(`types.${name}.when 必须是数组`);
    for (const [i, w] of (t.when ?? []).entries()) {
      if (!w || typeof w.if !== 'object' || Array.isArray(w.if) || !Object.values(w.if).every(Array.isArray)) throw new Error(`types.${name}.when[${i}].if 必须是 {字段: [取值...]}`);
      strArr(w.require, `types.${name}.when[${i}].require`);
      rules++;
    }
  }
  if (rules > MAX_RULES) throw new Error(`契约规则数 ${rules} 超过上限 ${MAX_RULES}`);
  return { version: 1, type_fields: typeFields, unknown_types: unknown, types: raw.types, re };
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
    const v = d[f];
    if (!present(v)) continue;
    const vals = Array.isArray(v) ? v : [v];
    if (vals.some((x) => typeof x === 'string' && x.length > MAX_PATTERN_INPUT)) { errs.push(`${typeName}.${f} 超过 ${MAX_PATTERN_INPUT} 字符`); continue; }
    if (!vals.every((x) => typeof x === 'string' && rx.test(x))) errs.push(`${typeName}.${f} 格式不符（${rx.source}）`);
  }
  for (const w of t.when ?? []) {
    if (!Object.entries(w.if).every(([f, vals]) => (vals as unknown[]).includes(d[f]))) continue;
    const cond = Object.entries(w.if).map(([f, vals]) => `${f}=${(vals as unknown[]).join('/')}`).join(' 且 ');
    for (const f of w.require ?? []) if (!present(d[f])) errs.push(`${cond} 时 ${typeName}.${f} 必填`);
    for (const [f, v] of Object.entries(w.equals ?? {})) if (d[f] !== v) errs.push(`${cond} 时 ${typeName}.${f} 必须为 ${JSON.stringify(v)}`);
  }
  if (t.file_ids && d.file_ids !== undefined) {
    const ids = d.file_ids;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x) && (x as number) > 0)) errs.push(`${typeName}.file_ids 必须是正整数数组`);
    else for (const id of ids as number[]) if (!fileExists(id)) errs.push(`${typeName}.file_ids 含本台不存在的文件 ${id}`);
  }
  return errs;
}
