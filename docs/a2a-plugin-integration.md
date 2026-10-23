# 市场作为 DSH 插件 × A2A 插件：接触面调查（2026-10-23）

> 触发：主人要求「作为 Cordis 架构 DSH 的插件，跟 a2a 插件的联系问题务必调查清楚」。
> 取证：本机 `dsh-open-a2a-net` 检出（0.6.25）+ `deepseek-harness` 检出（只读）。

## 一、结论先说

**市场插件可以与 a2a 插件同宿主共存，但三件事必须先解决；其中第 2 件不解决，市场就发不了卡。**

| # | 冲突 | 严重度 | 解法 |
|---|---|---|---|
| 1 | `/api` 前缀被 DSH Connection 独占 | 阻断级（路由注册直接抛错） | 市场插件全部 REST 迁到自有命名空间（`/wm/api/*`），前端/MCP/E2E 同步 |
| 2 | `/.well-known/agent-card.json` 被 a2a 插件独占，且**其 `sessionTeams` 只认会话节点** | **架构级**：市场的 SOP 节点无法上卡 | 见 §3 三条路径 |
| 3 | `agents` 服务归属 | 中：市场原桥接 agent 不再需要 | a2a 直接 steer 到真实 DSH 会话，会话调市场工具 |

## 二、取证

### 2.1 a2a 插件在宿主里注册什么

`dsh-open-a2a-net@0.6.25` `apply(ctx, config)`：

```js
export const inject = ['tools', 'timer', 'systemPrompt'];   // 还要 webServer / agents（经 ctx.get）
```

HTTP 面（全部 `webServer.register`，与市场插件共享同一 WebServer 实例）：

```
/.well-known/agent-card.json   ← exact，独占
/a2a/direct                    ← exact，独占
/a2a/log  /a2a/query           ← exact
/__dsh_a2a/*（state/join/leave/dispatch/canvas/groups/session-log/tasks/*）
```

### 2.2 DSH 自身占用

```ts
// packages/client/connection/src/api-path.ts
/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'
```

Connection 层把这一个 **prefix** 注册在 WebServer 上；`webServer.register` 对重复 `(kind, path)` **抛错**（官方契约：路由模式是组合级契约，冲突即配置错误）。

### 2.3 卡片里能出现什么（决定性）

`lib/index.js:2012`：

```js
const sessionTeams = [
  ...[...sessionNodes.values()].filter(isJoinedNode).map(agent => exposureRow(sessionTeamOf(agent), ...)),
  ...joinedSessions.list().filter(id => !liveRoots.has(id) && isArchived?.(id) !== true)
     .map(id => exposureRow(`${config.team}/${id8(id)}`, { name: `${session}-${id8(id)}`, ... })),
]
```

**`sessionTeams` 只来自宿主的真实会话节点（live 或冷会话行），没有“外部/非会话节点”登记接口**（全仓 grep `externalNode|foreignNode|registerNode|proxyNode|virtualNode` 无命中）。

也就是说：市场的 **SOP 台不是会话**，在宿主里没有位置可以出现在卡片上。

## 三、市场 SOP 上卡的三种可能

| 路径 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A. 网络面独立（推荐）** | 市场作为 DSH 插件只提供业务（工具/服务/UI，端口复用宿主、路径 `/wm/*`）；**A2A 节点仍由市场自己的实例承担**（现在的单进程 9800 + 官方子路径） | 多一个监听端口/实例；但网络身份完全可控 | ✅ 现状即可演进：插件化与网络面解耦 |
| **B. SOP = 常驻会话** | 每个 SOP 建一个 DSH 会话（带市场工具的 preset），a2a 把 `market/<id8>` 映射到该会话 | 会话常驻成本；SOP 语义被会话语义吞掉；冷会话唤醒可接受但节点数=台数 | ⚠️ 可行但重，适合“少量高频 SOP” |
| **C. 上游扩展** | 请 a2a 上游提供**外部节点声明**（非会话能力注册进 roster/card） | 依赖上游排期（#17 P5 同类协调） | 📌 应作为接口需求提出 |

## 四、插件化时的其余约束（§1 冲突之外的）

| 面 | 现状（独立进程） | 插件形态要求 |
|---|---|---|
| WebServer | 自己 `app.listen(9800)` | 必须 `inject: ['webServer']`，**复用宿主实例**，不再自监听 |
| 静态站点/web-dist | 自己 express.static | 用 `webServer.registerFallback`（唯一 owner）或挂到自有前缀 |
| 持久化 | `server/data/*.db`，靠 `DATA_DIR`/cwd | 显式 config 项（skill §4.6：不得依赖 cwd），并做旧数据迁移 |
| 定时巡检 | `setTimeout` 自管 | 用 `ctx.timer` / `ctx.effect`，随 fiber dispose |
| Redis 客户端 | 模块级单例 | 挂 Service `start/stop`（`Service.init`） |
| MCP `/mcp` | 自建 JSON-RPC | 若插件化，模型工具应走 `ctx.tools.register`；`/mcp` 仅保留给外部 agent（路径也要挪） |
| 前端 | 独立 SPA（9800 托管） | 可保留独立 web（另一端口）或改 DSH client slot；**不能与宿主 SPA fallback 抢** |
| 子进程（multer/文件） | 已有 | 保留，但上传目录走显式配置 |

## 五、与 a2a 的协作模型（推荐 A 落地）

```
DSH 宿主（一个 WebServer，一个 agents）
├── a2a 插件        网络身份：卡片 / 入站 / 幂等 / 回执 / 账本   （独占 /.well-known、/a2a/*）
└── 市场插件（业务） ctx.tools 暴露 wm_sop_* / wm_app_* → 模型可调
                     ctx 服务供其他插件调用；HTTP 面在 /wm/* 命名空间
                     ↕（可选）HTTP 调用自己的 A2A 实例（9800）做发件/收件
市场 A2A 实例（独立进程/端口）
└── 官方子路径：card / a2a-client / receipt / transport-caps ← 当前实现
    SOP 节点卡（market/<id8>）+ /a2a/direct 准入 → 开 run（已通过评审席 A1-A13 / N1-N13）
```

这样两边各司其职：**宿主内的 a2a 管“宿主的会话网络身份”，市场实例管“SOP 能力的网络身份”**；二者不抢路由、不抢卡。若将来上游支持外部节点声明（路径 C），市场可把 SOP 节点迁进宿主统一发卡，删掉自己的实例。

## 六、路径 C 的精化规格（上游评审席 dsh/74555a36 五条，已认可）

1. **句柄**：外部节点用 `dsh/<slug>` 形态，**禁止 8-hex**（与会话节点 id8 空间不相交）；卡片行带 `external: true`。
2. **`reachableBy: string[]` 显式声明链接集**（关键安全精化）：缺省空数组 = **网络侧全拒**；不靠隐式推断。
3. **卡面内容走 #19 暴露档管线**，无豁免——外部节点与 SOP 广告受同一暴露策略约束。
4. **解析链与会话旁路并行**：slug / id8 空间不相交；外部节点**无唤醒、无冷行、无 steer**——宿主直调 `ingress(信封, body)`。
5. **零新面**：无新 HTTP 路由、无线格式变更、零数据迁移。

**结论**：满足这五条后，市场的 `a2a.ts` 可退化为**纯业务 handler**（只实现 `ingress`），网络层完全交宿主；
路径 A（网络面独立）今天即可成立、不被 C 阻塞。C 走 gh 双章入 #20 批三或独立小波。
