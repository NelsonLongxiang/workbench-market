---
name: wm-data-views
version: 0.1.0
description: 工作台市场·数据视图——不写 HTML 做一个工作台：把数据放进台自己的数据集，写一份视图描述，页面由市场的组件（统计卡、表格、柱线饼、进度、筛选栏、表单）画出来。当需要「建一个看数据的台」「更新台里的数据」「给台加一张图或一张表」「改台的页面」「台里的数据写不进去、图不出来」时使用。
---

# 工作台市场·数据视图（建台、更新数据、改页面）

**一句话**：视图台 = 数据集（你写进去的行）+ 视图描述（一份 JSON，说页面上放哪些组件、各自读什么）。页面是市场画的，你不写 HTML、不写 SQL。

> **现在的进度（2026-11）**：数据集、查询、视图描述、组件都已经做好并验收。**页面和 REST 的入口做好了，缺省关着**（部署方设 `WM_BENCH_VIEWS=on` 才开；现在只对有管理层授予的登录账号开放读写、普通员工只读，范围都要是「全部」），地址见 `references/rest.md`。**MCP 的工具入口还没开**（接着做）：开了以后工具名和要给的东西就是下面写的这些；开之前 `access_info` 的目录里没有它们，也无从申请。**入口开之前想先做起来，见最后一节「入口开之前怎么先验」。**

## 什么时候用它、什么时候不用

| 要做的事 | 用什么 |
|---|---|
| 看数、对数、报表、看板、明细表、简单提报 | **数据视图（本技能）** |
| 页面上有复杂的交互、自己的流程、要调别的系统 | 自产台（HTML），见 `wm-quickstart` |
| 只是把一个已有的外部系统挂进市场 | 登记外部工作台，见 `wm-quickstart` |

## 三步做一个台

**① 建数据集**（`dataset_define`）：起名、列出列和类型、定主键。

```json dataset
{ "name": "orders", "title": "订单", "key": ["id"],
  "columns": [
    { "name": "id", "type": "integer", "label": "单号" },
    { "name": "day", "type": "date", "label": "日期" },
    { "name": "region", "type": "text", "label": "区" },
    { "name": "status", "type": "text", "label": "状态" },
    { "name": "amount", "type": "decimal", "label": "金额" }
  ] }
```

列上再写 `"required": true` 就是必填（主键列自动必填，不用写）。

**② 写数据**：四种写法，按数据的性质选一种（见下表）。下面这批用整份替换写进去。

```json rows:orders
[ { "id": 1, "day": "2026-01-05", "region": "东区", "status": "done", "amount": 1200.5 },
  { "id": 2, "day": "2026-01-20", "region": "南区", "status": "late", "amount": 860 },
  { "id": 3, "day": "2026-02-02", "region": "东区", "status": "done", "amount": 15 } ]
```

**③ 写视图描述**（`view_put`）：页面上放什么。

```json view-doc
{ "title": "订单台", "views": [ { "key": "overview", "title": "总览", "blocks": [
  { "type": "filter-bar", "fields": [ { "name": "month", "kind": "month", "label": "月份" },
                                      { "name": "region", "kind": "select", "label": "区", "options": { "dataset": "orders", "col": "region" } } ] },
  { "type": "stat", "title": "金额", "unit": "元",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "measures": [ { "as": "v", "fn": "sum", "col": "amount" } ] },
    "value": "v" },
  { "type": "bar", "title": "各区金额",
    "query": { "dataset": "orders", "filter": [ { "col": "day", "op": "prefix", "value": "$month" } ], "group": ["region"], "measures": [ { "as": "amount", "fn": "sum", "col": "amount", "label": "金额" } ] },
    "x": "region", "y": "amount",
    "tone_rules": [ { "col": "amount", "op": "<", "value": 100, "tone": "danger" } ] },
  { "type": "table", "title": "明细",
    "query": { "dataset": "orders", "filter": [ { "col": "region", "op": "=", "value": "$region" } ], "sort": [ { "col": "day", "dir": "desc" } ], "limit": 200 },
    "columns": ["status", "id", "day", "region", "amount"],
    "value_labels": { "status": { "done": { "text": "已完成", "tone": "success" }, "late": { "text": "已超期", "tone": "danger" } } } }
] } ] }
```

保存时带两样：`base`（你是基于第几版改的；第一次给 0）和一句说明。保存成功就生效，页面立刻是新的。

## 更新数据：四种写法怎么选

| 工具 | 什么时候用 | 要点 |
|---|---|---|
| `dataset_replace` | 每次都算好一整份（日报、快照式的数） | 给**全部**行，原子切换；替换前的那一份自动留作上一代，能退回 |
| `dataset_upsert` | 增量：有的改、没有的加 | 每行给主键列和必填列，其余给了哪列改哪列；数据集必须有主键 |
| `dataset_append` | 流水：只加不改 | 主键和已有的行撞了，整批拒收 |
| `dataset_delete_rows` | 按主键删 | 只给主键；一行也没对上就什么都不做 |

每种要给的东西（`bench` 是台的标识）：

| 工具 | 要给的 |
|---|---|
| `dataset_replace`、`dataset_upsert`、`dataset_append` | `bench`、`dataset`（数据集名）、`rows`（行的数组，写法同上面第 ② 步）、`idempotency_key`、`note`（一句说明，可不给） |
| `dataset_delete_rows` | `bench`、`dataset`、`keys`（只含主键列的对象的数组）、`idempotency_key` |

```json upsert:orders
[ { "id": 2, "day": "2026-01-20", "status": "done" },
  { "id": 4, "day": "2026-02-10", "region": "西区", "status": "late", "amount": 99 } ]
```

```json append:orders
[ { "id": 5, "day": "2026-02-11", "region": "北区", "status": "done", "amount": 640 } ]
```

```json delete:orders
[ { "id": 5 } ]
```

上面三段依次是：把 2 号单的状态改成 done（别的列不动）并新加 4 号单；追加 5 号单；再把 5 号单删掉。

所有写入的共同规矩：

- **整批成、整批败**。有一行不合格，一行都不会写进去，报错里逐条写明第几行哪一列为什么不行。照着改了重发。
- **带幂等键**（8～128 个可见 ASCII 字符，一次写入一个）。网络断了、超时了，带同一个键重发：写过了就返回原来的结果，不会写两遍。
- 大的写入（几 MB 以上）不要塞进 MCP 的消息体：走 REST，把 `rows` 的 JSON 文本原样当请求体发。地址和写法见 `references/rest.md`。

## 改页面

1. `view_get` 读现在生效的那一版，记下版本号。
2. 改 JSON。
3. `view_put`，`base` 填刚才的版本号。这期间别人改过了会被拒（冲突），重新 `view_get` 再改，不会互相覆盖。
4. 改坏了：`view_rollback` 让旧版本重新生效（只移指针，不丢任何版本）。

保存时会核对：组件类型认得、键不多不少、引用的数据集和列存在、查询合法、`$参数` 在同一个视图的筛选栏里声明过。不合格不产生新版本，逐条说明哪里不对。

## 让一份视图出现在驾驶舱里

驾驶舱不抄你的数据和页面，只存一个引用：**哪个台、哪一份视图**（视图的 `key`）。查询、排布、状态的说法、按值着色都还在台自己的视图描述里，你改了视图，驾驶舱里跟着变（驾驶舱跟的是当前生效的那一版，不钉版本）。

要让它在驾驶舱里好用，写视图时注意三点：

- **一份视图只讲一件事**。驾驶舱的一个面板放一份视图，太长的视图拆成几份（几个 `key`）。
- **筛选项起通用的名字**。驾驶舱顶上那一排选中的值，会按名字传给面板里的每一份视图：你的筛选栏里有同名的字段就生效，没有就忽略。所以月份就叫 `month`，不要每个台各起一个名字。视图认哪些筛选项，取数的结果里会列出来（`filters`）。
- **看的人没有这个台的权限时，面板显示「你看不到这个台的数据」**，不会整页出错，也不会漏数据。谁能看由台的权限定，不由驾驶舱定。

## 出错了怎么办

| 回的是什么 | 意思 | 怎么办 |
|---|---|---|
| 不合格（invalid） | 写法不对：行、列、查询、视图描述 | 看细目，照着改 |
| 没有这个东西（not_found） | 数据集、视图、版本、快照不存在 | 先 `dataset_list` / `view_versions` 看有什么 |
| 冲突（conflict） | 主键重复；幂等键用在了别的内容上；视图被别人改过 | 主键和幂等键检查自己的数据；视图重新读了再改 |
| 超限（limit） | 行数、大小、一次取回的内容超了 | 见 `references/limits.md`，缩小或分批 |
| 超时（timeout） | 读超过 3 秒、写超过 15 秒 | 写着「没有生效」的是确定没写进去，缩小范围重来；写着「不确定」的带**同一个幂等键**重发 |
| 正忙（busy） | 排队的读写太多 | 等一会儿重试 |
| 内部错误（internal） | 服务这边的问题 | 重试一次；还不行就报给负责市场的人，别反复重发 |

## 入口开之前怎么先验

工具还调不了的时候，数据集定义、行、查询、视图描述可以先写好、先验对——用的是和线上同一份实现：

1. 在仓库里新建一份 `.md` 放到 `skills/wm-data-views/` 下面（比如 `references/my-bench.md`，**验完删掉，不要提交**），把你的 JSON 写成带标记的代码块。标记写在三个反引号后面：

| 标记 | 里面放什么 | 脚本拿它做什么 |
|---|---|---|
| `json dataset` | 数据集定义 | `dataset_define`（同名的再出现一次就是改列） |
| `json rows:<数据集名>` | 行的数组 | `dataset_replace`（整份替换） |
| `json upsert:<数据集名>` | 行的数组 | `dataset_upsert` |
| `json append:<数据集名>` | 行的数组 | `dataset_append` |
| `json delete:<数据集名>` | 主键的数组 | `dataset_delete_rows` |
| `json query` | 查询描述 | `dataset_query`（筛选栏的参数里只给了 `month`，值是 `2026-01`） |
| `json view-doc` | 视图描述 | `view_put`，再把每个视图取一次数，有组件出错就算不过 |

2. 跑 `node scripts/skill-data-views-examples-test.mjs`。它按文件里出现的先后逐块执行（先 SKILL.md，再 references 下按文件名排），哪一块不行会点名并给出和线上一样的报错。
3. 都过了，等入口开了把同样的 JSON 交给对应的工具。

脚本验不了的：快照的手工留和退回、视图的回退（这几样没有对应的代码块）。

## 细节在这几份参考里

- `references/rest.md`：REST 入口的地址（每个工具对应哪条）、谁进得来、大写入怎么发
- `references/datasets.md`：列的类型和值怎么写、改列的规矩、快照与退回
- `references/query.md`：查询描述的全部写法（筛选、分组、聚合、排序、`$参数`）
- `references/views.md`：八种组件各自的键、筛选栏、表单、取值的说法、按值着色、宽度
- `references/limits.md`：全部上限和时限
- `references/recipes.md`：几个常见的台照着抄
