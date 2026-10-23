# omni-inbox 第三源（A2A）接入设计 · v2 预研草稿

> 派单 direct-8e2d9bc3（总工程师）· 依赖 **dsh-open-a2a-net PR#32**（OPEN，fix-required 轮，未合并）。
> 本文只读研究产物：不写实现，字段名以 #32 实际 diff 为准；#32 合并后若有微调，本文随改。

## 一、上游 API 形状（PR#32 实测证据）

- **端点**：`GET /__dsh_a2a/state`（宿主 WebServer exact 路由，`controlRoute` 守护）
- **鉴权**：`X-API-Key: <config.apiKey>`（或 `?api_key=`）；未配 key 时走 Origin 信任（`controlTrustedWithoutKey`），否则 401/403。
  ⚠️ **注意**：不是 `X-Market-Client` 头族——那是市场调 **MCP 上游**的身份头；对 a2a-net `/state` 用的是 `X-API-Key`。
- **本源消费的字段**（响应 JSON 顶层）：
  - `tasks[]`：在途（pending + settleable + stale 计数面）——行含 `taskId/team/peer/direction('inbound'|'outbound')/startedAt/brief?`
  - `tasksRecent[]`：**最近 20 条归档**（newest first，`RECENT_FACE_CAP=20`），行形状：
    `{ taskId, team, peer, direction, startedAt, resolvedAt, endedBy, outcome, late?, brief? }`
    其中 `endedBy ∈ 'receipt'|'echo'|'abandoned'|'cancelled'`，`outcome` 为信封裁定或 `'unclassified'`
  - `tasksDead[]`：死信行（本源**不消费**，v2 只做活待办+近期结算）

## 二、信封映射（A2A task → 七字段冻结信封）

| 信封字段 | 在途 `tasks[]` | 归档 `tasksRecent[]` |
|---|---|---|
| `id` | `a2a:<taskId>` | `a2a:<taskId>` |
| `source` | `'a2a'` | `'a2a'` |
| `title` | `brief ? brief : `${team} · ${peer} ${taskId}` | `${brief ?? taskId}（${endedBy}）` |
| `status` | **`doing`**（在途含 settleable/stale） | **`done`**（已归档） |
| `due` | `null`（A2A 无 due 语义） | `null` |
| `link` | `null`（v2 可选：配置了 peer 根地址则拼宿主 GUI URL） | `null` |
| `project` | `team` | `team` |

- **todo 态缺位说明**：A2A 无「未开始」态（派单即 in-flight），故 A2A 源不产出 `todo`；面板 todo 计数自然只来自 ygl/market 两源——与设计件「三源」不冲突（状态词表不变，来源分布不同）。
- 归档行 cap 20：`sources.a2a.count` 语义 = **在途数**（对账口径与 ygl 非 done 同构：面板「未完」= doing）；归档仅作为 done 流水展示。
- 幂等：同 `taskId` 若同时出现在 tasks 与 tasksRecent（竞态窗口），以 tasks 为准（在途优先）。

## 三、降级语义（J5 同构）

- **不可达/超时**：server 侧 fetch `X-API-Key` 调 `/state`，`AbortSignal.timeout(5_000)`；失败 → `sources.a2a = { ok:false, count:0, latency_ms:<实测> }`，**不阻塞** ygl/market 源聚合（Promise.allSettled 形态）。
- **401/403（key 缺失/Origin 拒）**：同样 `ok:false`；错误摘要进 `error?` 字段（元数据可选扩展，不进信封）。
- **重试策略**：无独立重试——面板 60s 轮询天然重试；缓存 30s 与聚合缓存共用（`generated_at` 不动）。

## 四、sources 元数据扩展

```jsonc
"sources": {
  "ygl-trees": { "ok": true,  "count": 7,   "latency_ms": 559 },
  "market":    { "ok": true,  "count": 0,   "latency_ms": 0 },
  "a2a":       { "ok": true,  "count": 3,   "latency_ms": 120, "error": null }  // count=在途；error 可选
}
```

- 类型：`SourceMeta` 增可选 `error: string | null`（三源同构，ygl/market 亦可带）。
- `/tasks` 页源过滤 Segmented 增「a2a」；驾驶舱 TasksView 无需改（信封驱动）。

## 五、实现挂点（合并 #32 后的最小实现清单，供排期）

1. `server/src/tasks.ts`：`execA2aTasks()`（fetch + timeout + 头），映射进 `collectTasks` 的 `Promise.allSettled`；env `A2A_STATE_URL` / `A2A_API_KEY`（复用 settings 域亦可）。
2. 冒烟 `omni-inbox-smoke` 增 A2A 分支：起替身 /state（回放 #32 形状夹具）断言映射/降级两出口（**显式区分，防空转绿**——遥测单教训规约）。
3. 判据：信封字段/在途优先/降级 ok=false 三条钉进 gen-verifier（待实现时随 PR 提）。

## 六、开放问题（请总工程师/评审席裁）

- `A2A_STATE_URL` 指向哪台宿主（多 peer 取主用还是聚合多台）？
- 归档 done 流水是否需要独立视图页（当前设计混排在 /tasks done 过滤下）？
- `error` 字段是否入冻结契约（一旦入即向后兼容义务）。
