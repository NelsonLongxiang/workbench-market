/**
 * 报告的编排（docs/report-step1.md 第三节；报告第 1 步 PR B）：模板 + 台的绑定 + 台库按绑定取回的数 + 输入 + 论断 → 冻结的报告。纯函数，不碰库。
 *
 * 由 P0 的技术试验（web/src/report-template/p0.ts）改写而来，规矩照搬，差别：
 *   · 模板可用第二版节点数组，或第三版平铺正文和冻结时求值的指令；
 *   · 绑定只说「数据槽对应本台哪份视图的哪个块、参数和列怎么对应」；数据来源的视图版本、视图描述的 sha256、行数由台库填（ReportSlotData），
 *     不再收调用方给的「夹具证据」（P0 文档写明那些不是生产授权）；
 *   · 论断（第三节）随报告一起核、一起冻结：类别、条数照模板；依据（basis）指的数据槽、行要在这份报告里；
 *   · 图片节点（docs/image-step1.md 第五节、用例 8；图片第 1 步 PR C）：src 引用一个 image 类型的参数、一个文字字段或数据行里一个 image 列，
 *     冻结时只记链接加哈希（属主 D5）。这里是纯函数，只核写法、解析出链接；哈希由 services/bench-report.ts 取图后填（imageNodesOf）。
 * 网页那份 P0 照旧留着做打印试验（前端没有引用服务端代码的路子），服务端以这一份为准。
 */
import { createHash } from 'node:crypto';
import { imageRefOk } from '../bench-query.ts';
import type { ReportSlotData } from './bench-store-core.ts';
import { compileV3Body, ReportError, type ReportText } from './report-body-v3.ts';

export { ReportError };

export type Ref = { ref: { scope: 'parameter' | 'field' | 'row'; name: string } };
type SlotCol = { name: string; type: string; label: string; nullable?: boolean };
type Slot = { columns: SlotCol[]; key?: string[]; max_rows: number; completeness: 'all' | 'summary' };
type Node = {
  id: string; type: string; title?: unknown; content?: unknown; children?: Node[]; items?: Node[]; columns?: number[];
  data?: string; row_key?: string[]; max_items?: number; component?: string; props?: Record<string, unknown>; src?: unknown; alt?: unknown;
};
type TemplateFields = {
  title: string; parameters: Record<string, { type: string; required: boolean }>; fields: Record<string, { required: boolean; max_length: number }>;
  slots: Record<string, Slot>; claims: { kind: string; label: string; min: number; max: number }[];
};
export type ReportTemplate = TemplateFields & ({ schema_version: 2; body: Node[] } | { schema_version: 3; body: unknown });
export type Inputs = { parameters: Record<string, string>; fields: Record<string, string> };
/** 一个数据槽的绑定：本台第几份视图（键）、第几个块，筛选参数从哪个输入来，槽的列对应块的哪一列 */
export type SlotBinding = { view: string; block: number; params: Record<string, Ref>; columns: Record<string, string> };
export type Binding = Record<string, SlotBinding>;
export type ClaimInput = { kind: string; text: string; basis?: { slot: string; key: (string | number | boolean)[] }[] };
export type FrozenClaim = { claim_key: string; kind: string; text: string; basis: { slot: string; key: (string | number | boolean)[] }[] };
export type SourceMeta = { slot: string; view: string; block: number; view_version: number; view_sha256: string; rows: number; completeness: string };
type BlockColumn = { name: string; type: string; label: string };
type BlockData = { columns: BlockColumn[]; rows: Record<string, unknown>[]; truncated: false };
export type ResolvedNode = { id: string; type: string; title?: string; content?: string; children?: ResolvedNode[]; columns?: number[]; component?: string; props?: Record<string, unknown>; data?: BlockData; src?: string; alt?: string; sha256?: string };
/** 冻结的图片节点：链接（格子或输入里的原值）、替代文字、取到的图的 sha256（冻结时由 bench-report.ts 填） */
export type ImageNode = ResolvedNode & { type: 'image'; src: string; alt: string; sha256: string };
/** 一份报告最多这么多个图片节点（展开 repeat 之后算），和 repeat 的 max_items 上限一致（#1081）：冻结时每张都要取一次 */
export const IMAGE_NODES_MAX = 100;
/** 冻结时取回的图片总字节上限（同一链接只算一次）。单张上限另见 bench-image.ts 的 IMAGE_LIMITS.bytes（5MB） */
export const IMAGE_BYTES_MAX = 64 * 1024 * 1024;
export type FrozenBody = { schema_version: 2; title: string; inputs: Inputs; body: ResolvedNode[] };

const fail: (code: string, path: string, detail?: string) => never = (code, path, detail) => { throw new ReportError(code, path, detail); };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: object, k: string) => Object.hasOwn(v, k);
const keys = (v: unknown, allowed: string[], path: string) => { if (!obj(v)) fail('invalid_object', path); for (const k of Object.keys(v)) if (!allowed.includes(k)) fail('unknown_key', path + '/' + k); };
const ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const id = (v: unknown, path: string): string => typeof v === 'string' && ID_RE.test(v) ? v : fail('invalid_id', path);
const text = (v: unknown, path: string, max = 10000): string => typeof v === 'string' && v.length <= max ? v : fail('invalid_text', path);
const bounded = (v: unknown, min: number, max: number, path: string) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max ? Number(v) : fail('invalid_limit', path);
const TYPES = ['text', 'integer', 'decimal', 'date', 'datetime', 'boolean', 'image'];
/** 模板参数的类型：月份（筛选用），图片（image 节点的来源，值是图片链接） */
const PARAM_TYPES = ['month', 'image'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 核数据槽的声明（模板里），回规范化的槽表 */
function slotsOf(t: ReportTemplate): Record<string, Slot> {
  if (!obj(t.slots) || Object.keys(t.slots).length > 24) fail('invalid_slot', '/slots');
  for (const [name, slot] of Object.entries(t.slots)) {
    id(name, '/slots/' + name); keys(slot, ['columns', 'key', 'max_rows', 'completeness'], '/slots/' + name);
    bounded(slot.max_rows, 1, 5000, '/slots/' + name + '/max_rows');
    if (!['all', 'summary'].includes(slot.completeness) || !Array.isArray(slot.columns) || slot.columns.length < 1 || slot.columns.length > 60) fail('invalid_slot', '/slots/' + name);
    const names = new Set<string>();
    for (const c of slot.columns) {
      keys(c, ['name', 'type', 'label', 'nullable'], '/slots/' + name + '/columns');
      id(c.name, '/slots/' + name + '/columns');
      if (names.has(c.name) || !TYPES.includes(c.type) || typeof c.label !== 'string' || !c.label) fail('invalid_column', '/slots/' + name + '/' + c.name);
      names.add(c.name);
    }
    if (slot.key !== undefined && (!Array.isArray(slot.key) || !slot.key.length || slot.key.some((k) => !names.has(k)))) fail('invalid_row_key', '/slots/' + name);
  }
  return t.slots;
}

/** 核输入（参数、文字字段），回一份复制 */
export function prepareInputs(t: ReportTemplate, input: unknown): Inputs {
  if (!obj(input) || !obj(input.parameters) || !obj(input.fields)) fail('invalid_inputs', '/inputs');
  keys(input, ['parameters', 'fields'], '/inputs');
  const params = input.parameters as Record<string, unknown>, fields = input.fields as Record<string, unknown>;
  keys(params, Object.keys(t.parameters), '/inputs/parameters');
  keys(fields, Object.keys(t.fields), '/inputs/fields');
  for (const [name, def] of Object.entries(t.parameters)) {
    id(name, '/parameters/' + name); keys(def, ['type', 'required'], '/parameters/' + name);
    if (!PARAM_TYPES.includes(def.type) || typeof def.required !== 'boolean') fail('invalid_parameter', '/parameters/' + name);
    const v = params[name];
    if (v === undefined && !def.required) continue;
    if (def.type === 'image') { if (typeof v !== 'string' || !imageRefOk(v)) fail('invalid_image_ref', '/inputs/parameters/' + name); continue; }
    if (typeof v !== 'string' || !MONTH_RE.test(v)) fail('invalid_month', '/inputs/parameters/' + name);
  }
  for (const [name, def] of Object.entries(t.fields)) {
    id(name, '/fields/' + name); keys(def, ['required', 'max_length'], '/fields/' + name);
    bounded(def.max_length, 1, 10000, '/fields/' + name + '/max_length');
    if (typeof def.required !== 'boolean') fail('invalid_field', '/fields/' + name);
    const v = fields[name]; if (v === undefined && !def.required) continue;
    if (typeof v !== 'string' || v.length > def.max_length || (def.required && !v.trim())) fail('invalid_field', '/inputs/fields/' + name);
  }
  return jsonCopy({ parameters: params, fields }) as Inputs;
}

/** 把一段文字片段（字符串或引用）拼成文字 */
function renderText(v: unknown, path: string, input: Inputs, row?: Record<string, unknown>): string {
  if (!Array.isArray(v) || v.length > 100) fail('invalid_fragments', path);
  return (v as unknown[]).map((x, i) => {
    if (typeof x === 'string') return text(x, path + '/' + i);
    if (!obj(x) || !obj(x.ref)) return fail('invalid_reference', path + '/' + i);
    keys(x, ['ref'], path); keys(x.ref, ['scope', 'name'], path);
    const { scope, name } = x.ref as { scope: unknown; name: unknown };
    if (typeof name !== 'string') return fail('invalid_reference', path);
    const values: Record<string, unknown> | null = scope === 'parameter' ? input.parameters : scope === 'field' ? input.fields : scope === 'row' && row ? row : null;
    if (!values || !own(values, name)) return fail('missing_reference', path + '/' + name);
    const value = values[name];
    if (value === null || value === undefined) return fail('missing_reference', path + '/' + name);
    if (!['string', 'number', 'boolean'].includes(typeof value)) return fail('invalid_reference_value', path);
    return String(value);
  }).join('');
}

/**
 * image 节点的来源 → 图片链接。src 只能是一个引用（不能拼字）：
 *   · parameter：模板里声明成 image 类型的参数（month 类型的不行）；
 *   · field：文字字段，值要是合规的图片链接；
 *   · row：repeat 里当前那一行的一列，这一列在槽里要是 image 类型。
 * 引用的东西不是图片（参数、列的类型不对）报 image_source_type；值不是合规链接报 invalid_image_ref；没有值报 missing_reference
 */
function imageSource(t: ReportTemplate, v: unknown, path: string, input: Inputs, row?: { values: Record<string, unknown>; columns: BlockColumn[] }): string {
  if (!obj(v) || !obj(v.ref)) return fail('invalid_reference', path);
  keys(v, ['ref'], path); keys(v.ref, ['scope', 'name'], path);
  const { scope, name } = v.ref as { scope: unknown; name: unknown };
  if (typeof name !== 'string') return fail('invalid_reference', path);
  let value: unknown;
  if (scope === 'parameter') {
    if (!own(t.parameters, name)) return fail('missing_reference', path + '/' + name);
    if (t.parameters[name].type !== 'image') return fail('image_source_type', path);
    value = own(input.parameters, name) ? input.parameters[name] : undefined;
  } else if (scope === 'field') {
    if (!own(t.fields, name)) return fail('missing_reference', path + '/' + name);
    value = own(input.fields, name) ? input.fields[name] : undefined;
  } else if (scope === 'row' && row) {
    const c = row.columns.find((x) => x.name === name);
    if (!c) return fail('missing_reference', path + '/' + name);
    if (c.type !== 'image') return fail('image_source_type', path);
    value = row.values[name];
  } else return fail('missing_reference', path + '/' + name);
  if (value === null || value === undefined || value === '') return fail('missing_reference', path + '/' + name);
  if (typeof value !== 'string' || !imageRefOk(value)) return fail('invalid_image_ref', path);
  return value;
}
/** 替代文字：1～200 个字符、不全是空白、不带控制字符 */
const altText = (v: unknown, path: string): string => (typeof v === 'string' && v.trim() !== '' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : fail('invalid_alt', path));

/** 冻结正文里的全部图片节点（按出现顺序，含 section、grid、repeat 展开后的子节点） */
export function imageNodesOf(nodes: ResolvedNode[] | unknown): ImageNode[] {
  const out: ImageNode[] = [];
  const walk = (ns: unknown) => { if (!Array.isArray(ns)) return; for (const n of ns as ResolvedNode[]) { if (n && n.type === 'image' && typeof n.src === 'string') out.push(n as ImageNode); walk(n?.children); } };
  walk(nodes);
  return out;
}

/**
 * 冻结时给每个图片节点填 sha256：同一链接只取一次。取回的图累计字节（同一链接只算一次）超过 bytesMax 就停，
 * 报 image_limit（detail bytes），后面的图不再取。取图由调用方给（services/bench-report.ts 传代取的 fetchImage），这里不碰网络。
 */
export async function hashImages(nodes: ResolvedNode[] | unknown, fetchBody: (src: string) => Promise<Buffer | Uint8Array>, bytesMax = IMAGE_BYTES_MAX): Promise<void> {
  const hashes = new Map<string, string>();
  let total = 0;
  for (const n of imageNodesOf(nodes)) {
    let h = hashes.get(n.src);
    if (h === undefined) {
      const body = await fetchBody(n.src);
      total += body.length;
      if (total > bytesMax) fail('image_limit', '/body/' + n.id, 'bytes');
      h = createHash('sha256').update(body).digest('hex');
      hashes.set(n.src, h);
    }
    n.sha256 = h;
  }
}

/**
 * 核台的绑定（绑的时候核一次，生成时再核一次：模板和绑定都可能变）：模板的每个数据槽都要绑、不多绑；
 * 每个槽：view 是视图的键，block 是 0～39 的块号，params 的值只能是参数、文字字段的引用（行引用没有意义），columns 盖住槽的每一列
 */
export function checkBinding(t: ReportTemplate, b: unknown): Binding {
  const slots = slotsOf(t);
  if (!obj(b)) fail('invalid_binding', '/binding');
  keys(b, Object.keys(slots), '/binding');
  for (const [name, slot] of Object.entries(slots)) {
    if (!own(b, name)) fail('missing_binding', '/binding/' + name);
    const sb = b[name];
    keys(sb, ['view', 'block', 'params', 'columns'], '/binding/' + name);
    const x = sb as Record<string, unknown>;
    if (typeof x.view !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(x.view)) fail('invalid_binding', '/binding/' + name + '/view');
    bounded(x.block, 0, 39, '/binding/' + name + '/block');
    if (!obj(x.params) || Object.keys(x.params).length > 20) fail('invalid_binding', '/binding/' + name + '/params');
    for (const [p, r] of Object.entries(x.params)) {
      if (!obj(r) || !obj(r.ref)) fail('invalid_reference', '/binding/' + name + '/params/' + p);
      keys(r, ['ref'], '/binding/' + name + '/params/' + p); keys((r as Ref).ref, ['scope', 'name'], '/binding/' + name + '/params/' + p);
      const ref = (r as Ref).ref;
      const decl = ref.scope === 'parameter' ? t.parameters : ref.scope === 'field' ? t.fields : null;
      if (!decl || typeof ref.name !== 'string' || !own(decl, ref.name)) fail('invalid_reference', '/binding/' + name + '/params/' + p);
    }
    if (!obj(x.columns)) fail('invalid_binding', '/binding/' + name + '/columns');
    keys(x.columns, slot.columns.map((c) => c.name), '/binding/' + name + '/columns');
    for (const c of slot.columns) if (!own(x.columns, c.name) || typeof (x.columns as Record<string, unknown>)[c.name] !== 'string') fail('missing_column_mapping', '/binding/' + name + '/' + c.name);
  }
  return jsonCopy(b) as Binding;
}

/** 生成时按绑定和输入算出每个槽要取什么：筛选参数从输入里取值，按槽的 max_rows 取（多一行由台库标 truncated） */
export function slotSpecs(t: ReportTemplate, b: Binding, input: Inputs): { slot: string; view: string; block: number; params: Record<string, string>; limit: number }[] {
  return Object.entries(slotsOf(t)).map(([name, slot]) => {
    const sb = b[name];
    const params: Record<string, string> = {};
    for (const [p, r] of Object.entries(sb.params)) params[p] = renderText([r], '/binding/' + name + '/params/' + p, input);
    return { slot: name, view: sb.view, block: sb.block, params, limit: slot.max_rows };
  });
}

/** 冻结：核每个槽取回的数（完整、列类型、行键），展开文档结构，核论断。回成品、来源、论断 */
export function materialize(t: ReportTemplate, b: Binding, data: ReportSlotData[], input: Inputs, claimsIn: unknown): { body: FrozenBody; sources: SourceMeta[]; claims: FrozenClaim[] } {
  const slots = slotsOf(t);
  const slotData: Record<string, BlockData> = Object.create(null);
  const sources: SourceMeta[] = [];
  for (const [name, slot] of Object.entries(slots)) {
    const d = data.find((x) => x.slot === name);
    if (!d) fail('source_unavailable', '/slots/' + name);
    // 取不完（比 max_rows 多）就拒：不出半份报告
    if (d.truncated !== false || d.rows.length > slot.max_rows) fail('incomplete_data', '/slots/' + name);
    const sb = b[name];
    const columns: BlockColumn[] = slot.columns.map((c) => {
      const src = d.columns.find((x) => x.name === sb.columns[c.name]);
      if (!src || src.type !== c.type) return fail('incompatible_column', '/slots/' + name + '/' + c.name);
      return { name: c.name, type: c.type, label: c.label };
    });
    const rows = d.rows.map((r, ri) => {
      if (!obj(r)) return fail('invalid_row', '/slots/' + name + '/rows/' + ri);
      return Object.fromEntries(slot.columns.map((c) => {
        const srcName = sb.columns[c.name]; const v = own(r, srcName) ? r[srcName] : undefined;
        if ((v === null || v === undefined) && c.nullable) return [c.name, null];
        const valid = c.type === 'integer' ? Number.isSafeInteger(v) : c.type === 'decimal' ? typeof v === 'number' && Number.isFinite(v) : c.type === 'boolean' ? typeof v === 'boolean'
          : c.type === 'image' ? typeof v === 'string' && imageRefOk(v) : typeof v === 'string' && v.length <= 10000;
        if (!valid) return fail('invalid_cell', '/slots/' + name + '/rows/' + ri + '/' + c.name);
        return [c.name, v];
      }));
    });
    if (slot.key) {
      const seen = new Set<string>();
      for (const r of rows) {
        const value = slot.key.map((k) => r[k]);
        if (value.some((x) => x === null || x === undefined)) fail('missing_row_key', '/slots/' + name);
        const k = JSON.stringify(value); if (seen.has(k)) fail('duplicate_row_key', '/slots/' + name); seen.add(k);
      }
    }
    slotData[name] = { columns, rows, truncated: false };
    sources.push({ slot: name, view: d.view, block: d.block, view_version: d.view_version, view_sha256: d.view_sha256, rows: rows.length, completeness: slot.completeness });
  }

  const nodeIds = new Set<string>(); let expanded = 0, images = 0;
  const allowedByType: Record<string, string[]> = {
    cover: ['title', 'content'], section: ['title', 'children'], text: ['content'], grid: ['columns', 'items'],
    repeat: ['data', 'row_key', 'max_items', 'children'], 'data-view': ['component', 'data', 'props'], 'page-break': [], image: ['src', 'alt'],
  };
  const validateNodes = (nodes: unknown, depth = 0) => {
    if (!Array.isArray(nodes) || depth > 6) fail('node_depth', '/body');
    if (nodes.length > 300) fail('node_limit', '/body');
    for (const n of nodes as Node[]) {
      if (!obj(n) || typeof n.type !== 'string' || !own(allowedByType, n.type)) fail('unsupported_node', '/body');
      id(n.id, '/body/id'); if (nodeIds.has(n.id) || nodeIds.size >= 300) fail('node_id_or_limit', '/body/' + n.id); nodeIds.add(n.id);
      keys(n, ['id', 'type', ...allowedByType[n.type]], '/body/' + n.id);
      if (n.type === 'section' || n.type === 'repeat') validateNodes(n.children ?? [], depth + 1);
      if (n.type === 'grid') validateNodes(n.items, depth + 1);
    }
  };
  const nodes = t.schema_version === 3 ? compileV3Body(t.body) as Node[] : t.body;
  validateNodes(nodes);
  const bodyText = (v: unknown, path: string, row?: Record<string, unknown>) =>
    t.schema_version === 3 ? (v as ReportText)({ ...input, row, slots: slotData }) : renderText(v, path, input, row);
  const renderNodes = (nodes: Node[], suffix = '', row?: Record<string, unknown>, rowCols?: BlockColumn[]): ResolvedNode[] => nodes.flatMap((n) => {
    if (++expanded > 1000) return fail('expanded_limit', '/body');
    const path = '/body/' + n.id, base = { id: n.id + suffix, type: n.type };
    if (n.type === 'repeat') {
      const d = slotData[n.data ?? ''], contract = slots[n.data ?? ''];
      if (!d || !Array.isArray(n.row_key) || JSON.stringify(n.row_key) !== JSON.stringify(contract.key)) return fail('invalid_repeat_key', path);
      const max = bounded(n.max_items, 1, 100, path + '/max_items'); if (d.rows.length > max) return fail('repeat_limit', path);
      return d.rows.flatMap((r) => renderNodes(n.children ?? [], suffix + '/' + encodeURIComponent(JSON.stringify(n.row_key?.map((k) => r[k]))), r, d.columns));
    }
    if (n.type === 'cover') return [{ ...base, title: bodyText(n.title, path + '/title', row), content: n.content ? bodyText(n.content, path + '/content', row) : '' }];
    if (n.type === 'text') return [{ ...base, content: bodyText(n.content, path + '/content', row) }];
    if (n.type === 'section') return [{ ...base, title: bodyText(n.title, path + '/title', row), children: renderNodes(n.children ?? [], suffix, row, rowCols) }];
    if (n.type === 'image') {
      if (++images > IMAGE_NODES_MAX) return fail('image_limit', path, 'count');
      const src = imageSource(t, n.src, path + '/src', input, row && rowCols ? { values: row, columns: rowCols } : undefined);
      return [{ ...base, src, alt: altText(n.alt, path + '/alt'), sha256: '' }];
    }
    if (n.type === 'grid') {
      const cols = n.columns, items = n.items;
      if (!Array.isArray(cols) || !Array.isArray(items) || cols.length !== items.length || items.length < 1 || items.length > 4 || cols.some((x) => !Number.isInteger(x) || x < 1 || x > 12) || cols.reduce((a, b2) => a + b2, 0) !== 12) return fail('invalid_grid', path);
      if (!['12', '6-6', '4-4-4', '3-3-3-3'].includes(cols.join('-'))) return fail('grid_ratio_unsupported', path);
      // #1081：格子里可以放图（一行并排几张小图），和前端 p0.ts 的校验一致；表格仍不能拆进格子
      if (items.some((x) => !['text', 'data-view', 'image'].includes(x.type) || x.component === 'table')) return fail('grid_split_unsupported', path);
      return [{ ...base, columns: [...cols], children: renderNodes(items, suffix, row, rowCols) }];
    }
    if (n.type === 'data-view') {
      const d = slotData[n.data ?? '']; if (!d || !obj(n.props)) return fail('missing_slot', path);
      if (!['stat', 'table', 'bar'].includes(n.component ?? '')) return fail('unsupported_component', path);
      const p = n.props; keys(p, n.component === 'stat' ? ['value', 'unit'] : n.component === 'bar' ? ['x', 'y'] : ['columns'], path + '/props');
      const column = (cname: unknown, numeric = false) => { const c = d.columns.find((x) => x.name === cname); if (!c || (numeric && !['integer', 'decimal'].includes(c.type))) fail('invalid_column_role', path); };
      if (n.component === 'stat') { column(p.value, true); if (d.rows.length !== 1) return fail('scalar_cardinality', path); }
      if (n.component === 'bar') { column(p.x); if (!Array.isArray(p.y) || !p.y.length || p.y.length > 12) return fail('invalid_y', path); (p.y as unknown[]).forEach((c) => column(c, true)); }
      if (n.component === 'table') { if (!Array.isArray(p.columns) || !p.columns.length || new Set(p.columns).size !== p.columns.length) return fail('invalid_table_columns', path); (p.columns as unknown[]).forEach((c) => column(c)); }
      if (p.unit !== undefined) text(p.unit, path + '/unit');
      return [{ ...base, component: n.component, props: jsonCopy(p), data: jsonCopy(d) }];
    }
    return [base];
  });
  const body: FrozenBody = { schema_version: 2, title: t.title, inputs: jsonCopy(input), body: renderNodes(nodes) };
  return { body, sources, claims: checkClaims(t, claimsIn, slotData) };
}

/** 核论断（第三节）：类别只能是模板声明的；每类条数在 min～max 里；正文 1～4000 字；依据指的槽要有行键，行要在这份报告里。claim_key 是「类别-序号」 */
function checkClaims(t: ReportTemplate, claimsIn: unknown, slotData: Record<string, BlockData>): FrozenClaim[] {
  if (!Array.isArray(claimsIn) || claimsIn.length > 200) fail('invalid_claims', '/claims');
  const decl = new Map(t.claims.map((c) => [c.kind, c]));
  const count = new Map<string, number>();
  const out: FrozenClaim[] = [];
  for (const [i, c] of (claimsIn as unknown[]).entries()) {
    const path = '/claims/' + i;
    keys(c, ['kind', 'text', 'basis'], path);
    const x = c as ClaimInput;
    if (typeof x.kind !== 'string' || !decl.has(x.kind)) fail('unknown_claim_kind', path + '/kind');
    if (typeof x.text !== 'string' || !x.text.trim() || x.text.length > 4000) fail('invalid_claim_text', path + '/text');
    const basis: FrozenClaim['basis'] = [];
    if (x.basis !== undefined) {
      if (!Array.isArray(x.basis) || x.basis.length > 20) fail('invalid_basis', path + '/basis');
      for (const [j, bb] of x.basis.entries()) {
        keys(bb, ['slot', 'key'], path + '/basis/' + j);
        const sd = typeof bb.slot === 'string' ? slotData[bb.slot] : undefined;
        const keyCols = typeof bb.slot === 'string' ? t.slots[bb.slot]?.key : undefined;
        if (!sd || !keyCols || !Array.isArray(bb.key) || bb.key.length !== keyCols.length) fail('basis_not_in_report', path + '/basis/' + j);
        const want = JSON.stringify(bb.key);
        if (!sd.rows.some((r) => JSON.stringify(keyCols.map((k) => r[k])) === want)) fail('basis_not_in_report', path + '/basis/' + j);
        basis.push({ slot: bb.slot, key: jsonCopy(bb.key) });
      }
    }
    const n = (count.get(x.kind) ?? 0) + 1; count.set(x.kind, n);
    out.push({ claim_key: `${x.kind}-${n}`, kind: x.kind, text: x.text, basis });
  }
  for (const c of t.claims) {
    const n = count.get(c.kind) ?? 0;
    if (n < c.min || n > c.max) fail('claim_count', '/claims/' + c.kind);
  }
  return out;
}

/**
 * 产出方、回应者算人还是 AI（人和 AI 的边界是两层组织的基础，#930 独立验收）：只有主体表里登记为人（kind 为 person）的记 human；
 * 席位、应用、节点、系统主体、内置身份（本机命令行、匿名……）、MCP 会话、认不出的，一律记 ai——宁可把人算成非人，不把非人算成人。
 * principalKind 是按 actor 在主体表里查到的 kind（查不到给 null）
 */
export function actorKindOf(principalKind: string | null | undefined): 'human' | 'ai' {
  return principalKind === 'person' ? 'human' : 'ai';
}
