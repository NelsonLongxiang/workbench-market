# 查询描述

不写 SQL，给一份 JSON。组件里的 `query` 和 `dataset_query` 用的是同一种写法。

```json query
{ "dataset": "orders",
  "filter": [ { "col": "day", "op": ">=", "value": "2026-01-01" }, { "col": "region", "op": "in", "values": ["东区", "南区"] } ],
  "group": ["region"],
  "measures": [ { "as": "n", "fn": "count" }, { "as": "total", "fn": "sum", "col": "amount", "label": "金额" } ],
  "sort": [ { "col": "total", "dir": "desc" } ],
  "limit": 50 }
```

## 全部的键

| 键 | 说明 |
|---|---|
| `dataset` | 必填。数据集名 |
| `select` | 明细查询取哪些列；不给就是全部列。有 `group` 或 `measures` 时不能写 |
| `filter` | 筛选条件的数组，各条之间是「并且」。最多 20 条 |
| `group` | 按哪些列分组 |
| `measures` | 聚合：`{ "as": 别名, "fn": 函数, "col": 列, "label": 显示名 }`。最多 12 个 |
| `sort` | `{ "col": 列, "dir": "asc" 或 "desc" }`，最多 8 项。聚合查询只能按输出列（分组列和别名）排 |
| `limit` | 1～5000，不给是 200 |
| `offset` | 跳过多少行 |

没有连表，没有子查询，没有自己写的表达式。要两个数据集的数放在一起，就在写入的时候算好放进一个数据集。

## 筛选的比较符

| `op` | 意思 | 备注 |
|---|---|---|
| `=`、`!=`、`>`、`>=`、`<`、`<=` | 比大小 | 值的写法要和列的类型一致（日期列给 `"2026-01-01"`） |
| `in` | 在这几个值里 | 用 `values` 给数组，1～200 个 |
| `is_null`、`not_null` | 空 / 不空 | 不用给值 |
| `contains` | 文本里包含（区分大小写） | 只用于文本列 |
| `prefix` | 以它开头 | 文本列、日期列、时间列。**按月筛日期就用它**：`{ "col": "day", "op": "prefix", "value": "2026-01" }` |

## 聚合函数

`count`（不给 `col` 是数行数）、`count_distinct`、`sum`、`avg`、`min`、`max`。`sum` 和 `avg` 只用于数字列。

## `$参数`：跟着筛选栏变

值写成 `"$名字"`，就是取这个视图筛选栏里叫这个名字的字段现在的值：

```json query
{ "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "v", "fn": "sum", "col": "amount" } ] }
```

- 那个字段没填（人选了「全部」），这一条筛选就不生效。
- 参数名必须在同一个视图的筛选栏里声明过，否则保存视图时被拒。
- 筛选栏的值都是文本，拿去比数字列、布尔列时会自动转；转不了（比如拿月份去比日期的 `>=`）这个组件会显示出错，别的组件照常。

## 结果

`{ dataset, columns: [{ name, type, label, role }], rows: [{…}], truncated }`。`truncated` 为真表示数据不止这些（到了 `limit`）。一次取回的内容（各格字符数相加）超过 800 万会被拒：少取几列，或者把 `limit` 调小。
