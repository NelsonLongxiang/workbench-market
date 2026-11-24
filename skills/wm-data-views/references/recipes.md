# 照着抄

下面的例子都用同一个数据集 `orders`（见 SKILL.md 第 ① 步）。

## 每天整份更新的报表

写入方每天算好一整份，调一次 `dataset_replace`。幂等键用日期（`orders-2026-01-31`）：当天重跑不会写两遍，也不会和别的日期撞。

```json rows:orders
[ { "id": 1, "day": "2026-01-31", "region": "东区", "status": "done", "amount": 320 },
  { "id": 2, "day": "2026-01-31", "region": "西区", "status": "hold", "amount": 75.5 } ]
```

替换错了：`dataset_snapshots` 看这个数据集的快照（或者用替换那次结果里带的 `snapshot_id`），`dataset_restore` 退回到替换前的那一份。

## 一张看板：筛选栏 + 四个数 + 一张图 + 明细

```json view-doc
{ "title": "订单看板", "views": [ { "key": "board", "title": "看板", "blocks": [
  { "type": "filter-bar", "fields": [ { "name": "month", "kind": "month", "label": "月份" } ] },
  { "type": "stat", "title": "金额", "unit": "元", "value": "v",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "v", "fn": "sum", "col": "amount" } ] } },
  { "type": "stat", "title": "单数", "unit": "单", "value": "v",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "v", "fn": "count" } ] } },
  { "type": "stat", "title": "超期", "unit": "单", "value": "v",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" }, { "col": "status", "op": "=", "value": "late" } ], "measures": [ { "as": "v", "fn": "count" } ] },
    "tone_rules": [ { "col": "v", "op": ">", "value": 0, "tone": "danger" } ] },
  { "type": "progress", "title": "金额 / 月目标", "value": "got", "total": 10000,
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "got", "fn": "sum", "col": "amount" } ] } },
  { "type": "line", "title": "每天的金额", "x": "day", "y": "amount",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "group": ["day"], "measures": [ { "as": "amount", "fn": "sum", "col": "amount", "label": "金额" } ], "sort": [ { "col": "day" } ] } },
  { "type": "pie", "title": "各区占比", "label": "region", "value": "amount", "donut": true,
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "group": ["region"], "measures": [ { "as": "amount", "fn": "sum", "col": "amount" } ] } },
  { "type": "table", "title": "明细", "page_size": 20, "columns": ["status", "id", "day", "region", "amount"],
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "sort": [ { "col": "day", "dir": "desc" } ], "limit": 500 },
    "value_labels": { "status": { "done": { "text": "已完成", "tone": "success" }, "late": { "text": "已超期", "tone": "danger" }, "hold": "暂缓" } } }
] } ] }
```

看板里几处的讲究：

- 进度条的总数这里是写死的月目标。总数也可以取查询的另一个输出列（`"total": "列名"`）。
- 一个查询里**不能**分别数「全部」和「满足某个条件的」（没有按条件计数）。要「完成率」这样的数：在写入的时候算好放进数据集，或者像上面「超期」那张统计卡一样，用带筛选的查询单独数一个数。
- `count` 带 `col` 数的是「这一列不空的行」，不是「这一列等于某个值的行」。

## 给人填的提报页

```json view-doc
{ "title": "订单台", "views": [ { "key": "entry", "title": "补录", "blocks": [
  { "type": "form", "title": "补一单", "dataset": "orders", "fields": ["id", "day", "region", "status", "amount"], "submit_label": "提交" },
  { "type": "table", "title": "最近补录的", "query": { "dataset": "orders", "sort": [ { "col": "id", "dir": "desc" } ], "limit": 20 } }
] } ] }
```

## 增量同步（外部系统那边有变化就推过来）

- 用 `dataset_upsert`，主键用外部系统的单号。每批不超过 5000 行。
- 外部删掉的，用 `dataset_delete_rows` 给主键。
- 每批一个幂等键（比如「同步批次号-第几批」）。超时了带同一个键重发。

## 长程任务：任务表 + 依赖图 + 甘特图 + 进度曲线

AI 拆任务、推进、改终点都只是写任务表；页面自己画。先建任务表和进度日志：

```json dataset
{ "name": "tasks", "title": "任务", "key": ["id"],
  "columns": [
    { "name": "id", "type": "text", "label": "编号" },
    { "name": "name", "type": "text", "label": "任务", "required": true },
    { "name": "deps", "type": "text", "label": "前置" },
    { "name": "role", "type": "text", "label": "角色", "values": { "start": "起点", "end": "主线终点", "branch_end": "支线终点" } },
    { "name": "status", "type": "text", "label": "状态", "values": { "todo": "未开始", "doing": "进行中", "done": "完成" } },
    { "name": "progress", "type": "integer", "label": "进度" },
    { "name": "source", "type": "text", "label": "来源" },
    { "name": "start", "type": "date", "label": "开始", "required": true },
    { "name": "due", "type": "date", "label": "截止", "required": true }
  ] }
```

```json dataset
{ "name": "progress_log", "title": "进度日志", "key": ["at"],
  "columns": [
    { "name": "at", "type": "datetime", "label": "时间" },
    { "name": "done", "type": "integer", "label": "完成数", "required": true },
    { "name": "total", "type": "integer", "label": "总数", "required": true }
  ] }
```

先写起点和终点，再把拆出来的任务连上依赖。实现有两条路（`impl_a|impl_b` 任一完成即可），调研是可选前置（`?research`）：

```json rows:tasks
[
  { "id": "kickoff", "name": "立项", "role": "start", "status": "done", "progress": 100, "start": "2026-01-05", "due": "2026-01-06" },
  { "id": "research", "name": "调研", "deps": "kickoff", "status": "doing", "progress": 40, "start": "2026-01-06", "due": "2026-01-12" },
  { "id": "design", "name": "设计", "deps": "kickoff,?research", "status": "done", "progress": 100, "start": "2026-01-07", "due": "2026-01-14" },
  { "id": "impl_a", "name": "实现甲方案", "deps": "design", "status": "doing", "progress": 60, "start": "2026-01-15", "due": "2026-01-28" },
  { "id": "impl_b", "name": "实现乙方案", "deps": "design", "status": "todo", "progress": 0, "start": "2026-01-15", "due": "2026-01-30" },
  { "id": "release", "name": "发布", "deps": "impl_a|impl_b", "role": "end", "status": "todo", "progress": 0, "start": "2026-02-02", "due": "2026-02-03" }
]
```

推进一步就按主键改那几行（必填列要给全）；改起点、终点也一样，撤旧的、标新的放在同一批里。甲方案做完了：

```json upsert:tasks
[
  { "id": "impl_a", "name": "实现甲方案", "deps": "design", "status": "done", "progress": 100, "start": "2026-01-15", "due": "2026-01-28" }
]
```

每推进一步往进度日志追加一行，进度曲线就有了：

```json append:progress_log
[ { "at": "2026-01-28T18:00:00+08:00", "done": 3, "total": 6 } ]
```

页面：一页看依赖和进度，一页看排期：

```json view-doc
{ "title": "项目台", "views": [
  { "key": "progress", "title": "进度", "blocks": [
    { "type": "stat", "title": "已完成", "query": { "dataset": "tasks", "filter": [ { "col": "status", "op": "=", "value": "done" } ], "measures": [ { "as": "v", "fn": "count" } ] }, "value": "v", "unit": "个" },
    { "type": "dag", "title": "依赖", "query": { "dataset": "tasks" }, "id_col": "id", "label_col": "name", "deps_col": "deps", "role_col": "role", "status_col": "status", "progress_col": "progress", "source_col": "source", "detail_cols": ["start", "due"],
      "value_labels": { "status": { "done": { "text": "完成", "tone": "success" }, "doing": { "text": "进行中", "tone": "warning" }, "todo": "未开始" } } },
    { "type": "line", "title": "完成数", "query": { "dataset": "progress_log", "sort": [ { "col": "at" } ] }, "x": "at", "y": ["done", "total"] }
  ] },
  { "key": "schedule", "title": "排期", "blocks": [
    { "type": "gantt", "title": "排期", "query": { "dataset": "tasks" }, "id_col": "id", "label_col": "name", "start_col": "start", "end_col": "due", "deps_col": "deps", "role_col": "role", "status_col": "status", "progress_col": "progress" }
  ] }
] }
```

- 统计卡数的是写入时就定好的状态。「完成率」「到主线终点还差几个」在依赖图的摘要里，按依赖算，不用自己算。
- 乙方案经任一组汇合回发布，不是没有后继的叶子，所以不需要支线终点。发布只要甲、乙任一完成：甲做完后发布就「可开始」，完成率按立项、设计、甲、发布四个算（3/4，还差 1 个），乙和可选的调研不计入。
- 真正走不下去、也不汇合回主线的支线，才要在角色列标 `branch_end`，否则报「支线没确认终点」。
- 任务过了 500 个，或者给图的查询加了筛选，图会说明「当前是部分任务」，不核终点。

## 审批流程：允许退回的流程图

```json dataset
{ "name": "review_steps", "title": "审批步骤", "key": ["id"],
  "columns": [
    { "name": "id", "type": "text", "label": "编号" },
    { "name": "name", "type": "text", "label": "步骤", "required": true },
    { "name": "deps", "type": "text", "label": "前置" },
    { "name": "role", "type": "text", "label": "角色" },
    { "name": "shape", "type": "text", "label": "形状", "values": { "step": "步骤", "decision": "判断" } }
  ] }
```

审核不过退回修改：起草 → 审核（判断）→ 否 → 修改 → 起草；是 → 发布。修改依赖审核的「否」，所以写成可选前置加说法 `?review=否`：

```json rows:review_steps
[
  { "id": "begin", "name": "开始", "role": "start" },
  { "id": "draft", "name": "起草", "deps": "begin,fix" },
  { "id": "review", "name": "审核", "deps": "draft", "shape": "decision" },
  { "id": "fix", "name": "修改", "deps": "?review=否" },
  { "id": "publish", "name": "发布", "deps": "review=是", "role": "end" }
]
```

```json view-doc
{ "title": "审批台", "views": [ { "key": "flow", "title": "流程", "blocks": [
  { "type": "flow", "title": "审批流程", "query": { "dataset": "review_steps" }, "id_col": "id", "label_col": "name", "deps_col": "deps", "role_col": "role", "shape_col": "shape" }
] } ] }
```

用依赖图 `dag` 画这份数据会整块报「依赖有环」；流程图把回边画成弯线，有出口（发布）就不报错。

## 交付前自查

1. `dataset_list`：行数、数据量和预期一致。
2. `view_get`：是刚保存的那一版。
3. 打开页面：每个组件都有数；筛选栏换一个值，数跟着变；没有组件显示出错。
4. 表格里没有灰色小字的原文（有就是状态的说法没配全）。
