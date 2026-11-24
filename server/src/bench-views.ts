/**
 * 数据视图的视图描述（docs/data-views.md 第六、八节）：核对一份描述合不合格，以及两个版本之间差在哪。
 *
 * 改台不走评审，这里的核对就是不让坏描述生效的那一关：组件类型认得、键不多不少、引用的数据集和列存在、
 * 查询合法、$参数 在同一个视图的筛选栏里声明过。不合格的不产生新版本（由 services/bench-store.ts 的 putView 调）。
 *
 * 纯函数，不碰库。组件清单是第一批的八个，加上记录卡 records（#858）、任务图 dag 与甘特图 gantt（docs/task-graph-step1.md）；别的类型做出来之前在这里不认。
 * 描述里的文字只当文字：页面渲染时一律转义，这里不解释其中的任何标记。
 */
import { BenchError, NAME_RE, planQuery, type DatasetDef, type OutColumn } from './bench-query.ts';
import { isVarRef } from './bench-bindings.ts';

export const BLOCK_TYPES = ['filter-bar', 'stat', 'table', 'records', 'bar', 'line', 'pie', 'progress', 'form', 'dag', 'gantt'] as const;
/** 任务图 dag、甘特图 gantt（docs/task-graph-step1.md）：节点上限即取数上限，依赖、角色列的写法见那份文档第三节 */
export const DAG_LIMITS = { nodes: 500, detailCols: 12, doneValues: 20 } as const;
/** 任务图块的取数说明：有 filter 才算筛选（部分结果）；current_only 只排除被更正掉的旧行，不算筛选（docs/task-graph-step1.md 第五节之一） */
export function dagGraphMeta(query: unknown): { filtered: boolean } {
  const q = isObj(query) ? query : {};
  return { filtered: Array.isArray(q.filter) && q.filter.length > 0 };
}
/**
 * 记录卡的来源链接：只认 http(s) 的完整网址（javascript:、data:、相对地址、以 // 开头的协议相对地址、带账号密码的都不认）。
 * 认的给 { href, host }（host 只是主机名，给悬停和读屏说「去哪」）；不认的给 null，页面上标「来源地址无效」、不渲染成链接。
 * 取数时服务端核一次（应答里的 link_targets），页面渲染时再核一次（web/src/bench-blocks/blocks-view.ts 的同名函数，同一套规则）。
 */
export function safeLink(v: unknown): { href: string; host: string } | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!/^https?:\/\/[^/\s]/i.test(t) || t.length > 2000) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
  return { href: u.href, host: u.hostname };
}
/** 表格和记录卡都在页面上分页：每页几条的上下限（两种块同一个口径） */
export const PAGE_SIZE_MIN = 5, PAGE_SIZE_MAX = 200;
/** 记录卡各部分最多几列 */
export const RECORDS_LIMITS = { badges: 3, fields: 8, details: 12, links: 3, linkLabel: 12, emptyText: 32 } as const;
const VIEW_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FILTER_KINDS = ['month', 'date', 'select', 'search'];
const MAX_VIEWS = 20, MAX_BLOCKS = 40, MAX_FIELDS = 40, MAX_FILTER_FIELDS = 12;

export type BlockType = (typeof BLOCK_TYPES)[number];
/** 每种组件的契约：允许哪些键（顺序同校验）、哪些必填、条件写在 note。校验的键清单从这里取，view_put 工具定义的机器可读形态也从这里生成——同一份来源，不许漂移（scripts/bench-view-contract-test.mjs 钉住）。 */
export const BLOCK_CONTRACT: Record<BlockType, { keys: readonly string[]; required: readonly string[]; note: string }> = {
  'filter-bar': { keys: ['type', 'title', 'span', 'fields'], required: ['type', 'fields'], note: 'fields 是 1～12 个筛选字段 { name, kind, label?, default?, options? }，kind 只有 month / date / select / search；查询里用 $名字 引用的参数要先在这里声明；只有 select 给 options（一组文本，或 { dataset, col } 取某列的不同取值）' },
  stat: { keys: ['type', 'title', 'span', 'query', 'value', 'unit', 'tone_rules'], required: ['type', 'value'], note: 'value 指向查询的一个输出列，或写本台引用 { var: 键名 }（此时不写 query，块独立取值）；tone_rules 按值着色，最多 2 条' },
  table: { keys: ['type', 'title', 'span', 'query', 'columns', 'page_size', 'value_labels', 'column_labels'], required: ['type', 'query'], note: 'columns 选显示哪些输出列；每列要有说明名（数据集列定义的 label 或 column_labels）；page_size 5～200；value_labels 是「列名 → 取值 → 说法」' },
  records: { keys: ['type', 'title', 'span', 'query', 'title_col', 'badges', 'fields', 'details', 'date_col', 'links', 'page_size', 'value_labels', 'column_labels', 'empty_text'], required: ['type', 'query', 'title_col'], note: '每行一张卡片。title_col 是卡片标题列；badges 0～3 列显示成徽标（说法走 value_labels），fields 0～8 列一直可见，details 0～12 列收在「展开」里，date_col 是日期或时间列；这五处引用的列互不重复，每列要有说明名（数据集列定义的 label 或 column_labels）。links 0～3 个 { col, label }：col 的值是网址，只认 http(s)，卡片上只显示 label（12 字以内）；page_size 5～200；empty_text 是没有记录时的说法' },
  bar: { keys: ['type', 'title', 'span', 'query', 'x', 'y', 'series', 'stacked', 'horizontal', 'tone_rules'], required: ['type', 'query', 'x', 'y'], note: 'x 是分类列，y 是 1～12 个数值列（或用 series 拆系列，不和多个 y 同用）；tone_rules 只用于单系列的柱子' },
  line: { keys: ['type', 'title', 'span', 'query', 'x', 'y', 'series', 'area'], required: ['type', 'query', 'x', 'y'], note: 'x 通常是时间列，y 是 1～12 个数值列；series 拆系列（不和多个 y 同用）；area 是面积填充' },
  pie: { keys: ['type', 'title', 'span', 'query', 'label', 'value', 'donut'], required: ['type', 'query', 'label', 'value'], note: 'label 是分类列，value 是数值列，donut 画环形' },
  progress: { keys: ['type', 'title', 'span', 'query', 'value', 'total'], required: ['type', 'value', 'total'], note: 'value、total 指向数值输出列，或写本台引用 { var: 键名 }（total 也可以写大于 0 的数字）' },
  form: { keys: ['type', 'title', 'span', 'dataset', 'fields', 'submit_label'], required: ['type', 'dataset', 'fields'], note: '直接写数据集（表单没有 query）；fields 是 1～40 个列名，数据集的必填列都要在表单里' },
  dag: { keys: ['type', 'title', 'span', 'query', 'id_col', 'label_col', 'deps_col', 'role_col', 'status_col', 'done_values', 'progress_col', 'source_col', 'group_col', 'detail_cols', 'direction', 'value_labels', 'column_labels'], required: ['type', 'query', 'id_col', 'label_col', 'deps_col', 'role_col'],
    note: '任务依赖图，只读。一行一个任务：query 是明细查询（不能有 group、measures，不能写 limit、offset，最多画 500 个）；deps_col 是文本列，逗号分隔前置编号：a 必需、?a 可选、a|b 任一；role_col 是文本列，start 起点、end 主线终点、branch_end 支线终点，其余留空（起点终点各恰好一个，没有后继的任务都要标终点）；status_col 配 done_values（缺省 ["done"]）认完成；progress_col 是 0～100 的数值列；detail_cols 是点开任务时显示的 1～12 列；direction 为 LR 或 TB' },
  gantt: { keys: ['type', 'title', 'span', 'query', 'id_col', 'label_col', 'start_col', 'end_col', 'deps_col', 'role_col', 'status_col', 'done_values', 'progress_col', 'group_col', 'detail_cols', 'value_labels', 'column_labels'], required: ['type', 'query', 'id_col', 'label_col', 'start_col', 'end_col'],
    note: '甘特图，只读。一行一个任务，一条横条：query 是明细查询（不能有 group、measures，不能写 limit、offset，最多画 500 个）；start_col、end_col 是开始、截止，须为日期或日期时间列，且在数据集定义里是必填列（required: true）；progress_col 是 0～100 的数值列，画成条内填充；给了 deps_col（写法同任务图）就画前置截止到后继开始的箭头；给了 role_col 就在终点、支线终点的条尾画标记；截止已过、没完成的条用警示色；status_col 配 done_values（缺省 ["done"]）认完成' },
};
/** 视图描述整体的契约（view_put 的 doc 参数从这里生成；上限与校验同源） */
export const VIEW_DOC_CONTRACT = {
  titleMax: 64,
  maxViews: MAX_VIEWS,
  viewKeyPattern: VIEW_KEY_RE.source,
  viewTitleMax: 32,
  maxBlocks: MAX_BLOCKS,
  filterFieldsMax: MAX_FILTER_FIELDS,
  filterKinds: FILTER_KINDS,
  blocks: BLOCK_CONTRACT,
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;

/** 核对一份视图描述；返回不合格的地方（空数组 = 合格），每条写明在哪个视图的第几个组件 */
export function validateViewDoc(doc: unknown, datasets: Map<string, DatasetDef>): string[] {
  const errs: string[] = [];
  const keys = (o: Record<string, unknown>, allowed: readonly string[], where: string) => {
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    // 顺带列出这里能用的键：会话不读技能里的契约，也能照着改对
    if (extra.length) errs.push(`${where}：有不认识的键 ${extra.join('、')}；这里能用的键：${allowed.join('、')}`);
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
      /** 按值着色：最多两条「列、比较符、值 → 语气」。语气只有三种语义色（危险 / 提醒 / 正常），不能给任意色值 */
      const toneRules = (cols: OutColumn[] | null) => {
        const v = block.tone_rules;
        if (v === undefined) return;
        if (!Array.isArray(v) || !v.length || v.length > 2) { errs.push(`${at}：tone_rules 须为 1～2 条规则`); return; }
        v.forEach((r: unknown, ri: number) => {
          const rAt = `${at}：tone_rules 第 ${ri + 1} 条`;
          if (!isObj(r)) { errs.push(`${rAt}须为对象`); return; }
          keys(r, ['col', 'op', 'value', 'tone'], rAt);
          out(cols, r.col, `tone_rules 第 ${ri + 1} 条的 col`, true);
          if (typeof r.op !== 'string' || !['<', '<=', '>', '>=', '=', '!='].includes(r.op)) errs.push(`${rAt}的 op 须为 < / <= / > / >= / = / !=`);
          if (!isVarRef(r.value) && (typeof r.value !== 'number' || !Number.isFinite(r.value))) errs.push(`${rAt}的 value 须为数字或本台引用 { var: 键名 }`);
          if (typeof r.tone !== 'string' || !['danger', 'warning', 'success'].includes(r.tone)) errs.push(`${rAt}的 tone 须为 danger / warning / success`);
        });
      };
      /** 列名 → 说明名（表格和记录卡共用）：给了的每一项都要是输出列、1～32 个字；返回给了的那份 */
      const columnLabels = (cols: OutColumn[] | null): Record<string, unknown> => {
        let named: Record<string, unknown> = {};
        if (block.column_labels !== undefined) {
          const cl = block.column_labels;
          if (!isObj(cl) || !Object.keys(cl).length || Object.keys(cl).length > 40) errs.push(`${at}：column_labels 须为对象（列名 → 说明名，1～40 列）`);
          else {
            named = cl;
            for (const [colName, label] of Object.entries(cl)) {
              out(cols, colName, 'column_labels 的列');
              if (!isText(label, 32)) errs.push(`${at}：column_labels.${colName.slice(0, 48)} 须为 1～32 个字符`);
            }
          }
        }
        return named;
      };
      /** 列名 → 取值 → 说法（表格和记录卡共用） */
      const valueLabels = (cols: OutColumn[] | null) => {
        // 「取值 → 说法」对照：列名 → 取值 → 说法（一段文字，或 { text, tone }）。没给对照的取值，页面显示成灰色的原文
        if (block.value_labels !== undefined) {
          const vl = block.value_labels;
          if (!isObj(vl) || Object.keys(vl).length > 12) errs.push(`${at}：value_labels 须为对象（列名 → 取值 → 说法，最多 12 列）`);
          else for (const [colName, map] of Object.entries(vl)) {
            out(cols, colName, 'value_labels 的列');
            if (!isObj(map) || !Object.keys(map).length || Object.keys(map).length > 50) { errs.push(`${at}：value_labels.${colName.slice(0, 48)} 须为 1～50 个「取值 → 说法」`); continue; }
            for (const [val, label] of Object.entries(map)) {
              const where = `${at}：value_labels.${colName.slice(0, 48)} 里 ${val.slice(0, 32)} 的说法`;
              if (val.length > 64) errs.push(`${at}：value_labels.${colName.slice(0, 48)} 的取值最多 64 个字符`);
              if (typeof label === 'string') { if (!isText(label, 32)) errs.push(`${where}须为 1～32 个字符`); }
              else if (isObj(label)) {
                keys(label, ['text', 'tone'], where);
                if (!isText(label.text, 32)) errs.push(`${where}的 text 须为 1～32 个字符`);
                if (label.tone !== undefined && !['success', 'warning', 'danger', 'default'].includes(label.tone as string)) errs.push(`${where}的 tone 须为 success / warning / danger / default`);
              } else errs.push(`${where}须为一段文字，或 { text, tone }`);
            }
          }
        }
      };
      const pageSize = () => { if (block.page_size !== undefined && (!Number.isInteger(block.page_size) || (block.page_size as number) < PAGE_SIZE_MIN || (block.page_size as number) > PAGE_SIZE_MAX)) errs.push(`${at}：page_size 须为 ${PAGE_SIZE_MIN}～${PAGE_SIZE_MAX} 的整数`); };
      const flag = (name: string) => { if (block[name] !== undefined && typeof block[name] !== 'boolean') errs.push(`${at}：${name} 须为 true 或 false`); };

      if (type === 'filter-bar') {
        keys(block, BLOCK_CONTRACT['filter-bar'].keys, at);
        if (!Array.isArray(block.fields) || !block.fields.length || block.fields.length > MAX_FILTER_FIELDS) { errs.push(`${at}：fields 须为 1～${MAX_FILTER_FIELDS} 个筛选字段`); return; }
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
        keys(block, BLOCK_CONTRACT.form.keys, at);
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
      // Scalar references are explicit exact keys in this card's space, never paths or expressions.
      const valueRef = (type === 'stat' || type === 'progress') && isVarRef(block.value);
      const totalRef = type === 'progress' && isVarRef(block.total);
      const standalone = valueRef && (type === 'stat' || totalRef || typeof block.total === 'number');
      if (standalone && block.query !== undefined) errs.push(`${at}：完全取自常量变量的块不写 query`);
      if (!standalone && block.query === undefined) { errs.push(`${at}：缺 query（或者用本台引用 { var: 键名 }）`); return; }
      const cols: OutColumn[] | null = standalone ? [{ name: 'value', type: 'decimal', label: typeof block.title === 'string' ? block.title : '数值', role: 'measure' }] : query();
      if (type === 'stat') {
        keys(block, BLOCK_CONTRACT.stat.keys, at);
        if (!valueRef) out(cols, block.value, 'value');
        toneRules(cols);
        if (block.unit !== undefined && !isText(block.unit, 12)) errs.push(`${at}：unit 须为 1～12 个字符`);
      } else if (type === 'table') {
        keys(block, BLOCK_CONTRACT.table.keys, at);
        // 表头：每一列都要有说明名——数据集列定义的 label、聚合的 label，或者这里的 column_labels（列名 → 说明名）。
        // 缺了就拒、点名缺哪一列：页面上的表头不露键名（没配的旧版本由页面写「第 N 列」兜底）
        const named = columnLabels(cols);
        if (cols) {
          const shown = Array.isArray(block.columns) ? cols.filter((c) => (block.columns as unknown[]).includes(c.name)) : cols;
          const missing = shown.filter((c) => !c.labeled && !(Object.hasOwn(named, c.name) && isText(named[c.name], 32)));
          if (missing.length) errs.push(`${at}：表格的列 ${missing.map((c) => c.name).join('、')} 没有说明名——在数据集的列定义里给 label，或者在这个组件的 column_labels 里写（列名 → 说明名）`);
        }
        valueLabels(cols);
        if (block.columns !== undefined) {
          if (!Array.isArray(block.columns) || !block.columns.length) errs.push(`${at}：columns 须为非空数组`);
          else for (const n of block.columns) out(cols, n, 'columns');
        }
        pageSize();
      } else if (type === 'records') {
        keys(block, BLOCK_CONTRACT.records.keys, at);
        const named = columnLabels(cols);
        valueLabels(cols);
        pageSize();
        // 卡片上各处引用的列：标题、徽标、主要字段、次要字段、日期。都要是输出列、互不重复、有说明名
        const used: { col: unknown; prop: string }[] = [{ col: block.title_col, prop: 'title_col' }];
        const list = (prop: 'badges' | 'fields' | 'details', max: number) => {
          const v = block[prop];
          if (v === undefined) return;
          if (!Array.isArray(v) || v.length > max) { errs.push(`${at}：${prop} 须为 0～${max} 个输出列`); return; }
          for (const n of v) used.push({ col: n, prop });
        };
        list('badges', RECORDS_LIMITS.badges); list('fields', RECORDS_LIMITS.fields); list('details', RECORDS_LIMITS.details);
        if (block.date_col !== undefined) used.push({ col: block.date_col, prop: 'date_col' });
        for (const u of used) out(cols, u.col, u.prop);
        const seen = new Map<string, string>();
        for (const u of used) {
          if (typeof u.col !== 'string') continue;
          const before = seen.get(u.col);
          if (before) errs.push(`${at}：列 ${u.col} 同时出现在 ${before} 和 ${u.prop} 里——标题、徽标、主要字段、次要字段、日期各用各的列`);
          else seen.set(u.col, u.prop);
        }
        if (cols) {
          const missing = used.map((u) => cols.find((c) => c.name === u.col)).filter((c): c is OutColumn => !!c && !c.labeled && !(Object.hasOwn(named, c.name) && isText(named[c.name], 32)));
          if (missing.length) errs.push(`${at}：记录卡的列 ${[...new Set(missing.map((c) => c.name))].join('、')} 没有说明名——在数据集的列定义里给 label，或者在这个组件的 column_labels 里写（列名 → 说明名）`);
          const dc = typeof block.date_col === 'string' ? cols.find((c) => c.name === block.date_col) : undefined;
          if (dc && dc.type !== 'date' && dc.type !== 'datetime') errs.push(`${at}：date_col 指向的列 ${dc.name} 不是日期或时间`);
        }
        // 来源链接：col 的值是网址（只认 http(s)，渲染时再核一次）；卡片上只显示 label
        if (block.links !== undefined) {
          if (!Array.isArray(block.links) || block.links.length > RECORDS_LIMITS.links) errs.push(`${at}：links 须为 0～${RECORDS_LIMITS.links} 个 { col, label }`);
          else block.links.forEach((l: unknown, li: number) => {
            const lAt = `${at}：links 第 ${li + 1} 个`;
            if (!isObj(l)) { errs.push(`${lAt}须为 { col, label }`); return; }
            keys(l, ['col', 'label'], lAt);
            out(cols, l.col, `links 第 ${li + 1} 个的 col`);
            const c = cols && typeof l.col === 'string' ? cols.find((x) => x.name === l.col) : undefined;
            if (c && c.type !== 'text') errs.push(`${lAt}的 col 指向的列 ${c.name} 不是文本`);
            if (!isText(l.label, RECORDS_LIMITS.linkLabel)) errs.push(`${lAt}的 label 须为 1～${RECORDS_LIMITS.linkLabel} 个字符（比如「查看依据」「打开资料」）`);
          });
        }
        if (block.empty_text !== undefined && !isText(block.empty_text, RECORDS_LIMITS.emptyText)) errs.push(`${at}：empty_text 须为 1～${RECORDS_LIMITS.emptyText} 个字符`);
      } else if (type === 'bar' || type === 'line') {
        keys(block, BLOCK_CONTRACT[type].keys, at);
        if (type === 'bar') {
          toneRules(cols);
          // 按值着色是给每根柱子换色，只有一个系列时才说得清
          if (block.tone_rules !== undefined && (block.series !== undefined || (Array.isArray(block.y) && block.y.length > 1))) errs.push(`${at}：tone_rules 只用在一个系列的柱状图上（不能和 series、多个 y 一起用）`);
        }
        out(cols, block.x, 'x');
        outMany(cols, block.y, 'y');
        if (block.series !== undefined) {
          out(cols, block.series, 'series');
          if (Array.isArray(block.y) && block.y.length > 1) errs.push(`${at}：series 和多个 y 不能同时用`);
        }
        for (const f of type === 'bar' ? ['stacked', 'horizontal'] : ['area']) flag(f);
      } else if (type === 'pie') {
        keys(block, BLOCK_CONTRACT.pie.keys, at);
        out(cols, block.label, 'label');
        out(cols, block.value, 'value', true);
        flag('donut');
      } else if (type === 'dag' || type === 'gantt') {
        keys(block, BLOCK_CONTRACT[type].keys, at);
        const q = block.query;
        if (isObj(q)) {
          if (q.group !== undefined || q.measures !== undefined) errs.push(`${at}：${type === 'gantt' ? '甘特图' : '任务图'}的查询须为明细查询（不能有 group、measures）`);
          if (q.limit !== undefined || q.offset !== undefined) errs.push(`${at}：任务图的查询不能写 limit、offset（一次最多取 ${DAG_LIMITS.nodes} 个任务，不分页）`);
        }
        const typed = (prop: string, types: string[], what: string) => {
          out(cols, block[prop], prop);
          const c = cols && typeof block[prop] === 'string' ? cols.find((x) => x.name === block[prop]) : undefined;
          if (c && !types.includes(c.type)) errs.push(`${at}：${prop} 指向的列 ${c.name} 须为${what}`);
        };
        typed('id_col', ['text', 'integer'], '文本或整数列');
        out(cols, block.label_col, 'label_col');
        // 依赖、角色列：任务图必填，甘特图可选（给了就核）
        if (type === 'dag' || block.deps_col !== undefined) typed('deps_col', ['text'], '文本列');
        if (type === 'dag' || block.role_col !== undefined) typed('role_col', ['text'], '文本列');
        // 甘特图的开始、截止：日期或日期时间列，且在数据集定义里必填——写入为空即被拒，图上不会有缺日期的条（docs/task-graph-step1.md 第四节之二）
        if (type === 'gantt') for (const p of ['start_col', 'end_col']) {
          typed(p, ['date', 'datetime'], '日期或日期时间列');
          const ds = isObj(q) && typeof q.dataset === 'string' ? datasets.get(q.dataset) : undefined;
          const dc = ds && typeof block[p] === 'string' ? ds.columns.find((c) => c.name === block[p]) : undefined;
          if (dc && !dc.required) errs.push(`${at}：${p} 指向的列 ${dc.name} 在数据集定义里须为必填列（required: true），甘特图的开始、截止不能为空`);
        }
        for (const p of ['status_col', 'source_col', 'group_col']) if (block[p] !== undefined) out(cols, block[p], p);
        if (block.progress_col !== undefined) out(cols, block.progress_col, 'progress_col', true);
        if (block.done_values !== undefined && (!Array.isArray(block.done_values) || !block.done_values.length || block.done_values.length > DAG_LIMITS.doneValues || block.done_values.some((x) => !isText(x, 64)))) errs.push(`${at}：done_values 须为 1～${DAG_LIMITS.doneValues} 个文本`);
        if (block.done_values !== undefined && block.status_col === undefined) errs.push(`${at}：给了 done_values 就要给 status_col`);
        if (block.detail_cols !== undefined) {
          if (!Array.isArray(block.detail_cols) || !block.detail_cols.length || block.detail_cols.length > DAG_LIMITS.detailCols) errs.push(`${at}：detail_cols 须为 1～${DAG_LIMITS.detailCols} 个输出列`);
          else for (const n of block.detail_cols) out(cols, n, 'detail_cols');
        }
        if (block.direction !== undefined && block.direction !== 'LR' && block.direction !== 'TB') errs.push(`${at}：direction 须为 LR 或 TB`);
        columnLabels(cols);
        valueLabels(cols);
      } else if (type === 'progress') {
        keys(block, BLOCK_CONTRACT.progress.keys, at);
        if (!valueRef) out(cols, block.value, 'value', true);
        if (totalRef) { /* checked exact-key reference, numeric value is checked when read */ }
        else if (typeof block.total === 'number') { if (!Number.isFinite(block.total) || block.total <= 0) errs.push(`${at}：total 写成数字时须大于 0`); }
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
