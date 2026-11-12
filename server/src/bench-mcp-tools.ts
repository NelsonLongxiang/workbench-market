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

export const BENCH_TOOL_DEFS: BenchToolDef[] = [
  tool('dataset_list', 'read', '这个台有哪些数据集：列定义、行数、占多少字节、上次谁在什么时候改的', obj({}, [])),
  tool('dataset_query', 'read', '按查询描述读一个数据集（筛选、分组、聚合、排序；不写 SQL）', obj({ query: { type: 'object', description: '查询描述' }, params: { type: 'object', description: '查询描述里 $参数 的取值' } }, ['query'])),
  tool('dataset_snapshots', 'read', '列出一个数据集现有的快照', obj({ dataset: DATASET }, ['dataset'])),
  tool('view_get', 'read', '读视图描述：不写 version 读现在生效的那一版', obj({ version: { type: 'integer', minimum: 1 } }, [])),
  tool('view_versions', 'read', '视图描述的版本清单', obj({}, [])),
  tool('view_diff', 'read', '两版视图描述差在哪', obj({ a: { type: 'integer', minimum: 1 }, b: { type: 'integer', minimum: 1 } }, ['a', 'b'])),
  tool('dataset_define', 'write', '建数据集，或者改它的列（给完整的新定义）', obj({ definition: { type: 'object', description: '数据集定义：name、title、key、columns' }, note: NOTE }, ['definition'])),
  tool('dataset_replace', 'write', '整份替换一个数据集的行；替换前的那一份自动留作快照', rows('全部行')),
  tool('dataset_upsert', 'write', '按主键更新：有的改、没有的加', rows('要更新或新增的行')),
  tool('dataset_append', 'write', '追加行；主键和已有的行撞了整批拒收', rows('要追加的行')),
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
