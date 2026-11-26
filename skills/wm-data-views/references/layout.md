# 先规划，再摆组件：视图的布局

做视图时最常见的毛病是一上来就挑组件，结果每个数据集各占一个页签，页面里叠满表格，标题写成审计口吻，人打开后不知道该看哪儿、该做什么。先写一张规划卡，组件和布局就跟着定了。

本篇用一个合成的选品台做例子：挑出值得出初评报告的候选商品。

## 一、动手前写规划卡

四格写清楚了再动手：

| 格 | 写什么 | 例子 |
|---|---|---|
| 谁看 | 哪类人、多久看一次、看多久 | 业务负责人，每天一次，两三分钟 |
| 看完做什么决定 | 一句话 | 哪些候选排进初评 出报告；已出的初评留还是停 |
| 一行代表什么 | 决策对象 | 一个候选 ASIN |
| 什么时候算做完 | 页面上能看到的状态 | 「待你定」清零，「该排进初评」都排上了 |

然后把要回答的问题逐条列出来，每个问题配一个块：

| 问题 | 块 | 位置 |
|---|---|---|
| 现在有多少事等我？ | 统计卡 × 4 | 第一行，各 3 栏 |
| 整体好不好？ | 柱状图（分段） | 第二行左，6 栏 |
| 好的集中在哪？ | 横向柱状图（前 10） | 第二行右，6 栏 |
| 具体先看哪几个？ | 记录卡，按要紧程度排 | 第三行，12 栏 |
| 要查某一个？ | 全量表格，加最上面的筛选栏 | 最下面 |

凑不出问题的块不放。

## 二、布局规则

1. **从上到下：筛选、数、图、清单、明细。** 统计卡每排四个，各占 3 栏；图两张并排，各占 6 栏；记录卡和表格占满 12 栏。不写 `span`，平台会自动补齐。
2. **标题写成这个块回答的问题。** 比如「毛利分段：多少候选值得看」。口径、来源、截至日期放进详情列或报告附录，不放进标题。
3. **颜色只表示要不要动手。** 等人决定的用 `warning`，出了问题的用 `danger`，已核过的用 `success`，其余用默认的灰色。统计卡上用 `tone_rules` 标出来。
4. **给人看的数据集按决策对象建，一行一个对象。** 平台不连表，也不能在一个查询里按条件计数。跨数据集的数（经营测算、报价条数、报告状态）由写入方合进这一行。
5. **数在写入时就整理好。** 小数位、分段、名次、下一步这几列都在写入时算好。取值代号一律配 `value_labels`，不直接给人看。分段要排序，就另给一列序号，`group` 写成 `[序号, 分段]`，再按序号排。
6. **页签按用途排。** 人用的页签放前面，比如报告、选品、进度。给报告取数的页签放最后，标题写明「报告取数 · 初评」。一个台最多 20 个页签，不要每个数据集各做一个。
7. **前 N 名由写入方算名次。** 图表里用 `limit` 截前 N 名时，页面下方会提示「数据不止这些」，这是正常的。报告的数据槽却是按 `max_rows` 取数，多一行整份报告就拒收，所以报告里要用「前 N 名」时，写入方要先写一列名次（比如「入口内毛利名次」），槽对应的块再按名次 `<=` N 筛。
8. **交付前先过一遍校验。** `view_put` 本身就会校验，不合格时逐条说明原因。入口开之前，也可以先把例子写进本技能，用 `node scripts/skill-data-views-examples-test.mjs` 跑通，做法见 SKILL.md 最后一节。

## 三、照着抄：选品

数据集：一行一个候选。毛利段配了序号列，入口内名次留给报告取「同入口前 N」时用。

```json dataset
{ "name": "picks", "title": "选品看板（一行一个候选）", "key": ["asin"],
  "columns": [
    { "name": "asin", "type": "text", "label": "ASIN" },
    { "name": "title", "type": "text", "label": "商品", "required": true },
    { "name": "market_entry", "type": "text", "label": "市场入口", "required": true },
    { "name": "price", "type": "decimal", "label": "售价（美元）" },
    { "name": "monthly_sales", "type": "integer", "label": "月销量" },
    { "name": "margin_pct", "type": "decimal", "label": "估算毛利率（%）" },
    { "name": "entry_rank", "type": "integer", "label": "入口内毛利名次" },
    { "name": "band_rank", "type": "integer", "label": "毛利段序号", "required": true },
    { "name": "margin_band", "type": "text", "label": "毛利段", "required": true },
    { "name": "decision", "type": "text", "label": "上一轮裁决", "required": true },
    { "name": "next_step", "type": "text", "label": "下一步", "required": true,
      "values": { "queue": "排进初评", "decide": "初评已出，待人定", "wait": "等出报告", "skip": "暂不看" } },
    { "name": "review_link", "type": "text", "label": "报告" },
    { "name": "updated_at", "type": "datetime", "label": "更新于", "required": true }
  ] }
```

```json rows:picks
[
  { "asin": "SAMPLE01", "title": "合成样品 · 有机棉床笠", "market_entry": "crib-sheets", "price": 39.95, "monthly_sales": 5977, "margin_pct": 45.0, "entry_rank": 1, "band_rank": 1, "margin_band": "≥20%", "decision": "GO", "next_step": "queue", "review_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE02", "title": "合成样品 · 速干洗碗巾", "market_entry": "dish-towels", "price": 34.0, "monthly_sales": 7134, "margin_pct": 31.2, "entry_rank": 1, "band_rank": 1, "margin_band": "≥20%", "decision": "GO", "next_step": "decide", "review_link": "https://example.com/reports/2", "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE03", "title": "合成样品 · 超细纤维抹布", "market_entry": "dish-towels", "price": 12.99, "monthly_sales": 6348, "margin_pct": 14.6, "entry_rank": 2, "band_rank": 2, "margin_band": "10–20%", "decision": "CONDITIONAL", "next_step": "queue", "review_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE04", "title": "合成样品 · 手持按摩器", "market_entry": "handheld-massager", "price": 29.99, "monthly_sales": 3964, "margin_pct": 6.1, "entry_rank": 1, "band_rank": 3, "margin_band": "0–10%", "decision": "GO", "next_step": "skip", "review_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE05", "title": "合成样品 · 化妆刷套装", "market_entry": "kabuki-brushes", "price": 9.99, "monthly_sales": 2210, "margin_pct": -4.2, "entry_rank": 1, "band_rank": 4, "margin_band": "亏损", "decision": "UNREVIEWED", "next_step": "skip", "review_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE06", "title": "合成样品 · 旅行收纳袋", "market_entry": "travel-organizers", "price": null, "monthly_sales": null, "margin_pct": null, "entry_rank": null, "band_rank": 5, "margin_band": "未算", "decision": "UNREVIEWED", "next_step": "skip", "review_link": null, "updated_at": "2026-01-20T10:00:00Z" }
]
```

视图：一个人用的页签，加一个放在最后的报告取数页签。

```json view-doc
{ "title": "选品台", "views": [
  { "key": "pick", "title": "选品", "blocks": [
    { "type": "filter-bar", "fields": [
      { "name": "entry", "kind": "select", "label": "市场入口", "options": { "dataset": "picks", "col": "market_entry" } },
      { "name": "decision", "kind": "select", "label": "上一轮裁决", "options": ["GO", "CONDITIONAL", "UNREVIEWED"] },
      { "name": "q", "kind": "search", "label": "ASIN" } ] },
    { "type": "stat", "title": "候选", "unit": "个", "value": "n",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" } ],
                 "measures": [ { "as": "n", "fn": "count" } ] } },
    { "type": "stat", "title": "估算毛利 ≥ 20%", "unit": "个", "value": "n",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" }, { "col": "margin_pct", "op": ">=", "value": 20 } ],
                 "measures": [ { "as": "n", "fn": "count" } ] },
      "tone_rules": [ { "col": "n", "op": "=", "value": 0, "tone": "warning" } ] },
    { "type": "stat", "title": "该排进初评", "unit": "个", "value": "n",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" }, { "col": "next_step", "op": "=", "value": "queue" } ],
                 "measures": [ { "as": "n", "fn": "count" } ] } },
    { "type": "stat", "title": "初评已出、待你定", "unit": "份", "value": "n",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" }, { "col": "next_step", "op": "=", "value": "decide" } ],
                 "measures": [ { "as": "n", "fn": "count" } ] },
      "tone_rules": [ { "col": "n", "op": ">", "value": 0, "tone": "warning" } ] },
    { "type": "bar", "title": "毛利分段：多少候选值得看", "span": 6, "x": "margin_band", "y": "n",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" } ],
                 "group": ["band_rank", "margin_band"], "measures": [ { "as": "n", "fn": "count", "label": "候选数" } ], "sort": [ { "col": "band_rank" } ] } },
    { "type": "bar", "title": "哪些入口的好候选多（毛利 ≥ 10%）", "span": 6, "x": "market_entry", "y": "n", "horizontal": true,
      "query": { "dataset": "picks", "filter": [ { "col": "decision", "op": "=", "value": "$decision" }, { "col": "margin_pct", "op": ">=", "value": 10 } ],
                 "group": ["market_entry"], "measures": [ { "as": "n", "fn": "count", "label": "候选数" } ], "sort": [ { "col": "n", "dir": "desc" } ], "limit": 10 } },
    { "type": "records", "title": "先看这些：按估算毛利从高到低", "page_size": 12,
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" }, { "col": "margin_pct", "op": ">=", "value": 10 } ],
                 "sort": [ { "col": "margin_pct", "dir": "desc" } ], "limit": 200 },
      "title_col": "title", "badges": ["next_step", "decision"],
      "fields": ["asin", "market_entry", "margin_pct", "monthly_sales", "price"],
      "details": ["margin_band"], "date_col": "updated_at",
      "links": [ { "col": "review_link", "label": "打开初评报告" } ],
      "value_labels": {
        "next_step": { "queue": { "text": "排进初评", "tone": "warning" }, "decide": { "text": "待你定", "tone": "danger" }, "wait": "等出报告", "skip": "暂不看" },
        "decision": { "GO": { "text": "上轮 GO", "tone": "success" }, "CONDITIONAL": { "text": "上轮有条件", "tone": "warning" }, "UNREVIEWED": "上轮未裁" } },
      "empty_text": "这个筛选下没有毛利 ≥ 10% 的候选" },
    { "type": "table", "title": "全部候选", "page_size": 50,
      "columns": ["next_step", "asin", "title", "market_entry", "margin_pct", "monthly_sales", "price"],
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "decision", "op": "=", "value": "$decision" }, { "col": "asin", "op": "contains", "value": "$q" } ],
                 "sort": [ { "col": "band_rank" }, { "col": "margin_pct", "dir": "desc" } ], "limit": 1000 },
      "value_labels": { "next_step": { "queue": { "text": "排进初评", "tone": "warning" }, "decide": { "text": "待你定", "tone": "danger" }, "wait": "等出报告", "skip": "暂不看" } } }
  ] },
  { "key": "pick-src", "title": "报告取数 · 初评", "blocks": [
    { "type": "filter-bar", "fields": [ { "name": "asin", "kind": "search", "label": "ASIN" }, { "name": "entry", "kind": "search", "label": "市场入口" } ] },
    { "type": "table", "title": "本品要点（一行）",
      "query": { "dataset": "picks", "filter": [ { "col": "asin", "op": "=", "value": "$asin" } ], "limit": 2 },
      "columns": ["asin", "title", "market_entry", "price", "monthly_sales", "margin_pct", "decision"] },
    { "type": "table", "title": "同入口毛利前 10",
      "query": { "dataset": "picks", "filter": [ { "col": "market_entry", "op": "=", "value": "$entry" }, { "col": "entry_rank", "op": "<=", "value": 10 } ], "sort": [ { "col": "entry_rank" } ], "limit": 20 },
      "columns": ["asin", "margin_pct", "monthly_sales"] }
  ] }
] }
```

几处讲究：

- 筛选栏放在最上面，所有块共用；「哪些入口」那张图故意不按入口筛，否则只剩一根柱子。
- 「报告取数」页签里的块按 `=` 精确筛一行或按名次筛，报告槽绑定到这些块（报告的版式见 [wm-reports](../../wm-reports/SKILL.md)「版式：结论先行」）。
- 统计卡和记录卡展示小数时，按写入时整理好的位数显示，所以写入方要先取好位数（第二节第 5 条）。
