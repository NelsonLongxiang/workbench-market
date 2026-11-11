# workbench-market · 工作台市场

管理 Web 工作台的轻量框架：把散落在各端口的 AI 工具/服务（Ollama、OpenAI 兼容 API、Gradio、Streamlit、Jupyter、MCP SSE、普通 Web 应用…）注册到一处，集中查看在线状态、健康巡检、分类标签检索，并以内嵌全屏页直达使用。

- **后端**：Express 4 + `node:sqlite`（Node 24 内置，零原生依赖，单文件 SQLite）
- **前端**：React 18 + antd 5 + @ant-design/pro-components + react-grid-layout（可拖拽仪表盘）+ react-markdown
- **形态**：单进程、单端口（默认 9800），`/api/*` 提供 REST，其余路径托管前端构建产物

## 快速开始

```bash
pnpm install          # pnpm workspace：server + web
pnpm dev              # 并行起 server(9800, watch) 与 web(5173, 代理 /api)
pnpm build            # 构建前端 → web/dist，由 server 同端口托管
pnpm start            # 生产模式（只跑 server，访问 http://127.0.0.1:9800）
node scripts/gen-design-tokens.mjs   # 改了 DESIGN.md 的 token 后重新生成 web/src/tokens.css 与 design-tokens.ts（--check 只比对）
node scripts/tech-route-check.mjs    # 路线体检：结构数字对照 tech-route.json 里的基线（预算与红线超了会失败；--selftest 自检）
node scripts/surface-snapshot.mjs     # 对外面的快照：改了路由、MCP 工具或表结构后，加 --write 重新生成
node scripts/route-replay-test.mjs    # 路由录制回放：对同一组请求重放，状态码、响应头和响应体要和录下来的一样（有意改了行为加 --record 重录）
```

浏览器回归（`scripts/*-browser.mjs` 等）要用 Python Playwright，版本与 CI 一致。一般交给 CI 或共用测试环境跑。解释器由 `scripts/python-bin.mjs` 统一选取，顺序是：`PYTHON` 环境变量 → 仓库根的 `.venv` → 系统 `python3`，不用在命令前手写解释器路径。想在自己机器上跑的话（可选），建一次 `.venv` 即可：

```bash
python3 -m venv .venv && .venv/bin/python -m pip install playwright==1.57.0
```

环境变量（13 面）：`PORT`（默认 9800）、`WM_LOGIN_GATE`（全站登录门·`enforce`=没有身份什么都访问不到：页面 302 `/login`、API 401；缺省/`off`=行为不变；其它值拒绝启动；见 [ADMIN-TOKEN-SETUP.md](ADMIN-TOKEN-SETUP.md)「全站登录门」）、`WM_CONTROL_PORT`（可选的独立管理端口·缺省不开·见「信任模型」）、`DATA_DIR`（SQLite 数据目录·默认 `server/data`）、`ADMIN_TOKEN`（控制面口令·可设置页改）、`MCP_GATEWAY`（#284 起**缺省开**：未设/空/`on`=会话令牌网关；只有显式 `off` 且 `NODE_ENV=development/test` 才允许关闭并启动告警；生产/未设/空/未知运行模式配 off 由启动自检拒绝，其它网关值也拒绝启动）、`REDIS_URL`（SOP 状态层·缺省读 `DATA_DIR/redis.url`·无则降级 SQLite）、`MARKET_TEAM`（A2A team 默认 `market`）、`MARKET_PUBLIC_URL`（对外基址·A2A 卡片与 MCP `skill_download` 下载链接用；生产建议设成 https 地址——没设时下载链接取请求主机，主机名不规范就不签发）、`A2A_API_KEY`/`A2A_STATE_URL`（A2A 外部面）、`WM_A2A_DIRECT_SIG`（`POST /a2a/direct` 入站签名·缺省 `accept`=带了 OriginClaim Sig2 就验、没带照旧走绑定准入；`require`=没签名或验不过一律 401；`off`=不验；`WM_LOGIN_GATE=enforce` 时强制 `require`；其它值拒绝启动。公钥只从调用方绑定上登记的 `notify_url` 取卡，不跟随重定向）、`WM_A2A_DIRECT_SIG_BODY`（缺省 `accept`；`require`=只认同时签了 body 摘要的 `X-WM-Body-Sha256`/`X-WM-Body-Sig`，现有 DSH 节点只发 Sig2，打开前对端要先升级；其它值拒绝启动）、`A2A_ORIGIN_CLAIM_UNBOUND`（v1 未绑定调用方签名兼容窗：`off`=停发 `X-A2A-Caller-Sig`，缺省继续发；v1 不绑路由，未升级对端上可被剥 Sig2 重放，全舰队升级后应设 `off`）、`LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS·缺一即禁用）、`LAYERFS_SERVICE_TOKEN_FILE`（LayerFS 令牌文件·设了就以文件为准，不回落到库里或环境变量里的令牌；内容不足 32 字节拒绝启动）、`AI_GATEWAY_API_KEY`（`skill_search` 评估模型令牌·缺=工具报错不降级）、`EVAL_GATEWAY_URL`（评估网关覆盖·验证器/代理用）、`SANDBOX_BRIDGE_URL`/`SANDBOX_BRIDGE_TOKEN`（sandbox 派发）、`PUBLISH_LOCK_MS`（发布锁窗口·测试可调）、`SOP_READ_CAP_TTL_DAYS`（SOP run 只读能力有效期·缺省 30 天·非数字回落缺省）、`WM_GITHUB_TOKEN`（自产台/SOP 台来源仓库读令牌·可选·私有仓库用）、`WM_GITHUB_API`（GitHub API 基址·只给测试替身用）、`WM_APP_FILES_MAX`（单台文件数上限·浏览器上传与 MCP 上传共用·缺省 2000）、`A2A_EVICT_COOLDOWN_MS`（台驱逐冷却窗·缺省 24h·测试可调）、`A2A_OUTBOX_BACKOFF_SCALE`（A2A 回执 outbox 退避倍率·测试可调）、`WM_REGISTER_URL_ALLOWLIST`（#258 公网登记精确许可·JSON 字符串数组·缺省 `[]`=公网一律 403 `url_not_allowlisted`·坏项/通配/硬拒/私网条目拒绝启动·见 docs/r3-url-allowlist-design.md）、`ALLOW_PUBLIC_NET`（#258 起**不再放行任何公网登记**，`1` 只在启动时告警）（网关开时 `/mcp` 启用会话令牌网关——**生产已开：所有 /mcp 调用须 `Authorization: Bearer <会话令牌>`**·会话经 `POST /api/mcp/sessions` 创建+`PUT …/grants` 授权）、`LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS 服务面·两者任一缺失则 LayerFS 集成整个禁用=降级直写）、`WM_ODOO_ORIGINS`（可信 Odoo 源·逗号分隔·门户只把 Odoo `session_id` 转给这些源与 `WM_ODOO_URL` 的源；都未设时谁都不转、Odoo 台免登不生效（fail closed·启动时提示））、`WM_ODOO_URL`（工作台认人的 Odoo 地址·浏览器 Odoo 会话按它现查 `get_session_info`：登录门、统一待办读权、Odoo 管理员认定、`/api/auth/viewer` 共用·未设则不认 Odoo 身份；旧名 `LC_ODOO_URL` 已弃用，仍在 `WM_ODOO_URL` 为空时回退读取并在启动时告警，两个都设以新名为准）、`WM_ODOO_BROWSER_URL`（只给浏览器用的 Odoo 登录地址·可选·须在可信名单内、只写 origin，非法拒启动；仅对源等于 `WM_ODOO_URL` 的 Odoo 台生效，主机名不符或 https 降级回 503；同域中继开着时中继优先·见 [docs/odoo-browser-origin.md](docs/odoo-browser-origin.md)）、`WM_ODOO_LOGIN_PROXY`（`1`=市场同域 Odoo 登录中继·上游固定为 `WM_ODOO_URL`·见 [docs/odoo-login-relay.md](docs/odoo-login-relay.md)）、`WM_SESSION_TTL_MIN`（市场会话的绝对期限，分钟·缺省 720＝12 小时·范围 15～10080·不续期·不合法拒绝启动）、`WM_FEISHU_LOGIN`（`on`=打开飞书登录·缺省关）、`WM_FEISHU_AUTHORIZE_URL` / `WM_FEISHU_TOKEN_URL` / `WM_FEISHU_USERINFO_URL`（飞书授权页、换令牌、取用户信息的地址·缺省取飞书开放平台文档里的·只收 https）、`WM_FEISHU_TENANT_TOKEN_URL` / `WM_FEISHU_CONTACT_USER_URL`（对账用：取 tenant_access_token、按 union_id 查人的地址·缺省同上）、`WM_FEISHU_VAULT_ENTRY`（飞书应用凭证在凭据库里的条目名·缺省 `feishu-login`：username 是 App ID、password 是 App Secret）、`WM_FEISHU_TENANT_KEY`（可选·只认这个租户的人）、`WM_FEISHU_AUTO_BIND_EMAIL`（`on`=没对到主体的人按飞书企业邮箱自动对到已有主体·缺省关·打开时必须配 `WM_FEISHU_TENANT_KEY`，否则拒绝启动）；见「主体」一节、`WM_TRUSTED_PROXIES`（可信反代·逗号分隔的 IP/CIDR·这些对端写入的 `X-Real-IP`/`X-Forwarded-For` 最右项才算来源 IP，用于登录门限频与审计、Odoo 登录票据按来源限额；回环恒可信；容器部署要写上 docker 网桥网关或反代网段；非法项拒绝启动）、`WM_EXTENSIONS_DIR`（扩展挂载点·绝对路径·缺省不加载任何扩展·见「扩展」）、`YGL_MAX_PROJECTS`（统一待办读 ygl-trees 的 active 项目数上限·缺省 200·超出部分在 `degraded_projects` 报 cap-exceeded）、`YGL_TOTAL_BUDGET_MS`（ygl-trees 源总预算·缺省 8000·超预算未读的报 budget-exhausted；两项非整数或越界都回落缺省）。内容面（Draft，默认关闭）：`WM_CONTENT_PORT`（显式内容端口，缺省/0不启）、`WM_CONTENT_IP`（显式绑定非通配IP）、`WM_CONTENT_MARKET_ORIGIN`（可信市场完整origin）、`WM_CONTENT_ODOO_ORIGIN`（须属于已配可信Odoo源）、`WM_CONTENT_TARGETS`（JSON数组，固定id/origin/upstreamUrl；migrateBrowser仅显式true才迁出该target浏览器导航（默认关）；queryCredentialKeys只列上游凭据参数键，不列值，pin URL需去除这些参数；origin为w-id-env.internal且端口匹配）、`WM_PORTAL_OBSERVE`（显式1才记录被动聚合，管理员读`/api/content/observation`；coverageVerified仍false），见[装配说明](docs/content-foundations-integration-296.md)。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。。凭据库：`WM_VAULT_PATH`（库文件·缺省 `DATA_DIR/vault/default.json`；指向 `$DSH_HOME/vault/default.json` 即与 DSH 插件共用——插件开着时同时写会丢更新）、`DSH_VAULT_PASSWORD_FILE`（主密码文件·**设了就以文件为准**：管理员访问凭据库时按需自动解锁、不闲置上锁、页面不再要主密码；每次开库现读、只去掉末尾一个换行；读不到或为空回 503，不回落到环境变量·文件建议 0600、只挂给 market 容器）、`DSH_VAULT_PASSWORD`（主密码·同上效果、与插件同名，但会出现在 `docker inspect`，生产优先用文件；两者都不设则在页面输入，只存进程内存）——**服务端持有主密码时凭据库只在凭据库专用域名 `WM_VAULT_HOST`（或控制面）开放，主域名一律 403 `vault_control_only`**：主域名跑着 `/go/` 外站与 SOP 正文，同源脚本可借管理员的 Odoo 会话静默读走全库；专用域名是另一个源，那些脚本改不了 Host、也读不到跨源响应。`WM_VAULT_HOST`（凭据库专用域名·只填主机名，如 `vault.example.com`·按请求 Host 精确比较、不分大小写、不看端口·带协议/端口/路径拒绝启动）上与控制面同一道围栏：`/go`、`/sop`、`/apps`、`/mcp`、`/openapi.json`、`/api/mcp-rest/`、`/a2a/` 一律 404，禁止被嵌；反代须原样转发 Host（nginx `proxy_set_header Host $host`）；Odoo 会话按域名分开，在专用域名上要用口令或在该域名 `/login` 登录。代价是「专用域名上的管理员身份 = 能读全部凭据」，服务器被攻破时库也随之暴露。`WM_VAULT_SERVER_PASSWORD_ON_MAIN`（只接受 `accept-same-origin-risk` 或不设，其它值拒绝启动）：设了就让服务端持有主密码时凭据库**在主域名也开放**，不需要专用域名或控制面。**残余风险（属主接受后才设）：管理员登着的时候，经 `/go/` 代理的外站页面或带脚本的 SOP 正文，能不声不响地读走全部凭据明文，不需要主密码，也不受闲置上锁的限制**；不设时保持只在专用域名/控制面开放、`WM_VAULT_IDLE_MIN`（页面解锁后闲置自动上锁分钟数·缺省 15·`0` 不自动锁）。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。

## 启动安全自检（#326）

市场/控制面监听后先运行固定匿名回环自检，完成前 HTTP 和 WebSocket 业务入口均关闭；`GET /api/health` 返回 503，`self_probe.passed=false/at=null`。固定行里有一行管主体管理面：远程匿名 GET `/api/principals` 必须被拒（登录门关着 403，开着由登录门先拦 401）；一行管登录回调：远程匿名拿编出来的 state 打 `/login/feishu/callback` 必须 400（不跳转、不发会话）；一行管失效通知：远程匿名、不带签名向 `/login/feishu/events` 发事件必须 401。`WM_LOGIN_GATE=enforce` 时另加四行：远程匿名 GET `/`、`/apps/<台>/` 必须 302 到登录页、`/api/apps` 必须 401（浏览器写那一行改为期望登录门的 401），外加远程无签名 `POST /a2a/direct` 必须 401。强制行通过后才开放业务并启动后台巡检，health 可回读逐行结果。任一强制行失败或超时只关闭本进程监听并非零退出，不杀宿主或父进程；只有 `NODE_ENV=development/test` 的显式 `MCP_GATEWAY=off` 才把两条 MCP 行变成 warning，生产/未设/空/未知模式配 off 两行均 fail 并拒绝启动；控制面关闭则对应行 skip，不能视为完整认证验证。

自检只使用固定 127.0.0.1、实际监听端口和固定路径，不发送 Cookie、Bearer 或管理员口令。拒绝写探针使用空的非法 name/url，并以无 Origin 的 400 校验对照证明不落业务库；自检审计只标 `source=self-probe` 的状态/行名，不存请求或响应正文，也不计入采纳流量。**后续安全修复必须往自检表增加对应行及正反测试**，不能仅凭配置值宣称生效。详见 [启动自检契约](docs/startup-security-self-probe.md)。本功能不替代 #309/#324 等各自的授权修复或现网上线验收。


## 功能

| 功能 | 说明 |
| --- | --- |
| 工作台 CRUD | 名称/URL/类型/图标/分类/标签/排序/Markdown 描述；一键复制为副本（全字段预填）快速创建变体；删除仅解除注册不影响服务 |
| 绑定统一（联合评审①·S5 同批） | 一张 `bindings` 表=台×agent 关系：direction(admits=入站准入[可直投/上卡]/notify=出站推送[提交回执]/both=显式双授)——**授权独立**：授推送不隐含授派单；POST 缺 direction 即 400（无默认）；旧双面 `/api/(sops|apps)/:slug/bindings` 已 410+Location 过渡指向 `/api/bindings`；消费点四处（直投准入/上卡/提交推送/P3 回执）按方向过滤；旧两表保留一版作回滚锚。双形态分工：SOP 台=多步流程（run 生命周期·mode 分层）；自产台=表单+看板（哑存储+推送）——kind 差异在 run 语义，不在绑定治理 |
| 发布门禁·预览·元数据（S1/S2/S6） | 发布三闸：空 content 拒（v16 事故锚）/对前版体积骤降>50% 拒（`force:true` 显式越门=合法瘦身通道）/HTML div 开闭配对失衡拒；`?version=N` 历史版本预览槽（`X-App-Version` 头明示所服务版本）；republish 缺省元数据继承现值（title/description/created_by/code），`enabled=false` 仅下架市场列表——API/数据面不受影响（如需彻底下线走台 deprecate） |
| 类型系统 | 每类型定义探测语义（方法/路径/期望状态码，留空=任意响应即在线）+ 默认端口；内置 9 种（web/openai-api/ollama/gradio/streamlit/jupyter/mcp-sse/docs/market-app），可自定义 |
| 健康检测 | 单测/全部检测（并发限流、超时控制）、后台定时巡检（间隔可配，0=关闭） |
| 总览仪表盘 | 统计卡（点击深链 `/market?status=up\|down\|unknown` 直达过滤）+ 数据卡（在线率环/平均延迟/分类巡检/上次巡检）+ 可拖拽缩放卡片墙（布局存 localStorage，15s 自动刷新） |
| 使用页 | `/use/:id` 全屏内嵌（经 `/go/:id/` 统一门户同源代理，禁嵌站也能嵌）+ 顶部状态条 + 新窗口逃生 |
| 任务驾驶舱 | `/cockpit` 把常用 2-4 个工作台拼成一屏分屏视图（iframe 面板可拖拽/缩放/刷新/单独移除），布局存服务端自动保存；按场景建多个驾驶舱一键切换——从「收藏夹」到「驾驶舱」 |
| 统一门户 | `/go/<id>/` 反向代理全部工作台到 9800 同域：一个端口号直达所有台、同源消灭 CORS、自动剥除上游 `X-Frame-Options`/`CSP` 禁嵌头（实测 DENY 站点经代理可嵌）；支持 WebSocket 升级（Jupyter/MCP）与 3xx Location 前缀改写——从「登记簿」到「统一入口」 |
| 凭据注入 | 工作台可配置 Bearer/Basic 凭据，经 `/go/` 门户访问时代理自动注入 `Authorization` 头：token 不必再明文拼进 url（token-in-url 会泄漏进上游访问日志/Referer）；url 自带一次性 token query 而请求未带时自动补全，已持认证 cookie 则不补（防重签死循环）；凭据值在详情抽屉脱敏展示 |
| 待属主看板 | `/owner-pending`（管理员可看，**只有属主本人的 Odoo 登录能答复**）：全机唯一的「等属主决定或动手」清单。数据存在一张地址为本站 `/owner-pending` 的外部台的变量里：`config.owner` 由属主本人登记，`item.<NN>` 由登记身份（MCP 会话）写，`answer.<NN>` 由属主写，三类都是常量，页面只采信作者对得上的记录，其余列为「来源不符」并点名作者。服务端不新增接口。上线步骤、令牌吊销与轮换、已知限制见 [docs/owner-pending-board.md](docs/owner-pending-board.md) |
| 凭据库（融合 dsh-vault） | `/vault`（**要管理员**：口令或 Odoo 管理员）：加密保存账号/邮箱/手机/密码/TOTP/SSH/API Key/Secret/OAuth 令牌/银行卡——存储层原样复用 [dsh-vault](https://github.com/Ox0400/dsh-vault) v1.10.75（scrypt + AES-256-GCM，磁盘无明文，文件格式与写锁协议与 DSH 插件一致）；缺省库文件在 `DATA_DIR/vault/default.json`。`WM_VAULT_PATH` 可指向 DSH 插件那份 `$DSH_HOME/vault/default.json` 共用，但**上游插件进程常驻一份内存库、写盘前不重读文件，DSH 会话开着时两边同时写会互相覆盖（丢更新）**，页面会显著提示——只在一边写；检索/列表/回收站/安全体检只给无密摘要（自定义字段只给键名），完整密钥只在单条详情显式读取并记审计；动态验证码倒计时、强密码/口令短语生成与强度评估、弱密码/复用/未开 2FA/http 站点/到期轮换体检、软删→回收站→永久删除两步；**新建库主密码门槛**：至少 12 个字符、不能全是数字、不能命中常见口令表（SecLists 前 1 万条 + 变形）、强度不能为「弱」，不过就拒且不落盘（阈值在 `server/src/vault-policy/policy.ts`）；已有库照常解锁，主密码低于标准只提示建议更换；**读写都要管理员口令**，业务面一律 403；主密码只在进程内存，闲置由定时器主动上锁（取验证码不算活动）；解锁/上锁/重开串行，连错 5 次冷却 30s；外部改动自动重开、不删别的进程持有的写锁（写锁被占回 503） |
| 台生成器 | **来源只认 GitHub 仓库 main 分支**（属主 2026-11-02 收敛：非挂载类工作台即自产台与 SOP 台，见下「来源：GitHub main」）：把台的文件合进仓库 main，调 `POST /api/apps/<slug>/sync` 或 MCP `app_sync`，市场拉 main 头静态托管在 `/apps/<slug>/`，**发布即自动入册**（类型 market-app、探测短路=服务活着即在线），门户/驾驶舱/市场全链立即可用；**全版本快照**——同 slug 重发 = 新版本，`activate` 一键回滚任意历史版本——从「台的管理者」到「台的生产者」 |
| SOP 台 | 台生成器的 `kind:'sop'` 分流：`sop.yaml`（标题/编号/步骤，步骤 body 内嵌 HTML）发布为 SOP 台，`/sop/:slug/` 服务端渲染零构建执行页（步骤卡 + data-field 自动收集 + 800ms 防抖保存 + localStorage 缓冲 + 刷新恢复 run）；**状态机 draft→published→deprecated**（changelog 必填，draft 不入册防半成品上架）；执行数据**分层持久化**——状态层 Redis（HSET 热态 + 活跃索引，写路径 ~ms 级；不可达自动降级直写 SQLite；#442：没有进程内缓冲时，读热态出错一律 503 稍后重试，Redis 未连上时完成与升级也 503、等恢复，免得丢掉只在 Redis 里的已确认填写；#448：run 有只在 Redis、尚未落盘的已确认写入时 `sop_runs.hot_pending=1`，Redis 未连上期间该 run 的保存与备注也 503，任何一次落盘后自动清零。**人工处置**：Redis 里那份数据已确认永久丢失（被清空或换了实例）且等不到恢复时，运维确认后对该 run 执行 `UPDATE sop_runs SET hot_pending = 0 WHERE id = <run id>`——等于接受丢失那笔写入，之后按降级直写 SQLite）+ 持久层 SQLite（sop_runs 表为真源：开 run 钉版本、真实30s定时checkpoint（停写也落盘）、同run串行保存/finish，全量沉淀；Redis 条目 1h 平滑淘汰） |
| MCP 生产通道 | `/mcp` StreamableHTTP（stateless，零依赖手写 JSON-RPC 2.0）：AI 会话/任意 MCP 客户端直连市场，**33 个本地工具**（+ 上游聚合）——权限自助 2（**免授权**：任何已认证会话都能调，`tools/list` 始终列出）：`access_info`（会话名、已授权工具、完整工具目录——本地 + 上游，每项带 `category`=read/write/admin 与 `granted`——以及本会话提过的申请与状态；缺工具时先调它）/ `access_request`（`{tools, reason}` 申请授权：工具须在目录里、reason 必填 ≤500 字、同组待批去重、每会话每小时 ≤10 条；管理员在「MCP 网关」页「权限申请」批准 = 并入现有 grants，立即生效、同事务记审计；会话不能自己批，已吊销会话不能批）；**授权限定到单个台**（#452）：grants 与申请都可写 `工具@台id`（目前 `workbench_vars_get` / `workbench_vars_set` 支持），只对该台生效——调用前按 `id` 参数核对，台外与未授权同应答（MCP `-32601`、REST 403）并记审计 `not granted: workbench scope`；不带 `@` 的仍是全局授权；台不存在或工具不支持按台时 400，已持有的台被删除后下次保存从 grants 剔除（`dropped` 列明），申请批准前台被删则整单 409；这依赖台 id 自增不复用——**从备份恢复库或 `sqlite_sequence` 被重置时，先清理各会话 grants 里的 `工具@台`**；`access_info` 目录项带 `granted_workbenches`（限定到的台）与 `scopable`；生产 6：`workbench_list`（找台）/`workbench_summary`（总览）/`workbench_check`（探测）/`use_url`（取 `/go/<id>/` 门户入口）/`app_sync`（**从 GitHub main 重拉已登记来源的自产台与 SOP 台**；`app_publish` 与草稿三工具已随来源收敛移除）/`sop_publish`（SOP 上架·`app_activate` 已移出 MCP·回滚走变更申请）；变更申请 2：`change_request_create` / `change_requests`（回滚/删除统一评审门·REST approve 需 managed 口令+reviewed_by）；执行数据 6：`sop_run_start` / `sop_run_step_save`（直接更新持久化执行数据，与 Runner/REST 同链）/ `sop_run_get` / `sop_run_list`（`limit` 缺省 50·最大 200 + `offset` 翻页）/ `sop_run_finish` / `sop_run_sandbox`（VM sandbox 派发·LayerFS commit 交付）；技能 7：上传/发版/更新 = `skill_file_put`（**一次一个文件**，不收压缩包；文本原文、二进制 `encoding:"base64"`；单文件 ≤10MB；内容寻址暂存 24h）→ `skill_publish`（`files` 只列 `{path, sha256}` 引用暂存，一次成版：slug 不存在建技能发 v1，已存在发 N+1；缺文件点名 400；同技能同内容 409；审计人记调用会话；这两个是 admin 类需授权）；获取 = `skill_download`（签发 10 分钟下载票据 `GET /api/skills/dl/<票号>`，URL 不带会话令牌，单票至多下载 5 次，库里只存票号的 sha256，响应带 `Referrer-Policy: no-referrer`；同一版本的包逐字节可重现，应答带 `package_sha256`、`verify_script_sha256`、`tree_digest`，`install_command` 把三者写进命令：先核对整包哈希再解压，核对脚本哈希再执行，脚本再核对清单指纹，任何一步不符都停且不动已装版本；包里有符号链接、硬链接、设备文件，或清单里有绝对路径、`..` 段、目录名与包不一致，整包拒绝；`.tar.gz` 顶层目录为 slug 的 `:` 换成 `.`，内含清单 `.wm-skill.json` 与市场固定模板的校验脚本 `.wm-skill-verify.mjs`：`--install` 先校验包，再把 `~/.workbench-market/skills/<目录>` 旧版本移进 `.backups/`（每技能至多 3 个）后整体换上；不带参数运行列出本地被改的文件）。**迁移**：`skill_manifest`、`skill_file_get` 只在 #460 开发过程中出现过、未随任何版本发布，获取技能一律用 `skill_download`；`skill_publish` 不收内联 content，文件先逐个经 `skill_file_put` 上传/ `skills_list`（`active_version`＝市场当前版本即回滚指针；`current_version`＝本机钉装记录里的版本，两者不是一回事） / `skill_versions`（版本链·`active` 标市场当前版本） / `skill_install_plan`（钉装计划+expected digest·缺省取 `active_version`）——技能回滚（`POST /api/skills/:slug/activate` 或变更申请批准）只把 `active_version` 指针移到已有版本、不新增版本，不带版本号的取装/导出/下载/安装计划随之取它，发布新版恢复跟随最新；发布先写临时目录再整体改名，撞上库里没有的同名版本目录（旧回滚失败留下的）先挪进 `skill-snapshots/<slug>/.orphans/` 并打日志 / `skill_search`（**语义搜**：需求→jev 评估模型打分·P(true)>0.7 严格·≤3 降序·不可用报错不降级）；注册 CRUD 3：`workbench_register`（agent 自主登记外部台）/ `workbench_update` / `workbench_unregister`（凭据字段一律拒绝，人工配置）；台数据 4：`app_data_list`（读自产台表单提交数据）/ `app_data_submit`（写一条表单数据：与 `POST /api/apps/:slug/data` 同一写入核心——1MB 上限、台的数据契约校验，违约返回 400 与逐条 `violations`；可带 `idempotency_key` 重试不重复写）/ `app_files_list`（读文件提交列表，含下载 url）/ `app_files_upload`（base64 上传附件）——**只走 MCP 的 agent 也能登记台数据、上传附件**；工作台变量 2：`workbench_vars_get` / `workbench_vars_set`（#336：按 workbench id 隔离的看板变量与常量，revision 乐观锁，MCP 不能修订常量）；设计标准 1：`design_standard`（只读取 `DESIGN.md` token 与 `PATTERNS.md` 页面模式·`part`=tokens/guide/patterns/all·`section` 按标题过滤·带版本与源文件 sha256——agent 做台/页面前先取）；**上游聚合**（#20 P2）：`settings.mcp_upstreams` 配外部 MCP（如 taste-mcp），其工具以 `<prefix>__<tool>`（如 `taste__rules`）并入同一 /mcp 面，上游工具的类别按其 `annotations.readOnlyHint` 判（明说只读才算 read，否则按 write），上游不可达自动降级不影响本地 33 工具；网关会话存在时以 `X-Market-Client: mcp/<会话名>` 透传调用方身份（上游据此判 judge 身份）。**ygl-trees 上游**（#474）：`PUT /api/mcp/upstreams` 里写 `{prefix, kind:"ygl-trees", ygl_home:"<团队工作区绝对路径>"}`，市场自己启动服务端已装的 `ygl-trees mcp`（stdio，与统一待办同一个入口），把 `read`/`write`/`verify`/`doctor` 以 `<prefix>__…` 并进 /mcp，`read` 归 read、其余按 write；配置里不能写命令、参数或环境变量。工作区须是已存在的目录、先 `ygl-trees db init` 过，且不能是服务端自己的 `YGL_HOME`。子进程只拿系统变量，不继承市场的口令和密钥，`HOME` 指向工作区，`YGL_VERIFY_ALLOW_CMD` 显式置空（verify 的 command 型检查一律判 ERROR）；一个前缀一个子进程、调用串行，超时就杀掉、下次重启。团队用法：每个团队一个市场会话令牌，只读会话只授 `<prefix>__read`——市场从 REST 页面操作升级为 agent 可编程；已实测接入 DSH（dsh-mcp-connector，工具以 `mcp__workbench-market__*` 注入会话） |
| 台数据查看 | 工作台详情（market-app）→「查看提交数据」Drawer：表单数据行（JSON 折叠/提交者/时间）+ 文件（类型/大小/下载）+ 游标加载更多——数据落库后在 UI 直接可查 |
| 工作台变量与常量 | `/api/workbenches/:id/vars`（#336）：每个登记台（自产台、SOP 台、外部 Web 台、Odoo 台）按 workbench id 各有一份隔离的键值空间，供看板读写——`GET …/vars`（列举·`prefix` 过滤）、`GET/PUT/DELETE …/vars/:key`；值是任意 JSON（≤64KB，每台 ≤512 键）；**乐观锁**：每次写 revision +1，改/删已存在的键必须带 `If-Match` 或 `revision`，缺 428、不符 409，响应都带 `current_revision` 与当前值；`kind:'const'` 写入后不能直接改、删，**谁写的谁维护**：新建时记作者 `owner`（只认个人身份 `mcp:<会话名>` / `odoo:<登录名>`），作者本人带 `override` 与 `reason` 可修订、删除（REST 或 MCP `workbench_vars_set`）；口令管理员、Odoo 管理员不因此就能动别人的常量；作者缺失或要移交（`owner` 字段）只由部署机本机命令行兜底；按台令牌注入在页面里、人人可得，不能新建常量（`const_create_forbidden`）。审计表只记值的 sha256，操作者落到 `mcp:`/`odoo:`/`admin-token`/`cli`（`GET …/vars/:key/audit` 管理员读）。**读写口径**：本机命令行与管理员（口令或 Odoo 管理员）可读写任意台；自产台、SOP 台页面凭本台 `X-App-Token` 只能读写本台（沙箱 `Origin: null` 有 CORS）；外部台没有按台令牌，只有管理员能读写；匿名一律 403。只存 SQLite，写返回即落库，不经 Redis。删台时变量随台删除、审计保留 |
| SOP 管理页 | `/sops`：SOP 台的消费与管理面——状态徽章可视化状态机（draft/published/deprecated，色值经对比度审计）、版本链与 changelog、**run 记录 Drawer**（直查分层持久化的执行数据：运行中/已完成、步骤数、逐步骤填报数据展开）、页面上架/废弃操作、执行入口直达 Runner；演示 SOP（demo-rack-sop）常驻可点击体验 |
| 备份迁移 | 全量 JSON 导出 / 导入（合并或替换模式） |

## REST API（节选）

```
GET/POST         /api/workbenches          列表（q/type/category/status 过滤）/ 新增
GET/PUT/DELETE   /api/workbenches/:id
POST             /api/workbenches/:id/check     立即探测并回写状态
POST             /api/check-all                 并发检测全部启用项
GET              /api/summary                   总数/在线/离线/平均延迟/分类聚合
GET/POST         /api/types                     类型列表/新增（key 唯一）
PUT/DELETE       /api/types/:id                 web 内置类型禁删禁改语义；被使用禁删(409)
GET/PUT          /api/settings                  巡检设置（间隔/超时/并发）
GET/POST         /api/cockpits                  驾驶舱列表/新增
GET/PUT/DELETE   /api/cockpits/:id              驾驶舱详情/改名与面板布局/删除（面板引用校验：工作台不存在或重复引用 → 400）
ANY              /go/:id/*                      统一门户反向代理（剥禁嵌头/Cookie 域改写/WS 升级/凭据注入；id 不存在 → 404）
GET              /api/apps                      自产台列表（POST 直接传文件发布已关闭 → 410，task-center 内置元台除外）
POST             /api/apps/:slug/sync           从 GitHub 仓库 main 头同步一版（body: {source_repo?, source_path?, title?, kind?, code?, description?, changelog?, force?}；首次须带 source_repo；同 commit 重拉 unchanged:true；入册即用）
GET              /api/apps/:slug                详情 + 全版本链
POST             /api/apps/:slug/activate       版本回滚 {version}
DELETE           /api/apps/:slug                删除（文件树 + 版本链 + 市场注册一起清）
GET              /apps/:slug/*                  自产台静态托管（当前生效版本；无扩展名深链回退 index.html）
GET              /sop/:slug/*                   SOP Runner 执行页（published；draft → 403；只打开不建 run，第一次保存/上传/完成才建）
GET              /api/sops                      SOP 台列表（含状态与版本）
POST             /api/sops/:slug/publish        draft/deprecated → published（首次入册）
POST             /api/sops/:slug/deprecate      published → deprecated（市场行停用）
POST             /api/sop/runs                  开 run（钉 sop_version；Redis 初始化）
GET              /api/sop/runs/active           活跃 run（Redis 快路径，miss 回落 SQLite）
GET/PUT          /api/sop/runs/:id              run 详情 / 步骤保存（{stepKey, value}；Redis 热写 + 30s checkpoint）
POST             /api/sop/runs/:id/finish       归档（热态全量沉淀 SQLite，Redis 条目 1h 淘汰）
GET              /api/sop/runs/:id/upgrade-preflight  进行中的 run 升级到当前 SOP 版本前的预检：旧/新规则各核一遍，列新增、失效字段和没处放的数据（要 run 读授权）
POST             /api/sop/runs/:id/upgrade      升级到当前版本（管理员或本机命令行，reason 必填，可带 expected_version）；已填数据原样保留，未落盘缓冲一并写回，审计入 sop_run_upgrade_audit
POST             /api/sop/runs/:id/files/refs   引用已有文件（分批，单次 ≤200 条）：items=[{run_id,file_id,read_capability} | {sha256}]，只限同一 SOP；按 run/文件引用要带源 run 读凭证（管理员免），按 sha256 只限管理员；逐条回 linked/duplicate/failed+原因；引用与源共用存储、不占上传配额（20 个/200MB），另限 2000 条；GET …/files 回 quota
POST             /mcp                           MCP StreamableHTTP（initialize/tools/list/tools/call；30 本地工具；GET/DELETE → 405）
GET              /openapi.json                  MCP 工具的 OpenAPI 3.1 文档（同 /api/mcp-rest/openapi.json；只列本会话可调用的工具；会话令牌必带）
POST             /api/mcp-rest/tools/:name      按 REST 调一个 MCP 工具：请求体 = 工具参数，返回工具结果 JSON（会话令牌必带；见「MCP 工具的 REST / OpenAPI 开放」）
PUT              /api/mcp-rest/apps/:slug/files/:name  原始字节上传（流式落盘 ≤100MB，返回 id/sha256/mime/url；需 app_files_upload）
POST             /api/mcp-rest/apps/:slug/files        multipart 上传（字段 file + note/created_by；需 app_files_upload）
GET              /api/mcp-rest/apps/:slug/files        列文件（分页 + quota；需 app_files_list）
GET              /api/mcp-rest/apps/:slug/files/:id    二进制下载（Range / ETag=sha256；需 app_files_list）
GET              /api/mcp-rest/apps/:slug/data         读台数据（分页；需 app_data_list）
GET              /api/mcp-rest/sop/runs/:id[/files[/:fileId]]  SOP run 元数据 / 附件列表 / 附件下载（需 sop_run_get；附件另需 run 读授权）
POST             /api/apps/:slug/data            自产台数据写入（JSON ≤1MB；按台的 data-contract.json 校验（必填/枚举/格式/条件规则 when 可带 require·equals·pattern/数组对象 items 可带自己的 when），违约 400+violations；契约规则合计 ≤500 条，超出时发布/同步即拒；{data, idempotency_key} 信封或 Idempotency-Key 头幂等——沙箱台页（源为 null）预检只放行 content-type、x-app-token，只能用信封；台页 iframe 同源 fetch 直通）
GET              /api/mcp/access-requests        MCP 权限申请列表（?status=pending|approved|rejected；管理员）
POST             /api/mcp/access-requests/:id/approve  批准：工具并入会话 grants（并集）+ 审计，同一事务；已吊销会话 409（管理员）
POST             /api/mcp/access-requests/:id/reject   驳回：grants 不变，记审计（管理员）
GET              /api/apps/:slug/data            自产台数据列表（游标分页 ?limit=&before_id=）
POST             /api/apps/:slug/files           自产台文件提交（multipart 任意类型 ≤100MB；超限 413）
GET              /api/apps/:slug/files           文件列表（游标分页）
GET              /api/apps/:slug/files/:id       文件下载（content-type + nosniff；非白名单强制 attachment）
GET              /api/vault/status              凭据库状态（库文件/是否解锁）——/api/vault/* 读写全部要管理员（口令或 Odoo 管理员）·浏览器须同源·no-store
POST             /api/vault/unlock|lock         解锁（{password}·连错 5 次冷却 30s·库不存在=新建，过主密码门槛，不过回 400 vault_weak_master + reasons）/ 上锁；未解锁时数据接口回 423
POST             /api/vault/master-check        新建库主密码实时校验（{ok, reasons, strength}·与 unlock 同一门槛）
GET/POST         /api/vault/entries             无密摘要列表（q/kind/tag）/ 新增
GET/PUT/DELETE   /api/vault/entries/:id         完整条目（含密钥·记审计）/ 更新（空串=清除）/ 移入回收站
GET              /api/vault/entries/:id/totp    当前动态验证码 + 剩余秒数
GET              /api/vault/trash · POST …/:id/restore · DELETE /api/vault/trash/:id   回收站 / 恢复 / 永久删除（只对回收站内条目）
POST             /api/vault/generate|strength   生成密码或口令短语 / 强度评估（POST，密码不进 URL）
GET              /api/vault/health|history      安全体检（复用项不回明文）/ 活动记录（新→旧 200 条）
GET              /api/export                    全量导出
POST             /api/import?mode=merge|replace 导入
GET              /api/health                    存活：版本与运行时长（不发外部请求；配了 LayerFS 时回缓存的上次就绪结果）
GET              /api/health/ready              就绪：含 LayerFS 探测（结果缓存 10 秒），不健康 503
```

### A2A P3 回执（评审席 network/a2a-receipt）

派单 run 完成时向**绑定上人填的 `callback_url`** 投递回执（`[A2A receipt] task <id>` + 上游 `receipt.ts` 信封，outcome=completed、幂等键 `run-<id>-finished`）；
自报 callback 与绑定不一致 → 不投递且 `receipt=rejected:callback-mismatch`；人自己开的 run 不回执。outbox 退避 1m/5m/15m/1h、5 次后 dead（`A2A_OUTBOX_BACKOFF_SCALE` 可加速）；`GET /api/sop/runs/:id` 返回 `receipt`（none/pending/sent/dead/rejected:*）。

### A2A peer 宿主（上游实现承载，2026-10-23 主人裁定）

市场**不自己实现 A2A 协议**：`PEER=on` 时市场进程启动上游 `dsh-open-a2a-net` 插件宿主（`scripts/a2a-peer.mjs`，真实 Cordis 宿主 + WebServer），
签名卡片、`/a2a/direct` 入站、幂等、回执、账本全部由上游实现承担；市场只做三件事：

| 职责 | 位置 |
|---|---|
| 生命周期 | `server/src/index.ts`（`PEER=on` 拉起、退出 5s 重启、`GET /api/a2a/peer` 状态） |
| 业务桥接 | `scripts/a2a-peer.mjs` 的桥接 agent：入站派单 → 市场 REST 开 SOP run；自由文本 → 收件确认 |
| 出站发件 | `POST /api/a2a/peer/send` → peer 控制面 `/__bridge/send` → 上游 `a2a_route` 工具 |

环境变量：`PEER=on`（启用）· `PEER_PORT`（默认 9900）· `PEER_CTL_PORT`（默认 9901）· `PEER_HOME`（密钥与 peers.json）·
`PEER_PEERS`（种子对端）· `PEER_TEAMS`（队声明，精确队名，写入上游 `teamJoinAllowlist` 并由桥接代 join）。

冒烟：`node --import ./scripts/a2a-peer-loader.mjs scripts/a2a-peer-smoke.mjs`（双 peer 真实 HTTP，11 项）。

### 信任模型与远程写面（主人裁定 A，2026-10-23）

**管理员**（属主 2026-11-02 裁定，撤销 #292 M1「管理写只认控制面」）：满足任一即为管理员——
- **管理员口令**：请求头 `X-Admin-Token`。`设置` 页或顶栏钥匙图标输入（口令只存本标签页 `sessionStorage`，离开页面即清）；库存**加盐**哈希 `salt$sha256(salt+口令)`，settings/导出出口一律剔除该键。优先级：启动环境 `ADMIN_TOKEN` > 页面设置值 > 无。首次设置限本机（CLI 或本机同源页面）或 Odoo 管理员；改/清要带当前口令或 Odoo 管理员。
- **Odoo 管理员登录**：浏览器带着 Odoo 会话（`session_id`）访问时，服务端向 `WM_ODOO_URL` 现查 `get_session_info`，内部员工且 `is_admin=true` 即为管理员，不需另输口令；结论按会话哈希缓存 30 秒（Odoo 侧撤权最迟 30 秒生效）。`GET /api/admin/whoami` 返回当前身份（`via: token|odoo|null`），顶栏显示「Odoo 管理员 · 登录名」。
- 浏览器发来的管理写（带 `Origin` 或 `Sec-Fetch-Site`）在业务面即可做，但必须同源：跨源 `Origin` 或 `Sec-Fetch-Site: cross-site` 一律 403（Odoo 会话 cookie 是环境凭据，防跨站借用）。
- 持口令时使用页/驾驶舱不内嵌 `/go/`、离开市场页面即抹掉口令（#292 M4 止血保留）。
- **可选独立管理端口**：`WM_CONTROL_PORT` 显式给端口才开（缺省不开）；开了时它不提供 `/go/`、`/sop/`、`/apps/`、`/mcp`、`/openapi.json`、`/api/mcp-rest/*`、`/a2a/*`（404），响应带 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY`，管理写规则与业务面相同。
- 本机 CLI（回环直连、**不带** `Origin`/`Sec-Fetch-Site`、**没有** `X-Forwarded-For`/`Forwarded`/`X-Real-IP`）照旧免口令；逐路由自带 `adminGuard` 的写接口仍要口令。同机反代转进来的请求按远程处理。Node 自带 `fetch` 只发 `sec-fetch-mode`，按 CLI 算。
- web dev（vite 5173）：**默认关闭**；只有显式开启（`pnpm dev` 自带的 `--dev-origin` 启动参数，或 `WM_DEV_ORIGIN=1`）时，Origin 为本机 dev 源且本机直连的请求视同同源（仍要口令）。生产 `pnpm start` / 容器不开。
- **远程节点**（非 loopback）：写请求只放 `/mcp`、`/api/mcp-rest/tools/<name>` 与 `/api/mcp-rest/apps/<slug>/files[/<name>]`（路由内凭会话令牌鉴权）、`.well-known/agent-card.json`、`/a2a/direct`，以及**自产台数据/文件面**（`POST /api/apps/<slug>/data`、`/files`）——应用层写与发布面同口径（远程浏览器提交表单不会被 403）。
- 管理写（`/api/mcp/*` 会话令牌、SOP 绑定、工作台 CRUD 等）一律要管理员（口令或 Odoo 管理员），否则 403。

**主体**：登录认出的人要对到一个主体上才算数。主体是「谁」的那一张表（`principals`），五类——人 `user:<名>`、席位 `seat:<名>`、台 `app:<slug>`、系统 `system:<名>`、外部节点 `node:<团队>`；不是人的主体必须有责任人。现在只有「人」在用，其余四类只建好了结构。
- **外部身份**（`principal_identities`）挂在主体上：提供方 + 对方的用户标识唯一，一个主体可以有多个。现有登录认出一个人时，第一次见到就建一个 `user:<登录名>` 和一条外部身份，之后都是同一个主体。留痕里的旧写法 `odoo:<登录名>` 就是这条外部身份（提供方 `odoo`、标识是登录名），历史记录不用改。
- **停用**是本地动作：停用一个主体，所有认人的入口立即不认它——登录门、`/api/auth/viewer`、管理员认定、统一待办读权、SOP 运行读授权、内容面、交给扩展的认人；恢复之后立即照常。提供方的回答可以缓存（管理员认定和登录门各 30 秒），主体停没停用每次现查，不进缓存。共用数据目录的多个实例同样立即生效，重启不丢。
- 标识已经被别的主体占着、这个外部身份却没绑定：不自动认领（那等于让一个外来账号顶替已有的主体），登录不认，要管理员处理。「占着」按规范化之后的值比，规范化用 Unicode 的 NFKC_Casefold（完整大小写折叠加 NFKC，去掉零宽一类的默认可忽略字符；不用土耳其语规则）：只差大小写（含 ß、ẞ、SS）、全角半角、连字、夹零宽字符的写法算撞上，同样不认、不另建（表上按规范化值建了唯一约束）；只拒不并，原值照存。`scripts/principal-fold-test.mjs` 在全部码位上对照 Unicode 的派生属性核对它。
- **管理接口**（都要管理员：本机 CLI、口令或 Odoo 管理员）：`GET /api/principals` 列出全部主体和各自的外部身份；`POST /api/principals/disable`、`POST /api/principals/restore`，请求体 `{"id":"user:<名>","reason":"…"}`，行上记下最近一次是谁、什么时候、为什么。管理员不能停用自己。口令和本机 CLI 不是主体，停不掉，留作应急。
- **对一次外部身份**（都要管理员）：`POST /api/principals/bind` 请求体 `{"provider":"…","external_id":"…","principal":"user:<名>","create":false,"reason":"…"}`，把一条外部身份绑到一个启用的人身上，`create: true` 时目标不存在就新建这个人；`POST /api/principals/unbind` 请求体 `{"provider":"…","external_id":"…"}`。已经绑在别处的（含等价写法）不能直接改绑，要先解绑；管理员不能动自己名下的绑定。变体写法先登录、把本人挡在外面的：先解绑旧写法，再把新写法绑到原来的主体上。每次绑定、解绑写一行日志。
- **规范化依赖 Node 自带的 Unicode 数据**：已经分配的字符，折叠和规范化的结果按 Unicode 的稳定性承诺不会变；换 Node 版本时只有新分配的字符可能变。库里存的规范化值不重算，所以换版本不会让启动撞唯一约束；极少数情形下（登录名里有新分配的字符），撞名检查会多拦或漏拦一次。
- **市场自己的会话**：用飞书等「登录方式」登录之后，发一个市场会话（cookie `wm_session`，库里只存哈希）。绝对期限 `WM_SESSION_TTL_MIN`（缺省 12 小时），不续期；`POST /api/auth/logout` 注销即失效；主体停用立即失效（认人时连着主体状态查），停用时这个人的会话全部注销，恢复之后要重新登录。请求同时带着市场会话和 Odoo 会话时按市场会话算；两边认出的不是同一个人时留一行痕（`source: identity`、`event: session-mismatch`，两边各认成谁），同一对会话只记一次。会话登录的人不是管理员（角色和授予在阶段六）。
- **飞书登录**（`WM_FEISHU_LOGIN=on`）：标准授权码流程，`GET /login/feishu?next=<站内地址>` 发起，回调 `/login/feishu/callback`。回调地址按 `MARKET_PUBLIC_URL` 拼，要和飞书应用里登记的一致。`state` 一次性、绑在发起它的浏览器上、10 分钟有效、按来源限额；`next` 只收站内路径。飞书应用的标识和密钥从凭据库里的一条（`WM_FEISHU_VAULT_ENTRY`）取，要部署方配了服务端主密码（`DSH_VAULT_PASSWORD_FILE`）才能无人值守读；库锁着时飞书登录回 503。认人用 union_id。还没对到主体的飞书身份：不自动建主体，停在「等管理员开通」，列进 `GET /api/principals/pending`，管理员用 `POST /api/principals/bind` 对一次，第一批上线可以用 `POST /api/principals/bind-batch`（请求体 `{"items":[{"provider","external_id","principal","create"}…],"reason"}`，一次最多 500 条，逐条给结果）。待对接清单只放对方的用户标识、显示名、企业邮箱和最近一次来的时间，30 天没再来的清掉；等待页对停用的和没对到主体的一模一样，不透露有没有这个人。打开 `WM_FEISHU_AUTO_BIND_EMAIL` 时，飞书企业邮箱和身份来源的登录名（按规范化之后）恰好对上一个启用的人、而且那个人还没有别的飞书身份，才自动绑，每次自动绑定留一行痕。
- **离职即时失效**：飞书事件订阅的请求地址填 `<MARKET_PUBLIC_URL>/login/feishu/events`，订阅「员工离职」`contact.user.deleted_v3` 和「员工信息被修改」`contact.user.updated_v3`，并配 Encrypt Key。Encrypt Key、Verification Token 放在凭据库同一条（`WM_FEISHU_VAULT_ENTRY`）的自定义字段 `encrypt_key`、`verification_token` 里。照飞书文档验签（时间戳 5 分钟内、`X-Lark-Signature`）、解密、核对 Token 和 App ID；验不过 401。同一个事件号只处理一次（多实例共用、保留 7 天）；记事件号和停用在同一个事务里，停用出错事件号一起撤回，飞书重推时照常处理。处理出错只回固定的 503（`event_unavailable`），内部原因只进日志。离职、被修改成离职、冻结、退出的人：停用他绑着的主体，每个入口立即不认，会话一并注销；还没对到主体的从待对接清单里删掉。配了租户时别的租户的事件不处理。
- **每日对账**：每天一次把绑在启用的人身上的飞书身份交给飞书查（`tenant_access_token` 加按 union_id 查人），状态明确说离职、冻结、退出的才停用；飞书出错、查不到的一个也不停用，只计数留痕。管理员可以手动跑一次：`POST /api/principals/reconcile`，请求体 `{"flow":"feishu"}`。**补不上的情形**：飞书那边直接删掉的人，如果「员工离职」事件也丢了，按 union_id 查回来是「不存在」，对账按查不清处理、不停用，每天留痕里的 `unknown` 会一直算上他。`unknown` 不为 0 就要人工复核：留痕的 `unknown_ids` 列出查不清的 union_id（最多 100 个），对着飞书通讯录核对，确认离开了由管理员手动停用（`POST /api/principals/disable`）。
- 管不到的：按 run 发的读凭据、自产台查看凭证是不记名的，各有各的期限和吊销，不随主体停用失效；已经建立的 WebSocket 连接不会被掐断，新的请求和新的连接立即拒绝。停用是按登录名对的：身份来源那边把登录名改了，就是另一个人。
- **读面不拦**：远程 agent 用 `GET /api/apps/<slug>/data`、`/files` 直接读提交数据（掩码策略只作用于凭据，不作用于业务数据）。

## 设计 token（给 SOP 执行页与自产台）

唯一事实源是仓库根的 `DESIGN.md`。`node scripts/gen-design-tokens.mjs` 生成 `web/src/tokens.css`，即 `--wm-*` 变量。市场前端、SOP 执行页、自产台用的都是这一份。

- **自产台**：在页面 `<head>` 里引入 `<link rel="stylesheet" href="/design/tokens@1.css">`。经市场门户（`/apps/<slug>/`、`/go/<id>/`）打开时是同源的。正文、状态、面与线只用 `--wm-*` 变量，不抄色值；可以另加自己的品牌色。完整示例见 [docs/examples/self-built-tokens.html](docs/examples/self-built-tokens.html)。
- **路径与契约**（DESIGN.md「CSS 变量契约」：**名字稳定、值可变**）：
  - `/design/tokens@<主版本>.css`（现为 `@1`）：推荐用这个。主版本内只改值、不改名，响应 `no-cache`，值更新后自动生效。
  - `/design/tokens@<完整版本>.css`（现为 `@1.0.0`）：精确钉版本，内容不变，可长期缓存。
  - 其他版本一律 404。改名或删名要升主版本，并保留旧名一个版本做别名。
- **SOP 执行页**（`/sop/<slug>/`）：服务端把同一份变量内联进页面，不另发请求。页面样式只用变量，顶栏是深色区，用 `nav-*`。
- agent 可以经 MCP 工具 `design_standard` 读取 token 与页面模式。

## 目录

```
server/src/     index.ts（REST+静态+巡检装配） db.ts（schema+迁移） portal.ts（/go/ 反代·白屏五层+登录态） a2a.ts（卡片/绑定/direct 准入） a2a-direct-sig.ts（/a2a/direct 入站签名校验：只从登记地址取卡·防重放·WM_A2A_DIRECT_SIG） eval.ts（#178 jev 评估客户端） mcp-tools.ts（MCP 工具注册表） sop-runner.ts（SOP 执行页） redis.ts（SOP 状态层） sop-state-checkpoints.ts（#337 热写检查点：逐 run 串行与 SQLite 落盘期限） health.ts（探测） tasks.ts（定时任务） task-center.ts（任务中心元台种子+收件发布） endpoint-stats.ts（端点数） errors.ts（错误类型） context.ts（服务容器） sop-types.ts（SOP 类型） identity.ts（身份契约：核心只经它认人·Cordis 服务 `identity` 认人与 whoami、`loginRelay` 业务台登录中继的窄接口·`/api/auth/viewer`·提供方认出的人要对到主体上才算数，主体停用即不认） root-context.ts（全进程唯一的 Cordis 根上下文·不开数据库） extensions.ts（扩展挂载点·WM_EXTENSIONS_DIR） surfaces.ts（#292 M1 业务面/控制面多端口监听·按 localPort 判面·浏览器标记与回环判定） content-access.ts（内容票据与准入） content-surface.ts（内容面终结分发与到期引导） portal-observation.ts（无敏感原文的被动计数） url-admission.ts（#258 R3 业务 URL 登记准入单核·WM_REGISTER_URL_ALLOWLIST） vault-api.ts（凭据库 REST 面） workbench-vars.ts（#336 工作台变量与常量：按台隔离、revision 乐观锁、常量保护） vault/（dsh-vault 存储层引入件·见其 README） content-static.ts（无令牌静态资产读取） sop-readonly-channel.ts（只读隔离字段通道） sop-readonly-assembly.ts（冻结清单与run装配） sop-run-access.ts（run授权、能力与revision事务） sop-field-channel.ts（字段/上传/人工完成通道候选） sop-field-save.ts（未挂载字段保存路由） sop-field-upload.ts（未挂载惰性文件上传路由） sop-field-finish.ts（未挂载人工完成路由） sop-read-auth.ts（#309 run 私有读授权：读能力 + 主体 grant） design-standard.ts（MCP design_standard 工具的 design token 标准只读读取） design-tokens-css.ts（DESIGN.md 生成的 tokens.css 服务端出口） workbench-events.ts（工作台事件层 v1：人提交→事件→团队接单→决定回写） tasks-read-access.ts（#324 待办身份与来源授权） startup-security-self-probe.ts（#326 启动匿名安全面自检与门闩） github-source.ts（GitHub main 分支来源拉取：commits/trees/blobs 三段取内容·版本记 commit sha） layerfs-shadow.ts（LayerFS 影子发布结果持久化：只回写 commit_id 为空的版本行，失败标记后可重试） app-data-contract.ts（自产台数据契约：必填/枚举/格式/条件规则（含条件格式）/数组对象逐元素，POST 数据时服务端权威校验） file-sniff.ts（上传按内容识别类型：签名为准、扩展名与内容不符或可执行文件拒收） sop-field-rules.ts（SOP 字段规则：从步骤 HTML 读 required/pattern/长度/类型、条件必填 data-required-if、字段间数值关系 data-check 与文件清单 data-type="file-list"，完成时服务端校验，文件清单另按文件面实际 hash 逐行核） login-gate.ts（全站登录门 WM_LOGIN_GATE：enforce 时页面 302 登录、API 401） sso-ticket-store.ts（门户 SSO 回调一次性票据的 SQLite 存储：重启不丢、多实例原子取出）
server/src/login-providers/  登录提供方插件（身份的具体实现只放这里，核心不引用）：index.ts（清单：这个部署装哪些提供方） feishu/index.ts（飞书登录方式：授权码流程，向 `identity` 登记一个登录方式，凭证从凭据库取） odoo/index.ts（Odoo 提供方的插件入口：向 `identity` 登记、提供 `loginRelay`） odoo/odoo-viewer.ts（Odoo 查看人现查） odoo/odoo-session.ts（门户 Odoo 会话可信源判定与剥除、登录回调票据） odoo/odoo-login-proxy.ts（可选同源 Odoo 登录中继 WM_ODOO_LOGIN_PROXY：只放行登录面，不代理 Odoo 应用） odoo/odoo-browser-origin.ts（只给浏览器用的 Odoo 登录地址 WM_ODOO_BROWSER_URL：登录一跳送到可信内网地址，身份与代理目标不变）
server/src/services/  app·app-data·sop·skill·sandbox·cockpit·workbench·cookie·setting·mcp（域服务）· principal.ts（主体与外部身份：Cordis 服务 `principals`·把登录认出的人对到主体·停用与恢复）· login-session.ts（市场会话与登录 state：Cordis 服务 `loginSessions`·绝对期限·注销与停用即失效·state 一次性并绑浏览器）· binding.ts（A2A 人工绑定）· work-item.ts（事项与事项日志：Cordis 服务 `workItems`·按迁移表推进状态的唯一入口 `apply`·日志只增不改；阶段八，还没接来源、没有路由）· sop-runner.ts（执行页）
server/src/http.ts    HTTP 服务（Cordis 服务 http）：持有 Express 应用；域模块经它注册路由，注册可撤销
server/src/routes/    按域分的路由模块，各带一个注册函数：types.ts（类型管理 /api/types） cockpits.ts（驾驶舱 /api/cockpits） cookies.ts（Cookie 池 /api/cookies） stats.ts（端点命中统计 /api/stats） design-tokens.ts（设计 token 固定路径 /design/tokens@<版本>.css） agent-card.ts（A2A 签名卡片 /.well-known/agent-card.json） sso.ts（SSO 回调 /sso/callback） summary.ts（首页总览 /api/summary） content-observation.ts（门户观测状态 /api/content/observation） auth-viewer.ts（登录探测 /api/auth/viewer） principals.ts（主体管理 /api/principals：列出、停用、恢复、对一次外部身份、待对接清单，只有管理员能用） login-flows.ts（登录方式 /login/<方式> 与回调：state、next、对到主体、发市场会话） login-events.ts（离职即时失效：/login/<方式>/events 失效通知、每日对账） settings.ts（设置 /api/settings） admin-token.ts（管理口令 /api/admin/whoami、/api/admin-token） bindings.ts（A2A 人工绑定 /api/bindings 和退役的旧面） export-import.ts（导出与导入 /api/export、/api/import） principals.ts（主体管理 /api/principals：列出、停用、恢复，只有管理员能用） workbenches.ts（工作台 /api/workbenches、/api/check-all） sop-page.ts（SOP 执行页 /sop/<slug>/：执行页和附件）
web/src/        pages/（Dashboard/Market/Sops/Types/Settings/UseWorkbench/Cockpit/McpGateways/Tasks/Skills/SopSpace/SopRunDetail/Vault/Reviews/OwnerPending） components/ admin-token.ts（统一口令注入）
deploy/         Dockerfile.market（多阶段·非 root·HEALTHCHECK） docker-compose.yml（回环默认·profiles 隔离） layerfs-svc.mjs
docs/           layerfs-service-contract-v0/v1.md（LayerFS 服务契约）
data/           SQLite 数据文件（git 忽略）
```

`server/src/mcp-stdio-upstream.ts`（#474）：`settings.mcp_upstreams` 里 `kind` 为 `ygl-trees` 的上游不走 HTTP，由市场启动 `ygl-trees mcp`（stdio）子进程，工作区取该项的 `ygl_home`。子进程只拿运行必需的系统变量，不继承市场的口令和令牌；它的 `YGL_SESSION` 由市场设成 `market-<前缀>`。

结构上的约定（新东西该写在哪）见仓库根的 `CONTRIBUTING.md`。`node scripts/tech-route-check.mjs` 把这些约定量成数字，对照 `tech-route.json` 里的基线；CI 每次把体检表写进摘要页。预算档的检查比基线多了、红线档的检查高于目标，CI 就失败；其余只报告。每项现在是哪一档，以 `tech-route.json` 为准。

路由正在按域从 `server/src/index.ts` 搬进 `server/src/routes/<域>.ts`，终点是 `index.ts` 只做装配。域模块导出一个注册函数，`index.ts` 在这组路由原来的位置调用它，所以挂载顺序不变。注册经 HTTP 服务（`server/src/http.ts`）：路由还是挂在同一个 Express 应用上，处理函数原样传入；每次注册都能撤销，由插件注册的随插件卸载一起撤销（`scripts/http-service-test.mjs`）。搬一个域是纯移动，下面的路由快照和录制回放都必须零差异。

对外的面有三份快照，放在 `surfaces/`：路由（带挂载顺序）、MCP 工具、表结构，由 `scripts/surface-snapshot.mjs` 从一个隔离实例里导出。改了面就加 `--write` 重新生成，把快照和代码一起提交。

快照管的是「有哪些路由、按什么顺序」，应答对不对由录制回放管。`surfaces/replay/<域>.json` 里是一组请求和录下来的应答：状态码、响应头、响应体。`scripts/route-replay-test.mjs` 按场景各起一个隔离实例，对同一组请求重放，有一处不一样就失败。搬路由之前先录，搬完重放必须零差异。有意改了行为，就加 `--record` 重录，把录制和代码一起提交。

每次都不一样的东西不比：`Date`、`Connection`、`Keep-Alive` 三个头不录；时间里的数字换成占位，写法留着（所以时间的写法变了看得出来）；按内容算出来的 ETag 只留长度。值每次都变的响应头（比如带随机会话号的 `Set-Cookie`）现在还没有换占位的办法，搬到有这种头的域之前要先补。

应答里由「现在」算出来的数（还有几天过期、今天是哪一天）每次也不一样。这样的场景在请求集里写一个 `clock`（ISO 时刻），实例的时钟就从那一刻开始走（`scripts/replay-clock-preload.mjs`，只在测试环境可用），这些数才能录下来比。数据库自己取的时间不受影响。应答体里每个实例随机生成的值（密钥、签名），在那条请求上写 `vary`：点名的字段换成占位，只留类型和长度；由「现在」算出来、带毫秒的数也可以点名，往下取整再比。`vary` 之后签名只比长度，所以签名卡片的请求另写 `verify: "a2a-card"`：换占位之前先用卡片里的公钥验签名，验的结果录下来比。要认人的路由，场景写 `fixtures: ["identity-fake"]`，登录提供方换成假的（`scripts/identity-fake-provider.mjs`，只在测试环境可用），不访问外部系统。

每条路由都要有未授权、参数非法、正常三类请求。类别按录下来的应答核对：未授权是 401 或 403，参数非法是其余的 4xx，正常是 2xx 或 3xx；请求上标的类别和应答对不上，脚本就失败。确实没有某一类的路由（比如不读任何参数，就没有会被拒的输入），在请求集的 `exempt` 里写明理由，并指给一条打在这条路由上、照常应答的请求。

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。


> **验证资产为本地产物不入库**（隐私治理·监督席处置单）：`evidence/`、`verify/`、`tmp/` 已 gitignore——E2E 摘要/判据冻结包/运行截图属本机生成物，fresh clone 后先跑一轮 E2E 再 make-submission（摘要门 fail-closed 即本义）。冻结报告另存 `~/.ygl-trees/verify/archives/`（zip 可携带）。**既有克隆合并 untrack 批后须恢复本地验证资产**（untrack=索引删除语义·合并即删工作树文件·全机验证链静默断）：`git checkout <untrack 前 SHA> -- evidence verify && git restore --staged evidence verify`——文件回工作树·不回流索引·gitignore 罩住。**净克隆自举**（#95 修正）：`verify/material.md`/`candidates.json`/`reviews.json` 三件套由 `node scripts/gen-verifier.mjs` 从**单一事实源再生成**（生成器自建 `verify/` 目录·净克隆一条命令重建 175 判据）。干净克隆跑验证链步骤：`node scripts/gen-verifier.mjs` → 跑一轮 E2E 产 `evidence/e2e-summary.json`（摘要门 fail-closed 即本义）→ `node scripts/make-submission.mjs --source-db <绝对库路径> --target-mode isolated --isolated-root <合成数据根>` → `ygl-trees verify submit/prepare/run`。


### 文件面 URL 语义（#164 P1②）

| 面 | 语义 |
|---|---|
| `POST /api/apps/:slug/files` | multipart 上传（`file` 字段·≤100MB）；可带 `note`/`created_by` 表单字段 |
| `POST /mcp` `app_files_upload` | **MCP 侧上传**：`{slug,name,content_base64,size?,sha256?,mime?,note?,created_by?}`——同表同链（app_files+落盘）。有的 MCP 客户端会把过长参数截短（常见截在 64KB），所以 base64 严格校验、带了 `size`/`sha256` 不符即拒收不落库、恰好 65536 字符又没带时按疑似截断拒收；大文件优先用 REST 原始字节上传 |
| `GET /api/apps/:slug/files` | 列表（倒序游标）：`id/original_name/mime/size/note/created_by/created_at/url`·软删行不返 |
| `GET /api/apps/:slug/files/:id` | 下载：`Content-Disposition` 白名单 mime inline（png/jpeg/webp/gif/pdf/plain/csv/markdown），其余 attachment·`nosniff` |
| `PATCH /api/apps/:slug/files/:id` | 更新 `note`（≤500 字） |
| `DELETE /api/apps/:slug/files/:id` | 软删（`deleted_at` 置位·原行留审计·列表隐藏） |

### 来源：GitHub main（属主 2026-11-02）

非挂载类工作台（`market-app` 自产台与 `kind=sop` 的 SOP 台）**只接受 GitHub 仓库 main 分支**；挂载类（按 URL 登记、经 `/go/` 门户打开的外部台）不受影响。

- **两种仓库组织都行**：每台一个独立仓库（`source_repo: "owner/repo"`），或集中仓库每台一个目录（再加 `source_path: "apps/<slug>"`）。`https://github.com/owner/repo(.git)` 会规范化成 `owner/repo`。
- **分支写死 main**，不收分支参数。市场拉 main 头 commit → 递归列该目录文件 → 逐个取内容；版本记下 `source_commit`，changelog 缺省 `[github] <repo>[/<path>]@main <短 sha>`。
- **谁能同步**：首次登记或改来源只走 REST `POST /api/apps/<slug>/sync`（本机 CLI 或管理员）；已登记的台可由 MCP `app_sync` 重拉（不收来源参数）。main 头与活跃版同 commit 时不出新版。
- **发布门禁照旧**：空文件、体积骤降 >50%（`force:true` 可越）、HTML div 失衡一律 400；60s 同 slug 发布锁照旧。
- **关闭的入口**：`POST /api/apps` 直接传 `files` / `patch` → 410；MCP `app_publish`、`app_draft_open/edit/submit` 移除。`task-center` 内置元台仍只走管理员人工面。
- **收敛前直接发布的旧台**：历史版本照常可回滚；要出新版先由管理员带 `source_repo` 绑定一次。
- 环境变量：`WM_GITHUB_TOKEN`（可选·读私有仓库）、`WM_GITHUB_API`（只给测试指向本机替身·缺省 `https://api.github.com`）。生产需能出网访问 api.github.com。测试替身见 `scripts/github-fixture.mjs`，判据见 `scripts/github-source-smoke.mjs`。

## 数据面语义（#164 P2）

发布元数据（未传=继承·显式空串=清空）·`enabled`（仅列表可见性）·SOP 步骤字段（哑存储·校验归 agent）——详见 [docs/datastore-and-semantics.md](docs/datastore-and-semantics.md)。

## 脚本目标必须显式（#341）

脚本不从仓库 server/data、用户技能目录或任何默认服务地址推断目标。缺少目标/模式时，在网络、数据库或目标目录访问前非零退出；**127.0.0.1:9800 同样不是安全缺省**。生产模式额外要求命令行 `--ack-production-target`，技术确认不代替实际维护授权。服务器自身正常 DATA_DIR 默认不在此脚本整改范围。

- 39个历史快照冒烟：`node scripts/<name>-smoke.mjs --source-data <绝对源数据目录> --target-mode isolated --isolated-root <专用合成根>`。库源与 apps/skill-snapshots/uploads 都从同一显式目录取；源目录不缺省，不能把生产库简单称为 isolated。
- 打包：`node scripts/make-submission.mjs --source-db <绝对库路径> --target-mode isolated --isolated-root <专用合成根>`。只从指定库产生快照，库缺失报错，不再默默跳过或取仓内库。构建/材料仍从脚本所在检出取。
- 多源导入：显式 DATA_DIR、SKILL_SRC_A/B/C（或 --data-dir/--source-a/b/c）以及模式/隔离根；未配置的可选源需显式指向自己准备的空目录。`--dry-run`/`--selftest`也不能扫描默认个人目录；dry-run不导入context，不创建数据库/快照。
- 单技能：显式 DATA_DIR、SKILL_SRC（或 --data-dir/--source-dir）；快照与库共用显式DATA_DIR，不再固定写入仓内 skill-snapshots。
- 服务层冒烟：`--data-dir <绝对库目录>` 与模式/隔离根必须先校验，再动态导入context；不允许顶层导入隐式建库。
- 监督：sup-audit必须给 `--api http://127.0.0.1:<测试端口> --summary <绝对摘要路径>`；sup-live必须给 `--api ... --log-file <绝对日志路径>`。都要显式模式，拒重定向。没有 `--restart-task <精确名称>` 时只报健康不点火；点火只准显式production+确认，不创建/修改计划任务。
- 隔离模式要求绝对目标位于显式 --isolated-root 下，递归拒源树内及其祖先链接/junction穿越（含数据库文件和被复制的子目录），拒当前检出的server/data与个人.dsh/.ygl-trees；它不能证明整个目录没有业务数据。生产路径不能伪装成隔离源。URL还必须显式端口/规范host，isolated拒9800/9801/3080、非回环、URL凭据/query/fragment/path。

合成跑器只向子进程显式传 SCRIPT_SOURCE_DATA_DIR、SCRIPT_SOURCE_DB、SCRIPT_TARGET_MODE=isolated、SCRIPT_ISOLATED_ROOT；这些没有代码缺省值。手动操作优先命令行参数，生产确认旗标不从环境继承。不向服务端注入这些脚本参数以改变其运行行为。

39个快照冒烟的自启实例必须经子进程独立IPC报告监听端口后才发HTTP；子进程未成功绑定或退出时拒请求，不以任意端口200当自有服务。本地接口测试只从本机网卡枚举地址，不继承LAN_IP；同测试端口的非本机host在底层fetch之前拒绝。本次亦收口appdata与skill-smoke这两项遗漏。此防意外碰撞，不是对恶意本机端口重绑定的原子证明。

验证：`node scripts/explicit-data-targets-test.mjs`拦截所有负例网络/子进程/SQLite/目录访问，正向仅合成目录；原脚本不拿真实服务试。`scripts/explicit-data-target-inventory.json`固定本次清单。冻结包/已有验证报告不就地改写，旧命令需显式传参后重新运行新报告。

## 开发验证器

v69.2 仅更新判据65的源码结构口径（继v69.1追加GoFrame遮蔽与属性值副作用拒绝，并明示数据流限度）：M4 将 iframe 构造移到 GoFrame，提取器检查使用页到 GoFrame 的受限顶层 return／const 绑定结构，并保留 raw URL、删除组件调用、不经门户、遮蔽与死 return 必红反例；需新材料重新 submit/prepare，不覆盖旧 v68 的174/1报告。175编号不变，结构检查不替代运行时E2E。见 [迁移说明](docs/verifier-v69-portal-chain.md)。

基于 ygl-trees verify 管线（M13 spec validator）的闭集判定器 v69.2：**175 条判据**五十四维覆盖——数据域完整性（9：types/workbenches 全部数值与枚举列域）、种子与配置（6：类型数 ≥9、内置 web、ollama/streamlit 探测路径钉、巡检三键、工作台非空）、提交物结构（20：清单/源码/构建产物/脚本/自举档案/设计规范/证据资产）、**颜色可见性**（18：经对比度审计的色值钉位，如次级文字 #5A6577=5.9:1、焦点环 rgba(5,150,105,.6)、深底状态文字 rgba(255,255,255,.85)）、**E2E 行为证据**（3：用例规模（≥25 含驾驶舱/统一门户/自产台/凭据注入/WS 握手/SOP 台/MCP 生产通道/SOP 管理页/运行时批用例）、全绿、时间戳，源自 e2e_test.py 落盘的 evidence/e2e-summary.json）、**渲染层对比度探针**（2：E2E 内置 Playwright 实测 DOM 前景/背景配对——深底状态文字曾实测 1.18:1 不可见，此维度在行为层抓住同类回归，9 处目标全 ≥4.5:1 且 fail-closed）、**任务驾驶舱**（3：驾驶舱名称域完整、Cockpit.tsx 在位、/api/cockpits 路由钉位）、**统一门户**（4：代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走 /go/ 同源代理）、**台生成器**（5：自产台 slug 域完整、market-app 内置类型在位、发布路由与版本链表钉位、演示自产台常驻）、**凭据注入**（3：服务端注入头钉位、表单凭据字段钉位、E2E 注入行为断言钉位——认证类工作台凭据不再明文拼 url）、**WS 升级**（2：upgrade 事件挂载与握手 Origin 改写钉位——upgrade 不流经 Express 中间件链且不触发 proxyReq 钩子，缺位时 HTTP 通而 WS 死（DSH 台「重新连接中」的实测根因），E2E 以 socket 级 101 握手断言钉住行为）、**SOP 台**（5：运行真源表 sop_runs 与 Redis 状态层模块 runStateSave 钉位、Runner 服务端渲染与运行 API 钉位、E2E 行为断言钉位——状态层 Redis 热态 + 持久层 SQLite 真源的分层治理，Redis 不可达自动降级直写）、**MCP 生产通道**（4：/mcp 端点与工具注册表钉位、JSON-RPC -32601 协议合规锚点、E2E 行为断言钉位——AI 会话直连市场的 agent 原生供给面）、**SOP 管理页**（4：Sops.tsx 在位与 SOP_STATUS 状态语义表钉位、/sops 路由钉位、演示 SOP 常驻钉位——状态徽章可视化状态机 + run 记录直查分层持久化数据）、**凭据面防泄露**（2：maskSensitiveQuery 掩码函数与掩码回传保护钉位——REST/MCP 无认证出口对 url query 敏感参数与 auth.value 统一脱敏，代理侧 DB 直读不受影响）、**安全批整改**（2：auth.value+MCP 脱敏、CORS 白名单、draft 403 瘦身——外部评审 #1/#2/#3/#11）、**门户 Location 改写**（2：proxyRes 的 goWid 备份钉位与行为断言——3xx 跳转改写回 /go/ 前缀内，评审 #4）、**安全批双锚**（3：CORS/MCP 协议/draft 403 三面源码+行为双锚——防「代码在而行为回归」）、**运行时批整改**（4：巡检重挂/删台清注册/导入 replace 语义钉位 + 组 19 断言探针——评审 #5-10）、**A2A 网络接入 P1**（4：上游一致卡片签名/绑定口令/节点短 id/裁判冒烟——GH #17 只读暴露）、**Agent 执行数据面**（3：run 持久化同链核心 + MCP sop_run_* 五工具 + 人机同链断言）、**导出脱敏**（3：默认 maskForApi + 导入掩码跳过 + 行为断言——compliance 二期首项）、**注册 CRUD MCP 化**（3：REST 同链核心/凭据硬拒绝/行为断言——agent 自主登记外部台）、**破坏性测试隔离**（1：导入 replace 永不碰活库——84 事故根治）。内容与 JSON 在 CLI 闭集不可直接判定，经三张提取表桥接：`verifier_text_facts`（色值与源码事实钉位）、`verifier_e2e_summary`（E2E 摘要）、`verifier_contrast_checks`（渲染对比度实测），由 make-submission.mjs 打包时从当前源码/证据重新提取写入快照。typecheck/lint/build 不在闭集内，由开发流程自行执行。

```bash
# 0) 再生成三件套（单一事实源 175 单元表 → verify/material.md + candidates.json + reviews.json）
node scripts/gen-verifier.mjs

# 1) 生成判定面：活库快照（含色值/E2E/对比度提取表）+ 封装提交物（幂等，干净克隆自愈——tmp/ 不存在时自动创建；E2E 判据依赖 evidence/e2e-summary.json，未跑 E2E 则 fail-closed）
node scripts/make-submission.mjs --source-db /absolute/test-data/workbench-market.db --target-mode isolated --isolated-root /absolute/test-data

# 2) 构造期（材料 → 候选 → 盲审 → 三重门 → 冻结 spec；材料/候选/盲审改动后需重新 submit；file 判据需 --attach 提交物 tar）
ygl-trees verify submit --title "workbench-market 开发验证器 v68" --text verify/material.md --attach tmp/submission-v16.tar.gz
ygl-trees verify prepare <material-id> --candidates verify/candidates.json --reviews verify/reviews.json --db tmp/verify-snap.sqlite

# 3) 执行期（可重复跑；--submission 指向封装提交物而非仓库根——file 型全仓扫描在 pnpm 联接点上不可行）
ygl-trees verify run <spec-id> --db tmp/verify-snap.sqlite --submission tmp/submission

# 4) 判定报告可视化（多 run 对照，单文件 HTML）
node scripts/verify-report.mjs <run1.json> [run2.json ...]
```

基线：`run_62af35289857cabe` 175/175 PASS（spec_049eae7969a2，2026-10-27）；初版基线 `run_766e0c923b514232` 58/58 PASS（spec_24a0b30d47d1，2026-10-20）。红测四条：`run_8b5fa9dcc555773c`（删 ollama+README）V10/V12/V16 精确 FAIL；`run_45ce9306eb05a210`（源码改 #5A6577）V37 精确 FAIL；`run_79cacaa31cd69a45`（E2E 13/14 + 轴色漂移）V49/V53 精确 FAIL；`run_aa92adf654b5964a`（篡改对比度记录为 1.18:1）V56 精确 FAIL——DOM 探针 → 摘要 → 提取表 → 判据的 fail-closed 链路实证。判据源文件在 [verify/](verify/)：material.md（冻结材料原文）、candidates.json（VU 候选 + checker）、reviews.json（三问盲审结论）；175 单元表由 [scripts/gen-verifier.mjs](scripts/gen-verifier.mjs) 单一事实源生成。

## 统一待办（omni-inbox）

任务聚合（只读，勾销回原系统）：`GET /api/tasks` 返回任务信封 `{id,source,title,status,due,link,project}` 与源元数据。**#324：匿名查询前401；新鲜内部会话只读明确获授权的来源/对象，管理者凭有效口令读取；取消聚合共享缓存，响应 private/no-store。**
- **ygl-trees 源**：只使用显式绝对 `YGL_HOME` 且已有的工作区；管理员枚举 active 项目，普通内部用户只查询单独批准、工作区绑定且未过期/撤销的精确项目，无授权不启动 CLI。
- **market 源**：running SOP run 与已发布任务；普通用户只读有既有 run 读权的 run/intake 任务，SQL 层按范围查询，不按 started_by 推权。
- **A2A 源**：仅管理员、配置启用时查询；普通内部用户默认无权。来源故障只出稳定脱敏错误码。显式项目授权/撤权接口与测试边界见 [读取权限契约](docs/tasks-read-authority-324.md)。
- **扩展来源**：`WM_EXTENSIONS_DIR` 里的扩展可经 `ctx.tasks.addSource` 注册来源（带显示名与颜色），按查看人现取；失败降级为稳定码 `<来源键>_source_unavailable`，不透传原始错误，不阻塞其它来源。
UI：`/tasks` 页（源/状态过滤·扩展条目可标「仅查看」）· 总览待办聚合卡 · 驾驶舱「加待办卡」（kind=tasks 面板，布局服务端保存）。

## 扩展

公开仓库只带通用能力；部署方的私有功能（页面、接口、待办来源）放在仓库外，经 `WM_EXTENSIONS_DIR` 挂进来。不设就什么都不加载。

- 目录形状：`<WM_EXTENSIONS_DIR>/<扩展名>/`，扩展名 `[a-z0-9-]`。`server.ts`（或 `.mjs`/`.js`）导出 `register(ctx)`，启动时调用一次；`web/index.tsx` 默认导出 `{ name, routes, nav, marketOnly }`，**构建期**由 `web/vite-extensions.mjs` 并入前端（`WM_EXTENSIONS_DIR` 要在 `pnpm --filter web build` 时也设上）。
- 出错不静默：目录不存在、不是绝对路径、子目录两种入口都没有、模块加载失败、没导出 `register`、`register` 抛错，服务端都**拒绝启动**并点名扩展与原因；前端构建同样失败。
- `ctx`（`server/src/extensions.ts`，`apiVersion` 1）：`app`/`wrap` 挂路由（在身份与写门之后、SPA 回落之前）；`adminGuard`；`odoo.url`/`resolveViewer`/`loginUrl`/`addReturnPath`（登记需要身份的页面作登录回跳）；`tasks.addSource`；`remoteWrite.allowExact`（业务写面：远程浏览器 POST 该精确路径不经管理写门、由扩展自己判身份，只收 `/api/<非宿主命名空间>/…`，进 S3 豁免面快照）。
- 前端扩展从 `@wm/host` 取宿主组件（`WmPage`、`useOdooPopupLogin`、`odooLoginHref`）；`react`、`antd` 等按宿主的一份解析。
- 镜像：`deploy/Dockerfile.market` 有一个空的 `wm-extensions` 阶段，部署方用同名构建上下文覆盖它（compose `build.additional_contexts`），并传构建参数 `WM_EXTENSIONS_DIR=/opt/wm-extensions`；运行时同样设 `WM_EXTENSIONS_DIR`。
- 冒烟：`node scripts/extensions-smoke.mjs`。

## 鉴权边界与代理相对路径（#132 ⑨⑩）

### REST vs MCP 鉴权差异表

| 面 | 写操作 | 读操作 |
|---|---|---|
| REST `/api/apps`（发布） | `X-Admin-Token` 必带（远程写另经 T1 豁免面清单） | 开放（GET） |
| REST `/api/apps/:slug/files` | 上传=管理员口令；列表/下载开放 | 开放 |
| REST `/api/sop/runs/:id/files`、`…/files/refs` | **run-scoped `X-Run-Upload-Token`**（启动响应/派单回执取）或管理员口令；refs 另逐条核源 run 读凭证 | 开放 |
| MCP REST `/openapi.json`、`/api/mcp-rest/*` | 与 `/mcp` 同一套：只认 `Authorization: Bearer <会话令牌>`，不走浏览器登录与管理口令 | 同左 |
| MCP `/mcp` | 无独立口令——网关模式下按会话 `grants` 工具白名单授权（`Authorization: Bearer <token>`）；`access_info` / `access_request` 免授权，缺权限的会话据此看目录、提申请 | 同左 |
| 管理面（settings/mcp sessions） | `X-Admin-Token` 必带 | 部分开放（脱敏） |

**推荐路径**：agent 侧一律走 MCP（授权白名单可审计）；人工作业走 REST+口令；远程台面发布用 T1 豁免清单内的业务写面。

### MCP 工具的 REST / OpenAPI 开放

MCP 自带一套 REST：不说 MCP 协议的客户端（普通脚本、按 OpenAPI 导入工具的平台），以及要传大文件的 agent，用**同一个会话令牌**（`Authorization: Bearer <会话令牌>`）按 REST 调用。认证、授权、审计和 `/mcp` 共用同一条链，不走浏览器登录和管理口令。

- **入口告诉 agent**：MCP `initialize` 结果和 `access_info` 都带 `openapi_url`、`rest_base`（设了 `MARKET_PUBLIC_URL` 就用它当基址）。`app_files_upload` / `app_files_list` 的描述里也写了大文件改走 REST。
- **文档**：`GET /openapi.json`（或 `/api/mcp-rest/openapi.json`）返回 OpenAPI 3.1，分两部分：
  - 文件与资源接口：二进制请求体和响应写的是 `application/octet-stream` / `multipart/form-data`，`x-requires-tool` 标出对应的工具授权。
  - 工具映射：每个工具一个 `POST /api/mcp-rest/tools/{name}`，`operationId` 是工具名，`requestBody` 是工具的 `inputSchema`，`x-category` 标 read/write/admin。

  文档**只列当前会话能调用的接口**（`x-granted`）；匿名或无效令牌返回 401。授权变了要重新拉一次文档。

**文件与资源**（授权映射到现有工具，不另设权限）：

| 接口 | 需要的工具授权 | 说明 |
|---|---|---|
| `PUT {rest_base}/apps/{slug}/files/{文件名}` | `app_files_upload` | 请求体就是文件的原始字节，边收边落盘，不整包读进内存，单文件 ≤100MB；可带 `?note=&created_by=`（`created_by` 缺省为 `mcp:<会话名>`） |
| `POST {rest_base}/apps/{slug}/files` | `app_files_upload` | multipart：字段 `file`，可选 `note`、`created_by` |
| `GET {rest_base}/apps/{slug}/files` | `app_files_list` | 列文件，倒序分页（`limit`、`before_id`），带 `quota` |
| `GET {rest_base}/apps/{slug}/files/{id}` | `app_files_list` | 二进制下载 |
| `GET {rest_base}/apps/{slug}/data` | `app_data_list` | 读台数据（分页） |
| `GET {rest_base}/sop/runs/{id}` | `sop_run_get` | 结果与 sop_run_get 相同；没有 run 读授权时只返回元数据 |
| `GET {rest_base}/sop/runs/{id}/files[/{fileId}]` | `sop_run_get` + 该 run 的读授权 | 附件列表与下载 |

- 上传和浏览器上传走同一套入库核心：按内容识别类型（扩展名与内容不符、或是可执行文件返回 415），并检查台文件数配额。返回 `id`、`sha256`、`mime`、`size`、`url`（REST 下载地址）和 `download_url`（台页面用的下载地址）。
- 下载：响应头 `ETag` 和 `X-Content-SHA256` 都是文件的 sha256（上传时存进 `app_files.sha256`；早先没存的文件第一次下载时算一次并写回）；`If-None-Match` 命中返回 304；单段 `Range`（`bytes=a-b` / `a-` / `-n`）返回 206，越界返回 416；`If-Range` 不符时回整份。安全头沿用现有下载：`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`。

```bash
curl -s -X PUT "$REST_BASE/apps/$SLUG/files/report.pdf" \
  -H "Authorization: Bearer $MCP_SESSION_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @report.pdf
```

```bash
curl -s -H "Authorization: Bearer $MCP_SESSION_TOKEN" -H 'Range: bytes=0-1048575' -o part.bin "$REST_BASE/apps/$SLUG/files/42"
```

**工具调用**：`POST {rest_base}/tools/{name}`，请求体就是工具参数（JSON 对象，可省略，即空参数）。

```bash
curl -s -X POST "$REST_BASE/tools/workbench_summary" \
  -H "Authorization: Bearer $MCP_SESSION_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

| 状态码 | 含义 |
|---|---|
| 200 / 201 / 206 | 成功：工具结果 JSON（本地工具返回业务对象，与 `/mcp` 的 text content 解析后相同；上游工具返回其 MCP 结果 `{content}`）、上传结果、Range 片段 |
| 400 | 参数错误；违反台数据契约时带逐条 `violations` |
| 401 | 缺少或无效的会话令牌 |
| 403 | 会话未获授权；响应里 `hint` 提示调 `access_info` 查看、用 `access_request` 申请，`required_tool` 给出需要的工具 |
| 404 | 工具或资源不存在 |
| 413 | 文件超过 100MB 或台文件数已满；JSON 请求体上限：带有效会话 140MB，其余 4MB（与 `/mcp` 同口径） |
| 415 | 文件内容与扩展名不符，或是可执行文件 |
| 416 | Range 越界 |
| 502 | 上游工具失败或不可达 |

- **审计**：每次调用都记进 `mcp_calls`，`channel` 列区分 `rest` 和 `mcp`（「MCP 网关」页审计表的「渠道」列）。文件接口的 method 记为 `rest/file_upload`、`rest/file_download` 等。
- **与 `/mcp` 的差异**：`/mcp` 对未授权的工具按「不存在」应答；REST 分开返回 403 和 404，方便脚本区分（工具目录本来就能经 `access_info` 看到）。

### 代理相对路径标准式（iframe / 统一门户 `/go/<id>/`）

被测台在 iframe 内的**同源相对请求**要以**页面自身路径**为基准：

- 推荐：脚本/api 调用用**相对路径**（`api/x` 而非 `/api/x`）或显式拼 `location.pathname` 基；
- 或注入 `<base href="/go/<id>/">`（市场门户不做注入·台自持）；
- **禁止**在 bundle 里硬编码根绝对路径（`/assets/...`）——门户代理只改写 HTML 属性与 Vite assetsURL helper，任意自拼的根绝对路径会逃逸前缀（白屏三层修的直接教训，见 PR#128-#130）。

## Docker 部署（#147）

### 快速起

```bash
docker compose -f deploy/docker-compose.yml up -d --build
# 打开 http://127.0.0.1:9800（基文件默认仅回环绑定——安全默认）
```

构建要求：Node 镜像内需要有网（npm registry）。内网/离线请换镜像站：
```bash
docker build -f deploy/Dockerfile.market --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ -t market .
```

### 网络模式（重要）

| 模式 | 容器内如何探本机服务 | 说明 |
|---|---|---|
| **host（推荐）** | `http://127.0.0.1:PORT` 直连 | 基文件已用 `network_mode: host`（Linux）——市场探测本机台零配置 |
| bridge | `http://host.docker.internal:PORT` | 需 `extra_hosts: ["host.docker.internal:host-gateway"]`；WSL 下 ufw FORWARD 可能仍阻（建议 host） |
| 注册表单 | Windows 可达性 | 容器内 127.0.0.1 ≠ 宿主；注册本机台用宿主内网 IP 或 host 模式 |

### 对外暴露端口（覆盖层 `!override`）

基文件端口是 `127.0.0.1:9800:9800`（仅本机）。要对外：
```yaml
# docker-compose.override.yml
services:
  market:
    ports: !override
      - "0.0.0.0:9800:9800"
```
> 直接写 `ports:` 会与基文件**合并**（追加两条→address already in use），必须 `!override`。

**管理端口**：缺省只监听 `PORT`（9800），管理写在业务面凭口令或 Odoo 管理员完成，不需要另开端口。显式设 `WM_CONTROL_PORT` 才多开一个独立管理端口（`network_mode: host` 下直接监听宿主；bridge 模式要另映射），绑不上时只告警、业务面照常。

### 探活与数据

- **探活端点**：`/api/health` 是存活（只看本进程，不对外发请求），`/api/health/ready` 是就绪（配了 LayerFS 时探测它，结果缓存 10 秒，不健康 503）；镜像与 Compose 的 HEALTHCHECK 用就绪端点。`/health` 不再被 SPA 兜底成 HTML
- **重启策略**：Compose 里 market 与 layerfs 都是 `restart: unless-stopped`，宿主重启后自动拉起
- 数据卷：`market-data` → `/data`（SQLite WAL·停容器前 SIGTERM 自动 checkpoint）
- 备份：`docker compose exec market node -e "require('node:sqlite').DatabaseSync" 2>/dev/null || true`——推荐宿主侧 `sqlite3 /var/lib/docker/volumes/.../_data/workbench-market.db ".backup /tmp/bak.db"` 或经 API `GET /api/export`
- 升级：`git pull && docker compose up -d --build`（数据卷不受影响）
- 恢复：停容器→替换卷内 db 文件→起（WAL 残留自动回放）

### layerfs 服务（可选·profiles）

```bash
LAYERFS_SERVICE_TOKEN=<强随机> docker compose --profile layerfs up -d --build
```
- 不设 token 或设 `change-me` → **拒启**（fail-fast）
- 该服务挂 `/var/run/docker.sock` = 等同宿主 root 权限——仅可信环境启用
