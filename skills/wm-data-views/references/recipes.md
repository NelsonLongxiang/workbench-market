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

## 交付前自查

1. `dataset_list`：行数、数据量和预期一致。
2. `view_get`：是刚保存的那一版。
3. 打开页面：每个组件都有数；筛选栏换一个值，数跟着变；没有组件显示出错。
4. 表格里没有灰色小字的原文（有就是状态的说法没配全）。
