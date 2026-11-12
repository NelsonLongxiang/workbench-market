/**
 * 数据视图的视图描述（docs/data-views.md 第六、八节）：核对一份描述合不合格，以及两个版本之间差在哪。
 *
 * 改台不走评审，这里的核对就是不让坏描述生效的那一关：组件类型认得、键不多不少、引用的数据集和列存在、
 * 查询合法、$参数 在同一个视图的筛选栏里声明过。不合格的不产生新版本（由 services/bench-store.ts 的 putView 调）。
 *
 * 纯函数，不碰库。组件清单是第一批的八个；第二批的类型做出来之前在这里不认。
 * 描述里的文字只当文字：页面渲染时一律转义，这里不解释其中的任何标记。
 */
import { BenchError, NAME_RE, planQuery, type DatasetDef, type OutColumn } from './bench-query.ts';

export const BLOCK_TYPES = ['filter-bar', 'stat', 'table', 'bar', 'line', 'pie', 'progress', 'form'] as const;
const VIEW_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FILTER_KINDS = ['month', 'date', 'select', 'search'];
const MAX_VIEWS = 20, MAX_BLOCKS = 40, MAX_FIELDS = 40;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;

/** 核对一份视图描述；返回不合格的地方（空数组 = 合格），每条写明在哪个视图的第几个组件 */
export function validateViewDoc(doc: unknown, datasets: Map<string, DatasetDef>): string[] {
  const errs: string[] = [];
  const keys = (o: Record<string, unknown>, allowed: string[], where: string) => {
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.length) errs.push(`${where}：有不认识的键 ${extra.join('、')}`);
  };
  if (!isObj(doc)) return ['视图描述须为对象'];
  keys(doc, ['title', 'views'], '视图描述');
  if (!isText(doc.title, 64)) errs.push('title 须为 1～64 个字符');
  if (!Array.isArray(doc.views) || !doc.views.length || doc.views.length > MAX_VIEWS) return [...errs, `views 须为 1～${MAX_VIEWS} 个视图的数组`];
  const seenKeys = new Set<string>();
  doc.views.forEach((view: unknown, vi: number) => {
    const vAt = `第 ${vi + 1} 个视图`;
    if (!isObj(view)) { errs.push(`${vAt} 须为对象`); return; }
    keys(view, ['key', 'title', 'blocks'], vAt);
    if (typeof view.key !== 'string' || !VIEW_KEY_RE.test(view.key)) errs.push(`${vAt}：key 须为小写字母开头，只含小写字母、数字、连字符，最多 32 个字符`);
    else if (seenKeys.has(view.key)) errs.push(`${vAt}：key ${view.key} 重复`);
    else seenKeys.add(view.key);
    if (!isText(view.title, 32)) errs.push(`${vAt}：title 须为 1～32 个字符`);
    if (!Array.isArray(view.blocks) || view.blocks.length > MAX_BLOCKS) { errs.push(`${vAt}：blocks 须为数组（最多 ${MAX_BLOCKS} 个组件）`); return; }

    // 这个视图的筛选栏声明了哪些参数
    const declared = new Set<string>();
    for (const b of view.blocks) if (isObj(b) && b.type === 'filter-bar' && Array.isArray(b.fields)) for (const f of b.fields) if (isObj(f) && typeof f.name === 'string') declared.add(f.name);

    view.blocks.forEach((block: unknown, bi: number) => {
      const at = `${vAt}第 ${bi + 1} 个组件`;
      if (!isObj(block)) { errs.push(`${at} 须为对象`); return; }
      const type = block.type;
      if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) { errs.push(`${at}：不认识的组件类型 ${String(type).slice(0, 40)}（现有：${BLOCK_TYPES.join('、')}）`); return; }
      if (block.title !== undefined && !isText(block.title, 64, 0)) errs.push(`${at}：title 须为 64 个字符以内的文本`);
      if (block.span !== undefined && (!Number.isInteger(block.span) || (block.span as number) < 1 || (block.span as number) > 12)) errs.push(`${at}：span 须为 1～12 的整数（12 栏网格里占几栏）`);
      const base = ['type', 'title', 'span'];

      /** 核对组件里的查询，返回它的输出列；查询不合格时返回 null */
      const query = (): OutColumn[] | null => {
        try {
          const plan = planQuery(block.query, datasets);
          for (const p of plan.params) if (!declared.has(p)) errs.push(`${at}：查询引用了 $${p}，但这个视图的筛选栏里没有这个字段`);
          return plan.columns;
        } catch (e) {
          errs.push(`${at}：查询不合格——${e instanceof BenchError ? e.message : '写法不对'}`);
          return null;
        }
      };
      const out = (cols: OutColumn[] | null, name: unknown, prop: string, numeric = false) => {
        if (!cols) return;
        const c = typeof name === 'string' ? cols.find((x) => x.name === name) : undefined;
        if (!c) errs.push(`${at}：${prop} 须为查询的一个输出列（${cols.map((x) => x.name).join('、')}）`);
        else if (numeric && c.type !== 'integer' && c.type !== 'decimal') errs.push(`${at}：${prop} 指向的列 ${c.name} 不是数值`);
      };
      const outMany = (cols: OutColumn[] | null, v: unknown, prop: string) => {
        const list = Array.isArray(v) ? v : [v];
        if (!list.length || list.length > 12) { errs.push(`${at}：${prop} 须为 1～12 个输出列`); return; }
        for (const n of list) out(cols, n, prop, true);
      };
      const flag = (name: string) => { if (block[name] !== undefined && typeof block[name] !== 'boolean') errs.push(`${at}：${name} 须为 true 或 false`); };

      if (type === 'filter-bar') {
        keys(block, [...base, 'fields'], at);
        if (!Array.isArray(block.fields) || !block.fields.length || block.fields.length > 12) { errs.push(`${at}：fields 须为 1～12 个筛选字段`); return; }
        const names = new Set<string>();
        block.fields.forEach((f: unknown, fi: number) => {
          const fAt = `${at}第 ${fi + 1} 个字段`;
          if (!isObj(f)) { errs.push(`${fAt} 须为对象`); return; }
          keys(f, ['name', 'kind', 'label', 'default', 'options'], fAt);
          if (typeof f.name !== 'string' || !NAME_RE.test(f.name)) errs.push(`${fAt}：name 须为参数名（小写字母开头，字母、数字、下划线）`);
          else if (names.has(f.name)) errs.push(`${fAt}：name ${f.name} 重复`);
          else names.add(f.name);
          if (typeof f.kind !== 'string' || !FILTER_KINDS.includes(f.kind)) errs.push(`${fAt}：kind 须为 ${FILTER_KINDS.join(' / ')}`);
          if (f.label !== undefined && !isText(f.label, 32)) errs.push(`${fAt}：label 须为 1～32 个字符`);
          if (f.default !== undefined && !isText(f.default, 64, 0)) errs.push(`${fAt}：default 须为 64 个字符以内的文本`);
          if (f.kind === 'select') {
            // 选项：写死的一组文本，或者取某个数据集某一列的不同取值
            const o = f.options;
            if (Array.isArray(o)) { if (!o.length || o.length > 100 || o.some((x) => !isText(x, 64))) errs.push(`${fAt}：options 须为 1～100 个文本`); }
            else if (isObj(o)) {
              keys(o, ['dataset', 'col'], `${fAt} 的 options`);
              const ds = typeof o.dataset === 'string' ? datasets.get(o.dataset) : undefined;
              if (!ds) errs.push(`${fAt}：options 里的数据集 ${String(o.dataset).slice(0, 48)} 不存在`);
              else if (!ds.columns.some((c) => c.name === o.col)) errs.push(`${fAt}：数据集 ${ds.name} 没有列 ${String(o.col).slice(0, 48)}`);
            } else errs.push(`${fAt}：select 要给 options（一组文本，或 { dataset, col }）`);
          } else if (f.options !== undefined) errs.push(`${fAt}：只有 select 才有 options`);
        });
        return;
      }
      if (type === 'form') {
        keys(block, [...base, 'dataset', 'fields', 'submit_label'], at);
        const ds = typeof block.dataset === 'string' ? datasets.get(block.dataset) : undefined;
        if (!ds) { errs.push(`${at}：数据集 ${String(block.dataset).slice(0, 48)} 不存在`); return; }
        if (!Array.isArray(block.fields) || !block.fields.length || block.fields.length > MAX_FIELDS) { errs.push(`${at}：fields 须为 1～${MAX_FIELDS} 个列名`); return; }
        if (new Set(block.fields).size !== block.fields.length) errs.push(`${at}：fields 里有重复的列`);
        for (const f of block.fields) if (!ds.columns.some((c) => c.name === f)) errs.push(`${at}：数据集 ${ds.name} 没有列 ${String(f).slice(0, 48)}`);
        // 必填列不在表单里，提交一定会被拒：保存时就指出来
        for (const c of ds.columns) if (c.required && !block.fields.includes(c.name)) errs.push(`${at}：数据集 ${ds.name} 的必填列 ${c.name} 不在表单里`);
        if (block.submit_label !== undefined && !isText(block.submit_label, 16)) errs.push(`${at}：submit_label 须为 1～16 个字符`);
        return;
      }
      // 其余组件都读一份查询
      if (block.query === undefined) { errs.push(`${at}：缺 query`); return; }
      const cols = query();
      if (type === 'stat') {
        keys(block, [...base, 'query', 'value', 'unit'], at);
        out(cols, block.value, 'value');
        if (block.unit !== undefined && !isText(block.unit, 12)) errs.push(`${at}：unit 须为 1～12 个字符`);
      } else if (type === 'table') {
        keys(block, [...base, 'query', 'columns', 'page_size'], at);
        if (block.columns !== undefined) {
          if (!Array.isArray(block.columns) || !block.columns.length) errs.push(`${at}：columns 须为非空数组`);
          else for (const n of block.columns) out(cols, n, 'columns');
        }
        if (block.page_size !== undefined && (!Number.isInteger(block.page_size) || (block.page_size as number) < 5 || (block.page_size as number) > 200)) errs.push(`${at}：page_size 须为 5～200 的整数`);
      } else if (type === 'bar' || type === 'line') {
        keys(block, [...base, 'query', 'x', 'y', 'series', ...(type === 'bar' ? ['stacked', 'horizontal'] : ['area'])], at);
        out(cols, block.x, 'x');
        outMany(cols, block.y, 'y');
        if (block.series !== undefined) {
          out(cols, block.series, 'series');
          if (Array.isArray(block.y) && block.y.length > 1) errs.push(`${at}：series 和多个 y 不能同时用`);
        }
        for (const f of type === 'bar' ? ['stacked', 'horizontal'] : ['area']) flag(f);
      } else if (type === 'pie') {
        keys(block, [...base, 'query', 'label', 'value', 'donut'], at);
        out(cols, block.label, 'label');
        out(cols, block.value, 'value', true);
        flag('donut');
      } else if (type === 'progress') {
        keys(block, [...base, 'query', 'value', 'total'], at);
        out(cols, block.value, 'value', true);
        if (typeof block.total === 'number') { if (!Number.isFinite(block.total) || block.total <= 0) errs.push(`${at}：total 写成数字时须大于 0`); }
        else out(cols, block.total, 'total', true);
      }
    });
  });
  return errs;
}

export type JsonDiff = { path: string; change: 'added' | 'removed' | 'changed' };
/**
 * 两份 JSON 之间差在哪：逐层比，给出路径。数组里的对象带 key 的按 key 对（视图换了先后不算改动），其余按位置对。
 * 只说哪里变了、是加是删是改；具体内容由调用方按路径去两版里取。
 */
export function diffJson(a: unknown, b: unknown, path = ''): JsonDiff[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === undefined) return [{ path: path || '/', change: 'added' }];
  if (b === undefined) return [{ path: path || '/', change: 'removed' }];
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = (arr: unknown[]) => arr.every((x) => isObj(x) && typeof x.key === 'string');
    if (a.length && b.length && keyed(a) && keyed(b)) {
      const ka = new Map(a.map((x) => [(x as { key: string }).key, x])), kb = new Map(b.map((x) => [(x as { key: string }).key, x]));
      const out: JsonDiff[] = [];
      for (const k of new Set([...ka.keys(), ...kb.keys()])) out.push(...diffJson(ka.get(k), kb.get(k), `${path}/${k}`));
      return out;
    }
    const out: JsonDiff[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffJson(a[i], b[i], `${path}/${i}`));
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out: JsonDiff[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diffJson(a[k], b[k], `${path}/${k}`));
    return out;
  }
  return [{ path: path || '/', change: 'changed' }];
}
