# 视图描述和八种组件

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
- 每个组件都可以带 `title`（最多 64 个字符）和 `span`（占几栏，落到 3 / 4 / 6 / 12 这四档上；不给时统计卡和进度占 3，表格和筛选栏占 12，其余占 6）。
- **多写一个不认识的键会被拒**（防止写错了没人知道）。

## 组件一览

| `type` | 画什么 | 自己的键 |
|---|---|---|
| `filter-bar` | 筛选栏 | `fields` |
| `stat` | 一个大数 | `query`、`value`（取哪个输出列）、`unit`、`tone_rules` |
| `progress` | 进度条 | `query`、`value`、`total`（一个输出列，或者写死的正数） |
| `table` | 表格 | `query`、`columns`（显示哪些列、什么次序）、`page_size`（5～200）、`value_labels` |
| `bar` | 柱状图 | `query`、`x`、`y`（一个或几个数值列）、`series`、`stacked`、`horizontal`、`tone_rules` |
| `line` | 折线图 | `query`、`x`、`y`、`series`、`area` |
| `pie` | 饼图 | `query`、`label`、`value`、`donut` |
| `form` | 表单 | `dataset`、`fields`、`submit_label` |

图表的规矩：

- `x`、`y`、`value`、`label` 都必须是查询的输出列；`y` 和 `value` 要是数值。
- 分系列有两种写法，**不能同时用**：给多个 `y`（每个一条线 / 一组柱），或者一个 `y` 加 `series`（按那一列的取值分）。
- 系列最多画 5 个，再多的自动并成「其他」。
- 统计卡、进度取的是查询结果的**第一行**，所以它们的查询一般是只有聚合、没有分组的。

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
