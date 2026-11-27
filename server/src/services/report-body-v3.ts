/** Compile the report's json-render subset into the existing freeze renderer. */
export class ReportError extends Error {
  code: string;
  path: string;
  /** Which limit or part went wrong, when the code alone does not say (image_limit: count | bytes). */
  detail?: string;
  constructor(code: string, path: string, detail?: string) {
    super(`${code} at ${path}${detail ? ` (${detail})` : ''}`); this.name = 'ReportError'; this.code = code; this.path = path; if (detail) this.detail = detail;
  }
}
class InvalidBody extends ReportError {}
const fail = (code: string, path: string): never => { throw new InvalidBody(code, path); };
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v: object, k: string) => Object.hasOwn(v, k);
function object(v: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (!obj(v)) return fail('invalid_object', path);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail('unknown_key', path + '/' + k);
  return v;
}

export const REPORT_NODE_PROPS = {
  cover: ['title', 'content'], section: ['title'], text: ['content'], grid: ['columns'],
  repeat: ['data', 'row_key', 'max_items'], 'data-view': ['component', 'data', 'props'], 'page-break': [], image: ['src', 'alt'],
};
export type ReportBodyContext = {
  parameters: Record<string, string>;
  fields: Record<string, string>;
  row?: Record<string, unknown>;
  slots: Record<string, { columns: { name: string }[]; rows: Record<string, unknown>[] }>;
};
type Scalar = string | number | boolean | null;
type Value = Scalar | Scalar[];
type Expression = (context: ReportBodyContext) => Value;
export type ReportText = (context: ReportBodyContext) => string;
const scalar = (v: unknown, path: string): Scalar => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  return fail('invalid_expression_value', path);
};
const number = (v: Value, path: string) => typeof v === 'number' && Number.isFinite(v) ? v : fail('invalid_expression_number', path);
const stringify = (v: Value, path: string) => Array.isArray(v) ? fail('invalid_expression_value', path) : String(v ?? '');
const limitText = (v: string, path: string) => v.length <= 10000 ? v : fail('invalid_text', path);
function concatenate(parts: Iterable<string>, path: string): string {
  let result = '';
  for (const part of parts) result = limitText(result + part, path);
  return result;
}

const binary = {
  add: (a: number, b: number) => a + b, subtract: (a: number, b: number) => a - b,
  multiply: (a: number, b: number) => a * b, divide: (a: number, b: number) => a / b,
  mod: (a: number, b: number) => a % b, min: Math.min, max: Math.max,
};
const unary = { round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs };
const ID = /^[a-z][a-z0-9_-]{0,47}$/;

function reference(raw: unknown, path: string): Expression {
  const ref = object(raw, ['scope', 'name', 'column'], path);
  const { scope, name, column } = ref;
  if (typeof name !== 'string' || !ID.test(name)) return fail('invalid_reference', path);
  if (scope === 'slot') {
    if (column !== undefined && (typeof column !== 'string' || !ID.test(column))) return fail('invalid_reference', path);
    return ({ slots }) => {
      const slot = own(slots, name) ? slots[name] : undefined;
      if (!slot || (column !== undefined && !slot.columns.some((c) => c.name === column))) return fail('missing_reference', path);
      return slot.rows.map((row) => column === undefined ? null : scalar(row[column], path));
    };
  }
  if (column !== undefined || (scope !== 'parameter' && scope !== 'field' && scope !== 'row')) return fail('invalid_reference', path);
  return (context) => {
    const values = scope === 'parameter' ? context.parameters : scope === 'field' ? context.fields : context.row;
    if (!values || !own(values, name)) return fail('missing_reference', path);
    return scalar(values[name], path);
  };
}

function formatter(v: Record<string, unknown>, operand: Expression, path: string): Expression {
  const style = v.$format;
  if (style !== 'date' && style !== 'number' && style !== 'percent' && style !== 'currency') return fail('invalid_format', path);
  const locale = own(v, 'locale') ? v.locale : 'zh-CN';
  if (typeof locale !== 'string' || !/^[a-zA-Z0-9-]{2,35}$/.test(locale)) return fail('invalid_format', path);
  const currency = own(v, 'currency') ? v.currency : 'CNY';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || (style !== 'currency' && own(v, 'currency'))) return fail('invalid_format', path);
  if (style === 'date') {
    if (own(v, 'minimum_fraction_digits') || own(v, 'maximum_fraction_digits')) return fail('invalid_format', path); // 日期没有小数位
    let format: Intl.DateTimeFormat;
    try { format = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { return fail('invalid_format', path); }
    return (context) => {
      const raw = operand(context);
      if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw))) return fail('invalid_format_value', path);
      const date = new Date(raw);
      if (!Number.isFinite(date.getTime())) return fail('invalid_format_value', path);
      return format.format(date);
    };
  }
  // #1085 数字的写法和统计卡、数据视图共用一个实现（server/src/value-format.ts）；不写小数位时和以前一模一样
  const spec = reportNumberSpec({ style, locale, currency, minimum_fraction_digits: v.minimum_fraction_digits, maximum_fraction_digits: v.maximum_fraction_digits }, (k) => own(v, k));
  if (!spec.ok) return fail('invalid_format', path);
  return (context) => formatNumber(number(operand(context), path), spec.spec) as string;
}

function expression(v: unknown, path: string, depth = 0): Expression {
  if (depth > 8) return fail('expression_depth', path);
  const child = (value: unknown, key: string) => expression(value, path + '/' + key, depth + 1);
  if (Array.isArray(v)) {
    if (v.length > 100) return fail('expression_limit', path);
    const parts = v.map((x, i) => child(x, String(i)));
    return (context) => parts.map((part) => scalar(part(context), path));
  }
  if (!obj(v)) { const value = scalar(v, path); return () => value; }
  if (own(v, 'ref')) { object(v, ['ref'], path); return reference(v.ref, path + '/ref'); }
  if (own(v, '$format')) {
    object(v, ['$format', 'value', 'locale', 'currency', 'minimum_fraction_digits', 'maximum_fraction_digits'], path);
    return formatter(v, child(v.value, 'value'), path);
  }
  if (own(v, '$count')) {
    object(v, ['$count'], path);
    const operand = child(v.$count, '$count');
    return (context) => {
      const value = operand(context);
      if (Array.isArray(value) || typeof value === 'string') return value.length;
      return fail('invalid_expression_value', path);
    };
  }
  if (own(v, '$join')) {
    object(v, ['$join', 'separator'], path);
    const operand = child(v.$join, '$join');
    const separator = own(v, 'separator') ? v.separator : ', ';
    if (typeof separator !== 'string' || separator.length > 100) return fail('invalid_text', path);
    return (context) => {
      const value = operand(context);
      if (!Array.isArray(value)) return fail('invalid_expression_value', path);
      const parts = function* () {
        for (const [i, item] of value.entries()) yield (i === 0 ? '' : separator) + stringify(item, path);
      };
      return concatenate(parts(), path);
    };
  }
  if (own(v, '$concat')) {
    object(v, ['$concat'], path);
    if (!Array.isArray(v.$concat) || v.$concat.length > 100) return fail('expression_limit', path);
    const parts = v.$concat.map((part, i) => child(part, '$concat/' + i));
    return (context) => {
      const resolved = function* () { for (const part of parts) yield stringify(part(context), path); };
      return concatenate(resolved(), path);
    };
  }
  if (own(v, '$math')) {
    const op = v.$math;
    if (typeof op !== 'string') return fail('invalid_math', path);
    if (own(unary, op)) {
      object(v, ['$math', 'a'], path);
      const a = child(v.a, 'a');
      const run = unary[op as keyof typeof unary];
      return (context) => run(number(a(context), path));
    }
    if (own(binary, op)) {
      object(v, ['$math', 'a', 'b'], path);
      const a = child(v.a, 'a'), b = child(v.b, 'b');
      const run = binary[op as keyof typeof binary];
      return (context) => number(run(number(a(context), path), number(b(context), path)), path);
    }
  }
  return fail('unsupported_directive', path);
}

function bodyText(v: unknown, path: string): ReportText {
  const run = expression(v, path);
  return (context) => limitText(stringify(run(context), path), path);
}

function staticProp(v: unknown, path: string, depth = 0): void {
  if (depth > 6) fail('node_depth', path);
  if (Array.isArray(v)) {
    if (v.length > 100) fail('node_limit', path);
    v.forEach((part, i) => staticProp(part, path + '/' + i, depth + 1));
  } else if (obj(v)) {
    for (const [key, value] of Object.entries(v)) {
      if (key.startsWith('$')) fail('unsupported_directive', path + '/' + key);
      staticProp(value, path + '/' + key, depth + 1);
    }
  } else scalar(v, path);
}

type BodyNode = { id: string; type: string; children?: BodyNode[]; items?: BodyNode[] } & Record<string, unknown>;
export function compileV3Body(body: unknown): BodyNode[] {
  const spec = object(body, ['root', 'elements'], '/body');
  if (!obj(spec.elements)) return fail('invalid_object', '/body/elements');
  const elements = spec.elements;
  if (Object.keys(elements).length > 301) return fail('node_limit', '/body/elements');
  const seen = new Set<string>();
  function walk(key: unknown, depth: number): BodyNode {
    const path = '/body/elements/' + (typeof key === 'string' ? key : 'invalid');
    if (typeof key !== 'string' || !ID.test(key) || !own(elements, key) || seen.has(key)) return fail('invalid_node_reference', path);
    if (depth > 7) return fail('node_depth', path);
    seen.add(key);
    const element = object(elements[key], ['type', 'props', 'children'], path);
    const type = element.type;
    if (typeof type !== 'string' || !(depth === 0 && type === 'document' || own(REPORT_NODE_PROPS, type))) return fail('unsupported_node', path);
    const props = { ...object(element.props, type === 'document' ? [] : REPORT_NODE_PROPS[type as keyof typeof REPORT_NODE_PROPS], path + '/props') };
    for (const [name, value] of Object.entries(props)) {
      if (name !== 'title' && name !== 'content') staticProp(value, path + '/props/' + name);
    }
    const children = element.children === undefined ? [] : element.children;
    if (!Array.isArray(children) || children.length > 300 || (!['section', 'repeat', 'grid', 'document'].includes(type) && children.length)) return fail('invalid_children', path);
    if (type === 'cover' || type === 'section') props.title = bodyText(props.title, path + '/props/title');
    if (type === 'text' || (type === 'cover' && own(props, 'content'))) props.content = bodyText(props.content, path + '/props/content');
    const nodes = children.map((child) => walk(child, depth + 1));
    return { ...props, id: key, type, ...(type === 'grid' ? { items: nodes } : nodes.length ? { children: nodes } : {}) };
  }
  const root = walk(spec.root, 0);
  if (seen.size !== Object.keys(elements).length) return fail('unreachable_node', '/body/elements');
  if (root.type !== 'document') return [root];
  if (!root.children?.length) return fail('invalid_children', '/body/root');
  return root.children;
}

export function v3BodyProblem(body: unknown): string | null {
  try { compileV3Body(body); return null; }
  catch (e) { if (e instanceof InvalidBody) return e.message; throw e; }
}
import { formatNumber, reportNumberSpec } from '../value-format.ts';
