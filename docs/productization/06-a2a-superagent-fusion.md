# 06 · A2A × superagent 融合契约 v2（草案）

> 阶段 0 草案。**本文是提给 dsh-open-a2a-net 项目的需求与契约草案，不是已生效的协议。** 协议正文以 dsh-open-a2a-net 仓 `docs/protocol/workbench-event.md` 为准；v2 若被采纳，由该项目修订正文、评审、实现接收侧，本仓实现发送侧和回写端点。

## 一、现状

### 已有（workbench-event v1）

- 市场把任务中心的人工发布做成事件，经 `/a2a/direct` 异步投递给绑定的团队；每次尝试一个 `task_id`，退避 1m/5m/15m/1h，5 次后 `dead`。
- 投递状态：`held`（先观察）、`pending`、`sent`、`dead`、`cancelled`、`unrouted`。
- **回写通道**：接单节点凭投递里每个目标一枚的 `reply.token`，调 `POST /api/workbench-events/<event_id>/decision`，写 `accept` / `decline` / `ask`；`ask` 不是终态；token 自送达起 7 天有效。
- 来源校验：接收方只认 OriginClaim 绑定形式、根路径名片、且 origin 与团队配置的市场 origin 完全一致的事件。

### 缺口

| # | 缺口 | 后果 |
|---|---|---|
| G1 | 决定之后就没有下文：只有 accept / decline / ask，没有进展 | 业务同事看不到谁在干、卡在哪 |
| G2 | `ask` 只有一个状态值，没有结构化问题，也没有回答的通道 | agent 没法问人，人没法答 |
| G3 | superagent 的 Eval（accept / stop / ignore / unavailable）和 Report 六态在市场不可见 | 事项状态只能停在 `sent` |
| G4 | token 7 天过期 | 长任务的后续回写会 410 |
| G5 | 市场的 held 与 superagent 的 observe 都叫「先观察」，语义不同，没有分工 | 上线新路由、新席位时不知道该开哪个 |
| G6 | 市场里没有席位目录，绑定要手敲 `agent_node` | 接入慢、易错 |

## 一之二、对照实际之后的修正（2026-11-11）

把下面的提案和接单方今天真实发出的东西逐项对过（读的是上游公开版的代码，并在本机用隔离节点实测）。结论是：**市场先认对方真发的，不等对方采纳本文的提案。** 第二节的提案保留为给上游的建议，其中的进展回写降为可选。

对照出来的事实：

- 接单方不调任何 HTTP 回写。它回给请求方的只有 A2A 回执：每个任务最多一条正式回执，分三种——已受理、需要关注、结果。结果带一个结局：完成、失败、拒绝、放弃。
- 进展不外发。所以接通之后，市场里一件事项能看到的是：已接手 →（有问题时）在问你 → 等验收或没办成；中间做到哪了，市场拿不到。要看到进展，需要上游把进展发出来。
- 一旦发了「需要关注」，这个任务唯一的正式回执就用掉了，之后的结局市场机读不到。
- 回执今天全被市场挡在入口：入口先做准入，回执的收件方没有登记。另外上游从 0.8 起只往名片上声明了成员出处能力的宿主转发。

市场这一侧据此的做法（落地在阶段七，状态机的改动在 [02](02-concept-model.md) 的迁移表里）：

| 收到 | 市场怎么认 |
|---|---|
| 已受理的回执 | 接单 |
| 需要关注的回执 | 一条提问，进「关注」 |
| 结果：完成 | 等验收。没先收到「已受理」就直接来结果的，视同接单后完成 |
| 结果：失败、拒绝 | 没办成，拒绝的带上理由 |
| 结果：放弃 | 放弃（回执本身就是这个终态要的那条回执） |
| 词表之外的结局 | 只记「收到，未采信」，状态不动 |

- **人的答复作为同一件事下的一个新任务发回去**，后续靠这个新任务的回执推进。一件事项下因此会有一串任务号，都归到同一件事项。这样不需要对方改。
- **回执认谁**：签名验过，且签名方就是当初投递到的那个节点（投递时记下对端）。不拿收件的会话句柄比。有带正文绑定的新签名就必须验它，不降级。
- **准入之前的分流收得很窄**：正文能解析成回执、任务号是市场发出的、签名验过，三条同时成立才走回执这条路，其余请求和今天完全一样。
- **名片声明成员出处能力**，前提是把这项能力要求宿主做到的事逐条做全。
- 和第二节不一致的两处，以已实现的为准：对方说「暂不可用」只记录、不改状态；对方报失败直接进没办成，报放弃的必须有回执。

部署上还要配一项：接单方所在的节点要把市场加成团队的远端成员，两边互相登记为对端。

## 二、v2 提案

### 1. 进展回写：`report`（解决 G1、G3）

在 v1 的回写通道旁加一个端点，同一枚 token 鉴权：

```
POST /api/workbench-events/<event_id>/report
{
  "token": "…",
  "state": "progress | waiting | blocked | ready | failed | dropped",
  "summary": "≤500 字，必填",
  "eval": { "verdict": "accept | stop | ignore | unavailable", "reason": "…" },   // 可选；仅首次 report 或判断变化时带
  "outputs": [ { "kind": "app-data | file | sop-run | url", "ref": "…" } ],       // 可选
  "evidence": [ { "kind": "ygl-claim | ygl-verify-run", "ref": "…" } ],          // 可选，只放 id
  "seq": 3,                                                                       // 同一投递内单调递增，市场按 seq 去重和排序
  "by": "可选，节点名"
}
```

- **走 HTTP 回写，不走 A2A 消息。** 所以不占对方名额，也不触碰「A2A 上不回『收到』」的规矩。
- `eval` 与 v1 `decision` 的关系：`accept` ⇔ `decision=accept`；`stop` / `ignore` ⇔ `decision=decline`（理由写 reason）；`unavailable` 不写 decision，事项保持 `delivered`，市场提示「席位暂不可用」。
- `failed` / `dropped` 是席位侧的终态宣告，**仍须有 A2A 终态回执**；市场以回执为准对账，report 只用于显示。
- `seq` 回退或重复的 report 丢弃（幂等）。

### 2. 结构化提问与回答：`ask` v2（解决 G2）

v1 `decision=ask` 保留兼容。v2 在 `report` 里用 `state=blocked` 加 `question` 字段：

```
"question": {
  "qid": "q-<8 hex>",
  "text": "需要谁决定什么，≤500 字",
  "options": ["A …", "B …"],         // 可选；没有就是自由回答
  "default": "A …",                  // 可选；超时后席位按此继续时必填
  "deadline": "<ISO>"                // 可选
}
```

人在市场关注队列里回答后，市场把回答作为**同一事项的后续事件**发回原团队，复用 v1 预留的「同一事项后续事件复用 `context_id`」：

```json
{ "type": "workbench-event", "v": 2, "event_id": "wbe-…", "source": "task-center",
  "kind": "answer", "item": "task:<id>", "context_id": "wb:task-center:<id>",
  "answer": { "qid": "q-…", "text": "…", "by": "user:<名>" },
  "reply": { "url": "…/api/workbench-events/<新 event_id>/report", "token": "…" } }
```

- 回答事件走现有投递、重试、来源签名，接收方按 `qid` 去重。
- superagent 侧：回答事件是同一 Thread 上的新 Trigger（它的模型里「同一线程同时只跑一个 Eval」，正好串行）。

### 3. token 有效期（解决 G4）

- 有效期改为「到该投递的事项进入终态后 7 天」，不再从送达起算。
- 每次成功的 `report` 不延长 token 本身，只以事项是否终态判定。

### 4. held 与 observe 的分工（解决 G5）

| 开关 | 在哪 | 语义 | 什么时候开 |
|---|---|---|---|
| held（市场） | 发送侧 | 只记录「本来会派给谁」，不发出 | 新路由、新来源、来源可信度未确认 |
| observe（superagent） | 接收侧 | 收下、记录「本会接单」，但不自动接单 | 新席位上线、新规则上线 |

界面上两者分开显示：事项卡上「市场未发出（held）」与「席位观察中（observe）」是两种状态，后者来自 `report.eval.verdict` 之外的一个 `mode: observe` 标记（report 可选字段）。

### 5. 席位目录与连接向导（解决 G6，本仓实现，不改协议）

- 目录：市场读 A2A 宿主的 `/__dsh_a2a/state`（已有 `A2A_STATE_URL` + `A2A_API_KEY`）与各节点名片，列出团队、成员、在线、名额占用。
- 向导：
  1. 选团队；
  2. 选方向（admits / notify / both）；
  3. 市场生成对方那一半的准确配置（canvas 远端成员条目、团队的 market origin），供对方运维照做；
  4. 发一次签名探测事件（`kind: "probe"`，接收方回 `report state=ready` 即通）；
  5. 结果亮绿或亮红，失败原因翻成中文（见 [07](07-a2a-adapter-refactor.md) 的错误码表）。

## 三、superagent 侧需要的规则覆盖

superagent 是研究原型，默认行为和本契约有两处冲突，需要在它的规则里覆盖（由 superagent 那边落实）：

1. **关掉默认的接单确认消息**。接单只用 `report`（HTTP 回写）表达，不往 A2A 发「已接单」。
2. **`dropped` 必须发 A2A 终态回执**，不允许静默结束。

另外，它的 A2A Source 正在 observe 影子期（2026-11-07 ～ 11-14），影子期结论出来后再定 auto 的开启时机。

## 四、兼容

- v2 发送方对 v1 接收方：不发 `kind: "answer"` 事件（v1 接收方不认识）；`report` 端点对 v1 接收方无影响（它不调用）。
- 版本协商：接收方在第一次 `report` 里带 `v: 2`，市场据此对该团队启用回答事件；没收到过 v2 report 的团队一律按 v1 对待。

## 待决

- **P1**：v2 提案由 dsh-open-a2a-net 项目接（修订协议正文、评审、接收侧实现），本仓只提需求与草案。
- **P1**：superagent 两条规则覆盖。
- **P1**：token 有效期语义变化（安全面：token 存活更久）。
- P2：席位目录与连接向导（本仓实现，阶段 1）。
