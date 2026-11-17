/** P0 only: compile a bounded report template from already-resolved synthetic view results.
 * No IO, source authorization, persistence, production route or implicit query execution lives here.
 * A real adapter must authorize and resolve sources before calling; this is not that adapter.
 */
import type { BlockData, BlockColumn } from '../bench-blocks/blocks-view';

export type Ref = { ref: { scope: 'parameter' | 'field' | 'row'; name: string } };
export type Text = (string | Ref)[];
export type Slot = { columns: { name: string; type: BlockColumn['type']; label: string; nullable?: boolean }[]; key?: string[]; max_rows: number; completeness: 'all' | 'summary' };
export type Node = {
  id: string; type: 'cover' | 'section' | 'text' | 'grid' | 'repeat' | 'data-view' | 'image' | 'page-break';
  title?: Text; content?: Text; children?: Node[]; items?: Node[]; columns?: number[];
  data?: string; row_key?: string[]; max_items?: number;
  component?: 'stat' | 'table' | 'bar'; props?: { value?: string; unit?: string; x?: string; y?: string[]; columns?: string[] };
  asset?: string; alt?: string;
};
export type Template = { schema_version: 1; key: string; title: string; parameters: Record<string, { type: 'month'; required: boolean }>; fields: Record<string, { required: boolean; max_length: number }>; slots: Record<string, Slot>; body: Node[] };
export type View = { identity: string; version: number; definition_sha256: string; params: Record<string, string>; blocks: { type: string; data?: BlockData; error?: { code: string } }[] };
export type Bindings = Record<string, { source: string; identity: string; version: number; definition_sha256: string; block_index: number; expect_type: string; params: Record<string, Ref>; columns: Record<string, string>; expected_rows: number }>;
export type Inputs = { parameters: Record<string, string>; fields: Record<string, string> };
export type Asset = { mime: 'image/png'; data_url: string; sha256: string };
export type ResolvedNode = { id: string; type: Node['type']; title?: string; content?: string; children?: ResolvedNode[]; columns?: number[]; component?: Node['component']; props?: Node['props']; data?: BlockData; asset?: Asset; alt?: string };
export type FrozenReport = { schema_version: 1; template: { key: string; title: string }; inputs: Inputs; sources: { slot: string; identity: string; version: number; definition_sha256: string; rows: number; completeness: string }[]; body: ResolvedNode[] };
export class ReportError extends Error { constructor(publicCode: string, path: string) { super(publicCode + ' at ' + path); this.name = 'ReportError'; } }
const fail: (code: string, path: string) => never = (code, path) => { throw new ReportError(code, path); };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: object, k: string) => Object.hasOwn(v, k);
const keys = (v: object, allowed: string[], path: string) => { if (!obj(v)) fail('invalid_object', path); for (const k of Object.keys(v)) if (!allowed.includes(k)) fail('unknown_key', path + '/' + k); };
const id = (v: unknown, path: string): string => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(v) ? v : fail('invalid_id', path);
const text = (v: unknown, path: string): string => typeof v === 'string' && v.length <= 10000 ? v : fail('invalid_text', path);
const bounded = (v: unknown, min: number, max: number, path: string) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max ? Number(v) : fail('invalid_limit', path);
const types = ['text', 'integer', 'decimal', 'date', 'datetime', 'boolean'];
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.freeze(v); for (const x of Object.values(v)) freeze(x); } return v; }
function jsonCopy<T>(v: T): T { try { return JSON.parse(JSON.stringify(v)) as T; } catch { return fail('not_json', '/'); } }

/** Values are copied and deeply frozen. A template/version pin alone never freezes live values. */
export function materializeReport(template: Template, bindings: Bindings, views: Record<string, View>, input: Inputs, assets: Record<string, Asset> = {}): FrozenReport {
  if (!obj(template)) fail('invalid_template', '/template');
  let templateText: string; try { templateText = JSON.stringify(template); } catch { return fail('not_json', '/template'); }
  if (templateText.length > 200000) fail('template_limit', '/template');
  keys(template, ['schema_version', 'key', 'title', 'parameters', 'fields', 'slots', 'body'], '/template');
  if (template.schema_version !== 1) fail('unsupported_version', '/schema_version');
  id(template.key, '/key'); text(template.title, '/title');
  for (const name of ['parameters', 'fields', 'slots']) if (!obj(template[name as keyof Template])) fail('invalid_contract', '/' + name);
  if (!obj(input) || !obj(input.parameters) || !obj(input.fields)) fail('invalid_inputs', '/inputs');
  keys(input, ['parameters', 'fields'], '/inputs');
  keys(input.parameters, Object.keys(template.parameters), '/inputs/parameters');
  keys(input.fields, Object.keys(template.fields), '/inputs/fields');
  for (const [name, def] of Object.entries(template.parameters)) {
    id(name, '/parameters/' + name); keys(def, ['type', 'required'], '/parameters/' + name);
    if (def.type !== 'month' || typeof def.required !== 'boolean') fail('invalid_parameter', '/parameters/' + name);
    const v = input.parameters[name];
    if (v === undefined && !def.required) continue;
    if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) fail('invalid_month', '/inputs/parameters/' + name);
  }
  for (const [name, def] of Object.entries(template.fields)) {
    id(name, '/fields/' + name); keys(def, ['required', 'max_length'], '/fields/' + name);
    bounded(def.max_length, 1, 10000, '/fields/' + name + '/max_length');
    if (typeof def.required !== 'boolean') fail('invalid_field', '/fields/' + name);
    const v = input.fields[name]; if (v === undefined && !def.required) continue;
    if (typeof v !== 'string' || v.length > def.max_length || (def.required && !v.trim())) fail('invalid_field', '/inputs/fields/' + name);
  }
  const renderText = (v: unknown, path: string, row?: Record<string, unknown>): string => {
    if (!Array.isArray(v) || v.length > 100) fail('invalid_fragments', path);
    return v.map((x, i) => {
      if (typeof x === 'string') return text(x, path + '/' + i);
      if (!obj(x) || !obj(x.ref)) return fail('invalid_reference', path + '/' + i);
      keys(x, ['ref'], path); keys(x.ref, ['scope', 'name'], path);
      const { scope, name } = x.ref; if (typeof name !== 'string') return fail('invalid_reference', path);
      const values = scope === 'parameter' ? input.parameters : scope === 'field' ? input.fields : scope === 'row' && row ? row : null;
      if (!values || !own(values, name)) return fail('missing_reference', path + '/' + name);
      const value = values[name]; if (value === null || value === undefined) return fail('missing_reference', path + '/' + name);
      if (!['string', 'number', 'boolean'].includes(typeof value)) return fail('invalid_reference_value', path);
      return String(value);
    }).join('');
  };
  if (Object.keys(template.slots).length > 24 || !obj(bindings) || !obj(views)) fail('binding_limit', '/slots');
  keys(bindings, Object.keys(template.slots), '/bindings');
  const slotData: Record<string, BlockData> = Object.create(null);
  const sources: FrozenReport['sources'] = [];
  for (const [name, slot] of Object.entries(template.slots)) {
    id(name, '/slots/' + name); keys(slot, ['columns', 'key', 'max_rows', 'completeness'], '/slots/' + name);
    const max = bounded(slot.max_rows, 1, 5000, '/slots/' + name + '/max_rows');
    if (!['all', 'summary'].includes(slot.completeness) || !Array.isArray(slot.columns) || slot.columns.length < 1 || slot.columns.length > 60) fail('invalid_slot', '/slots/' + name);
    const names = new Set<string>();
    for (const c of slot.columns) {
      keys(c, ['name', 'type', 'label', 'nullable'], '/slots/' + name + '/columns');
      id(c.name, '/slots/' + name + '/columns');
      if (names.has(c.name) || !types.includes(c.type) || !c.label || typeof c.label !== 'string') fail('invalid_column', '/slots/' + name + '/' + c.name);
      names.add(c.name);
    }
    if (slot.key !== undefined && (!Array.isArray(slot.key) || !slot.key.length || slot.key.some(k => !names.has(k)))) fail('invalid_row_key', '/slots/' + name);
    const b = bindings[name];
    if (!own(bindings, name) || !b || !own(views, b.source)) fail('missing_binding', '/bindings/' + name);
    keys(b, ['source', 'identity', 'version', 'definition_sha256', 'block_index', 'expect_type', 'params', 'columns', 'expected_rows'], '/bindings/' + name);
    const view = views[b.source];
    bounded(b.version, 1, 1000000, '/bindings/' + name + '/version');
    if (!obj(view) || !obj(view.params) || !Array.isArray(view.blocks)) fail('invalid_source', '/bindings/' + name);
    keys(b.columns, slot.columns.map(c => c.name), '/bindings/' + name + '/columns');
    if (!/^[a-f0-9]{64}$/.test(b.definition_sha256) || view.identity !== b.identity || view.version !== b.version || view.definition_sha256 !== b.definition_sha256) fail('source_changed', '/bindings/' + name);
    if (!obj(b.params) || !obj(b.columns)) fail('invalid_binding', '/bindings/' + name);
    if (JSON.stringify(Object.keys(view.params).sort()) !== JSON.stringify(Object.keys(b.params).sort())) fail('unmapped_source_parameter', '/bindings/' + name);
    for (const [param, r] of Object.entries(b.params)) {
      const value = renderText([r], '/bindings/' + name + '/params/' + param);
      if (view.params[param] !== value) fail('parameter_mismatch', '/bindings/' + name + '/params/' + param);
    }
    const block = view.blocks[bounded(b.block_index, 0, 39, '/bindings/' + name + '/block_index')];
    if (!block || block.type !== b.expect_type || ['form', 'filter-bar'].includes(block.type)) fail('block_changed', '/bindings/' + name);
    if (block.error || !block.data) fail('source_unavailable', '/bindings/' + name);
    const data = block.data;
    if (!Array.isArray(data.columns) || !Array.isArray(data.rows) || data.rows.length > max) fail('row_limit', '/slots/' + name);
    if (data.truncated !== false) fail('incomplete_data', '/slots/' + name);
    // P0 fixtures provide a count captured with the rows; no inferred totals from array length.
    const expected = bounded(b.expected_rows, 0, max, '/bindings/' + name + '/expected_rows');
    if (data.rows.length !== expected) fail('incomplete_data', '/slots/' + name);
    const columns: BlockColumn[] = slot.columns.map(c => {
      if (!own(b.columns, c.name)) return fail('missing_column_mapping', '/bindings/' + name + '/' + c.name);
      const source = data.columns.find(x => x.name === b.columns[c.name]);
      if (!source || source.type !== c.type) return fail('incompatible_column', '/slots/' + name + '/' + c.name);
      return { name: c.name, type: c.type, label: c.label };
    });
    const rows = data.rows.map((r, ri) => { if (!obj(r)) return fail('invalid_row', '/slots/' + name + '/rows/' + ri); return Object.fromEntries(slot.columns.map(c => {
      const src = b.columns[c.name]; const v = own(r, src) ? r[src] : undefined;
      if (v === null && c.nullable) return [c.name, null];
      const valid = c.type === 'integer' ? Number.isSafeInteger(v) : c.type === 'decimal' ? typeof v === 'number' && Number.isFinite(v) : c.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string' && v.length <= 10000;
      if (!valid) return fail('invalid_cell', '/slots/' + name + '/rows/' + ri + '/' + c.name);
      return [c.name, v];
    })); });
    if (slot.key) {
      const seen = new Set<string>();
      for (const r of rows) { const value = slot.key.map(k => r[k]); if (value.some(x => x === null || x === undefined)) fail('missing_row_key', '/slots/' + name); const k = JSON.stringify(value); if (seen.has(k)) fail('duplicate_row_key', '/slots/' + name); seen.add(k); }
    }
    slotData[name] = { columns, rows, truncated: false };
    sources.push({ slot: name, identity: b.identity, version: b.version, definition_sha256: b.definition_sha256, rows: expected, completeness: slot.completeness });
  }
  const nodeIds = new Set<string>(); let expanded = 0;
  const allowedByType: Record<Node['type'], string[]> = {
    cover: ['title', 'content'], section: ['title', 'children'], text: ['content'], grid: ['columns', 'items'],
    repeat: ['data', 'row_key', 'max_items', 'children'], 'data-view': ['component', 'data', 'props'], image: ['asset', 'alt'], 'page-break': [],
  };
  function validateNodes(nodes: Node[], depth = 0) {
    if (!Array.isArray(nodes) || depth > 6) fail('node_depth', '/body');
    if (nodes.length > 300) fail('node_limit', '/body');
    for (const n of nodes) {
      if (!obj(n) || !own(allowedByType, n.type)) fail('unsupported_node', '/body');
      id(n.id, '/body/id'); if (nodeIds.has(n.id) || nodeIds.size >= 300) fail('node_id_or_limit', '/body/' + n.id); nodeIds.add(n.id);
      keys(n, ['id', 'type', ...allowedByType[n.type]], '/body/' + n.id);
      if (n.type === 'section' || n.type === 'repeat') validateNodes(n.children as Node[], depth + 1);
      if (n.type === 'grid') validateNodes(n.items as Node[], depth + 1);
    }
  }
  validateNodes(template.body);
  const renderNodes = (nodes: Node[], suffix = '', row?: Record<string, unknown>): ResolvedNode[] => nodes.flatMap(n => {
    if (++expanded > 1000) return fail('expanded_limit', '/body');
    const path = '/body/' + n.id, base = { id: n.id + suffix, type: n.type };
    if (n.type === 'repeat') {
      const d = slotData[n.data ?? ''], contract = template.slots[n.data ?? ''];
      if (!d || !Array.isArray(n.row_key) || JSON.stringify(n.row_key) !== JSON.stringify(contract.key)) return fail('invalid_repeat_key', path);
      const max = bounded(n.max_items, 1, 100, path + '/max_items'); if (d.rows.length > max) return fail('repeat_limit', path);
      const seen = new Set<string>();
      return d.rows.flatMap(r => {
        const key = JSON.stringify(n.row_key?.map(k => r[k])); if (seen.has(key)) return fail('duplicate_row_key', path); seen.add(key);
        return renderNodes(n.children ?? [], suffix + '/' + encodeURIComponent(key), r);
      });
    }
    if (n.type === 'cover') return [{ ...base, title: renderText(n.title, path + '/title', row), content: n.content ? renderText(n.content, path + '/content', row) : '' }];
    if (n.type === 'text') return [{ ...base, content: renderText(n.content, path + '/content', row) }];
    if (n.type === 'section') return [{ ...base, title: renderText(n.title, path + '/title', row), children: renderNodes(n.children ?? [], suffix, row) }];
    if (n.type === 'grid') {
      if (!Array.isArray(n.columns) || !Array.isArray(n.items) || n.columns.length !== n.items.length || n.items.length < 1 || n.items.length > 4 || n.columns.some(x => !Number.isInteger(x) || x < 1 || x > 12) || n.columns.reduce((a, b) => a + b, 0) !== 12) return fail('invalid_grid', path);
      if (!['12', '6-6', '4-4-4', '3-3-3-3'].includes(n.columns.join('-'))) return fail('grid_ratio_unsupported', path);
      if (n.items.some(x => !['text', 'data-view', 'image'].includes(x.type) || x.component === 'table')) return fail('grid_split_unsupported', path);
      return [{ ...base, columns: [...n.columns], children: renderNodes(n.items, suffix, row) }];
    }
    if (n.type === 'data-view') {
      const d = slotData[n.data ?? '']; if (!d || !n.props) return fail('missing_slot', path);
      if (!['stat', 'table', 'bar'].includes(n.component ?? '')) return fail('unsupported_component', path);
      const p = n.props; keys(p, n.component === 'stat' ? ['value', 'unit'] : n.component === 'bar' ? ['x', 'y'] : ['columns'], path + '/props');
      const column = (name: unknown, numeric = false) => { const c = d.columns.find(x => x.name === name); if (!c || numeric && !['integer', 'decimal'].includes(c.type)) fail('invalid_column_role', path); };
      if (n.component === 'stat') { column(p.value, true); if (d.rows.length !== 1) return fail('scalar_cardinality', path); }
      if (n.component === 'bar') { column(p.x); if (!Array.isArray(p.y) || !p.y.length || p.y.length > 12) return fail('invalid_y', path); p.y.forEach(c => column(c, true)); }
      if (n.component === 'table') { if (!Array.isArray(p.columns) || !p.columns.length || new Set(p.columns).size !== p.columns.length) return fail('invalid_table_columns', path); p.columns.forEach(c => column(c)); }
      if (p.unit !== undefined) text(p.unit, path + '/unit');
      return [{ ...base, component: n.component, props: jsonCopy(p), data: jsonCopy(d) }];
    }
    if (n.type === 'image') {
      if (!n.asset || !own(assets, n.asset) || !n.alt) return fail('missing_asset', path);
      const a = assets[n.asset]; if (a.mime !== 'image/png' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(a.data_url) || !/^[a-f0-9]{64}$/.test(a.sha256)) return fail('invalid_asset', path);
      return [{ ...base, asset: jsonCopy(a), alt: text(n.alt, path + '/alt') }];
    }
    return [base];
  });
  return freeze({ schema_version: 1, template: { key: template.key, title: template.title }, inputs: jsonCopy(input), sources, body: renderNodes(template.body) });
}
