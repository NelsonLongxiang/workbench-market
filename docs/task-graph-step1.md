# 任务图 · 第 1 步设计稿（数据视图加有向无环图组件）

状态：设计稿，待评审；只写文档，不改代码。代码基线：release/10 `e62b814b`。

## 一、为什么做、属主已定的

属主 2026-11-24 在 UI/UX 席会话里提出：数据视图要能画流程图或有向无环图（DAG），用来呈现长程任务、做进度跟踪与管理。随后定了：**「都是 AI 原生 MCP 写入操作，无人干预」**（转述）。

由此本稿的前提：

- 写入全由 AI 经现有 MCP 工具完成（`dataset_define`、`dataset_upsert`、`dataset_replace`、`dataset_delete_rows`、`view_put`），人只看。
- 所以第 1 步的任务图**只读**：不做拖拽节点、画布连线、画布上改状态。
- 不新增 MCP 工具、路由、动作或权限：任务就是台里的一个数据集，图是视图里的一种组件。

## 二、现状（逐条可核）

| 面 | 现状 | 出处 |
|---|---|---|
| 组件种类 | 只有 filter-bar、stat、table、records、bar、line、pie、progress、form 九种 | server/src/bench-views.ts:13 |
| 组件契约 | 每种组件的键、必填、说明在 `BLOCK_CONTRACT`，`view_put` 的机器可读参数从它生成 | server/src/bench-views.ts:37 |
| 图表 | ECharts 按需引入，只注册了柱、线、饼 | web/src/bench-blocks/echarts-lite.ts:6 |
| 依赖 | 没有 React Flow、dagre、mermaid、G6、X6 等画图库；ECharts 包里自带 graph 系列 | tech-route.json 的 deps；web/node_modules/echarts/lib/chart/graph |
| 规划 | 甘特图、树列在「按需」一批，没有 issue 或 PR | docs/data-views.md:241 |
| AI 写入 | MCP 已有数据集定义、追加、upsert、整份替换、删行、快照与恢复、视图保存与回滚 | server/src/bench-mcp-tools.ts |
| 上限 | 一次查询最多 5000 行；数据集最多 50000 行、60 列 | server/src/bench-query.ts:16 |

## 三、数据怎么存

任务存成台里一个普通数据集，一行一个节点。不另建「边」的表：依赖写在节点自己那一行。

| 列（名字由视图描述指定） | 类型 | 用途 |
|---|---|---|
| 编号 | text 或 integer，数据集主键 | 节点 id |
| 名称 | text | 节点上的字 |
| 依赖 | text | 前置节点编号，逗号分隔；空 = 没有前置 |
| 状态 | text | 如 `todo`、`doing`、`blocked`、`done`、`failed`；说法和颜色照现有 `value_labels` 写法配 |
| 进度 | integer 或 decimal（可选） | 0～100 |
| 负责人、分组、开始、截止等 | 任意（可选） | 节点详情里显示；分组可按泳道排 |

为什么依赖放在同一行：AI 一次 `dataset_upsert` 就能同时改节点和它的依赖，不会出现「节点写了、边没写」的半截状态；也不用两次查询拼图。代价是依赖列的取值要在渲染时解析、核对（见第五节）。

进度随时间的变化（「跟踪」）不需要新组件：AI 每次推进时往另一个数据集 `dataset_append` 一条（时间、完成数、总数），用现有的 line、progress、stat 组件画。本稿第六节给出一个完整视图示例。

## 四、新组件 `dag` 的契约

`BLOCK_TYPES` 加 `dag`；`BLOCK_CONTRACT.dag`：

| 键 | 必填 | 说明 |
|---|---|---|
| `type`、`title`、`span` | type 必填 | 同其它组件 |
| `query` | 是 | 查任务数据集（明细查询，不能有 group、measures） |
| `id_col` | 是 | 节点编号列 |
| `label_col` | 是 | 节点名称列 |
| `deps_col` | 是 | 依赖列（text） |
| `status_col` | 否 | 状态列；配 `value_labels` 给说法和色调（success / warning / danger / default，台不能自定颜色） |
| `progress_col` | 否 | 进度列（数值列） |
| `group_col` | 否 | 分组列；给了就按组分泳道 |
| `detail_cols` | 否 | 点开节点时显示的列，1～12 个 |
| `direction` | 否 | `LR`（缺省，从左到右）或 `TB`（从上到下） |
| `value_labels`、`column_labels` | 否 | 同 table |

保存视图时（`view_put` 与页面保存同一处校验）核：列都存在；`deps_col` 是文本列；`progress_col` 是数值列；查询是明细查询。这些都跟着 `BLOCK_CONTRACT` 自动进 `view_put` 的工具说明，AI 读工具说明就知道怎么写。

## 五、渲染

1. **解析**：依赖列按逗号切开、去空白、去重；指向自己的忽略。
2. **核对（渲染期，因为数据随时被 AI 改）**：
   - **有环**：整个组件显示「依赖有环：A → B → A」，列出一条环，不画图、不悄悄丢边；
   - **依赖指向不存在的编号**：画虚线短边到一个灰色「缺失：X」占位节点，并在组件顶上提示「有 N 条依赖指向不存在的任务」；
   - **节点超过上限**（建议 500）：提示「任务太多，只画了前 500 个」，并给「用筛选缩小范围」的说明；查询被截断时同样提示。
3. **布局**：分层布局，纯 TypeScript，放在 `blocks-view.ts`，不引依赖，单测直接测：
   - 层号 = 最长前置链的长度（拓扑排序）；
   - 层内次序用一到两遍重心法（按前置节点的平均位置排）减少交叉；
   - 给了 `group_col` 时，先按组分泳道，组内再排。
4. **画法**：ECharts graph 系列（包里已有，只多注册一个 `GraphChart`），坐标用第 3 步算好的，`layout: 'none'`。节点是圆角矩形：名称、状态色、进度条（文字写百分比）。边带箭头。颜色、字号只用 token。
5. **交互**：缩放、平移；点节点在侧栏看 `detail_cols`；悬停高亮它的前置和后继链。
6. **顶部摘要**：共 N 个、完成 N 个、进行中 N 个、受阻 N 个，整体完成率。
7. **等价表格**：照 docs/data-views.md「图表都有等价的表格视图」，组件右上角能切到表格（列：名称、状态、进度、前置、后继），读屏和键盘可用。

不做：拖拽、在图上改数据、自动推算关键路径（第 2 步候选）。

## 六、AI 怎么用（示例）

1. `dataset_define` 一个 `tasks` 数据集：`id`（主键）、`name`、`deps`、`status`、`progress`、`owner`、`due`。
2. 每推进一步，`dataset_upsert` 改那一行的 `status`、`progress`；新拆出的子任务直接 upsert 新行并填 `deps`。
3. 每次推进再往 `progress_log` `dataset_append` 一行（时间、完成数、总数）。
4. `view_put` 一个视图：顶上 stat（完成率）、中间 `dag`（`tasks`）、下面 line（`progress_log` 的完成数随时间）。

数据视图技能（wm-data-views）的 `references/views.md` 要补 `dag` 的写法和这个示例；技能在哪个仓、由谁改，实现时确认。

## 七、要属主定的

| # | 要定什么 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|
| T1 | 先做依赖图，还是甘特图 | 先做依赖图（`dag`）；甘特图第 2 步 | 长程任务首先要看「谁卡着谁」；甘特图要求每个任务都有开始和截止日期，AI 未必每次能给 | 第 1 步看不出时间排期 |
| T2 | 依赖存法 | 同一行的依赖列（逗号分隔） | AI 一次 upsert 改完，不会半截 | 依赖多时一格变长；单格上限 10000 字符够用 |
| T3 | 节点上限 | 500 | 再多布局难读，也拖慢页面 | 大项目要靠筛选分段看 |
| T4 | 画法 | ECharts graph + 自写分层布局 | 不引新依赖（红线：新运行时依赖要属主批） | 复杂图的交叉比专业布局库多一些 |

## 八、分 PR

都以 release/10 为 base（下一次上线的集成分支切出后改指它）。

| PR | 内容 | 用例 |
|---|---|---|
| A | 服务端：`BLOCK_TYPES`、`BLOCK_CONTRACT.dag`、保存校验；`view_put` 工具说明随之变（surfaces 的 MCP 工具快照、回放跟着更新） | 契约测试：缺键、列不存在、依赖列不是文本、聚合查询，都 400；`view_put` 的工具说明里有 dag |
| B | 页面：`DagBlock`、分层布局与核对（纯函数）、等价表格、摘要 | 单测：布局层号、环检测、缺失依赖、自依赖、上限截断；源码检查只用 token、无内联样式；变异回改即红 |
| C | 技能文档补 dag 写法与示例 | — |

A 只加组件种类、不动权限与取数，按普通改动走非作者评审；B 是页面改动，按 UI/UX 完成标准（设计 token、内联样式计数、`pnpm check`、build、`tech-route-check --strict`）。
