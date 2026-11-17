# 07 · A2A 适配层重构方案

> 阶段 0 草稿。目标：**市场不实现协议，只消费协议**；外部行为不变。行号以 2026-11-10 的 main 为准。

## 一、现状盘点

### 代码分布

| 关注点 | 位置 | 说明 |
|---|---|---|
| 名片、签名、回执格式、出站客户端 | `server/src/a2a.ts`（338 行） | 名片签名、回执格式、传输上限、`A2aClient` 已从 `@nelsonlongxiang/dsh-open-a2a-net` 引用 |
| 入站准入与消息处理 | `server/src/a2a.ts` `a2aDirectHandle`（约 162–275 行） | 团队解析 → caller 准入 → 幂等 → 解析市场私有方言 `{"sop":{"action":…}}` → run ↔ `context_id` |
| 入站路由与业务桥 | `server/src/index.ts` 3746–3819 | 签名校验 + 60 行 `runOps` 桥接对象（开 run、写备注、查状态、上下文登记、回执地址） |
| 入站签名校验 | `server/src/a2a-direct-sig.ts`（218 行） | OriginClaim Sig2 / body 摘要 |
| 名片发布 | `server/src/index.ts` 3379 | `/.well-known/agent-card.json` |
| 出站 ①：事件投递（有重试） | `server/src/workbench-events.ts`（353 行），worker 在 275 行 | 自己的 `setInterval` + 退避常量 `BACKOFF_MS` |
| 出站 ②：SOP 完成回执（有重试） | `server/src/index.ts` 1946–2026 | 另一个 `setInterval` + 另一份同值的 `OUTBOX_BACKOFF_MS`；表 `a2a_outbox` |
| 出站 ③：豁免面变更通知（无重试） | `server/src/index.ts` 约 286–297 | 启动后 `setTimeout` 尽力而为，失败只打日志 |
| 出站 ④：管理员手动发送 | `server/src/index.ts` 5160 `/api/a2a/send` | |
| 状态读取 | `server/src/tasks.ts` 238–260；`/api/a2a/state` 5151 | 统一待办的 A2A 来源；读 `/__dsh_a2a/state` |
| 绑定 CRUD | `server/src/index.ts` 3672–3741 | 统一绑定表 + 旧端点 410 过渡件 |
| 测试 | `scripts/a2a-smoke.mjs`、`scripts/a2a-direct-signature-smoke.mjs`、`scripts/a2a-bound-redirect-test.mjs` | 冒烟脚本；没有与上游测试向量对照的一致性测试 |

### 问题

| # | 问题 | 影响 |
|---|---|---|
| R1 | A2A 代码散在 5 个文件，入站路由和 60 行桥接写在 5278 行的 `index.ts` 里 | 改一处要读全文件；评审面大 |
| R2 | 四条出站路径，两套重试 worker、两份退避常量，一条无重试 | 行为不一致；同一修复要改两处 |
| R3 | 幂等窗口存在进程内存的 `Map` 里（30 分钟） | 进程重启后重放保护丢失；多进程不可用 |
| R4 | 幂等语义、准入顺序、-3200x 错误码、OriginClaim 域标签、名片有效期由市场自己维护一份 | 上游变化时悄悄偏离 |
| R5 | 钉 a2a-net 0.6.25，网络上已到 0.6.31，next/0.8 在推进 | 版本漂移；新能力用不上 |
| R6 | 入站消息方言 `{"sop":{"action":"start|note|status"}}` 是市场私有的，没写进协议 | 对端只能读本仓代码才知道怎么调 |
| R7 | A2A 相关环境变量 9 个（`MARKET_TEAM`、`MARKET_PUBLIC_URL`、`A2A_API_KEY`、`A2A_STATE_URL`、`WM_A2A_DIRECT_SIG`、`WM_A2A_DIRECT_SIG_BODY`、`A2A_ORIGIN_CLAIM_UNBOUND`、`A2A_EVICT_COOLDOWN_MS`、`A2A_OUTBOX_BACKOFF_SCALE`） | 组合多、难测、难部署 |
| R8 | 准入失败一律 404（不泄露存在性），但市场自己也看不到原因 | 排障只能翻服务器日志 |

## 二、目标形态

```
server/src/a2a/
  index.ts        对外只导出：registerA2aRoutes(app, deps)、startA2a(deps)、a2aHealth()
  config.ts       一个配置块（取代 9 个环境变量，见下）
  identity.ts     密钥、名片（全部调用上游包）
  inbound.ts      /a2a/direct：验签 → 准入 → 幂等 → 交给业务回调（不认识业务）
  dialect.ts      市场入站方言的解析与校验（schema 化，写进协议文档）
  outbox.ts       唯一出站队列：事件投递、完成回执、通知、手动发送都进这里
  idempotency.ts  幂等登记（SQLite，取代内存 Map）
  state.ts        读对端 /__dsh_a2a/state 与名片（统一待办、席位目录共用）
  errors.ts       错误码 → 中文原因 + 处理办法
  health.ts       名片新鲜度、签名模式、outbox 积压、dead 数、回执延迟、拒收计数
```

- 业务（开 run、写备注、事件、事项）通过 `deps` 回调注入，`a2a/` 不 import 业务服务。
- `index.ts` 里只剩一行 `registerA2aRoutes(app, deps)` 和一行 `startA2a(deps)`。

### 唯一 outbox

一张表、一个 worker：

| 字段 | 说明 |
|---|---|
| `kind` | `event-delivery` / `run-receipt` / `notify` / `manual` |
| `ref` | 业务引用（delivery id / run id / …），`(kind, ref)` 唯一 |
| `target_url`、`team`、`task_id`、`context_id`、`payload` | |
| `status` | `pending` / `sent` / `dead` / `cancelled` |
| `attempts`、`next_at`、`last_error` | |

- 退避常量只有一份；`notify` 也获得重试（修 R2）。
- 现有 `a2a_outbox` 与 `workbench_event_deliveries` 的数据迁入：先双写一个版本，校对计数一致后切读，再停旧写；旧表保留一版作回滚锚（沿用本仓「旧表保留一版」的惯例）。

### 配置收敛

| 新配置 | 取代 |
|---|---|
| `A2A_PROFILE=compat\|strict` | `WM_A2A_DIRECT_SIG`、`WM_A2A_DIRECT_SIG_BODY`、`A2A_ORIGIN_CLAIM_UNBOUND`（`strict` = 签名必验 + 校验 body 摘要 + 停发未绑定签名；`WM_LOGIN_GATE=enforce` 时强制 `strict`） |
| `A2A_SELF`（JSON：`team`、`public_url`） | `MARKET_TEAM`、`MARKET_PUBLIC_URL` |
| `A2A_STATE`（JSON：`url`、`key_file`） | `A2A_STATE_URL`、`A2A_API_KEY`（密钥改从文件读） |
| 测试专用的 `A2A_EVICT_COOLDOWN_MS`、`A2A_OUTBOX_BACKOFF_SCALE` | 保留，但只在 `NODE_ENV=development/test` 生效 |

旧变量保留一个版本：读到就映射到新配置并在启动时告警；新旧同时设且冲突时拒绝启动（沿用本仓「非法配置拒绝启动」的惯例）。启动安全自检表随之更新（README「启动安全自检」要求新增安全行为必须加自检行）。

## 三、和上游的关系

1. **能引用的全部引用**：幂等语义、错误码常量、OriginClaim 头构造与校验、名片有效期。上游没导出的，向 dsh-open-a2a-net 提需求导出，不在本仓复制。
2. **外部节点工具包（提议）**：入站处理 + outbox + 幂等 + 状态读取，本来就是任何「非 DSH 宿主的 A2A 节点」都要的。建议 a2a-net 把 `examples/external-node` 升格为正式包，市场只提供业务回调。系统定义里「对外节点接入要升格为正式契约」与此一致。是否采纳由 a2a-net 项目定（P1）。
3. **钉版本**：随系统清单走；升级 a2a-net 版本是一次生产部署（照旧由协同开发发部署单）。
4. **一致性测试**：市场 CI 跑上游的测试向量（名片签名、回执解析、OriginClaim、幂等），上游一升级哪里不兼容当场就红。上游没有发布测试向量的，作为需求提给 a2a-net。

## 四、步骤（阶段 1，每步一个 PR，外部行为不变）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 建 `server/src/a2a/`，把 `a2a.ts`、`a2a-direct-sig.ts` 平移进去；`index.ts` 的入站路由和 `runOps` 改为 `registerA2aRoutes(app, deps)` | 现有三个 a2a 冒烟脚本全过；对外路由逐字节同响应（录制回放） |
| 2 | 幂等登记改 SQLite | 新增：重启后同一 `task_id` 仍判 replay / conflict |
| 3 | 唯一 outbox：双写 → 校对 → 切读 → 停旧写 | 计数对账脚本；退避时序测试 |
| 4 | 配置收敛 + 启动自检行 | 新旧变量映射测试；冲突拒启动测试 |
| 5 | `errors.ts` + `health.ts`，`/api/health` 加 `a2a` 块 | 每个错误码有中文原因；health 字段测试 |
| 6 | 升级 a2a-net 钉版 + 一致性测试进 CI | 上游测试向量全过 |
| 7 | 市场方言 schema 化，草案提给 a2a-net 写进协议 | schema 校验正反例 |

## 五、风险

- **行为回归**：靠「录制现网交互 → 回放比对」兜底；每步可单独回滚。
- **双写期数据不一致**：对账脚本每日跑，切读前必须零差异。
- **上游节奏**：外部节点工具包若不被采纳，市场保留自己的 `a2a/` 模块，但仍按「能引用全引用」收敛。

## 待决

- **P1**：外部节点工具包与测试向量是否由 a2a-net 项目提供。
- **P1**：配置收敛改变部署接口（环境变量），落地前确认，并同步部署文档。
- P2：步骤顺序与 PR 切分（阶段 1 开工时定）。
