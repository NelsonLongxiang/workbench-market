# ADMIN_TOKEN 接入程序（主人操作指南——#17 修订 3 诚实约束）

值只能由主人放进启动环境，不进任何 agent 可读文件/配置/API。

## 步骤（约 2 分钟）

1. **生成强随机值**（任选其一）：
   ```powershell
   # PowerShell（Base64 约 44 字符）
   [Convert]::ToBase64String((1..32 | %{Get-Random}))
   # 或 cmd（hex 64 字符）
   powershell -Command "[Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')"
   ```

2. **设入机器级环境**（所有后续进程继承）：
   ```cmd
   setx ADMIN_TOKEN "<你生成的值>" /M
   setx MCP_GATEWAY "on" /M   （可选——#284 起不设也是开；只有显式 off 才关并启动告警，生产勿设 off；OFF/false/0 等其它写法拒绝启动）
   ```

3. **重启 9800 服务**（新进程才继承新 env）：
   - 守护拉起：等下一轮或手动触发
   - 或管理员终端跑 `schtasks /Run /TN workbench-market-9800`

4. **验证**（行为面）：
   ```bash
   # 无口令→403
   curl -X POST http://127.0.0.1:9800/api/mcp/sessions -d '{"name":"probe"}' -H 'Content-Type: application/json'
   # 带口令→201（token 出现一次）
   curl -X POST http://127.0.0.1:9800/api/mcp/sessions -d '{"name":"probe"}' \
     -H 'Content-Type: application/json' -H 'X-Admin-Token: <你的值>'
   ```

## 三处启动路径的插槽状态

| 路径 | 插槽形态 | 说明 |
|---|---|---|
| `tmp/make-tasks.cmd` | ✅ `if not "%AT%"=="" set ADMIN_TOKEN=...` | 从机器级 env 读值传给 node 进程（值不进 cmd 文件） |
| 守护脚本 `tmp/guard-9800.cmd` | 监督席领地 | 建议：node 启动行前加 `if defined ADMIN_TOKEN set "GWT=%ADMIN_TOKEN%"`（同模式）——请监督席同步 |
| managed job（监督席） | 监督席领地 | 同上——监督席确认其 job 启动环境从进程 env 继承 |

## DSH 连接器升级（网关开启后·#284 起升级即缺省开）

1. 市场管理页 `/mcp-gateways` → 建会话（token 只显示一次，立即复制）
2. grants 编辑器勾选授权工具
3. 各 DSH 连接器配置 headers 加：
   ```json
   { "Authorization": "Bearer <token>" }
   ```
   （dsh-mcp-connector 的自定义连接 headers 字段支持）

## 全站登录门（WM_LOGIN_GATE）

`WM_LOGIN_GATE=enforce` 后，没有身份的请求一律拦截：浏览器页面 302 到 `/login?next=<原地址>`（只收同站相对路径），API 回 401 `{"error":"login_required"}`（响应头 `X-WM-Login-Required: 1`，前端据此整页去登录页）。缺省 `off`：行为与以前完全一样。其它值拒绝启动。`GET /api/health` 的 `login_gate` 字段报当前状态。

认的身份（任一即可）：本机命令行（回环直连、无浏览器标记、无反代头）；有效的 `X-Admin-Token` 头；登录页输入管理员口令后签发的 cookie；Odoo 内部员工会话（需配 `LC_ODOO_URL`，只认 `is_internal_user`，门户账号不行）。

- **登录 cookie**：`wm_login`，HMAC 签名（密钥 `DATA_DIR/.wm-login-gate.key`，权限 600，首次启动自动生成），HttpOnly、SameSite=Lax、12 小时；https（或反代带 `X-Forwarded-Proto: https`）时加 Secure。cookie 里不含口令；**口令一轮换，所有已发 cookie 立即失效**。登出（顶栏「退出」/ `POST /api/auth/logout`）清 cookie 并作废这一枚（作废名单在进程内，重启后只靠 cookie 自身到期）。
- **cookie 只管能不能进站**，管理写仍要口令头或 Odoo 管理员，和以前一样。
- **登录限频**：按来源 IP 每分钟 10 次；连续失败 3 次起退避 1s、2s、4s…封顶 5 分钟，超限 429 带 `Retry-After`。来源 IP 取 TCP 对端：经同机反代时所有人共用一个桶。口令错与未设置口令同答「口令无效」。审计只记成功/失败、来源 IP 与时间（stdout 一行 JSON，`source=login-gate`）。
- **/mcp**：不走登录 cookie，只认网关会话令牌；enforce 时 `MCP_GATEWAY` 强制视为 on（设了 off 会告警并忽略）。
- **自产台（沙箱页）**：页面是不透明源，子资源请求带不了 cookie。已登录的人打开 `/apps/<slug>/`（或指向自产台的 `/go/<id>/`）会被 302 到 `/apps/<slug>/~wm/<查看凭证>/…`：凭证按台签名、12 小时有效，相对路径的脚本/样式/图片自然带上；页面里指向本台的绝对地址（`/apps/<slug>/…`、`/api/apps/<slug>/files/<id>`）由服务端和注入脚本补上凭证。带本台 `X-App-Token` 的 data/files/变量请求直接放行。凭证地址不能当顶层页面匿名打开（复制出去的链接要先登录）。
  已知不覆盖：沙箱页里内嵌**别的**台或 `/sop/`、`/go/<外部台>/` 的 iframe，以及 CSS 里 `url(/apps/…)` 形式的绝对地址——这些请求不带 cookie 也没有凭证，会被拦。
- **无身份也放行**：`/api/health`、`/login` 与 `/api/auth/*`、`/mcp`（网关认证）、签名卡片 `GET /.well-known/agent-card.json`、工作台事件回执 `POST /api/workbench-events/<id>/decision`（凭投递里的 reply token）、`/design/tokens@*.css`（公开设计变量）、沙箱页对本台数据面的预检、Odoo 登录中继（只有登录页给出的那一个 `/go/<id>/?return=/login`）。
- **不放行 `/a2a/direct`**：它没有签名校验（准入只按自报的 caller_session 匹配绑定），enforce 下远程节点直投 SOP 会 401。
- WebSocket 升级（`/go/` 代理的长连接）同样要身份。

开启前：已经打开着的页面在下一次请求时会被要求重新登录；本机脚本（回环直连）不受影响。

## 安全注意

- ADMIN_TOKEN 泄露=可建任意 MCP 会话/绑定 SOP/写一切控制面——请主人妥善保管
- 与 SOP 绑定口令共用同一 ADMIN_TOKEN（P1 设计）
- 撤销一个泄露的会话令牌：管理页吊销即可（令牌即时失效，无需改 ADMIN_TOKEN）
- 改 ADMIN_TOKEN 本身：重新 setx /M + 重启（所有旧会话令牌仍有效直到各自吊销——令牌与 ADMIN_TOKEN 是两套）


## 轮换步骤（监督席派单·控制面单点缓解）

1. **生效面**：设置页/顶栏钥匙图标改口令 → 立即生效（库存 sha256·不可取回·见 /api/admin/token）
2. **旧会话失效**：轮换后**清理全部 mcp_sessions**（`DELETE FROM mcp_sessions;`）——Bearer 会话令牌随旧口令作废面失效（agent 需重新建会话）
3. **验证**：改后旧 token 调 /mcp → 401；新口令建会话 → 200
4. **判据**：token 以 sha256 库存·**不进任何可读配置/日志/导出**（提交物/快照不含口令）
