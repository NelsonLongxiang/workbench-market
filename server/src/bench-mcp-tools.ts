/**
 * 数据视图的 MCP 工具（docs/data-views.md 第十节 3b）：纯数据，只有名字、说明、类别和参数的样子。
 * 怎么授予、怎么执行在 services/bench-mcp.ts。这个文件不引用库，mcp-tools.ts 和快照脚本都能直接引。
 *
 * 这些工具都**必须限定到台**：授予按「会话 × 台 × 工具」记，读也一样；不带台的授予不存在。
 */
import { VIEW_DOC_CONTRACT } from './bench-views.ts';

type Schema = Record<string, unknown>;
export interface BenchToolDef { name: string; description: string; category: 'read' | 'write'; benchScoped: true; inputSchema: Schema }

const BENCH = { type: 'string', description: '台的标识' };
const DATASET = { type: 'string', description: '数据集名' };
const NOTE = { type: 'string', description: '一句说明' };
const IDEM = { type: 'string', description: '幂等键：8～128 个可见 ASCII 字符。超时、断线后带同一个键重发，不会写两遍' };
const obj = (properties: Schema, required: string[]): Schema => ({ type: 'object', properties: { bench: BENCH, ...properties }, required: ['bench', ...required], additionalProperties: false });
const tool = (name: string, category: 'read' | 'write', description: string, inputSchema: Schema): BenchToolDef => ({ name, category, description: `[数据视图·必须限定到台] ${description}`, benchScoped: true, inputSchema });
const rows = (what: string) => obj({ dataset: DATASET, rows: { type: 'array', description: what, items: { type: 'object' } }, idempotency_key: IDEM, note: NOTE }, ['dataset', 'rows']);

const SKILL = '完整写法和例子见技能 wm-data-views（references/query.md）';
/** 查询描述的样子：键、比较符、聚合函数全列出来，席位不用猜（和 bench-query.ts 的 planQuery 一致） */
const QUERY: Schema = {
  type: 'object',
  description: `查询描述（不写 SQL）。不写 group、measures 是明细查询；写了是聚合查询。${SKILL}`,
  properties: {
    dataset: { type: 'string', description: '数据集名（必填）' },
    select: { type: 'array', items: { type: 'string' }, description: '明细查询要哪些列；不写是全部列。和 group、measures 不能同时写' },
    filter: {
      type: 'array', description: '筛选条件，最多 20 条，全部满足才算（AND）',
      items: {
        type: 'object', additionalProperties: false, required: ['col', 'op'],
        properties: {
          col: { type: 'string', description: '列名' },
          op: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'in', 'is_null', 'not_null', 'contains', 'prefix'], description: '比较符：= != > >= < <= 比大小；in 是「在这几个值里」（值放 values）；is_null / not_null 判空（不用 value）；contains 文本包含；prefix 开头是（文本、日期、时间列，比如按月筛日期列：prefix 2026-01）' },
          value: { description: '比较的值；写成 $名字 引用 params 里的值（没给就这条不生效）' },
          values: { type: 'array', description: 'op 为 in 时的取值，1～200 个' },
        },
      },
    },
    group: { type: 'array', items: { type: 'string' }, description: '按哪些列分组' },
    measures: {
      type: 'array', description: '聚合，最多 12 项',
      items: {
        type: 'object', additionalProperties: false, required: ['fn', 'as'],
        properties: {
          fn: { type: 'string', enum: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'], description: 'count 不写 col 就是数行数（COUNT(*)），写了 col 是数这一列不为空的行；count_distinct 数不同的值；sum、avg 只用于整数和小数列' },
          col: { type: 'string', description: '对哪一列算（count 可以不写）' },
          as: { type: 'string', description: '结果列的别名（必填，小写字母开头）' },
          label: { type: 'string', description: '显示名' },
        },
      },
    },
    sort: {
      type: 'array', description: '排序，最多 8 项。聚合查询只能按输出列（分组列和别名）排；不写时聚合按分组列升序、明细按写入次序',
      items: { type: 'object', additionalProperties: false, required: ['col'], properties: { col: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'], description: '缺省 asc' } } },
    },
    limit: { type: 'integer', minimum: 1, maximum: 5000, description: '最多返回几行，缺省 200' },
    offset: { type: 'integer', minimum: 0, description: '跳过前几行' },
    current_only: { type: 'boolean', description: '只取每条更正链上最新的那行（只用于公共区带来源列的数据集；那种数据集还能读来源列 _area、_task、_batch、_grant、_upstream、_supersedes 和行号 _row）' },
  },
  required: ['dataset'], additionalProperties: false,
};
/** 数据集定义的样子 */
const DEFINITION: Schema = {
  type: 'object', description: `数据集定义（给完整的新定义）。${SKILL.replace('query.md', 'datasets.md')}`, required: ['name', 'columns'], additionalProperties: false,
  properties: {
    name: { type: 'string', description: '数据集名：小写字母开头，只含小写字母、数字、下划线' },
    title: { type: 'string' },
    key: { type: 'array', items: { type: 'string' }, description: '主键列' },
    columns: {
      type: 'array', items: {
        type: 'object', required: ['name', 'type'], additionalProperties: false,
        properties: {
          name: { type: 'string' }, type: { type: 'string', enum: ['text', 'integer', 'decimal', 'date', 'datetime', 'boolean'] }, label: { type: 'string', description: '显示名' }, required: { type: 'boolean' },
          values: { type: 'object', additionalProperties: { type: 'string' }, description: '取值说明：「取值: 意思」，比如 { "ok": "正常", "bad": "异常" }。看数的人和席位靠它知道每个取值的业务意思' },
          auto: { type: 'boolean', description: '主键由服务端分配：只用于唯一的整数主键列。追加时不给这一列，按现有最大值往上数，应答的 ids 是分配到的号' },
        },
      },
    },
  },
};

/** #763 view_put 的 doc 参数：块类型、必填、上限全部从 bench-views.ts 的 VIEW_DOC_CONTRACT 生成（同一份来源）；字段语义见各分支描述与技能。服务端校验是权威，这份描述不许比它松——scripts/bench-view-contract-test.mjs 钉住同构。 */
const TONE_RULES: Schema = { type: 'array', maxItems: 2, description: '按值着色，最多 2 条：{ col, op, value, tone }，tone 只有 danger / warning / success', items: { type: 'object' } };
const BLOCK_BRANCH_PROPS: Record<string, Record<string, Schema>> = {
  'filter-bar': { fields: { type: 'array', minItems: 1, maxItems: VIEW_DOC_CONTRACT.filterFieldsMax, description: '筛选字段 { name, kind: month/date/select/search, label?, default?, options? }；查询里用 $名字 引用；只有 select 给 options（一组文本，或 { dataset, col }）', items: { type: 'object' } } },
  stat: { query: QUERY, value: { description: '查询的一个输出列；或本台引用 { var: 键名 }（此时不写 query）' }, unit: { type: 'string', description: '单位（12 字以内）' }, tone_rules: TONE_RULES },
  table: { query: QUERY, columns: { type: 'array', items: { type: 'string' }, description: '显示哪些输出列（不写是全部）' }, page_size: { type: 'integer', minimum: 5, maximum: 200 }, value_labels: { type: 'object', description: '列名 → 取值 → 说法（一段文字，或 { text, tone }）' }, column_labels: { type: 'object', description: '列名 → 说明名；每列要有说明名（或数据集列定义里的 label）' } },
  bar: { query: QUERY, x: { type: 'string', description: '分类列' }, y: { type: 'array', items: { type: 'string' }, description: '1～12 个数值列' }, series: { type: 'string', description: '拆系列的列（不和多个 y 同用）' }, stacked: { type: 'boolean' }, horizontal: { type: 'boolean' }, tone_rules: TONE_RULES },
  line: { query: QUERY, x: { type: 'string', description: '横轴列（通常是时间）' }, y: { type: 'array', items: { type: 'string' }, description: '1～12 个数值列' }, series: { type: 'string', description: '拆系列的列（不和多个 y 同用）' }, area: { type: 'boolean' } },
  pie: { query: QUERY, label: { type: 'string', description: '分类列' }, value: { type: 'string', description: '数值列' }, donut: { type: 'boolean' } },
  progress: { query: QUERY, value: { description: '数值输出列，或本台引用 { var: 键名 }' }, total: { description: '数值输出列、大于 0 的数字，或本台引用 { var: 键名 }' } },
  form: { dataset: { type: 'string', description: '直接写数据集（表单没有 query）' }, fields: { type: 'array', items: { type: 'string' }, description: '列名；数据集的必填列都要在里面' }, submit_label: { type: 'string', description: '提交按钮的字（16 字以内）' } },
};
const BLOCK_ONEOF: Schema[] = Object.entries(VIEW_DOC_CONTRACT.blocks).map(([t, c]) => {
  const extra = BLOCK_BRANCH_PROPS[t];
  if (!extra) throw new Error(`view_put 契约缺 ${t} 的字段说明`);
  const props: Record<string, Schema> = {};
  for (const k of c.keys) {
    if (k === 'type') props.type = { type: 'string', enum: [t] };
    else if (k === 'title') props.title = { type: 'string', description: '标题（64 字以内）' };
    else if (k === 'span') props.span = { type: 'integer', minimum: 1, maximum: 12, description: '12 栏网格里占几栏' };
    else { const p = extra[k]; if (!p) throw new Error(`view_put 契约 ${t}.${k} 缺字段说明`); props[k] = p; }
  }
  return { type: 'object', additionalProperties: false, required: [...c.required], description: c.note, properties: props };
});
/**
 * 视图描述的完整 JSON Schema（块类型、必填、上限、各字段说明），从 VIEW_DOC_CONTRACT 生成，和服务端校验同一来源。
 * 不放进 view_put 的工具定义：它一份就占全部工具定义的四成，每个拿到 view_put 的会话一开局都要整段装进上下文。
 * 改放技能 wm-data-views 的 references/view-doc-schema.json（scripts/gen-view-doc-schema.mjs 生成，
 * scripts/bench-view-contract-test.mjs 核对技能里的文件和这里一字不差），要写视图的会话按需去读。
 */
export const VIEW_DOC_SCHEMA: Schema = {
  type: 'object', additionalProperties: false, required: ['title', 'views'],
  description: `视图描述：顶层 title + views（1～${VIEW_DOC_CONTRACT.maxViews} 份视图）。${SKILL.replace('query.md', 'views.md')}；服务端按同一契约校验（输出列、$参数、数据集引用都查），不合格整份拒收、不产生新版本`,
  properties: {
    title: { type: 'string', description: `总标题（${VIEW_DOC_CONTRACT.titleMax} 字以内）` },
    views: { type: 'array', minItems: 1, maxItems: VIEW_DOC_CONTRACT.maxViews, items: {
      type: 'object', additionalProperties: false, required: ['key', 'title', 'blocks'],
      properties: {
        key: { type: 'string', pattern: VIEW_DOC_CONTRACT.viewKeyPattern, description: '视图键：小写字母开头，只含小写字母、数字、连字符，≤32 字符；不重复' },
        title: { type: 'string', description: `视图标题（${VIEW_DOC_CONTRACT.viewTitleMax} 字以内）` },
        blocks: { type: 'array', maxItems: VIEW_DOC_CONTRACT.maxBlocks, description: '组件（按顺序渲染）', items: { type: 'object', oneOf: BLOCK_ONEOF } },
      },
    } },
  },
};

/** view_put 的 doc 参数只给最小形状：完整契约按需读技能里的那份 schema（见 VIEW_DOC_SCHEMA） */
const VIEW_DOC_MIN: Schema = {
  type: 'object', required: ['title', 'views'],
  description: `视图描述：{ title, views: [{ key, title, blocks: [组件…] }] }，最多 ${VIEW_DOC_CONTRACT.maxViews} 份视图、每份最多 ${VIEW_DOC_CONTRACT.maxBlocks} 个组件；组件类型 ${Object.keys(VIEW_DOC_CONTRACT.blocks).join(' / ')}。`
    + '每种组件有哪些键、哪些必填、上限多少，完整的机器可读契约在技能 wm-data-views 的 references/view-doc-schema.json（写法和例子见 references/views.md）；先读它再写',
  properties: { title: { type: 'string' }, views: { type: 'array', minItems: 1, maxItems: VIEW_DOC_CONTRACT.maxViews, items: { type: 'object' } } },
};

export const BENCH_TOOL_DEFS: BenchToolDef[] = [
  tool('dataset_list', 'read', '这个台有哪些数据集：列定义（含显示名和取值说明 values——某个取值是什么业务意思看这里）、主键、行数、占多少字节、上次谁在什么时候改的', obj({}, [])),
  tool('dataset_query', 'read', `按查询描述读一个数据集（筛选、分组、聚合、排序；不写 SQL）。例：1 月各区域 result 为 bad 的行数——{ dataset, filter: [{ col: "day", op: "prefix", value: "2026-01" }, { col: "result", op: "=", value: "bad" }], group: ["region"], measures: [{ fn: "count", as: "n" }], sort: [{ col: "n", dir: "desc" }] }。${SKILL}`, obj({ query: QUERY, params: { type: 'object', description: '查询描述里 $名字 的取值' } }, ['query'])),
  tool('dataset_snapshots', 'read', '列出一个数据集现有的快照', obj({ dataset: DATASET }, ['dataset'])),
  tool('view_get', 'read', '读视图描述：不写 version 读现在生效的那一版', obj({ version: { type: 'integer', minimum: 1 } }, [])),
  tool('view_versions', 'read', '视图描述的版本清单', obj({}, [])),
  tool('view_diff', 'read', '两版视图描述差在哪', obj({ a: { type: 'integer', minimum: 1 }, b: { type: 'integer', minimum: 1 } }, ['a', 'b'])),
  tool('dataset_define', 'write', '建数据集，或者改它的列（给完整的新定义）。列可以带取值说明 values；唯一的整数主键可以设 auto 由服务端分配', obj({ definition: DEFINITION, note: NOTE }, ['definition'])),
  tool('dataset_replace', 'write', '整份替换一个数据集的行；替换前的那一份自动留作快照', rows('全部行')),
  tool('dataset_upsert', 'write', '按主键更新：有的改、没有的加', rows('要更新或新增的行')),
  tool('dataset_append', 'write', '追加行；主键和已有的行撞了整批拒收。主键列设了 auto 的数据集，行里不给主键，由服务端按现有最大值往上数，应答的 ids 是分配到的号（不要自己查最大值再加一：两个席位同时写会撞）。重放同一个幂等键时 duplicate 为 true、inserted 为 0', rows('要追加的行')),
  tool('dataset_delete_rows', 'write', '按主键删行；删之前自动留快照', obj({ dataset: DATASET, keys: { type: 'array', description: '只含主键列的对象的数组', items: { type: 'object' } }, idempotency_key: IDEM, note: NOTE }, ['dataset', 'keys'])),
  tool('dataset_snapshot', 'write', '手工留一份快照', obj({ dataset: DATASET, note: NOTE }, ['dataset'])),
  tool('dataset_restore', 'write', '把数据集退回到某一份快照', obj({ snapshot_id: { type: 'integer', minimum: 1 }, note: NOTE }, ['snapshot_id'])),
  tool('view_put', 'write', '保存视图描述：产生一个新版本并立即生效。服务端按契约校验（块类型、必填、上限、输出列、$参数、数据集引用都查），不合格整份拒收、不产生新版本，错误里点名是哪一处', obj({ doc: VIEW_DOC_MIN, base: { type: 'integer', minimum: 0, description: '你是基于第几版改的；还没有版本时给 0' }, note: NOTE }, ['doc', 'base', 'note'])),
  tool('view_rollback', 'write', '让旧版本重新生效（只移指针，不丢版本）', obj({ to: { type: 'integer', minimum: 1 }, base: { type: 'integer', minimum: 1, description: '你看到的生效版本' }, note: NOTE }, ['to', 'base', 'note'])),
  // 报告（docs/report-step1.md 第四节第 3 小节；报告第 1 步 PR C）：生成、读、回应。维度和模板只走 REST（领域能力以 REST 声明）；绑定也只走 REST。
  // 经 MCP 生成、回应的，产出方、回应者记这个会话、记 AI
  tool('report_list', 'read', '这个台上的报告清单（不带正文），可按维度、事物筛；superseded_by 是被哪一份更正了', obj({
    dimension: { type: 'string', description: '报告维度的标识' }, subject: { type: 'string', description: '事物：种类:标识，比如 item:123' }, limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, [])),
  tool('report_get', 'read', '读一份报告：冻结的成品、来源（视图版本、哈希、行数）、论断（各带回应和有没有未处理的反驳）、对整份报告的回应、验收声明', obj({ id: { type: 'integer', minimum: 1 } }, ['id'])),
  tool('report_generate', 'write', '按这个台对维度的绑定生成并冻结一份报告：服务端取数、核模板、核论断；来源和产出方由服务端填，不要自己给。取不全、列类型不合、论断不合模板都拒', obj({
    dimension: { type: 'string', description: '报告维度的标识' }, subject: { type: 'string', description: '事物：种类:标识，比如 item:123' },
    inputs: { type: 'object', description: '{ parameters: { 参数名: 值 }, fields: { 文字字段名: 值 } }，照模板声明的写', properties: { parameters: { type: 'object' }, fields: { type: 'object' } } },
    claims: { type: 'array', description: '论断：[{ kind, text, basis?: [{ slot, key: [行键的值…] }] }]，类别和条数照模板', items: { type: 'object' } },
    supersedes: { type: 'integer', minimum: 1, description: '更正哪一份（同维度、同事物、还没被更正过的那份）' },
  }, ['dimension', 'subject', 'inputs', 'claims'])),
  tool('report_respond', 'write', '对一份报告的一条论断表态：认可、反驳或补充，理由必填；claim_key 不写是对整份报告。改主意就带 supersedes 接自己上一条', obj({
    id: { type: 'integer', minimum: 1, description: '报告编号' }, claim_key: { type: 'string', description: '论断编号，比如 conclusion-1' },
    stance: { type: 'string', enum: ['agree', 'dispute', 'supplement'] }, reason: { type: 'string', description: '理由（1～4000 字）' },
    supersedes: { type: 'integer', minimum: 1, description: '你上一条回应的编号（改主意时）' },
  }, ['id', 'stance', 'reason'])),
];
export const BENCH_TOOL_NAMES: ReadonlySet<string> = new Set(BENCH_TOOL_DEFS.map((t) => t.name));
/** 授予里台的写法：工具@bench:<台的标识> */
export const BENCH_GRANT_RE = /^([a-z_]{3,40})@bench:([a-z0-9][a-z0-9-]{0,63})$/;
export const benchGrant = (toolName: string, bench: string): string => `${toolName}@bench:${bench}`;
