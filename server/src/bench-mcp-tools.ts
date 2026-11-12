/**
 * 数据视图的 MCP 工具（docs/data-views.md 第十节 3b）：纯数据，只有名字、说明、类别和参数的样子。
 * 怎么授予、怎么执行在 services/bench-mcp.ts。这个文件不引用库，mcp-tools.ts 和快照脚本都能直接引。
 *
 * 这些工具都**必须限定到台**：授予按「会话 × 台 × 工具」记，读也一样；不带台的授予不存在。
 */
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
  tool('view_put', 'write', '保存视图描述：产生一个新版本并立即生效', obj({ doc: { type: 'object', description: '视图描述' }, base: { type: 'integer', minimum: 0, description: '你是基于第几版改的；还没有版本时给 0' }, note: NOTE }, ['doc', 'base', 'note'])),
  tool('view_rollback', 'write', '让旧版本重新生效（只移指针，不丢版本）', obj({ to: { type: 'integer', minimum: 1 }, base: { type: 'integer', minimum: 1, description: '你看到的生效版本' }, note: NOTE }, ['to', 'base', 'note'])),
];
export const BENCH_TOOL_NAMES: ReadonlySet<string> = new Set(BENCH_TOOL_DEFS.map((t) => t.name));
/** 授予里台的写法：工具@bench:<台的标识> */
export const BENCH_GRANT_RE = /^([a-z_]{3,40})@bench:([a-z0-9][a-z0-9-]{0,63})$/;
export const benchGrant = (toolName: string, bench: string): string => `${toolName}@bench:${bench}`;
