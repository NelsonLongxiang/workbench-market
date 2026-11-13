# 完整例子：设备巡检台（从零到能打开页面）

一个真跑过的例子，数据全部是合成的。照着做一遍，就知道一个视图台从申请权限到交付要走哪几步。下面每一块 JSON 都由 `scripts/skill-data-views-examples-test.mjs` 用真实现跑过。

**任务**：派任务的人说：「卡片 12 是设备巡检台。把巡检记录放上去，管理层要看本月巡检了几次、有几次异常、各区域分布，还要能翻明细。异常就是 `bad`。」

## 第 0 步：拿到权限

台写卡片编号就行。一次把要用的工具都申请了，写清用途：

```text
access_request { "tools": ["dataset_define@bench:12", "dataset_replace@bench:12", "dataset_list@bench:12", "dataset_query@bench:12", "view_get@bench:12", "view_put@bench:12"], "reason": "建设备巡检台：两份数据集、一份视图描述" }
```

等管理层批（`access_info` 的 `bench_requests` 里看进度）。批之前调这些工具，结果和「没有这个工具」一样。

## 第 1 步：建两份数据集

每一列都写 `label`（页面上表格的表头只用它，没有就保存不了视图）；口径（「异常就是 bad」）写进列的 `values`。

```json dataset
{ "name": "patrol_devices", "title": "设备", "key": ["id"],
  "columns": [
    { "name": "id", "type": "integer", "label": "编号" },
    { "name": "name", "type": "text", "label": "名字" },
    { "name": "region", "type": "text", "label": "区域" },
    { "name": "status", "type": "text", "label": "状态", "values": { "在用": "在用", "停用": "停用，不再巡检" } }
  ] }
```

```json dataset
{ "name": "patrol_records", "title": "巡检记录", "key": ["id"],
  "columns": [
    { "name": "id", "type": "integer", "label": "编号" },
    { "name": "day", "type": "date", "label": "日期", "required": true },
    { "name": "device", "type": "text", "label": "设备" },
    { "name": "region", "type": "text", "label": "区域" },
    { "name": "who", "type": "text", "label": "巡检人" },
    { "name": "result", "type": "text", "label": "结果", "values": { "ok": "正常", "bad": "异常" } },
    { "name": "minutes", "type": "integer", "label": "用时（分钟）" }
  ] }
```

## 第 2 步：写数据

这两份都是「每次给全量」的数据，用整份替换（`dataset_replace`），带一个幂等键，重发不会写两遍。

```json rows:patrol_devices
[ { "id": 1, "name": "设备-01", "region": "东区", "status": "在用" },
  { "id": 2, "name": "设备-02", "region": "南区", "status": "在用" },
  { "id": 3, "name": "设备-03", "region": "西区", "status": "在用" },
  { "id": 4, "name": "设备-04", "region": "北区", "status": "停用" } ]
```

```json rows:patrol_records
[ { "id": 1, "day": "2026-01-05", "device": "设备-01", "region": "东区", "who": "甲", "result": "ok", "minutes": 13 },
  { "id": 2, "day": "2026-01-05", "device": "设备-02", "region": "南区", "who": "乙", "result": "ok", "minutes": 16 },
  { "id": 3, "day": "2026-01-05", "device": "设备-03", "region": "西区", "who": "丙", "result": "bad", "minutes": 22 },
  { "id": 4, "day": "2026-01-15", "device": "设备-01", "region": "东区", "who": "乙", "result": "ok", "minutes": 10 },
  { "id": 5, "day": "2026-01-15", "device": "设备-02", "region": "南区", "who": "丙", "result": "ok", "minutes": 19 },
  { "id": 6, "day": "2026-01-15", "device": "设备-03", "region": "西区", "who": "甲", "result": "ok", "minutes": 13 },
  { "id": 7, "day": "2026-02-05", "device": "设备-01", "region": "东区", "who": "丙", "result": "bad", "minutes": 16 } ]
```

## 第 3 步：先查一下，确认数对

本月（筛选栏的 `$month`，这里是 2026-01）各区域巡检几次：

```json query
{ "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ],
  "group": ["region"], "measures": [ { "as": "n", "fn": "count", "label": "次数" } ] }
```

## 第 4 步：写视图描述

两份视图：看板（四个数和一张图）、明细（一张表）。两份都有同一个月份筛选栏。

```json view-doc
{ "title": "设备巡检", "views": [
  { "key": "board", "title": "看板", "blocks": [
    { "type": "filter-bar", "fields": [ { "name": "month", "kind": "month", "label": "月份", "default": "2026-01" } ] },
    { "type": "stat", "title": "本月巡检", "unit": "次", "value": "v",
      "query": { "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "v", "fn": "count" } ] } },
    { "type": "stat", "title": "本月异常", "unit": "次", "value": "v",
      "query": { "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" }, { "col": "result", "op": "=", "value": "bad" } ], "measures": [ { "as": "v", "fn": "count" } ] },
      "tone_rules": [ { "col": "v", "op": ">", "value": 0, "tone": "danger" } ] },
    { "type": "progress", "title": "本月应巡检 6 次", "value": "got", "total": 6,
      "query": { "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "got", "fn": "count" } ] } },
    { "type": "bar", "title": "各区域巡检次数", "x": "region", "y": "n",
      "query": { "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "group": ["region"], "measures": [ { "as": "n", "fn": "count", "label": "次数" } ] } } ] },
  { "key": "detail", "title": "明细", "blocks": [
    { "type": "filter-bar", "fields": [ { "name": "month", "kind": "month", "label": "月份", "default": "2026-01" } ] },
    { "type": "table", "title": "巡检记录", "page_size": 20, "columns": ["day", "device", "region", "who", "result", "minutes"],
      "query": { "dataset": "patrol_records", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "sort": [ { "col": "day", "dir": "desc" } ], "limit": 500 },
      "value_labels": { "result": { "ok": { "text": "正常", "tone": "success" }, "bad": { "text": "异常", "tone": "danger" } } } } ] }
] }
```

保存时用 `view_put`，`base` 填你读到的版本（第一次是 0），`note` 写一句说明（「初版：看板和明细」）。

## 第 5 步：自己打开看一遍，再交付

- 打开地址：`/use/12`（卡片编号）。顶栏两份视图「看板」「明细」，默认打开看板。
- 2026-01 应当看到：本月巡检 6 次、异常 1 次（红色）、进度 6/6，柱状图东区 2、南区 2、西区 2；明细 6 行，表头都是中文，结果列显示「正常」「异常」标签。
- 交付给派任务的人：卡片编号 12、打开地址 `/use/12`、两份视图各给谁看。还看不到的人，请他找管理层放行；不要自己想办法绕。

## 之后：每天更新

每天把当天的全量巡检记录用 `dataset_replace` 整份替换（幂等键带上日期，比如 `patrol-2026-01-16`）。只追加当天新增的话，用 `dataset_append`，见 SKILL.md 的「更新数据：四种写法怎么选」。改页面先 `view_get` 读当前版本，改完 `view_put` 带上那个版本。
