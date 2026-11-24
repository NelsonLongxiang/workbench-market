# 视图描述和十二种组件

完整的机器可读契约（每种组件的键、必填、上限、字段说明）在同目录的 `view-doc-schema.json`，由代码生成、和服务端校验同一来源；`view_put` 的参数说明里只给大致形状。下面是写法和例子。

```json view-doc
{ "title": "订单台",
  "views": [
    { "key": "overview", "title": "总览", "blocks": [
      { "type": "stat", "title": "单数", "query": { "dataset": "orders", "measures": [ { "as": "v", "fn": "count" } ] }, "value": "v", "unit": "单" }
    ] },
    { "key": "entry", "title": "补录", "blocks": [
      { "type": "form", "title": "补一单", "dataset": "orders", "fields": ["id", "day", "region", "status", "amount"], "submit_label": "提交" }
    ] }
  ] }
```

- 一个台 1～20 个视图（页面顶上的页签）。`key`：小写字母开头，小写字母、数字、连字符，最多 32 个字符，不能重复。
- 每个视图最多 40 个组件，从上到下、从左到右排在 12 栏的网格里。
- 每个组件都可以带 `title`（最多 64 个字符）和 `span`（占几栏，落到 3 / 4 / 6 / 12 这四档上；不给时统计卡和进度占 3，表格、记录卡、筛选栏和三种任务图占 12，其余占 6）。不给 `span` 时页面会补齐一行：一行里只剩一个组件就撑满；一行没放满时，剩下的栏数平分给这一行里没给 `span` 的统计卡、进度卡（三张各 4 栏、两张各 6 栏）。想让卡并排占满一行，就别给它们写 `span`。
- **多写一个不认识的键会被拒**（防止写错了没人知道）。

## 组件一览

| `type` | 画什么 | 自己的键 |
|---|---|---|
| `filter-bar` | 筛选栏 | `fields` |
| `stat` | 一个大数 | `query`、`value`（取哪个输出列）、`unit`、`tone_rules` |
| `progress` | 进度条 | `query`、`value`、`total`（一个输出列，或者写死的正数） |
| `table` | 表格 | `query`、`columns`（显示哪些列、什么次序）、`page_size`（5～200）、`value_labels`、`column_labels` |
| `records` | 记录卡（每行一张卡片） | `query`、`title_col`（必填）、`badges`、`fields`、`details`、`date_col`、`links`、`page_size`（5～200）、`value_labels`、`column_labels`、`empty_text` |
| `bar` | 柱状图 | `query`、`x`、`y`（一个或几个数值列）、`series`、`stacked`、`horizontal`、`tone_rules` |
| `line` | 折线图 | `query`、`x`、`y`、`series`、`area` |
| `pie` | 饼图 | `query`、`label`、`value`、`donut` |
| `form` | 表单 | `dataset`、`fields`、`submit_label` |
| `dag` | 任务依赖图 | `query`、`id_col`、`label_col`、`deps_col`、`role_col`（必填）、`status_col`、`done_values`、`progress_col`、`source_col`、`group_col`、`detail_cols`、`direction`、`value_labels`、`column_labels` |
| `gantt` | 甘特图 | `query`、`id_col`、`label_col`、`start_col`、`end_col`（必填）、`deps_col`、`role_col`、`status_col`、`done_values`、`progress_col`、`group_col`、`detail_cols`、`value_labels`、`column_labels` |
| `flow` | 流程图 | 同 `dag`，另加 `shape_col` |

图表的规矩：

- `x`、`y`、`value`、`label` 都必须是查询的输出列；`y` 和 `value` 要是数值。
- 分系列有两种写法，**不能同时用**：给多个 `y`（每个一条线 / 一组柱），或者一个 `y` 加 `series`（按那一列的取值分）。
- 系列最多画 5 个，再多的自动并成「其他」。
- 统计卡、进度取的是查询结果的**第一行**，所以它们的查询一般是只有聚合、没有分组的。

## 任务图：依赖图、甘特图、流程图

用来呈现长程任务、跟踪进度。三种组件读同一张任务表：**一行一个任务，依赖写在任务自己那一行**，不另建边表。AI 一次 `dataset_upsert` 就同时改完任务和它的依赖，不会出现「任务写了、边没写」的半截状态。完整的例子见 `recipes.md`「长程任务」。

**任务表的列**（列名随你起，视图里用 `*_col` 指过去）：

| 用途 | 类型 | 说明 |
|---|---|---|
| 编号 | text 或 integer，主键 | 最长 64 字；不能含逗号、等号、竖线、问号 |
| 名称 | text | 图上显示的字 |
| 依赖 | text | 前置，写法见下 |
| 角色 | text | `start` 起点、`end` 主线终点、`branch_end` 支线终点，其余留空 |
| 状态 | text | 哪些值算完成由 `done_values` 定，缺省 `["done"]` |
| 进度 | 数值，可选 | 0～100 |
| 来源 | text，可选 | 从哪采集的：科技树节点键、工单号、链接 |
| 开始、截止 | date 或 datetime | 甘特图要，**在数据集定义里必须是必填列**（`"required": true`），不是必填保存视图就拒 |
| 形状 | text，可选 | 只有流程图用：`decision` 画成菱形（判断），其余画矩形（步骤） |

**依赖写法**（逗号分隔，每格最多 50 项）：

- `a`：必需前置。所有必需前置完成，这个任务才「可开始」。
- `?a`：可选前置。画虚线，不挡开始。
- `a|b`：任一前置，组里有一个完成就算满足。
- `a=说法`、`?a=说法`：流程图边上的字，比如判断分支的「是」「否」。
- 自己指自己的项会被忽略并提示；写不对的项列成「看不懂的依赖」。

**起点和终点**（只在看全部任务时核）：起点、主线终点各恰好一个，起点不能有前置；没有后继的任务必须标 `end` 或 `branch_end`（支线也要确认终点）；每个任务顺后继要能走到某个终点；汇合回主线的支线不需要支线终点。改终点就是 upsert 改角色列（撤旧的、标新的放在同一批里），页面自动重画。不对的地方顶上报出来、标红，**图照画**，只是不算完成率。

**三种组件的不同**：

- `dag`：有环就整块报「依赖有环：A → B → A」，不画图，请改依赖。
- `flow`：允许循环（如「审核不过 → 退回修改」），回到前面的边画成弯线；起点、终点圆角，判断菱形；没有出口的循环报「走不到终点」。
- `gantt`：每个任务一条横条，进度画成条内填充；给了依赖就画箭头（前置的截止 → 后继的开始）；有「今天」竖线；截止已过没完成的条标红；给了角色列就在终点的条尾画标记。依赖、角色列可不给，不给就没有箭头、不核起点终点。超过 25 条有纵向滚动。日期列的截止算到当天结束。

**取数**：查询要是明细查询（不能有 `group`、`measures`），**不能写 `limit`、`offset`**——三种图一次最多取 500 个任务，不分页。超过 500 个、或查询里有 `filter` 时是「部分任务」：指到结果以外的依赖画成灰色的「范围外」占位，不核起点终点、不算完成率，顶上写明原因。

**摘要**：配了 `status_col` 时给出共几个、完成、可开始、等前置、出错，以及完成率和「到主线终点还差 N 个」（只算主线终点真正需要的那些任务；任一组只算其中一条路）。没配状态列就只画结构和诊断。依赖太复杂、算不过来时不出完成率，写明原因。

**实时刷新**：台的数据或视图变了，打开着的页面约 5 秒内自动重新取数，状态或进度变了的任务短暂描粗。页面不在前台时不问；没权限了立刻收起旧图。台上的变量（`{ "var": … }`）变了**不会**自动刷新，要换视图或点刷新。

每个组件右上角都能切到等价的表格（名称、状态、派生状态、进度、前置、后继、角色；甘特图另有开始、截止、是否过期），点任务看详情（`detail_cols` 列出的列）。

## 记录卡（`records`）

每行一张卡片，适合事项、阶段、问题、资料这类「一条一条读」的数据。不要用表格硬塞进卡片里。取数和表格一样：一个 `query`，筛选栏的 `$参数` 照常用，按台的读权限照旧。

下面这个例子用的数据集（每列都带说明名，记录卡要用）：

```json dataset
{ "name": "actions", "title": "下一动作",
  "columns": [
    { "name": "id", "type": "integer", "label": "编号", "auto": true },
    { "name": "action", "type": "text", "label": "动作", "required": true },
    { "name": "status", "type": "text", "label": "状态" },
    { "name": "owner", "type": "text", "label": "负责人" },
    { "name": "purpose", "type": "text", "label": "目的" },
    { "name": "depends", "type": "text", "label": "依赖" },
    { "name": "result", "type": "text", "label": "结果" },
    { "name": "due", "type": "date", "label": "约定时间" },
    { "name": "source_url", "type": "text", "label": "来源" }
  ],
  "key": ["id"] }
```

```json view-doc
{ "title": "督导台",
  "views": [
    { "key": "actions", "title": "下一动作", "blocks": [
      { "type": "records", "title": "下一动作",
        "query": { "dataset": "actions", "sort": [ { "col": "due", "dir": "asc" } ] },
        "title_col": "action", "badges": ["status"], "fields": ["owner", "purpose"], "details": ["depends", "result"],
        "date_col": "due", "links": [ { "col": "source_url", "label": "查看依据" } ],
        "value_labels": { "status": { "todo": "待办", "doing": { "text": "进行中", "tone": "warning" }, "done": { "text": "完成", "tone": "success" } } },
        "page_size": 20, "empty_text": "暂无下一动作" }
    ] }
  ] }
```

- `title_col`：卡片标题。`badges`：0～3 列，显示成徽标，说法走 `value_labels`；没写说法的取值照原值显示，并标「未定义的取值」。
- `fields`：0～8 列，主要字段，一直显示。`details`：0～12 列，次要字段，收在「展开」里。长文字（超过 120 字或带换行）会先收起，点「展开」才看全。
- `date_col`：右上角的日期，要是日期或时间列；空的写「未填」，不当成完成。
- 标题、徽标、主要字段、次要字段、日期这五处**不能重复用同一列**；每一列都要有说明名（数据集列定义的 `label`，或 `column_labels`）。
- `links`：0～3 个 `{ col, label }`。`col` 的值是网址，卡片上**只显示 `label`**（比如「查看依据」「打开资料」，12 字以内），不露网址；鼠标悬停和读屏会说出要去的主机名。只认 `http://`、`https://` 开头的完整网址，`javascript:`、`data:`、相对地址、以 `//` 开头的地址一律当无效，卡片上标「来源地址无效」，不渲染成链接。这一行没有网址的，就不显示这一项。`links` 的列可以和上面五处重叠。
- 所有字段都当纯文本显示，不解析 HTML 或 markdown。
- 分页在页面上做，每页 `page_size` 张（缺省 20）；上方写「共 N 条」；查询被截断时不写这一行，由块框架统一说「数据不止这些，只显示了前 N 行」（和表格一样，只说一次）。
- 新增、更新了数据，卡片跟着变，不用每行写一个组件。

## 引用本台常量与变量

指标卡的 `value`、进度条的 `value` / `total`、统计卡和柱图的 `tone_rules[].value` 可以写成 `{ "var": "键名" }`。常量和变量都在同一空间，这个写法不区分 kind，且只读，不改值。

下面假设本卡片已有数值键 `completed`、`monthly_target` 和 `warning_limit`：

```json
{ "title": "进度台", "views": [{ "key": "board", "title": "进度", "blocks": [
  { "type": "stat", "title": "已完成", "value": { "var": "completed" },
    "tone_rules": [{ "col": "value", "op": "<", "value": { "var": "warning_limit" }, "tone": "warning" }] },
  { "type": "progress", "title": "月度进度", "value": { "var": "completed" }, "total": { "var": "monthly_target" } }
]}] }
```

- 完全来自键的统计卡、进度条不用建一份重复数据集，也不写 query；进度的 total 也可以是固定正数。查询的 value 输出列仍可配一个键引用的 total。图表仍然从数据集查询，只是着色阈值可以引用键。
- 键只按完整字面值读取：`hot.progress` 表示这个完整键，不是对象的子字段；不收卡片号、path、SQL、模板或表达式，不跨台。查询里的 `$month` 仍是筛选参数，与键引用无关。
- 视图台须关联市场卡片；由服务端确定卡片，不从 URL 或绑定对象接受另一台。保存视图就是显式把被引用的数发布给有本视图读取权限的人；不赋予他们通用变量 API 权限。
- 重新取数读取当前值，不把值烘焙进视图版本。同一次取数同一个键只读一次，成功块额外带 `var_revisions`（键 → 所用 revision），便于辨别变更；不同键与数据集之间不承诺跨存储原子快照。预览旧视图时也读取当前键值，不是历史变量快照。
- 键可在保存视图后写入：保存只校验引用格式，运行时缺键、非数字（包括数字字符串）、目标不是正数都只使该块出错，不显示成 0。热变量暂时不可用或两边分叉同样明确块错，不读旧值。普通的数值 0 是合法值。
- 视图描述、MCP 的 view_get 返回的仍是引用，不返回变量值。只有已授权的 render 路径解析当前视图显式引用的键，不列出整个空间；向 render 额外传 key / var 等选择器会得到块错误。

## 筛选栏

```json view-doc
{ "title": "筛选", "views": [ { "key": "v", "title": "v", "blocks": [
  { "type": "filter-bar", "fields": [
    { "name": "month", "kind": "month", "label": "月份", "default": "2026-01" },
    { "name": "day", "kind": "date", "label": "日期" },
    { "name": "region", "kind": "select", "label": "区", "options": { "dataset": "orders", "col": "region" } },
    { "name": "status", "kind": "select", "label": "状态", "options": ["done", "late"] },
    { "name": "q", "kind": "search", "label": "单号" } ] }
] } ] }
```

| `kind` | 值 |
|---|---|
| `month` | `YYYY-MM` |
| `date` | `YYYY-MM-DD` |
| `select` | 选项里的一个。`options` 给一组文本，或者 `{ dataset, col }`（取那一列出现过的值，最多 100 个） |
| `search` | 人输入的文本 |

`name` 就是查询里 `$名字` 引用的那个名字。`default` 是没选的时候用的值（一段文本）。

## 表格的表头（每一列都要有说明名）

表头不给人看列名（键名）。表格里显示的每一列都要有说明名，取的次序是：

1. 这个组件的 `column_labels`（列名 → 说明名，1～32 个字符）；
2. 数据集列定义里的 `label`；
3. 聚合出来的列，`measures` 里那一项的 `label`。

一列都对不上，`view_put` 就拒，错误里点名缺的是哪几列。只核页面上显示的列（给了 `columns` 就只核那几列）。

```json view-doc
{ "title": "表头", "views": [ { "key": "v", "title": "v", "blocks": [
  { "type": "table", "title": "各区合计",
    "query": { "dataset": "orders", "group": ["region"], "measures": [ { "as": "n", "fn": "count" }, { "as": "amount", "fn": "sum", "col": "amount", "label": "金额" } ] },
    "column_labels": { "n": "单数" } }
] } ] }
```

上面这块：`region` 用数据集里的说明名「区」；`amount` 用 `measures` 里的「金额」；`n` 没有说明名，靠 `column_labels` 补上「单数」。

这条规矩之前就存下的旧版本不追改：页面上没有说明名的列，表头写「第 N 列」，不露列名。

## 表格里的取值怎么说（`value_labels`）

库里存的状态代号不要直接给人看。给一份对照：列名 → 取值 → 说法。

```json view-doc
{ "title": "说法", "views": [ { "key": "v", "title": "v", "blocks": [
  { "type": "table", "query": { "dataset": "orders" },
    "value_labels": { "status": { "done": { "text": "已完成", "tone": "success" }, "late": { "text": "已超期", "tone": "danger" }, "hold": "暂缓" } } }
] } ] }
```

- 说法可以只是一段文字，也可以带颜色：`success`（绿）、`warning`（黄）、`danger`（红）、`default`（灰）。
- 没配说法的取值会显示成灰色小字的原文——页面上一眼看得出「这个还没配」，不报错。
- 有对照的列一定排在表格最左边，**不管 `columns` 里把它写在第几个**（列表的规矩：状态最左）。其余的列照 `columns` 的次序。

## 按值着色（`tone_rules`）

把「低于阈值」这类信号直接画出来。用在统计卡和**只有一个系列**的柱状图上，最多两条，按先后第一条满足的算。

```json view-doc
{ "title": "着色", "views": [ { "key": "v", "title": "v", "blocks": [
  { "type": "bar", "title": "各区金额",
    "query": { "dataset": "orders", "group": ["region"], "measures": [ { "as": "amount", "fn": "sum", "col": "amount", "label": "金额" } ] },
    "x": "region", "y": "amount",
    "tone_rules": [ { "col": "amount", "op": "<", "value": 100, "tone": "danger" }, { "col": "amount", "op": "<", "value": 500, "tone": "warning" } ] }
] } ] }
```

- `col` 是一个数值输出列；`op` 是 `<`、`<=`、`>`、`>=`、`=`、`!=`；`value` 是数字；`tone` 只有 `danger`、`warning`、`success` 三种，不能给色值。
- 图下面会自动带一行说明（「红 = 金额低于 100；黄 = 金额低于 500」）。

## 表单

- `fields` 是表单里出现的列。**数据集的必填列必须都在表单里**，不然保存视图时被拒。
- 提交就是往那个数据集追加一行，校验和 `dataset_append` 一样。**只收表单里列出的字段**——数据集有、表单没列的列，经表单写不了。
- 输入框按列的类型出：文本、整数、小数、日期、时间、是否。

## 版本

- `view_put` 每次保存是一个新版本并立即生效；内容和现在一样就不产生新版本。留最近 100 版。
- `view_versions` 看历史，`view_diff` 看两版差在哪，`view_rollback` 让旧版本重新生效。
- 旧版本引用的列如果后来被删了，不能让它重新生效；先把列加回来，或者基于它改一份新的。
- 视图引用的列被删了之后，页面上只有用到那一列的组件显示出错，别的照常。删列之前先看一眼哪些组件在用。
