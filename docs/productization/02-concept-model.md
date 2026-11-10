# 02 · 概念模型

> 阶段 0 草稿。目的：同一件事在五个部件里叫法不同，先对齐，再谈界面和契约。

## 一、各部件的对象怎么对应

| 统一叫法（本产品） | 市场现在 | A2A（dsh-open-a2a-net） | superagent | ygl-trees | DSH |
|---|---|---|---|---|---|
| **事项**：一件要办的事，从下达到沉淀 | 分散：任务中心任务、`workbench_events`、SOP run 的上下文行 | — | 最接近 Ticket，但只在单机内 | task（跟踪） | — |
| **事件**：事项被投递出去的那一次 | `workbench_events` + `workbench_event_deliveries` | 一条带 `task_id` 的 direct 投递 | Trigger（不可变，按 id 幂等） | — | — |
| **接单判断** | 无 | 入站准入（签名、成员关系、名额） | Eval：accept / stop / ignore / unavailable | — | — |
| **授权** | 绑定（admits / notify / both）、MCP 授权、变更申请 | 协作规范档位 | Mandate（不可变，范围变大就开新工单） | — | 权限预设、审批 |
| **执行** | SOP run | — | Ticket + Assignment | — | 会话、子代理、工作流 |
| **进展** | 无（只有终态） | 无（回执只表达终态） | Report 六态：progress / waiting / ready / blocked / failed / dropped | — | 计划、目标 |
| **提问** | 无 | 无 | Attention（结构化，一次一件） | — | 用户提问（ui-user-questions） |
| **回执** | SOP 完成回执 outbox | `[A2A receipt] task <id>` + JSON 信封；终态，不对回执再回执 | Channel 发送（先存后发、幂等） | — | — |
| **产物** | 台数据、文件、SOP run 数据 | — | 工单产出 | artifact | deliverables |
| **证据** | 无 | — | — | source / evidence / claim / verify run | — |
| **沉淀** | 工作台变量与常量、技能市场 | — | — | kb、skill promote | 技能 |
| **线程** | `context_id` ↔ run 映射 | `context_id`（只管续接） | Thread（同一线程同时只跑一个 Eval，保存决定历史） | — | 会话 |

读法：一行就是一个概念，空格表示这个部件没有对应物。市场的问题是「事项」这一行最散，而「进展」「提问」「证据」三行是空的。

## 二、统一对象：事项（Work Item）

市场新增一张表，把一件事的全部痕迹串起来。界面（驾驶舱时间线、关注队列、统一待办）只读它，不再各自拼。

| 字段组 | 字段 | 说明 |
|---|---|---|
| 身份 | `item_id`、`title`、`created_at`、`created_by` | `created_by` 用主体标识（`user:<名>` / `seat:<名>`，见 [11](11-identity-and-permission.md)） |
| 来源 | `source_kind`（task-center / app-data / agent / cockpit）、`source_ref` | 指向原始提交 |
| 场景 | `context`（JSON：店铺、SKU、PD、日期等） | 来自驾驶舱的场景上下文（见 [03](03-cockpit-v2.md)） |
| 投递 | `event_id`；每次投递的 A2A `task_id`（多次） | 沿用 `workbench_events`，不另建 |
| 承接 | `target_team`、`seat`、`eval`（accept/stop/ignore/unavailable + 理由） | 接单判断来自 superagent 的 report（见 [06](06-a2a-superagent-fusion.md)） |
| 状态 | `state`：draft / held / delivered / accepted / progress / waiting / ready / blocked / done / failed / dropped / cancelled | 见下面的状态机 |
| 进展 | 最近一条 report 的摘要与时间 | 全量在事项日志 |
| 提问 | 未答的 ask 列表 | 进关注队列 |
| 回执 | 终态回执的 outcome 与时间 | 回执是终态 |
| 产出 | 台数据 id、文件 id、SOP run id | |
| 证据 | ygl-trees 的 claim / verify run id | 只存 id，不存正文 |

**事项日志**：每次状态变化、report、ask、answer、回执各记一行（追加式，不改写），驾驶舱时间线直接渲染它。

## 三、事项状态机

| 从 | 事实 | 到 |
|---|---|---|
| draft | 提交，派发开关没全开 | held |
| draft / held | 提交且开关全开，或管理员 release | delivered |
| draft / held | 撤回 | cancelled |
| delivered | 投递 dead（重试耗尽或终止码） | failed |
| delivered | 席位 report：eval=accept | accepted |
| delivered | 席位 report：eval=stop / ignore / unavailable | failed（带理由） |
| accepted / waiting / blocked | 席位 report：progress | progress |
| accepted / progress | 席位 report：waiting | waiting |
| accepted / progress / waiting | 席位 report：blocked，或发来 ask | blocked |
| progress / waiting / blocked | 席位 report：ready（做完，等验收） | ready |
| ready | 人在关注队列里验收 | done |
| ready | 人退回 | progress |
| 任一非终态 | 席位 report：failed，或终态回执 outcome=failed | failed |
| 任一非终态 | 席位 report：dropped（必须同时有回执） | dropped |

- 终态：`done`、`failed`、`dropped`、`cancelled`。每个终态都要有一条回执或一条市场侧的明确记录（例如投递 dead），不允许静默消失。
- `held` 是市场的「先观察」：只记录本来会派给谁，不发出（现有机制）。
- `ready` 是席位说「做完了，等你验收」；`done` 只能由人在关注队列里验收后进入。
- `waiting` 表示席位在等外部条件；`blocked` 表示需要人介入（通常伴随一条 ask）。

## 四、三条约束

1. **事项是索引，不是第二份真相。** 投递细节仍在 `workbench_event_deliveries`，run 数据仍在 `sop_runs`，证据仍在 ygl-trees。事项只存 id 和摘要，原件各回各家。
2. **状态只由事实推进。** 只有投递结果、席位 report、回执、人的操作能改事项状态，不允许手动改状态。
3. **身份只认已验证来源。** 未验证（unbound）的 A2A 消息只当数据，不推进状态（与现行 A2A 规矩一致）。

## 待决

- 表结构细节在阶段 1 实现时定（P2）。
- 状态词表一旦写进 workbench-event v2 就成了跨项目契约（P1），见 [06](06-a2a-superagent-fusion.md)。
