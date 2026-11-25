---
name: wm-capability-access
version: 0.1.0
description: 工作台市场·能力接入——agent 怎么找到、申请、调用市场的能力：tools/list 里只有一部分，完整目录在 access_info；参数表按名字取；没批的用 access_request 申请；MCP 和 REST 两条路同一个令牌；结果太大时只给引用，用 url 取或用 result_read 分段读。当「找不到想要的工具」「调工具被拒」「要申请权限」「想用 REST 或脚本调」「结果里只有 result_ref、没有数据」时使用。
---

# 工作台市场·能力接入（发现 → 详情 → 申请 → 调用）

**一句话**：`tools/list` 只是你现在能直接调的那一小部分；要找别的能力，先调 `access_info` 看目录，再按名字取详情，没批的申请，批了再调。结果太大时应答里只有引用，按引用去取。

工具的名字和个数会变，这里不列清单：**一律以 `access_info` 的目录为准**。

> 下面带标记的代码块（```json mcp:工具名```、```json rest:工具名```）都是真能调的参数，脚本 `scripts/skill-capability-access-examples-test.mjs` 会在隔离实例上逐个跑。`{{…}}` 是要换成上一步拿到的值。

## 一、发现：`tools/list` 和 `access_info` 不一样

| 看什么 | 给什么 | 什么时候看 |
|---|---|---|
| `tools/list` | 你**现在就能调**的工具：本会话被批了的，加上免授权的几个（看目录、提申请、读技能、分段读大结果） | 会话一开始，客户端自己会拉 |
| `access_info` | **完整目录**：所有工具，每项一行说明、类别（read / write / admin）、批没批（`granted`） | 找不到想要的工具、调工具被拒的时候 |

`access_info` 默认只给索引，不带参数表，免得一下子吃掉上下文：

```json mcp:access_info
{}
```

应答里的 `catalog` 每项是 `name`、`description`（一行）、`category`、`granted`；`how_to_detail` 告诉你怎么取详情。

## 二、详情：按名字取参数表

要知道某个工具怎么调，按名字取它的完整说明和参数表 `input_schema`。没批的工具也取得到：

```json mcp:access_info
{ "tool": "skill_search" }
```

应答是 `{ tool: { name, description, category, granted, input_schema, … } }`。

- 名字不在目录里会报错，不会编一个出来。
- 老客户端要整份目录（每项都带参数表）可以带 `full: true`，但很大，平时别用。
- `tool`、`capability`、`full`、`area`、`ref` 一次只能给一个。
- 领域能力在应答的 `capabilities` 中。用 `access_info { capability: "目录里的能力名" }` 取入参、REST 片段和说明技能名。

## 三、申请：没批的用 `access_request`

```json mcp:access_request
{ "tools": ["workbench_summary"], "reason": "统计市场里有多少台在线，给周报用" }
```

- `reason` 必填，写清要做什么（不超过 500 字）。
- 只要一张台：写成 `工具@台号`（`workbench_list` 里的 id；自产台、SOP 台也可以写台的标识）。目录里标了 `scopable` 的工具才支持这样写。
- 数据视图的工具必须限定到台：写成 `工具@bench:台的标识`，一条只申请一个台，由台的管理层批。详见 `wm-data-views`。
- 同一组工具已有待批的申请，会返回那一条，不重复建；每会话每小时最多 10 条。会话不能自己批。

应答里有申请编号 `ref`（通用申请 `mcp-N`，台的申请 `bench-N`）。等批的时候按编号查：

```json mcp:access_info
{ "ref": "{{ref}}" }
```

`status` 是 `pending`、`approved` 或 `rejected`（驳回时 `note` 里有原因）。批了立即生效，`tools/list` 里会多出这些工具。

## 四、调用：MCP 和 REST 是同一套

两条路用**同一个会话令牌**（`Authorization: Bearer <会话令牌>`），认人、授权、留痕都一样，只是应答的形状不同。

- **MCP**：`tools/call`，结果在 `content[0].text` 里，是一段紧凑的 JSON。
- **REST**：`POST /api/mcp-rest/tools/<工具名>`，请求体就是参数，应答就是那段 JSON。完整接口在 `access_info` 应答里的 `openapi_url`，基址是 `rest_base`。能写脚本的 agent 用这条更顺手。

```json rest:workbench_summary
{}
```

领域能力经 `access_request { area, actions, reason }` 申请。获批后仍要符合责任人当前的领域授予。

- **MCP 领域调用**：用通用工具 `invoke { target, args }`。目标和参数从能力详情取。
- **REST 领域调用**：按能力详情的 REST 路径发送 `args`。两条路都按目标能力记审计。决定类成功时只返回待人确认的提案编号和状态。
- 报告治理的按台、按维度绑定参见 `wm-report-governance`。

普通工具的拒绝应答：

| | 没批 | 没这个工具 |
|---|---|---|
| MCP | 和不存在同一句（`Method not found`），不告诉你它存不存在 | 同左 |
| REST | `403`，`hint` 让你去看目录、提申请 | `404` |

## 五、大结果：只给引用，按引用去取

结果太大（现在是超过 64 KB）时，应答里不放数据，只给：

```
{ result_ref: { id, url, sha256, bytes, expires_at }, summary: {...}, how_to_fetch: "..." }
```

`summary` 告诉你大概是什么（键和类型、数组有多长），先看它，常常就够了。真要全文，两种取法：

1. **能执行代码的**：用同一个会话令牌 GET `result_ref.url`，拿到的就是原来那份 JSON；对一下 `sha256`（应答头 `X-Content-Sha256` 也有）。
2. **不能执行代码的**：用免授权的 `result_read` 分段读，一段最多 32768 个字符：

```json mcp:result_read
{ "id": "{{result_id}}" }
```

应答里有 `text`（这一段）、`total_chars`（一共多长）和 `next_offset`。接着读就带上 `offset`；`next_offset` 是 `null` 就读完了：

```json mcp:result_read
{ "id": "{{result_id}}", "offset": 0, "length": 1000 }
```

规矩：

- 引用**只给本会话**：别的会话拿同一个编号，和不存在的同一句。
- 取的时候**按原来那个工具再判一次授权**：授权被收回了就取不到（REST 回 `403`）。
- **15 分钟过期**，过期了重新调原来的工具；每个会话最多留最新的 20 份。
- `offset` 超出末尾不报错，回空的 `text`。
- 文件、台数据、SOP run 这些 REST 资源接口照旧整份返回，不给引用。

## 六、还没有的

按领域批的能力（团队负责人批接入、领域动作、纯聊天客户端用的通用「调用」工具）要等渐进开放第 2～4 步上线才有。到时这里补上；现在按上面的按工具申请走。

## 七、常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `tools/list` 里找不到想要的工具 | 没批 | `access_info` 看目录 → 按名字取详情 → `access_request` |
| MCP 调用回 `Method not found` | 没批，或者名字写错了 | 同上；名字以目录为准 |
| 结果里只有 `result_ref` | 结果太大 | 先看 `summary`；要全文按第五节取 |
| 拿引用取回 404 | 过期了，或者不是本会话的编号 | 重新调原来的工具 |
| 拿引用取回 403 | 原来那个工具的授权被收回了 | 重新申请 |
