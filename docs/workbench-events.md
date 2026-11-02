# 工作台事件层 v1（人提交 → 团队接单）

契约（跨项目接口）以 dsh-open-a2a-net 的 `docs/protocol/workbench-event.md` 为准，本文只说明市场这一侧的实现和操作。实现在 `server/src/workbench-events.ts`。

## 哪些提交算事件

| 来源 | 判定 | 派发 |
|---|---|---|
| 任务中心人工发布（`POST /api/task-center/tasks`，管理口令把关） | `submitter_kind: human` | 是，带 reply token |
| 自产台表单提交（`POST /api/apps/:slug/data`，匿名面） | `submitter_kind: unverified` | 否，只做数据通知 |

agent、MCP、CLI 发起的提交永远不会是 `human`。等 SSO v2 覆盖到表单提交之后，表单提交才可能升级为 human。

## 发到哪个团队

1. 任务录入里「目标 SOP 台」能按 slug 或标题匹配到一个已发布的 SOP，就发给这个 SOP 上的 `notify` / `both` 绑定，记 `routed: target`。
2. 匹配不到，或这个 SOP 没有通知绑定，就发给 `task-center` 自己的通知绑定，即默认接单团队，记 `routed: default`。
3. 两处都没有，记 `routed: unrouted`。事件照样落库，不会静默丢失。

绑定的 `agent_node` 可以填画布队名，比如 `dsh/canvas/procurement`。对端主机要把市场加为这个画布的远程成员，那一半准入在 a2a 侧。

```bash
curl -X POST http://127.0.0.1:9800/api/bindings -H 'Content-Type: application/json' -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"target_type":"sop","target_slug":"task-center","agent_node":"dsh/canvas/intake","direction":"notify","notify_url":"http://<主机>:13080"}'
```

## 先观察，后自动

任务级开关 `agent_dispatch` 和中心级开关 `center_switch` 都打开时，事件发布即投递。

只要有一个没开，投递就记为 `held`：只记录「本来会派给谁」，不发出去。管理员看过之后可以 release：

```bash
curl -X POST http://127.0.0.1:9800/api/workbench-events/<event_id>/release -H "X-Admin-Token: $ADMIN_TOKEN"
```

## 投递与终态

- 投递走 a2a `/a2a/direct` 异步模式，`task_id = event_id`，`context_id = wb:<来源>:<事项>`，带绑定形式的 OriginClaim。
- 失败按 1m / 5m / 15m / 1h 退避，5 次后记 `dead`。对端返回 -32003（同一 task_id 重放）算作已送达。
- 投递状态只有四种：`held` / `pending` / `sent` / `dead`。reply token 的明文只在待投期间存在；投递成功或 dead 之后清空，只留哈希。

## 决定回写

接单节点凭投递里的 token 回写决定（业务面可达，不需要口令）：

```bash
curl -X POST http://<市场>/api/workbench-events/<event_id>/decision -H 'Content-Type: application/json' \
  -d '{"token":"<reply.token>","decision":"accept","reason":"…","ref":"https://github.com/…/issues/N","by":"dsh/66abc2cf"}'
```

- `ask` 之后还能改；`accept` / `decline` 是终态，之后再写返回 409。
- 错 token 和不存在的事件都返回 404，不泄露事件是否存在。

## 读面

`GET /api/workbench-events` 和 `GET /api/workbench-events/:event_id` 需要管理口令。读面包含目标团队、地址、决定和只增日志，不包含 token。

## 验证

`scripts/workbench-events-smoke.mjs` 覆盖 W1–W9 和终态判据。对端用上游 `verifyOriginClaim`，按关窗后的状态验证。
