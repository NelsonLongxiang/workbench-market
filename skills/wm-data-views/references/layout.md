# 数据视图设计指南

这篇写的是一个视图台从零到交付怎么设计：先想清楚给谁看、要做什么决定，再设计数据集、排页签、摆组件，最后接上报告。每条规则后面说明为什么这样做。最后一节是一个合成的选品台例子，测试脚本会把它实际跑一遍，可以直接照抄。

组件的键和上限见 [views.md](views.md)，查询写法见 [query.md](query.md)，报告的写法见 [wm-reports](../../wm-reports/SKILL.md)。

## 一、先分清五样东西

| 东西 | 管什么 | 谁写 |
|---|---|---|
| 数据集 | 存事实：一行一个对象，列是它的属性 | 写入方（采集、计算的席位） |
| 数据视图 | 活查询和展示：筛选、找对象、看进度 | 台所绑团队的人和 AI 成员 |
| 报告模板 | 判断的结构：要给哪些结论、风险、下一步 | 定维度的人 |
| 正式报告 | 某一刻冻结下来的事实和判断 | 出报告的席位 |
| 回应和决定 | 人对报告的认可、反驳和拍板 | 读报告的人 |

视图的用处是帮人筛选、找到要看的报告和对象，并跟进度。判断写进报告，不写在视图的标题和说明里。

## 二、动手前写规划卡

四格写清楚了再动手：

| 格 | 写什么 | 例子 |
|---|---|---|
| 谁看 | 哪类人、多久看一次、看多久 | 业务负责人，每天一次，两三分钟 |
| 看完做什么决定 | 一句话 | 哪些候选排进初评、出报告；已出的初评留还是停 |
| 一行代表什么 | 决策对象 | 一个候选商品 |
| 什么时候算做完 | 页面上能看到的状态 | 「待你定」清零，「该排进初评」的都排上了 |

再把要回答的问题逐条列出来，每个问题配一个块：

| 问题 | 块 | 位置 |
|---|---|---|
| 现在有多少事等我？ | 统计卡 × 4 | 第一行，各 3 栏 |
| 整体好不好？ | 柱状图（分段） | 第二行左，6 栏 |
| 好的集中在哪？ | 横向柱状图（前 10） | 第二行右，6 栏 |
| 具体先看哪几个？ | 记录卡，按要紧程度排 | 第三行，12 栏 |
| 要查某一个？ | 全量表格，配合最上面的筛选栏 | 最下面 |

凑不出问题的块不放。四格写不出来，说明还没想清楚给谁用，先回去问派任务的人。

## 三、数据集：按决策对象建

1. **给人看的数据集一行一个决策对象。** 平台不做连表，一个查询里也不能按条件计数。所以跨数据集的数（测算结果、报价条数、报告状态）由写入方先合进这一行。原始明细表照样保留，看板读的是这张合好的宽表。
2. **派生列在写入时算好。** 小数位、分段、名次、下一步、状态都算好再写进去。分段要排序就另给一列序号；「下一步」用规则推出来，写成几个固定取值。页面只负责展示，展示规则才能保持一致。
3. **取值有说法。** 状态这类列在列定义的 `values` 里写清每个取值的业务意思，视图里再用 `value_labels` 显示成说法。代号不直接给人看。
4. **来源跟着行走。** 观测时间、来源引用这类列放在行里，在详情、附录里展示，不写进标题。缺值写 `null`，原因另写一列。
5. **主键用业务上本来就唯一的号。** 比如商品编号、单号、日期加设备。整份重算用 `dataset_replace`，幂等键用日期。

## 四、页签：按用途和读者排

1. **人用的页签放前面。** 一般依次是：报告、主要工作页（看板、选品、待办）、进度、层级导航。
2. **给报告取数的页签放最后。** 标题写成「报告取数 · <维度>」，人一看就知道不用点。里面的块按 `=` 精确筛出一行，或按名次筛出前 N 名，专供报告的数据槽绑定。
3. **按读者和用途分页签，不按数据集分。** 一个台最多 20 个页签。每个数据集各占一个页签，页签就会越来越多，人还是不知道该看哪个。

## 五、页面布局

1. **从上到下：筛选、数、图、清单、明细。** 读者先看到要不要动手，再看原因，最后才查明细。
2. **栏宽按块的类型定。** 统计卡和进度条一排四个，各占 3 栏；图两张并排，各占 6 栏；记录卡、表格、任务图占满 12 栏。不写 `span`，平台会自动补齐。
3. **标题写成这个块回答的问题。** 比如「毛利分段：多少候选值得看」。口径、截至日期、来源放进详情或报告附录，不写成「部分证据：源截至……未判」这种审计口吻。
4. **颜色只表示要不要动手。** 等人决定的用 `warning`，出了问题的用 `danger`，已核过的用 `success`，其余用默认的灰色。统计卡上用 `tone_rules` 标出来。
5. **筛选栏放在最上面，各块共用。** 个别块故意不跟某个筛选走时，标题要能看出来。比如「哪些入口的好候选多」不按入口筛，否则只剩一根柱子。

## 六、组件怎么选

| 要回答的问题 | 组件 | 注意 |
|---|---|---|
| 有多少、到没到 | `stat`、`progress` | 查询只聚合、不分组，取第一行 |
| 各类比一比、分布 | `bar` | 类目名长就横着放；分段要排序就另给序号列 |
| 随时间怎么变 | `line` | x 用日期列，按日期排序 |
| 占比 | `pie` | 只适合五类以内 |
| 一条一条读、要做动作的对象 | `records` | 徽标放「下一步」和状态，链接只显示说法 |
| 查找、核对 | `table` | 放最下面；状态列配了说法会自动排到最左 |
| 任务和进度 | `dag`、`gantt`、`flow` | 一行一个任务，依赖写在本行 |
| 人工补录 | `form` | 必填列都要在表单里 |

## 七、对象有层级时：分层看、分层出报告

对象往往有层级，比如产品开发的「场景入口 → 产品子类 → 具体商品」。照下面的做法分层：

1. **每层一张看板宽表，上层由下层汇总。** 比如场景表一行一个入口，候选数、好候选数、最高毛利都从对象表汇总出来，由写入方算好。
2. **每层一个报告维度，报告对象写成 `<层>:<标识>`。** 比如 `entry:<入口>`、`ptype:<子类>`、`item:<编号>`。上层报告回答「值不值得做、先做哪几个下层」，最下层的报告回答「进不进下一阶段」。
3. **层与层互相点名。** 上层报告的「下一步」点名下层的对象；下层报告的封面写明属于哪个上层。
4. **报告索引里带上各层的列。** 「报告」页签按层筛选，人能从上层一路点到对象。
5. **映射没到的层，先备好模板和取数页签。** 页面上如实写「待映射」，映射一到就能出报告，不拿别的分类凑数。

## 八、报告：结论先行

报告是给业务的人读的，按封面结论、关键数、理由与证据、风险与下一步、附录的顺序排，口径和来源放进分页后的附录。具体写法见 [wm-reports](../../wm-reports/SKILL.md)「版式：结论先行」。设计视图时要给报告留好取数页签（第四节第 2 条）。还要记住，报告槽按 `max_rows` 取数，多一行整份报告就拒收，所以「前 N 名」靠写入方先算好名次列，再按名次筛。

## 九、交付前自查

- [ ] 规划卡四格都写了，每个块都对得上一个问题
- [ ] 给人看的数据集一行一个决策对象，派生列在写入时算好，小数已取好位数
- [ ] 取值代号都配了说法，列都有中文说明名
- [ ] 人用的页签在前，取数页签在后并标了「报告取数」
- [ ] 标题写的是问题，不是口径和来源
- [ ] 颜色只用在要动手的地方
- [ ] `view_put` 通过，每个页签取数时每个块都有数
- [ ] 报告槽绑定的块能精确筛出要的行；用一个真实对象实际出过一份报告，并打开看过
- [ ] 把「卡片编号、打开地址、几个页签、各给谁看」告诉派任务的人

## 十、常见的走偏和改法

| 常见情况 | 改成 |
|---|---|
| 每个数据集各做一个页签，页面上叠满表格 | 按规划卡的问题摆块，明细表只留一张，放最下面 |
| 标题写成「部分市场证据：源截至……未判」 | 标题写问题，口径放进详情和附录 |
| 页面上显示 `6.0007662835249045` | 写入时取好位数 |
| 状态直接显示 `GO`、`verified` | 列定义写 `values`，视图配 `value_labels` |
| 想在查询里数「满足条件的有几个」 | 每个条件用一张带筛选的统计卡，或写入时算好 |
| 报告要「前 10 名」，用 `limit` 截 | 写入方先算名次列，块按名次 `<=` 10 筛 |
| 视图里写判断，比如「建议放弃」 | 判断写进报告，视图只放事实和下一步 |

## 十一、照着抄：选品台

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
    { "name": "doc_link", "type": "text", "label": "报告" },
    { "name": "updated_at", "type": "datetime", "label": "更新于", "required": true }
  ] }
```

```json rows:picks
[
  { "asin": "SAMPLE01", "title": "合成样品 · 有机棉床笠", "market_entry": "crib-sheets", "price": 39.95, "monthly_sales": 5977, "margin_pct": 45.0, "entry_rank": 1, "band_rank": 1, "margin_band": "≥20%", "decision": "GO", "next_step": "queue", "doc_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE02", "title": "合成样品 · 速干洗碗巾", "market_entry": "dish-towels", "price": 34.0, "monthly_sales": 7134, "margin_pct": 31.2, "entry_rank": 1, "band_rank": 1, "margin_band": "≥20%", "decision": "GO", "next_step": "decide", "doc_link": "https://example.com/reports/2", "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE03", "title": "合成样品 · 超细纤维抹布", "market_entry": "dish-towels", "price": 12.99, "monthly_sales": 6348, "margin_pct": 14.6, "entry_rank": 2, "band_rank": 2, "margin_band": "10–20%", "decision": "CONDITIONAL", "next_step": "queue", "doc_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE04", "title": "合成样品 · 手持按摩器", "market_entry": "handheld-massager", "price": 29.99, "monthly_sales": 3964, "margin_pct": 6.1, "entry_rank": 1, "band_rank": 3, "margin_band": "0–10%", "decision": "GO", "next_step": "skip", "doc_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE05", "title": "合成样品 · 化妆刷套装", "market_entry": "kabuki-brushes", "price": 9.99, "monthly_sales": 2210, "margin_pct": -4.2, "entry_rank": 1, "band_rank": 4, "margin_band": "亏损", "decision": "UNREVIEWED", "next_step": "skip", "doc_link": null, "updated_at": "2026-01-20T10:00:00Z" },
  { "asin": "SAMPLE06", "title": "合成样品 · 旅行收纳袋", "market_entry": "travel-organizers", "price": null, "monthly_sales": null, "margin_pct": null, "entry_rank": null, "band_rank": 5, "margin_band": "未算", "decision": "UNREVIEWED", "next_step": "skip", "doc_link": null, "updated_at": "2026-01-20T10:00:00Z" }
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
      "links": [ { "col": "doc_link", "label": "打开初评报告" } ],
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
- 统计卡和记录卡展示小数时，按写入时整理好的位数显示，所以写入方要先取好位数（第三节第 2 条）。
