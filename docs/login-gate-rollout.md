# 全站登录门上线评估（WM_LOGIN_GATE=enforce）

> 范围：评估把已部署的 main（含 #383 #385 #386 #389 #392–#395，`login_gate=off`）切到 `WM_LOGIN_GATE=enforce` 的影响。
> 全部结论来自代码对照与隔离实例实测（`scripts/login-gate-rollout-check.mjs`：本机随机端口、合成 DATA_DIR、本机替身，不碰生产库与生产网络）。
> 本文不含任何业务信息；示例 slug、地址、口令都是合成的。

## 结论

**可以开，但要先合一个小修复，并做完下面「开之前」的配置。** 修复是：登录门认按 run 的凭据（见第 1 节 A2A 一行）。不修的话，经 A2A 派单的远程节点拿到 `read_capability` / `upload_token` 后，再直连 REST 读 run、传附件都会被登录门 401。

实测 61 行：上线必须成立的 51 行全部通过（含修复）；另 10 行是预期内的行为变化，主要是以前开放的远程只读接口要改为带口令。

## 1. 各类调用方受什么影响

登录门认四种身份：本机命令行（回环直连、无浏览器标记、无反代头）、`X-Admin-Token` 头、口令登录 cookie、Odoo 内部员工会话（需 `LC_ODOO_URL`）。在此之外，下表「放行依据」一列是 `server/src/login-gate.ts` 里无身份也放行的条目。

| 调用方 | 开 enforce 后 | 放行依据 / 该怎么办 | 要补豁免吗 |
|---|---|---|---|
| agent 经 MCP 令牌：`/mcp`、`/api/mcp-rest/*`、`/openapi.json` | 不受影响：匿名由网关回 401，有效会话 200；enforce 时网关强制开 | 前缀放行，交给网关会话认证。只带浏览器登录 cookie 调不了 MCP（预期） | 否 |
| 健康检查 `/api/health`（GET/HEAD）与启动自检 | 不受影响。自检在 enforce 下多 4 行：匿名 `/`、`/apps/<台>/` 必须 302，`/api/apps` 必须 401，未签名 direct 必须 401 | 精确放行 | 否 |
| A2A 入站 `POST /a2a/direct` | enforce 时强制 require 签名（#395）：未签名 401；签名有效且绑定登记了 `notify_url` → 照常；**绑定没有 `notify_url` 的调用方会 401（no-card）** | 放行到路由，由路由验签。要给每条 admits 绑定补 `notify_url`（取卡地址），并设 `MARKET_PUBLIC_URL`（签名里的 audience） | 否 |
| A2A 派单后直连 REST：凭 `read_capability` 读 run / 附件，凭 `upload_token` 传附件 | **修复前被拦（401）**，修复后放行 | 本评估的修复：`GET /api/sop/runs/<id>[/files[/<fileId>]]` 带该 run 有效的 `X-Run-Read-Capability`；`POST /api/sop/runs/<id>/files` 带该 run 的 `X-Run-Upload-Token`（run 在执行）。换 run、伪造、吊销、结束都拦 | **是（已补，见修复 PR）** |
| 回执链路：市场 → 对端的回执与事件派发 | 出站，不受影响；对端验市场签名要取市场卡片（公开） | `GET /.well-known/agent-card.json` 放行 | 否 |
| 工作台事件回写 `POST /api/workbench-events/<id>/decision` | 不受影响 | 精确放行，路由凭 reply token 认证。`reply.url` 用 `MARKET_PUBLIC_URL` 拼，未设时远程节点回写不了 | 否 |
| SOP Runner 页 `/sop/<slug>/` 与其上传、读凭证、附件 | 匿名打开 302 到登录页；登录后与以前一样（同源页面带 cookie） | 现场人员要能登录：Odoo 内部员工账号（推荐），或管理员口令 | 否 |
| 自产台、SOP 台页面与内嵌（沙箱子资源） | 登录后 302 到带查看凭证的地址，子资源、`<img>`、`/use` 内嵌照常；首次 enforce 轮换台令牌，**已打开的自产台页面要刷新** | 查看凭证、带本台 `X-App-Token` 的 data/files/vars | 否。已知不覆盖：沙箱页里内嵌别的台、`/sop/` 或外部 `/go/` 的 iframe，以及 CSS 里 `url(/apps/…)` 形式的绝对地址 |
| `/go/` 门户（外部台）与 WebSocket | 匿名 302 / 断开；登录后照常 | 身份 | 否 |
| 生命周期 `/lifecycle`、`/api/lifecycle/*` | Odoo 内部员工照常；门户账号与匿名被拦；`approve` 照旧凭 Odoo 会话 | Odoo 会话身份 | 否 |
| 任务中心发布 | 只有登录 cookie 不够（403），仍要口令或 Odoo 管理员，与以前一样 | 管理写门不变 | 否 |
| Odoo 登录回跳 | 「用 Odoo 登录」走登录页的中继；`/sso/callback` 带内部员工会话可过；匿名用户的旧入口 `?return=/lifecycle` 会先被送到登录页 | Odoo 登录中继（只放 `?return=/login` 那一个） | 否 |
| LayerFS | 没有入站回调（只有市场调 LayerFS），不受影响 | — | 否 |
| 本机命令行（开发席本机、sync、publish-lock、自检） | 不受影响 | 本机命令行身份。发布锁与登录门无关 | 否 |
| 局域网 / 远程脚本、看板（不带口令） | **以前开放的只读接口改为 401**：`/api/workbenches`、`/api/summary`、`/api/stats`、`/api/skills` 等；远程写由 403 变为 401 | 改为带 `X-Admin-Token`，或改走 MCP 会话 | 否（这是登录门的目的） |

## 2. 隔离实例实测

`node scripts/login-gate-rollout-check.mjs` 依次：先以 off 启动并布置（自产台、SOP 台、外部台、Odoo 台、两条 admits 绑定，记下开门前的台令牌），再以首次 enforce 启动并逐类发请求，最后回滚到 off、再开 enforce。远程调用方用 `X-Forwarded-For` 模拟。下表为含修复的结果（修复前，A2A 的两行是 401 login_required，其余相同）。

| 类别 | 请求 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| 健康 | 远程 GET /api/health | 200，login_gate=enforce | 200 enforce | ✅ 通过 |
| 健康 | 远程 HEAD /api/health | 200 | 200 | ✅ 通过 |
| 健康 | 启动自检全过（含登录门三行、未签名 direct 行） | passed，无 fail | true fail=无 行=9 | ✅ 通过 |
| 健康 | 首次 enforce 启动到健康 | < 30s | 307ms | ℹ️ 符合预期 |
| 健康 | 首次 enforce 轮换台令牌（日志一行，无密钥） | 有轮换日志 | 有 | ✅ 通过 |
| MCP | 远程匿名 POST /mcp | 401 + Bearer 质询（网关，不是登录门） | 401 Bearer | ✅ 通过 |
| MCP | 远程带会话 POST /mcp initialize | 200 | 200 | ✅ 通过 |
| MCP | 远程匿名 GET /openapi.json | 401（网关） | 401 | ✅ 通过 |
| MCP | 远程带会话 GET /openapi.json | 200 | 200 | ✅ 通过 |
| MCP | 远程带会话 POST /api/mcp-rest/tools/workbench_summary | 200 | 200 | ✅ 通过 |
| MCP | 远程带会话 PUT 原始字节上传 | 201 | 201 | ✅ 通过 |
| MCP | 只带登录 cookie 调 /mcp | 401（MCP 不认浏览器登录） | 401 | ✅ 通过 |
| A2A | 远程 GET 签名卡片 | 200，含 sessionTeams | 200 teams=1 | ✅ 通过 |
| A2A | 远程未签名 POST /a2a/direct | 401（enforce 强制 require） | 401 untrusted-origin: signature verification | ✅ 通过 |
| A2A | 远程签名 direct（绑定登记了取卡地址） | 200 DELIVERED，回 upload_token 与 read_capability | 200 TASK_STATE_DELIVERED run=1 | ✅ 通过 |
| A2A | 远程签名 direct（绑定没登记 notify_url） | 401 no-card（需补 notify_url） | 401 no-card（上线前给每条 admits 绑定补 notify_url） | ℹ️ 符合预期 |
| A2A | 远程 POST 事件回执 decision | 到路由（未知事件 404），不被登录门拦 | 404 | ✅ 通过 |
| A2A | 派单方凭 read_capability 远程读 run（REST） | 200 | 200 | ✅ 通过 |
| A2A | 派单方凭 upload_token 远程传 run 附件（REST） | 2xx | 201 | ✅ 通过 |
| SOP | 远程匿名打开 /sop/<slug>/ | 302 /login?next=… | 302 → /login?next=%2Fsop%2Frc-sop%2F | ✅ 通过 |
| SOP | 登录后打开 /sop/<slug>/ | 200 | 200 | ✅ 通过 |
| SOP | 登录后页面建 run（同源浏览器） | 2xx，回 upload_token 与 read_capability | 201 | ✅ 通过 |
| SOP | 登录后页面传 run 附件 | 2xx | 201 | ✅ 通过 |
| SOP | 登录后凭读凭证下载附件 | 200 | 200 | ✅ 通过 |
| SOP | 未登录只凭读凭证下载附件（凭证被转发出去） | 200（读凭证本身就是按 run 的不记名凭据，30 天有效、可吊销） | 200（与派单方直连同一条规则） | ℹ️ 符合预期 |
| 台 | 远程匿名打开自产台 | 302 /login | 302 → /login?next=%2Fapps%2Frc-app%2F | ✅ 通过 |
| 台 | 登录后打开自产台 | 302 到 /apps/<slug>/~wm/<凭证>/ | 302 → /apps/rc-app/~wm/<凭证>/ | ✅ 通过 |
| 台 | 沙箱子资源凭查看凭证（无 cookie） | 200 | 200 | ✅ 通过 |
| 台 | 登录后经 /go/<自产台>/ 打开 | 302 到 /go/<id>/~wm/… | 302 → /go/2/~wm/<凭证>/ | ✅ 通过 |
| 台 | 登录后经 /go/<外部台>/ 打开 | 200（代理上游） | 200 | ✅ 通过 |
| 台 | 远程匿名经 /go/<外部台>/ | 302 /login | 302 → /login?next=%2Fgo%2F4%2F | ✅ 通过 |
| 台 | 远程匿名 /go/ WebSocket 升级 | 断开（0 字节） | 0 字节 | ✅ 通过 |
| 台 | 登录后 /go/ WebSocket 升级 | 交给门户（有响应字节） | 45 字节 | ✅ 通过 |
| 台 | 开门前的旧台令牌写数据 | 401（首次 enforce 已轮换） | 401 login_required | ✅ 通过 |
| 台 | 新台令牌写数据（沙箱页） | 放行（非 401） | 201 | ✅ 通过 |
| 生命周期 | 远程匿名打开 /lifecycle | 302 /login?next=%2Flifecycle | 302 → /login?next=%2Flifecycle | ✅ 通过 |
| 生命周期 | Odoo 内部员工 /api/lifecycle/whoami | 过登录门（未配生命周期源时路由 503） | 200 | ✅ 通过 |
| 生命周期 | Odoo 内部员工 /api/lifecycle/board | 过登录门 | 200 | ✅ 通过 |
| 生命周期 | Odoo 内部员工 POST /api/lifecycle/approve | 过登录门（参数不全由路由拒） | 503 | ✅ 通过 |
| 生命周期 | Odoo 门户账号 | 401（登录门只认内部员工） | 401 login_required | ✅ 通过 |
| 生命周期 | Odoo 管理员只带会话读 /api/tasks | 200 | 200 | ✅ 通过 |
| 任务中心 | 只有登录 cookie（非管理员）发布任务 | 403（管理写仍要口令或 Odoo 管理员） | 403 | ✅ 通过 |
| 任务中心 | 远程带口令发布任务 | 过两道门（不存在的任务 404） | 404 | ✅ 通过 |
| Odoo | 登录中继 /go/<Odoo 台>/?return=/login（匿名） | 200 跳转页 | 200 | ✅ 通过 |
| Odoo | 旧入口 ?return=/lifecycle（匿名） | 302 /login（只能从登录页走） | 302 → /login?next=%2Fgo%2F5%2F%3Freturn%3D%252Flifecycle（匿名用户先到登录页；已登录用户在 /lifecycle 照旧可用） | ℹ️ 符合预期 |
| Odoo | 已登录用户走 ?return=/lifecycle | 200 跳转页 | 200 | ✅ 通过 |
| Odoo | Odoo 登录回跳 /sso/callback（带内部员工会话） | 过登录门（state 不符由路由 400） | 400 | ✅ 通过 |
| Odoo | 登录页给出「用 Odoo 登录」 | 有 | 有 | ✅ 通过 |
| 运维 | 本机命令行 GET /api/apps | 200 | 200 | ✅ 通过 |
| 运维 | 本机命令行 POST /api/apps/<slug>/sync | 2xx（或发布锁 409） | 200 | ✅ 通过 |
| 运维 | 远程（局域网）不带口令 sync | 401（以前是 403） | 401 login_required | ℹ️ 符合预期 |
| 运维 | 远程带口令 sync | 过登录门（2xx 或发布锁 409） | 200 | ✅ 通过 |
| 运维 | 远程不带口令 GET /api/workbenches（以前开放读） | 401 | 401 login_required（只读脚本、看板需改带口令或走 MCP） | ℹ️ 符合预期 |
| 运维 | 远程不带口令 GET /api/summary（以前开放读） | 401 | 401 login_required（只读脚本、看板需改带口令或走 MCP） | ℹ️ 符合预期 |
| 运维 | 远程不带口令 GET /api/stats（以前开放读） | 401 | 401 login_required（只读脚本、看板需改带口令或走 MCP） | ℹ️ 符合预期 |
| 运维 | 远程不带口令 GET /api/skills（以前开放读） | 401 | 401 login_required（只读脚本、看板需改带口令或走 MCP） | ℹ️ 符合预期 |
| 运维 | 远程带口令 GET /api/workbenches | 200 | 200 | ✅ 通过 |
| 回滚 | 改回 off 重启后远程匿名读 | 200 | 200（重启 311ms 后） | ✅ 通过 |
| 回滚 | off 下台令牌不回退（仍是 enforce 时的新令牌） | 新令牌 | 新令牌 | ✅ 通过 |
| 回滚 | off 下旧令牌写数据（远程写面本就免令牌） | 放行 | 201（旧令牌失效只影响沙箱页的跨源读（拿不到 ACAO），刷新即好） | ℹ️ 符合预期 |
| 回滚 | 再次 enforce 不重复轮换 | 令牌不变 | 不变 | ✅ 通过 |

## 3. 上线方案

### 开之前

1. **合修复 PR**（高档，需属主授权）：登录门认按 run 的读凭证 / 上传令牌。
2. **配置**：
   - `WM_LOGIN_GATE=enforce`。
   - `ADMIN_TOKEN`（或库存口令）：口令登录和远程运维要用；只分发给管理员，不要发给现场人员当「门票」。
   - `MARKET_PUBLIC_URL`：设成外部实际访问的根地址。A2A 入站签名的 audience 与事件回写地址都用它，未设时远程 A2A 全部 401。
   - `LC_ODOO_URL`（与包含它的 `WM_ODOO_ORIGINS`），并登记一个该源的 Odoo 台：现场与业务人员靠它登录。浏览器的 Odoo `session_id` 必须能送到市场（与 Odoo 同主机名，cookie 不区分端口）；否则他们只能用口令。
   - 绑定：每条 admits 绑定补 `notify_url`（对端卡片所在根地址），否则签名验不了，按 no-card 401。
   - HTTPS（建议）：有 https 时 cookie 自动加 Secure；经反代时带 `X-Forwarded-Proto: https`。若仍是 http，登录 cookie 与口令在网络上是明文，对公网开放前应先上 HTTPS。
3. **通知调用方**：远程只读脚本、看板改为带口令或走 MCP；A2A 对端确认按 Sig2 签名（或 body 签名）发 direct。
4. **演练**：在与生产同版本上跑 `node scripts/login-gate-rollout-check.mjs`，全部必须项通过。

### 什么时候开

选业务低峰。首次 enforce 启动会轮换按台令牌密钥（DATA_DIR 下写 `.wm-app-token.gate` 记号，之后不再轮换），所有已打开的自产台页面要刷新；已打开的市场页面在下一次请求时会被要求登录。实测首次 enforce 启动到健康不到 1 秒（合成库，生产库大时以实际为准）。

开之后立刻核对：`GET /api/health` 的 `login_gate` 为 `enforce`、`self_probe.passed` 为 true；用一个 MCP 会话、一个 A2A 对端、一个 Odoo 账号、口令各走一遍。

### 回滚

- **怎么回**：把 `WM_LOGIN_GATE` 改回 `off`（或删掉）并**重启**；开关只在启动时读，不重启不生效。实测重启到健康不到 1 秒，重启完成即生效。
- **台令牌不能还原**：首次 enforce 已经换了 `.wm-app-token.key`，回到 off 后仍用新密钥，开门前的旧令牌不会恢复。影响：off 下远程写数据本就免令牌，所以只影响沙箱页的跨源读（旧令牌拿不到 ACAO）——页面刷新后拿到新令牌即恢复。没有备份旧密钥就无法还原；如需还原，只能在首次 enforce 前自行备份该文件（不建议：旧令牌已在公网暴露过）。
- **再开**：记号文件还在，再次 enforce 不会重复轮换（实测令牌不变）。要强制再轮换一次，删掉 `DATA_DIR/.wm-app-token.gate` 后以 enforce 重启。
- 登录 cookie 在 off 下仍可验证但不再需要；口令轮换会让所有已发 cookie 立即失效。

### 已知取舍（不阻塞）

- 限频按 TCP 对端 IP；经同机反代或端口转发时所有人共用一个桶，可能互相拖累。
- 查看凭证按台签名、不绑定用户，12 小时有效。
- 按 run 的读凭证是不记名凭据：拿到的人在有效期内（缺省 30 天）不登录也能读该 run，可经 `POST /api/sop/runs/<id>/read-caps/revoke` 吊销。
