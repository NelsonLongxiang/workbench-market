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
node scripts/upgrade-smoke.mjs        # 升级冒烟：线上发布分支的库换成本检出的代码启动、再退回去，全程合成数据（--base 换基线）
A2A_UPSTREAM_DIR=<上游检出> node scripts/contract-upstream-test.mjs  # 契约联调：上游 a2a-net 的 superagent 宿主当对端（夹具 scripts/contract/market-superagent.spec.ts，拷进上游 tests/mesh/ 跑；只听回环、临时目录、合成数据；NODE_ENV=production 或设了 DATA_DIR 拒绝运行；CI 的 upstream-contract job）
```

浏览器回归（`scripts/*-browser.mjs` 等）要用 Python Playwright，版本与 CI 一致。一般交给 CI 或共用测试环境跑。解释器由 `scripts/python-bin.mjs` 统一选取，顺序是：`PYTHON` 环境变量 → 仓库根的 `.venv` → 系统 `python3`，不用在命令前手写解释器路径。想在自己机器上跑的话（可选），建一次 `.venv` 即可：

```bash
python3 -m venv .venv && .venv/bin/python -m pip install playwright==1.57.0
```

环境变量（14 面）：
- `PORT`（默认 9800）
- `WM_LOGIN_GATE`（全站登录门·`enforce`=没有身份什么都访问不到：页面 302 `/login`、API 401；缺省/`off`=行为不变；其它值拒绝启动；见 [ADMIN-TOKEN-SETUP.md](ADMIN-TOKEN-SETUP.md)「全站登录门」）
- `WM_CONTROL_PORT`（可选的独立管理端口·缺省不开·见「信任模型」）
- `DATA_DIR`（SQLite 数据目录·默认 `server/data`）
- `ADMIN_TOKEN`（控制面口令·可设置页改）
- `MCP_GATEWAY`（#284 起**缺省开**：未设/空/`on`=会话令牌网关；只有显式 `off` 且 `NODE_ENV=development/test` 才允许关闭并启动告警；生产/未设/空/未知运行模式配 off 由启动自检拒绝，其它网关值也拒绝启动）
- `REDIS_URL`（共用状态层：SOP 执行实例和台的热数据·可选·缺省读 `DATA_DIR/redis.url`·无则直写 SQLite）
- `WM_VARS_STORE`（工作台的常量、变量存在哪：`main` 缺省，只用主库；`shadow` 主库是真源、同时写一份卡片的台库；`bench` 卡片的台库是真源、尽力写回主库留作回退。对外应答三档一样。`bench` 档配了 Redis 时，键名以 `hot.` 开头的变量（高频变量）先写 Redis、30 秒落一次台库，起名 `hot.` 就表示接受最多丢 30 秒；Redis 不通而这张卡片还有没落盘的写入时，这类变量回 503 可重试。填错拒绝启动。上线时保持 `main`，另两档等生产演练和属主批准，见 docs/data-views.md 第十三节）
- `MARKET_TEAM`（A2A team 默认 `market`；名片的 team、会话句柄 `<MARKET_TEAM>/<node8>` 和工作台事件出站的 caller_session 都用它）
- `MARKET_PUBLIC_URL`（对外基址·A2A 卡片与 MCP `skill_download` 下载链接用；生产建议设成 https 地址——没设时下载链接取请求主机，主机名不规范就不签发）
- `A2A_API_KEY`/`A2A_STATE_URL`（A2A 外部面）
- `WM_BENCH_VIEWS`（数据视图的入口·缺省 `off`：`/api/bench-views` 下的每条路由都直接回 404；`on`=开放给有管理层授予（范围「全部」）的登录账号，和在台所绑的部门上有已放行授予的人；只有普通员工授予的人读也不行，管理口令看不了台里的数据；其它值拒绝启动；见 [docs/data-views.md](docs/data-views.md)）
- `WM_BENCH_REQUEST_TTL_HOURS`（数据视图·台的权限申请没人处理的总期限，缺省 `72`，1～720 小时：到期还没定的申请标成「失效：没有人处理」，申请的会话查状态时看得到，「关注」里那条一起消失；写错的台标识也是这个结局，不透露台存不存在。不合法拒绝启动）
- `WM_OUTBOUND`（对外断开·预发用·缺省 `on`；`off`=这个进程一个字节都不往外发：TCP、TLS、DNS、UDP 在发出前被拦下并计数，不许起子进程和 Worker，工作台事件投递和回执 outbox 整轮跳过（在途的保持 pending、不加 attempts、不判死），启动时的豁免面变更通知不发，库里的巡检间隔、MCP 上游、沙箱桥一律按关处理，check-all 拒绝探活；只放行本进程自己在听的回环端口。启动自检多一行「对外已断开」，`/api/health` 和 `/api/health/ready` 带 `outbound`，页面顶上有横幅。只能经环境变量打开；其它值拒绝启动。拿生产数据的副本做预发时用，见下方「预发：对外断开」）
- `WM_A2A_DIRECT_SIG`（`POST /a2a/direct` 入站签名·缺省 `accept`=签名可选：带了 OriginClaim Sig2 就验，取卡或验签这一步验不过（没登记取卡地址、取不到卡、卡上身份不对、签名对不上卡）按未签名走绑定准入——不比不带签名更宽也不更严，格式、时间戳、受众、身份不符、重放照旧 401；`require`=没签名或验不过一律 401；`off`=不验；`WM_LOGIN_GATE=enforce` 时强制 `require`；其它值拒绝启动。公钥只从调用方绑定上登记的 `notify_url` 取卡，不跟随重定向）
- `WM_A2A_DIRECT_SIG_BODY`（缺省 `accept`；`require`=只认同时签了 body 摘要的 `X-WM-Body-Sha256`/`X-WM-Body-Sig`，现有 DSH 节点只发 Sig2，打开前对端要先升级；其它值拒绝启动）
- `WM_A2A_CARD_COOLDOWN_S`（`/a2a/direct` 入站验签取卡的冷却秒数·缺省 30·只收 1～3600 的整数，否则拒绝启动；验签失败触发的重取卡按登记地址在冷却期内只发一次，对方换钥匙冷却过后生效）
- `WM_A2A_FOLLOWUP_RATE_10MIN`（席位跟进每个对端 10 分钟内存正文的条数上限·缺省 300·只收 1～100000 的整数，否则拒绝启动；超出的不存正文、只计数，结清回执照回）
- `A2A_ORIGIN_CLAIM_UNBOUND`（v1 未绑定调用方签名兼容窗：`off`=停发 `X-A2A-Caller-Sig`，缺省继续发；v1 不绑路由，未升级对端上可被剥 Sig2 重放，全舰队升级后应设 `off`）
- `WM_A2A_MEMBER_PROVENANCE`（缺省 `on`：市场名片声明 `canvasMemberProvenance`——a2a-net 0.8 起，对钉了公钥的画布成员只往声明了它的宿主转发，不声明则席位的回执到不了市场；声明即承诺：名片只列本节点自己服务、互不重复的句柄 `market/<8 hex>`，发给它们的消息只在本节点投递、查无或有歧义一律 404，句柄只由本节点密钥签发；`off`=不声明，名片与之前完全相同；其它值拒绝启动）
- `WM_A2A_PROGRESS_RECEIPTS`（缺省 `on`：市场名片声明 `progressReceipts`——宿主只给声明了它的调用方发进展回执 `progress-<task>-<n>`；市场收下后只记录、给事项页做「正在处理」提示和子项，不结清原派工、不推事项状态；`off`=不声明，宿主不发进展；其它值拒绝启动）
- `WM_A2A_TEAM_ROSTER`（缺省 `on`：市场名片声明 `teamRoster`——a2a-net next/0.8 的宿主只给声明了它的画布远端成员推团队名册 `[A2A roster]`，市场照规矩收（投递过的宿主、Sig3、节点键取自验过签的公钥）；`off` 时不声明、入站名册一律不收；其它值拒绝启动）
- `WM_A2A_DIRECTED_SEATS`（缺省 `on`：市场名片声明 `directedSeats`——宿主只认声明了它的远端成员发来的指名派工行；「安排一件事」带 `seat_id` 时派工正文第一行写指名（对端宿主没声明就退回整队派发并留痕）；`off` 时不声明，带 `seat_id` 的安排 400；其它值拒绝启动）
- `WM_PROPOSAL_ROSTER_GONE_HOURS`（缺省 `24`：关系的提议指向的团队，在节点照常报名册的情况下连续不在名册超过这么多小时，提议才失效；短暂掉出又回来的不收，节点整个停推的只走总期限；1～720 的整数，别的值拒绝启动）
- `WM_PROPOSAL_TTL_DAYS`（缺省 `14`：关系的提议（部门负责人、团队负责人、团队认领）超过这么多天没人处理就失效，目标不在了的也失效；每小时收一轮，失效的在提议人那里留 7 天；1～365 的整数，别的值拒绝启动）
- `WM_ROSTER_STALE_MINUTES`（缺省 `60`：某个节点的团队名册超过这么多分钟没更新，就在管理员的「等你拍板」里列出来；1～10080 的整数，别的值拒绝启动）
- `WM_WORK_ITEM_STUCK_HOURS`（缺省 `24`：一件事项在已转交、已接单、在做、在等、卡住这几步里，最后一次变动超过这么多小时，就冒给事项交给的团队的负责人，团队没有负责人时冒给管理层，进「等你拍板」的「停太久的事项」；只按自然时间算；不算进角标，`/api/attention` 的 `counts.stuck_count` 单独数；1～720 的整数，别的值拒绝启动）
- `LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS·缺一即禁用）
- `LAYERFS_SERVICE_TOKEN_FILE`（LayerFS 令牌文件·设了就以文件为准，不回落到库里或环境变量里的令牌；内容不足 32 字节拒绝启动）
- `AI_GATEWAY_API_KEY`（`skill_search` 评估模型令牌·缺=工具报错不降级）
- `EVAL_GATEWAY_URL`（评估网关覆盖·验证器/代理用）
- `SANDBOX_BRIDGE_URL`/`SANDBOX_BRIDGE_TOKEN`（sandbox 派发）
- `PUBLISH_LOCK_MS`（发布锁窗口·测试可调）
- `SOP_READ_CAP_TTL_DAYS`（SOP run 只读能力有效期·缺省 30 天·非数字回落缺省）
- `WM_GITHUB_TOKEN`（自产台/SOP 台来源仓库读令牌·可选·私有仓库用）
- `WM_GITHUB_API`（GitHub API 基址·只给测试替身用）
- `WM_APP_FILES_MAX`（单台文件数上限·浏览器上传与 MCP 上传共用·缺省 2000）
- `A2A_EVICT_COOLDOWN_MS`（台驱逐冷却窗·缺省 24h·测试可调）
- `A2A_OUTBOX_BACKOFF_SCALE`（A2A 回执 outbox 退避倍率·测试可调）
- `WM_REGISTER_URL_ALLOWLIST`（#258 公网登记精确许可·JSON 字符串数组·缺省 `[]`=公网一律 403 `url_not_allowlisted`·坏项/通配/硬拒/私网条目拒绝启动·见 docs/r3-url-allowlist-design.md）
- `ALLOW_PUBLIC_NET`（#258 起**不再放行任何公网登记**，`1` 只在启动时告警）（网关开时 `/mcp` 启用会话令牌网关——**生产已开：所有 /mcp 调用须 `Authorization: Bearer <会话令牌>`**·会话经 `POST /api/mcp/sessions` 创建+`PUT …/grants` 授权）
- `LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS 服务面·两者任一缺失则 LayerFS 集成整个禁用=降级直写）
- `WM_ODOO_ORIGINS`（可信 Odoo 源·逗号分隔·门户只把 Odoo `session_id` 转给这些源与 `WM_ODOO_URL` 的源；都未设时谁都不转、Odoo 台免登不生效（fail closed·启动时提示））
- `WM_ODOO_URL`（工作台认人的 Odoo 地址·浏览器 Odoo 会话按它现查 `get_session_info`：登录门、统一待办读权、Odoo 管理员认定、`/api/auth/viewer` 共用·未设则不认 Odoo 身份；旧名 `LC_ODOO_URL` 已弃用，仍在 `WM_ODOO_URL` 为空时回退读取并在启动时告警，两个都设以新名为准）
- `WM_ODOO_BROWSER_URL`（只给浏览器用的 Odoo 登录地址·可选·须在可信名单内、只写 origin，非法拒启动；仅对源等于 `WM_ODOO_URL` 的 Odoo 台生效，主机名不符或 https 降级回 503；同域中继开着时中继优先·见 [docs/odoo-browser-origin.md](docs/odoo-browser-origin.md)）
- `WM_ODOO_LOGIN_PROXY`（`1`=市场同域 Odoo 登录中继·上游固定为 `WM_ODOO_URL`·见 [docs/odoo-login-relay.md](docs/odoo-login-relay.md)）
- `WM_SESSION_TTL_MIN`（市场会话的绝对期限，分钟·缺省 720＝12 小时·范围 15～10080·不续期·不合法拒绝启动）
- `WM_APP_DATA_READ`（台数据与附件的读守卫·缺省 `enforce`：`GET /api/apps/<台>/data`、`/files`、`/files/<id>` 要本台的台令牌、管理员（同源）或本机命令行，下载另认本台页面的查看凭证，都不满足 403；`warn`＝上线过渡用，照旧放行，只按路由和调用方类别计数留痕（日志 `source: app-data-read`；进程启动以来的累计次数在带管理口令读 `/api/health` 的 `guard_would_deny.app_data_read` 里，按路由模板 × 调用方类别，不带主体和台名、run 号），过渡完设回 `enforce`；其它值拒绝启动）
- `WM_SOP_RUN_WRITE`（SOP run 的写守卫·缺省 `enforce`：保存一步 `PUT /api/sop/runs/<id>`、完成 `POST …/finish` 要这个 run 的上传令牌 `X-Run-Upload-Token`（run 还在执行）、管理员（同源）或本机命令行，都不满足 403，不分登录门开没开；`warn`＝上线过渡用，照旧放行，只按路由和调用方类别计数留痕（日志 `source: sop-run-write`；进程启动以来的累计次数在带管理口令读 `/api/health` 的 `guard_would_deny.sop_run_write` 里，按路由模板 × 调用方类别，不带主体和台名、run 号），过渡完设回 `enforce`；其它值拒绝启动）
- `WM_ROLES_FILE`（组织角色的外部声明文件·绝对路径·JSON `{"roles":[…]}`·设了就以它为准，不设用仓库里的通用初始集合·平台内置角色不能被覆盖，同名、循环包含、引用不存在的动作、范围写法不对都拒绝启动）
- `WM_JUDGMENT_COMPARE`（判定的并行比对·`on` 打开·缺省 `off`·别的值拒绝启动·打开时每个请求应答结束之后算新判定、和旧守卫的结论比，不改应答，并给第一次见到的人迁移 `member`、身份来源说是管理员的再迁移 `admin`（来源记 migration；不自动迁 `management`，管理层由属主单独授，见遗留差异 L6）·CI 和出报告用的实例里开；判定切换（6d）的第 0 步起生产也打开观察，见 [docs/judgment-legacy-differences.md](docs/judgment-legacy-differences.md)）
- `WM_JUDGMENT_COMPARE_OUT`（比对打开时每比一次追加一行 JSON 的文件·绝对路径·可选·给出报告的脚本汇总）
- `WM_JUDGMENT_ENFORCE`（判定切换的开关·缺省空＝一个域都不切、行为不变·写域名列表（逗号分隔）或 `all`·要和 `WM_JUDGMENT_COMPARE=on` 一起开·写法不对、域没有登记的动作都拒绝启动·切了的域在路由处理之前由新判定说放不放行，拒绝回 403 `judgment_denied`（转提议是 `judgment_ask`），记进比对库的 `judgment_enforced`；放行的照旧交给原来的处理函数，旧守卫再判一遍做反向比对·声明了状态码不代表授权的路由、没报动作的存量路由、「暂不切」清单里的动作不受影响·回退：去掉这个域、重启）
- `WM_FEISHU_LOGIN`（`on`=打开飞书登录·缺省关）
- `WM_FEISHU_AUTHORIZE_URL` / `WM_FEISHU_TOKEN_URL` / `WM_FEISHU_USERINFO_URL`（飞书授权页、换令牌、取用户信息的地址·缺省取飞书开放平台文档里的·只收 https）
- `WM_FEISHU_TENANT_TOKEN_URL` / `WM_FEISHU_CONTACT_USER_URL`（对账用：取 tenant_access_token、按 union_id 查人的地址·缺省同上）
- `WM_FEISHU_VAULT_ENTRY`（飞书应用凭证在凭据库里的条目名·缺省 `feishu-login`：username 是 App ID、password 是 App Secret）
- `WM_FEISHU_TENANT_KEY`（可选·只认这个租户的人）
- `WM_FEISHU_AUTO_BIND_EMAIL`（`on`=没对到主体的人按飞书企业邮箱自动对到已有主体·缺省关·打开时必须配 `WM_FEISHU_TENANT_KEY`，否则拒绝启动）；见「主体」一节
- `WM_TRUSTED_PROXIES`（可信反代·逗号分隔的 IP/CIDR·这些对端写入的 `X-Real-IP`/`X-Forwarded-For` 最右项才算来源 IP，用于登录门限频与审计、Odoo 登录票据按来源限额；回环恒可信；容器部署要写上 docker 网桥网关或反代网段；非法项拒绝启动）
- `WM_EXTENSIONS_DIR`（扩展挂载点·绝对路径·缺省不加载任何扩展·见「扩展」）
- `WM_EXTENSION_ROUTES`（扩展路由没报动作时怎么办·缺省 `warn`：照旧能跑，启动日志逐条点名并计数；`enforce`：有没报动作的扩展路由就拒绝启动，阶段六切换判定时打开；其它值拒绝启动·见「扩展」）
- `YGL_MAX_PROJECTS`（统一待办读 ygl-trees 的 active 项目数上限·缺省 200·超出部分在 `degraded_projects` 报 cap-exceeded）
- `WM_YGL_CLI`（ygl-trees 入口文件 `dist/bundle/bin.cjs` 的绝对路径·可选·不设时照旧在 node 同目录、PNPM_HOME、APPDATA/npm 下找·相对路径拒绝启动·统一待办、经验库、MCP 上游都经它找入口）
- `WM_KNOWLEDGE_SYNC_MINUTES`（经验库从 ygl-trees 同步目录的间隔·分钟·缺省 10·`0` 不同步·不是 0～1440 的整数拒绝启动·同步等启动自检通过才开始）
- `YGL_TOTAL_BUDGET_MS`（ygl-trees 源总预算·缺省 8000·超预算未读的报 budget-exhausted；两项非整数或越界都回落缺省）。内容面（Draft，默认关闭）：`WM_CONTENT_PORT`（显式内容端口，缺省/0不启）
- `WM_CONTENT_IP`（显式绑定非通配IP）
- `WM_CONTENT_MARKET_ORIGIN`（可信市场完整origin）
- `WM_CONTENT_ODOO_ORIGIN`（须属于已配可信Odoo源）
- `WM_CONTENT_TARGETS`（JSON数组，固定id/origin/upstreamUrl；migrateBrowser仅显式true才迁出该target浏览器导航（默认关）；queryCredentialKeys只列上游凭据参数键，不列值，pin URL需去除这些参数；origin为w-id-env.internal且端口匹配）
- `WM_PORTAL_OBSERVE`（显式1才记录被动聚合，管理员读`/api/content/observation`；coverageVerified仍false），见[装配说明](docs/content-foundations-integration-296.md)。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。。凭据库：`WM_VAULT_PATH`（库文件·缺省 `DATA_DIR/vault/default.json`；指向 `$DSH_HOME/vault/default.json` 即与 DSH 插件共用——插件开着时同时写会丢更新）
- `DSH_VAULT_PASSWORD_FILE`（主密码文件·**设了就以文件为准**：管理员访问凭据库时按需自动解锁、不闲置上锁、页面不再要主密码；每次开库现读、只去掉末尾一个换行；读不到或为空回 503，不回落到环境变量·文件建议 0600、只挂给 market 容器）
- `DSH_VAULT_PASSWORD`（主密码·同上效果、与插件同名，但会出现在 `docker inspect`，生产优先用文件；两者都不设则在页面输入，只存进程内存）——**服务端持有主密码时凭据库只在凭据库专用域名 `WM_VAULT_HOST`（或控制面）开放，主域名一律 403 `vault_control_only`**：主域名跑着 `/go/` 外站与 SOP 正文，同源脚本可借管理员的 Odoo 会话静默读走全库；专用域名是另一个源，那些脚本改不了 Host、也读不到跨源响应。`WM_VAULT_HOST`（凭据库专用域名·只填主机名，如 `vault.example.com`·按请求 Host 精确比较、不分大小写、不看端口·带协议/端口/路径拒绝启动）上与控制面同一道围栏：`/go`、`/sop`、`/apps`、`/mcp`、`/openapi.json`、`/api/mcp-rest/`、`/a2a/` 一律 404，禁止被嵌；反代须原样转发 Host（nginx `proxy_set_header Host $host`）；Odoo 会话按域名分开，在专用域名上要用口令或在该域名 `/login` 登录。代价是「专用域名上的管理员身份 = 能读全部凭据」，服务器被攻破时库也随之暴露。`WM_VAULT_SERVER_PASSWORD_ON_MAIN`（只接受 `accept-same-origin-risk` 或不设，其它值拒绝启动）：设了就让服务端持有主密码时凭据库**在主域名也开放**，不需要专用域名或控制面。**残余风险（属主接受后才设）：管理员登着的时候，经 `/go/` 代理的外站页面或带脚本的 SOP 正文，能不声不响地读走全部凭据明文，不需要主密码，也不受闲置上锁的限制**；不设时保持只在专用域名/控制面开放
- `WM_VAULT_IDLE_MIN`（页面解锁后闲置自动上锁分钟数·缺省 15·`0` 不自动锁）。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。

## 启动安全自检（#326）

市场/控制面监听后先运行固定匿名回环自检，完成前 HTTP 和 WebSocket 业务入口均关闭；`GET /api/health` 返回 503，`self_probe.passed=false/at=null`。固定行里：
- 一行管主体管理面：远程匿名 GET `/api/principals` 必须被拒（登录门关着 403，开着由登录门先拦 401）；
- 一行管登录回调：远程匿名拿编出来的 state 打 `/login/feishu/callback` 必须 400（不跳转、不发会话）；
- 一行管失效通知：远程匿名、不带签名向 `/login/feishu/events` 发事件必须 401；
- 一行管授予管理面：远程匿名 GET `/api/grants` 必须被拒（登录门关着 403，开着由登录门先拦 401）；
- 一行管台数据的读：远程匿名不带台令牌 GET `/api/apps/<台>/data` 必须被拒（登录门关着 403，开着由登录门先拦 401；`WM_APP_DATA_READ=warn` 时这一行不跑）；
- 一行管写 run：远程匿名不带 run 的写凭据 PUT `/api/sop/runs/<编出来的号>` 必须被拒（登录门关着 403，开着由登录门先拦 401；`WM_SOP_RUN_WRITE=warn` 时这一行不跑）；
- 另有一行进程内的自检管设置的出口（`settings.no-secret-values`，不发请求）：启动时拿真实的设置跑一遍两级出口，凭据类的值漏进任何一级就拒绝启动（只记键名）；
- `WM_OUTBOUND=off` 时另加一行「对外已断开」：真的去连一个不可路由的地址（192.0.2.1），确认在连之前就被闸拦下；闸没装上就拒绝启动；
- 一行管导出真值：远程匿名带 `reveal=1` 导出必须被拒（登录门关着 403，开着由登录门先拦 401）。`WM_LOGIN_GATE=enforce` 时另加四行：远程匿名 GET `/`、`/apps/<台>/` 必须 302 到登录页、`/api/apps` 必须 401（浏览器写那一行改为期望登录门的 401），外加远程无签名 `POST /a2a/direct` 必须 401。强制行通过后才开放业务并启动后台巡检，health 可回读逐行结果。任一强制行失败或超时只关闭本进程监听并非零退出，不杀宿主或父进程；

测试环境（`NODE_ENV=test`）里自检等得久一点：单条请求 8 秒（生产 1.5 秒）、等监听 60 秒（生产 10 秒）。判定一条不变，应答不对照样拒绝启动；这只是为了 CI 机器忙时不因「超时」「面没在听」误拒。测试起隔离实例时，用 `scripts/lib/self-probe-env.mjs` 分清环境问题和真失败：环境问题有限次重试，用完了在报错里写明「环境问题」；真失败立刻报。

只有 `NODE_ENV=development/test` 的显式 `MCP_GATEWAY=off` 才把两条 MCP 行变成 warning，生产/未设/空/未知模式配 off 两行均 fail 并拒绝启动；控制面关闭则对应行 skip，不能视为完整认证验证。

自检只使用固定 127.0.0.1、实际监听端口和固定路径，不发送 Cookie、Bearer 或管理员口令。拒绝写探针使用空的非法 name/url，并以无 Origin 的 400 校验对照证明不落业务库；自检审计只标 `source=self-probe` 的状态/行名，不存请求或响应正文，也不计入采纳流量。**后续安全修复必须往自检表增加对应行及正反测试**，不能仅凭配置值宣称生效。详见 [启动自检契约](docs/startup-security-self-probe.md)。本功能不替代 #309/#324 等各自的授权修复或现网上线验收。


## 上线前确认

- 至少一个主体持有管理层授予（管理口令读 `GET /api/health`，`work_items.management_grant_holders` 不是 0）。团队没有负责人时，只有他们能代办放行等过目的事项；一个都没有时，那些事项没人放得了（存量差异清单 L21）。

## 升级冒烟

每次上线前跑一遍 `node scripts/upgrade-smoke.mjs`，看「线上那个版本的库，换成这份代码启动」会发生什么。CI 里是单独的一个 job（`upgrade-smoke`）。

- **基线**：缺省是发布分支 `origin/release/prod-hotfix-1`（本地没有就先 fetch）；要换就带 `--base <标签、分支或提交>`（完整提交号本地没有时按提交号去取）。CI 跑两条：发布分支（第一次上线的起点）和 `fa89254f`（第二次上线的起点）。基线的代码解到 `tmp/` 下的临时目录，依赖和本检出相同就共用，不同就在那里另装。
- **数据**：先用基线的代码起一个空实例、经它自己的接口建凭据库，再用它自己的库模块灌一份合成数据（工作台、驾驶舱、自产台和它们的文件、台数据、技能、SOP 录入、任务、各种投递状态的工作台事件、变更申请、MCP 会话、工作台变量）。只写基线库里有的列，换个基线一般不用改灌数据的部分。
- **查什么**：本检出的代码在这份库上启动两次——能起来、启动自检全过；原有工作台、事件读得出来，凭据库照原主密码解得开；表结构只加不改（不删表、不删列、不改列定义；基线的索引、触发器、视图都还在、定义逐字相同），原有各表行数不变少，原有的行逐行逐列没被改（基线自己每次启动都会改的列先量出来、不算，输出里列出是哪几列；唯一写死的例外是回填版本确实升了时，回填进度表 `work_item_backfill` 的 version、phase、cursor 跟着变，版本没升时这三列变了、别的表的同名列变了照样算改了，`--selftest` 自检这个口径）；回填给每个事件建出一个事项；第二次启动表结构逐字节相同、各表行数相同、事项数不变。然后基线的代码在升级后的库上启动：自检全过，能读，能写（新建工作台、提交台数据、开录入），凭据库解得开。最后本检出再启动一次：自检全过，回滚期间基线写进来的事件（它不认识事项）也要建出事项。事项回填若改成后台跑，脚本会等 /api/health 报完成再看库。
- **隔离**：实例只听 127.0.0.1 的空闲端口；主目录、临时目录和几个工具的配置目录都指到临时目录；环境变量只给命令搜索路径、端口、数据目录和一个合成的管理员口令，不读本机配置、不连任何外部系统。跑完删掉临时目录（`--keep` 保留，排查用）。
- **换代码**：`--head <目录>` 把「要验的代码」换成另一个目录（那个目录要装好依赖），比如拿一份故意改坏的拷贝看它是不是真的会红。
- 每条检查都无条件执行：前提不成立（比如基线上凭据库没建成）就记一条不过，不会悄悄跳过；末尾再核对一遍检查条数。判据只看库里的数和接口的应答，不看日志的写法。
- 退出码：0 全过；1 有检查不过；2 准备阶段出错（取不到基线、装不上依赖、灌不进数据）。

它不覆盖：真实数据的量和形状（大库的回填耗时要另外量）、部署方的扩展目录、登录提供方（Odoo、飞书）和生产环境变量。

## 预发：对外断开

拿生产数据的副本起一个预发实例时，副本里的台地址、通知绑定、投递目标、对端都是生产的真实地址。不断开，它会拿着生产的数据去给真实的对端发消息。设 `WM_OUTBOUND=off` 启动：

- 闸在最底下（`server/src/outbound-gate.ts`，入口文件第一个引入）：TCP / TLS 在 `net.Socket.connect` 这一层拦（fetch、http、http2、反代、Redis 客户端都经过它），DNS 拦 `dns.lookup` 和各种 resolve，UDP 拦 `dgram` 的 send / connect，子进程和 Worker 一律不许起。只放行本进程自己在听的回环端口（启动自检要连自己）。
- 拦不到的：本进程以外的东西（宿主机上别的进程）、原生扩展自己开的套接字、直接调内部绑定（本仓都没有）。所以部署侧仍建议把预发容器放在没有出口路由的内部网络里，作为第二道。
- 会定时往外发的 worker（工作台事件投递、回执 outbox）在关着时整轮跳过：不发、不加 attempts、不判死，在途的保持 pending，开关打开以后原样接着投。启动时的豁免面变更通知不发。库里随副本带来的巡检间隔、MCP 上游、沙箱桥一律按关处理；check-all 返回 503。
- 看得见：启动自检多一行「对外已断开」；`/api/health`、`/api/health/ready` 带 `outbound: { mode: 'off' }`（带管理口令时再给各类被拦的次数和最近 20 个目标）；页面每一页顶上有红色横幅。
- 验证：`node scripts/outbound-off-test.mjs`（CI 里跑）。一个只记账的假网络，库里和环境里所有对外地址都指向它，各触发点走一遍，断言它收到 0 个连接；对照组不开开关重跑，必须收到连接。
- 副本里带着生产的签名密钥（`a2a-key.pem`、`.wm-submitter-ticket.key`）和有效会话：预发实例的地址不要对外开放，预发结束后连数据目录一起删掉。

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
| MCP 生产通道 | `/mcp` StreamableHTTP（stateless，零依赖手写 JSON-RPC 2.0）：AI 会话/任意 MCP 客户端直连市场，**34 个本地工具**（+ 上游聚合）——**免授权**的五个（任何已认证会话都能调，`tools/list` 始终列出；匿名、无效令牌、已吊销照样 401）：权限自助 2 和读技能 3（`skills_list`、`skill_search`、`skill_read`，技能里没有业务数据，新来的席位不用等人批就能自学）。权限自助：`access_info`（会话名、已授权工具、完整工具目录——本地 + 上游，每项带 `category`=read/write/admin、`granted` 和参数表 `input_schema`，没批的工具也看得到参数名——以及本会话提过的申请与状态；申请编号带类别前缀：通用申请 `mcp-N`、台的申请 `bench-N`，时刻统一成 ISO；带 `{ref}` 只回这一条，别的会话的和不存在的同一句；缺工具时先调它）/ `access_request`（`{tools, reason}` 申请授权：工具须在目录里、reason 必填 ≤500 字、同组待批去重、每会话每小时 ≤10 条；管理员在「MCP 网关」页「权限申请」批准 = 并入现有 grants，立即生效、同事务记审计；会话不能自己批，已吊销会话不能批；应答的 `next` 写清批了之后怎么知道：调 `access_info {ref}` 看状态）；**授权限定到单个台**（#452）：grants 与申请都可写 `工具@台id`（目前 `workbench_vars_get` / `workbench_vars_set` 支持；申请里自产台、SOP 台也可以写 `工具@台的标识`，服务端换成台号再记，换不到和台号不存在同一句），只对该台生效——调用前按 `id` 参数核对，台外与未授权同应答（MCP `-32601`、REST 403）并记审计 `not granted: workbench scope`；不带 `@` 的仍是全局授权；台不存在或工具不支持按台时 400，已持有的台被删除后下次保存从 grants 剔除（`dropped` 列明），申请批准前台被删则整单 409；这依赖台 id 自增不复用——**从备份恢复库或 `sqlite_sequence` 被重置时，先清理各会话 grants 里的 `工具@台`**；`access_info` 目录项带 `granted_workbenches`（限定到的台）与 `scopable`；生产 6：`workbench_list`（找台）/`workbench_summary`（总览）/`workbench_check`（探测）/`use_url`（取 `/go/<id>/` 门户入口）/`app_sync`（**从 GitHub main 重拉已登记来源的自产台与 SOP 台**；`app_publish` 与草稿三工具已随来源收敛移除）/`sop_publish`（SOP 上架·`app_activate` 已移出 MCP·回滚走变更申请）；变更申请 2：`change_request_create` / `change_requests`（回滚/删除统一评审门·REST approve 需 managed 口令+reviewed_by）；执行数据 6：`sop_run_start` / `sop_run_step_save`（直接更新持久化执行数据，与 Runner/REST 同链）/ `sop_run_get` / `sop_run_list`（`limit` 缺省 50·最大 200 + `offset` 翻页）/ `sop_run_finish` / `sop_run_sandbox`（VM sandbox 派发·LayerFS commit 交付）；技能 8：读正文 = `skill_read`（**免授权**：缺省读当前版本的 `SKILL.md`，`path` 读这一版里别的文件；只认快照里列得出的普通文件，路径穿越、绝对路径、快照外的符号链接和没有这个文件同一句；二进制和超过 256KB 的只给大小和摘要）；技能名可以写短名字（去掉来源前缀，技能正文里一般这样写）：`skill_read`、`skill_download` 按短名字找，正好一个就用它，几个来源都有同名的报错并列出完整名字；`skills_list`、`skill_search` 每项带 `slug`（完整名字）和 `short_name`，`skills_list` 每项还带一句 `description`（SKILL.md frontmatter 里的）。上传/发版/更新 = `skill_file_put`（**一次一个文件**，不收压缩包；文本原文、二进制 `encoding:"base64"`；单文件 ≤10MB；内容寻址暂存 24h；推荐带 `sha256`：不符拒收、不暂存，应答带 `integrity` 与 `next`，不需要取回核对）→ `skill_publish`（`files` 只列 `{path, sha256}` 引用暂存，一次成版：slug 不存在建技能发 v1，已存在发 N+1；缺文件点名 400；同技能同内容 409；审计人记调用会话；这两个是 admin 类需授权）；获取 = `skill_download`（签发 10 分钟下载票据 `GET /api/skills/dl/<票号>`，URL 不带会话令牌，单票至多下载 5 次，库里只存票号的 sha256，响应带 `Referrer-Policy: no-referrer`；同一版本的包逐字节可重现，应答带 `package_sha256`、`verify_script_sha256`、`tree_digest`，`install_command` 把三者写进命令：先核对整包哈希再解压，核对脚本哈希再执行，脚本再核对清单指纹，任何一步不符都停且不动已装版本；包里有符号链接、硬链接、设备文件，或清单里有绝对路径、`..` 段、目录名与包不一致，整包拒绝；`.tar.gz` 顶层目录为 slug 的 `:` 换成 `.`，内含清单 `.wm-skill.json` 与市场固定模板的校验脚本 `.wm-skill-verify.mjs`：`--install` 先校验包，再把 `~/.workbench-market/skills/<目录>` 旧版本移进 `.backups/`（每技能至多 3 个）后整体换上；不带参数运行列出本地被改的文件）。**迁移**：`skill_manifest`、`skill_file_get` 只在 #460 开发过程中出现过、未随任何版本发布，获取技能一律用 `skill_download`；`skill_publish` 不收内联 content，文件先逐个经 `skill_file_put` 上传/ `skills_list`（`active_version`＝市场当前版本即回滚指针；`current_version`＝本机钉装记录里的版本，两者不是一回事） / `skill_versions`（版本链·`active` 标市场当前版本） / `skill_install_plan`（钉装计划+expected digest·缺省取 `active_version`）——技能回滚（`POST /api/skills/:slug/activate` 或变更申请批准）只把 `active_version` 指针移到已有版本、不新增版本，不带版本号的取装/导出/下载/安装计划随之取它，发布新版恢复跟随最新；发布先写临时目录再整体改名，撞上库里没有的同名版本目录（旧回滚失败留下的）先挪进 `skill-snapshots/<slug>/.orphans/` 并打日志 / `skill_search`（**语义搜**：需求→jev 评估模型打分·P(true)>0.7 严格·≤3 降序·不可用报错不降级；技能库是空的时不调模型，直说还没有导入技能，和「有技能但没有够格的」分开说；实例上没配评估模型（没有 `AI_GATEWAY_API_KEY`）时退回关键词匹配——按标题、短名字、描述里出现的词，连写的中文按两字一组，应答带 `match: "keyword"`、每项带 `keyword_hits` 不带 `confidence`；配了模型但调不通照旧报错不降级）；注册 CRUD 3：`workbench_register`（agent 自主登记外部台）/ `workbench_update` / `workbench_unregister`（凭据字段一律拒绝，人工配置）；台数据 4：`app_data_list`（读自产台表单提交数据）/ `app_data_submit`（写一条表单数据：与 `POST /api/apps/:slug/data` 同一写入核心——1MB 上限、台的数据契约校验，违约返回 400 与逐条 `violations`；可带 `idempotency_key` 重试不重复写）/ `app_files_list`（读文件提交列表，含下载 url）/ `app_files_upload`（base64 上传附件）——**只走 MCP 的 agent 也能登记台数据、上传附件**；工作台变量 2：`workbench_vars_get` / `workbench_vars_set`（#336：按 workbench id 隔离的看板变量与常量，revision 乐观锁，MCP 不能修订常量）；设计标准 1：`design_standard`（只读取 `DESIGN.md` token 与 `PATTERNS.md` 页面模式·`part`=tokens/guide/patterns/all·`section` 按标题过滤·带版本与源文件 sha256——agent 做台/页面前先取）；**上游聚合**（#20 P2）：`settings.mcp_upstreams` 配外部 MCP（如 taste-mcp），其工具以 `<prefix>__<tool>`（如 `taste__rules`）并入同一 /mcp 面，上游工具的类别按其 `annotations.readOnlyHint` 判（明说只读才算 read，否则按 write），上游不可达自动降级不影响本地 34 工具；网关会话存在时以 `X-Market-Client: mcp/<会话名>` 透传调用方身份（上游据此判 judge 身份）。**ygl-trees 上游**（#474）：`PUT /api/mcp/upstreams` 里写 `{prefix, kind:"ygl-trees", ygl_home:"<团队工作区绝对路径>"}`，市场自己启动服务端已装的 `ygl-trees mcp`（stdio，与统一待办同一个入口），把 `read`/`write`/`verify`/`doctor` 以 `<prefix>__…` 并进 /mcp，`read` 归 read、其余按 write；配置里不能写命令、参数或环境变量。工作区须是已存在的目录、先 `ygl-trees db init` 过，且不能是服务端自己的 `YGL_HOME`。子进程只拿系统变量，不继承市场的口令和密钥，`HOME` 指向工作区，`YGL_VERIFY_ALLOW_CMD` 显式置空（verify 的 command 型检查一律判 ERROR）；一个前缀一个子进程、调用串行，超时就杀掉、下次重启。团队用法：每个团队一个市场会话令牌，只读会话只授 `<prefix>__read`——市场从 REST 页面操作升级为 agent 可编程；已实测接入 DSH（dsh-mcp-connector，工具以 `mcp__workbench-market__*` 注入会话） |
| 台数据查看 | 工作台详情（market-app）→「查看提交数据」Drawer：表单数据行（JSON 折叠/提交者/时间）+ 文件（类型/大小/下载）+ 游标加载更多——数据落库后在 UI 直接可查 |
| 工作台变量与常量 | `/api/workbenches/:id/vars`（#336）：每个登记台（自产台、SOP 台、外部 Web 台、Odoo 台）按 workbench id 各有一份隔离的键值空间，供看板读写——`GET …/vars`（列举·`prefix` 过滤）、`GET/PUT/DELETE …/vars/:key`；值是任意 JSON（≤64KB，每台 ≤512 键）；**乐观锁**：每次写 revision +1，改/删已存在的键必须带 `If-Match` 或 `revision`，缺 428、不符 409，响应都带 `current_revision` 与当前值；`kind:'const'` 写入后不能直接改、删，**谁写的谁维护**：新建时记作者 `owner`（只认个人身份 `mcp:<会话名>` / `odoo:<登录名>`），作者本人带 `override` 与 `reason` 可修订、删除（REST 或 MCP `workbench_vars_set`）；口令管理员、Odoo 管理员不因此就能动别人的常量；作者缺失或要移交（`owner` 字段）只由部署机本机命令行兜底；按台令牌注入在页面里、人人可得，不能新建常量（`const_create_forbidden`）。审计表只记值的 sha256，操作者落到 `mcp:`/`odoo:`/`admin-token`/`cli`（`GET …/vars/:key/audit` 管理员读）。**读写口径**：本机命令行与管理员（口令或 Odoo 管理员）可读写任意台；自产台、SOP 台页面凭本台 `X-App-Token` 只能读写本台（沙箱 `Origin: null` 有 CORS）；外部台没有按台令牌，只有管理员能读写；匿名一律 403。**先判权再看台在不在**：匿名、非管理员页面、别台的令牌问一个不存在的台，和问存在的台同一句 403，只有本机命令行和管理员看得到 404；台号只认十进制正整数（`0x2`、`02` 回 400）。只存 SQLite，写返回即落库，不经 Redis。删台时变量随台删除、审计保留 |
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
GET/PUT          /api/settings                  设置（巡检间隔/超时/并发、开关、上游、对端）：管理员（同源）读到全部，凭据类的值只说有没有；别人只读到巡检参数和开关
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
POST             /api/sop/runs/:id/files        上传交付文件（multipart：file，可选 created_by、sha256）；可带期望的 sha256（请求头 X-Content-SHA256 或表单字段 sha256，两处都带须一致），不符 400、不保存；应答带 sha256、integrity（sha256-verified / unverified）和 next，不需要下载回读
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
POST             /api/apps/:slug/data            自产台数据写入（JSON ≤1MB；按台的 data-contract.json 校验（必填/枚举/格式/条件规则 when 可带 require·equals·pattern/数组对象 items 可带自己的 when），违约 400+violations；契约规则合计 ≤500 条，超出时发布/同步即拒；{data, idempotency_key} 信封或 Idempotency-Key 头幂等（键按提交方隔开：台页面的提交是一方，每个 MCP 会话各是一方；页面里认不出是谁的匿名提交，重复和 409 时不回那条的编号和时间）——沙箱台页（源为 null）预检只放行 content-type、x-app-token，只能用信封；台页 iframe 同源 fetch 直通）
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
GET              /api/export                    全量导出（缺省掩码；?reveal=1 取真值要管理员：口令或管理员登录，浏览器来的要同源，否则 403）
POST             /api/import?mode=merge|replace 导入
GET              /api/health                    存活：版本与运行时长（不发外部请求；配了 LayerFS 时回缓存的上次就绪结果；`a2a` 块：入站签名开关的生效值、名片有效期、幂等窗口、出站积压与回执时长、拒收计数——只有计数，查无 SOP 与没有绑定并成 `not-found` 一个桶，计数进程内、重启清零）
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
- **Odoo 管理员登录**：浏览器带着 Odoo 会话（`session_id`）访问时，服务端向 `WM_ODOO_URL` 现查 `get_session_info`，内部员工且 `is_admin=true` 即为管理员，不需另输口令；结论按会话哈希缓存 30 秒（Odoo 侧撤权最迟 30 秒生效）。`GET /api/admin/whoami` 返回当前身份（`via: token|odoo|null`），顶栏显示「Odoo 管理员 · 登录名」。要管理员的读面（变更申请、MCP 会话与权限申请、凭据库、统一待办、绑定、工作台事件的列表和详情 `/api/workbench-events` 等）进路由前先这样认定，所以 Odoo 管理员和口令管理员看到的一样。
- 浏览器发来的管理写（带 `Origin` 或 `Sec-Fetch-Site`）在业务面即可做，但必须同源：跨源 `Origin` 或 `Sec-Fetch-Site: cross-site` 一律 403（Odoo 会话 cookie 是环境凭据，防跨站借用）。
- 持口令时使用页/驾驶舱不内嵌 `/go/`、离开市场页面即抹掉口令（#292 M4 止血保留）。
- **可选独立管理端口**：`WM_CONTROL_PORT` 显式给端口才开（缺省不开）；开了时它不提供 `/go/`、`/sop/`、`/apps/`、`/mcp`、`/openapi.json`、`/api/mcp-rest/*`、`/a2a/*`（404），响应带 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY`，管理写规则与业务面相同。
- 本机 CLI（回环直连、**不带** `Origin`/`Sec-Fetch-Site`、**没有** `X-Forwarded-For`/`Forwarded`/`X-Real-IP`）照旧免口令；逐路由自带 `adminGuard` 的写接口仍要口令。同机反代转进来的请求按远程处理。Node 自带 `fetch` 只发 `sec-fetch-mode`，按 CLI 算。
- web dev（vite 5173）：**默认关闭**；只有显式开启（`pnpm dev` 自带的 `--dev-origin` 启动参数，或 `WM_DEV_ORIGIN=1`）时，Origin 为本机 dev 源且本机直连的请求视同同源（仍要口令）。生产 `pnpm start` / 容器不开。
- **远程节点**（非 loopback）：写请求只放 `/mcp`、`/api/mcp-rest/tools/<name>` 与 `/api/mcp-rest/apps/<slug>/files[/<name>]`（路由内凭会话令牌鉴权）、`.well-known/agent-card.json`、`/a2a/direct`，以及**自产台数据/文件面**（`POST /api/apps/<slug>/data`、`/files`）——应用层写与发布面同口径（远程浏览器提交表单不会被 403）。
- 管理写（`/api/mcp/*` 会话令牌、SOP 绑定、工作台 CRUD 等）一律要管理员（口令或 Odoo 管理员），否则 403。

**主体**：登录认出的人要对到一个主体上才算数。主体是「谁」的那一张表（`principals`），五类——人 `user:<名>`、席位 `seat:<名>`、台 `app:<slug>`、系统 `system:<名>`、外部节点 `node:<团队>`；不是人的主体必须有责任人。现在只有「人」在用，其余四类只建好了结构。
- **外部身份**（`principal_identities`）挂在主体上：提供方 + 对方的用户标识唯一，一个主体可以有多个。现有登录认出一个人时，第一次见到就建一个 `user:<登录名>` 和一条外部身份，之后都是同一个主体。留痕里的旧写法 `odoo:<登录名>` 就是这条外部身份（提供方 `odoo`、标识是登录名），历史记录不用改。
- **等待页**：登录门开着时，登录是成功的（提供方认出了人）、却停用了或还没对到主体的人要页面，给一张「等管理员处理」的页（403），写明登录成功了、要管理员处理，不送回登录页；停用和没对到是同一页、逐字节相同，不透露是哪一种；页上不带任何数据，接口照旧 401。没通过提供方认证的照旧跳登录页。飞书回调里被拦的也是这一页。
- **停用**是本地动作：停用一个主体，所有认人的入口立即不认它——登录门、`/api/auth/viewer`、管理员认定、统一待办读权、SOP 运行读授权、内容面、交给扩展的认人；恢复之后立即照常。提供方的回答可以缓存（管理员认定和登录门各 30 秒），主体停没停用每次现查，不进缓存。共用数据目录的多个实例同样立即生效，重启不丢。
- 标识已经被别的主体占着、这个外部身份却没绑定：不自动认领（那等于让一个外来账号顶替已有的主体），登录不认，要管理员处理。不管经哪个登录提供方，这样被拦的人都进待对接清单（`GET /api/principals/pending`，「关注」的待对接来源也看得到）：只记提供方、对方的用户标识、显示名、邮箱、为什么在清单上和最近一次来的时间，同一个人反复来只有一条，再来时没带邮箱、显示名就留着原来的，保留 30 天；停用的不进（那不是待对接）。原因有两种：`unbound`（对不到主体，管理员对接一次）；`bound-to-non-person`（这条外部身份绑在席位、节点这类非人主体上，不能拿来登录，对接会 409，要先解绑那条外部身份；「关注」里这一条不给对接的答法）。「占着」按规范化之后的值比，规范化用 Unicode 的 NFKC_Casefold（完整大小写折叠加 NFKC，去掉零宽一类的默认可忽略字符；不用土耳其语规则）：只差大小写（含 ß、ẞ、SS）、全角半角、连字、夹零宽字符的写法算撞上，同样不认、不另建（表上按规范化值建了唯一约束）；只拒不并，原值照存。`scripts/principal-fold-test.mjs` 在全部码位上对照 Unicode 的派生属性核对它。
- **管理接口**（都要管理员：本机 CLI、口令或 Odoo 管理员）：`GET /api/principals` 列出全部主体和各自的外部身份；`POST /api/principals/disable`、`POST /api/principals/restore`，请求体 `{"id":"user:<名>","reason":"…"}`，行上记下最近一次是谁、什么时候、为什么。管理员不能停用自己。口令和本机 CLI 不是主体，停不掉，留作应急。
- **对一次外部身份**（都要管理员）：`POST /api/principals/bind` 请求体 `{"provider":"…","external_id":"…","principal":"user:<名>","create":false,"reason":"…"}`，把一条外部身份绑到一个启用的人身上，`create: true` 时目标不存在就新建这个人；`POST /api/principals/unbind` 请求体 `{"provider":"…","external_id":"…"}`。已经绑在别处的（含等价写法）不能直接改绑，要先解绑；管理员不能动自己名下的绑定。变体写法先登录、把本人挡在外面的：先解绑旧写法，再把新写法绑到原来的主体上。每次绑定、解绑写一行日志。
- **规范化依赖 Node 自带的 Unicode 数据**：已经分配的字符，折叠和规范化的结果按 Unicode 的稳定性承诺不会变；换 Node 版本时只有新分配的字符可能变。库里存的规范化值不重算，所以换版本不会让启动撞唯一约束；极少数情形下（登录名里有新分配的字符），撞名检查会多拦或漏拦一次。
- **市场自己的会话**：用飞书等「登录方式」登录之后，发一个市场会话（cookie `wm_session`，库里只存哈希）。绝对期限 `WM_SESSION_TTL_MIN`（缺省 12 小时），不续期；`POST /api/auth/logout` 注销即失效；主体停用立即失效（认人时连着主体状态查），停用时这个人的会话全部注销，恢复之后要重新登录。请求同时带着市场会话和 Odoo 会话时按市场会话算；两边认出的不是同一个人时留一行痕（`source: identity`、`event: session-mismatch`，两边各认成谁），同一对会话只记一次。会话登录的人不是管理员（角色和授予在阶段六）。
- **飞书登录**（`WM_FEISHU_LOGIN=on`）：标准授权码流程，`GET /login/feishu?next=<站内地址>` 发起，回调 `/login/feishu/callback`。回调地址按 `MARKET_PUBLIC_URL` 拼，要和飞书应用里登记的一致。`state` 一次性、绑在发起它的浏览器上、10 分钟有效、按来源限额；`next` 只收站内路径。飞书应用的标识和密钥从凭据库里的一条（`WM_FEISHU_VAULT_ENTRY`）取，要部署方配了服务端主密码（`DSH_VAULT_PASSWORD_FILE`）才能无人值守读；库锁着时飞书登录回 503。认人用 union_id。还没对到主体的飞书身份：不自动建主体，停在「等管理员开通」，列进 `GET /api/principals/pending`，管理员用 `POST /api/principals/bind` 对一次，第一批上线可以用 `POST /api/principals/bind-batch`（请求体 `{"items":[{"provider","external_id","principal","create"}…],"reason"}`，一次最多 500 条，逐条给结果）。待对接清单只放对方的用户标识、显示名、企业邮箱和最近一次来的时间，30 天没再来的清掉；等待页对停用的和没对到主体的一模一样，不透露有没有这个人。打开 `WM_FEISHU_AUTO_BIND_EMAIL` 时，飞书企业邮箱和身份来源的登录名（按规范化之后）恰好对上一个启用的人、而且那个人还没有别的飞书身份，才自动绑，每次自动绑定留一行痕。
- **离职即时失效**：飞书事件订阅的请求地址填 `<MARKET_PUBLIC_URL>/login/feishu/events`，订阅「员工离职」`contact.user.deleted_v3` 和「员工信息被修改」`contact.user.updated_v3`，并配 Encrypt Key。Encrypt Key、Verification Token 放在凭据库同一条（`WM_FEISHU_VAULT_ENTRY`）的自定义字段 `encrypt_key`、`verification_token` 里。照飞书文档验签（时间戳 5 分钟内、`X-Lark-Signature`）、解密、核对 Token 和 App ID；验不过 401。同一个事件号只处理一次（多实例共用、保留 7 天）；记事件号和停用在同一个事务里，停用出错事件号一起撤回，飞书重推时照常处理。处理出错只回固定的 503（`event_unavailable`），内部原因只进日志。离职、被修改成离职、冻结、退出的人：停用他绑着的主体，每个入口立即不认，会话一并注销；还没对到主体的从待对接清单里删掉。配了租户时别的租户的事件不处理。
- **每日对账**：每天一次把绑在启用的人身上的飞书身份交给飞书查（`tenant_access_token` 加按 union_id 查人），状态明确说离职、冻结、退出的才停用；飞书出错、查不到的一个也不停用，只计数留痕。管理员可以手动跑一次：`POST /api/principals/reconcile`，请求体 `{"flow":"feishu"}`。**补不上的情形**：飞书那边直接删掉的人，如果「员工离职」事件也丢了，按 union_id 查回来是「不存在」，对账按查不清处理、不停用，每天留痕里的 `unknown` 会一直算上他。`unknown` 不为 0 就要人工复核：留痕的 `unknown_ids` 列出查不清的 union_id（最多 100 个），对着飞书通讯录核对，确认离开了由管理员手动停用（`POST /api/principals/disable`）。
- **角色与授予**（阶段六 6b，只建结构，不接判定，不改变任何人能做什么）：角色是声明——平台的七个内置预设（`owner` 属主＝全部；`admin` 系统管理员＝系统域的读写管、各处的管理类，**默认不看业务数据**；`management` 管理层＝全公司的读写决定、不管系统；`dept-lead` 部门负责人＝读写决定、范围由授予给；`member` 普通员工＝读、提需求那几个写、只限自己的事的决定；`guest` 访客＝空、授予必须有期限；`ai-staff` AI 员工＝读写、只授予非人主体、决定类永远无效），组织角色用仓库里的通用初始集合（`dept-member` 部门成员＝读写），或者 `WM_ROLES_FILE` 指的外部声明文件。内置预设不能被覆盖、不能改，只能复制成自定义角色；预设的定义在阶段六切换之前不生效（放不放行照旧由各处的旧守卫决定）。权限按动作或按类别写，类别可以用 `domains` 圈在几个动作的域里；域分「系统」「业务」两张清单（`server/src/roles.ts`，进快照），每个已登记动作的域都要在其中一张，清单外新长出来的域算业务。范围通常不写、由授予给（`*`、`domain:`（授权域）、`dept:`（部门，标识要在部门表里）、`bench:`、`sop:`、`tool:`、`self`，另预留 `object:` 只存只比相等）。授予是数据：`/api/grants` 起草→提交→放行→撤销，状态只能往前走、每步留痕；不能给自己授予；管理员级的只有属主（本机命令行，或持有生效的 `owner` 授予的人）能放行；不是人的主体要有在职的责任人；决定类权限不给不是人的主体；到期自动失效。
- **自定义角色**（存库，校验和声明文件同一套）：`POST /api/roles/:id/copy {id, name}` 从任一角色复制；`PUT /api/roles/:id {name?, permissions}` 改（应答里 `affected_grants` 列出会影响的授予）；`DELETE /api/roles/:id`（有授予在用 409）；`POST /api/roles/:id/approve` 属主放行；`GET /api/roles/export` 导出成声明文件的格式。带来管理类或决定类权限的建和改要属主放行：口令管理员建的先 `pending`（放行前不能授予），改的先记成 `proposed`（放行前生效的定义不动）。从 AI 员工复制出来的不许带决定类。不能和内置预设、声明文件里的重名；声明文件后来用了同一个 id 或名字的，重启后以声明文件为准。每次建、提议、改、放行、删都留痕。都要管理员，放行只认属主。`GET /api/roles/matrix` 给「谁能做什么」的角色矩阵：角色 × 七大块（全景、事项与对话、关注、工作台数据、团队与 AI 员工、权限与角色、系统与节点，`roles.ts` 的 `BLOCKS`，每个动作的域归且只归一块）× 看/做/拍板/管理，格子取值 `all`（全部）、`scoped`（范围内）、`some`（部分动作）、`self`（只限自己的）、`none`（不能）、`na`（这一块没有这一类动作），另带卡片用的四句白话；服务端从角色定义算，前端不拼。`/api/auth/me` 认出了人时另带 `principal`、`display_name`、`roles`（当前生效授予的角色键、中文名、范围、是不是预设、来源 manual/migration、放行人）；口令、本机命令行、没登录时 `principal` 为 null、`roles` 为空。升级要注意的见 [docs/upgrade-notes.md](docs/upgrade-notes.md)。
- **判定与并行比对**（阶段六 6c，不改变任何人能做什么）：
  - 判定是 Cordis 事件 `judgment/judge`，按 bail 派发。内置监听器照六步判：主体停用→拒；动作没声明→拒；决定类而做的不是人→先问人；有覆盖的授予→允许，席位还要责任人也有；其余→拒。企业规则是另外的插件，挂在它前面。
  - 管理口令、本机命令行、本机页面、匿名是内置身份（`server/src/judgment-builtins.ts`）：权限按动作逐条列出，列的就是旧守卫今天放行的那些，进 `surfaces/actions.json` 的快照。管理口令另照管理员角色算，五个决定类动作登记为「代属主行事」。本机页面由匿名的清单推出来；登录认出来的人判不过时按匿名的清单兜底（匿名能做的，登录的人也能做）；少数比管理员更严的动作单独收窄（只有列出的身份能做）。
  - 旧行为里不合理的地方登记在 [docs/judgment-legacy-differences.md](docs/judgment-legacy-differences.md)，以后单独改。
  - 路由可以声明「状态码不代表授权」（`statusNotVerdict`，写原因）和按请求细分的动作（`refine`，比如带 `reveal=1` 的导出、任务中心台的发布），都进快照。
  - `WM_JUDGMENT_COMPARE=on` 时，每个请求应答结束之后算新结论，和旧守卫的结论比：
    - 401/403 是拒、2xx/3xx 是允许、404 不判、其余记「不确定」；
    - 声明了状态码不代表授权的不比；
    - 带跨站或别的站标记又被拒的记「被完整性门拦下」：同源门在判定之外、之前，切换时原样保留；
    - 只比报了动作的路由。
  - 比对记录：
    - 不一致按路由模式、身份类别、两边结论、命中规则合并计数，最多 1000 种；
    - 不记请求体、查询串、凭据和路径里的 id；
    - 记账攒批，应答之后异步写进单独的库文件 `judgment-compare.db`（不和业务库抢锁），写失败只计数；
    - 判定出错只计数，不影响应答。
  - 结果看 `GET /api/judgment/compare`。`scripts/judgment-compare-report.mjs` 把回放和 CI 脚本在比对打开时跑一遍，按域×原因出报告，另有按域×结果的汇总；`--from <比对输出.jsonl>` 不跑脚本，只汇总已有的比对输出（`WM_JUDGMENT_COMPARE_OUT` 的文件）；`--snapshot <GET /api/judgment/compare 的应答.json>` 拿接口里攒着的合计出同一张按域的表，再给 `--since <更早的一份>` 就只算两份之间新增的——生产上用这个，不用开 `WM_JUDGMENT_COMPARE_OUT`（那个文件每比一次加一行、不轮转），单测 `scripts/judgment-compare-snapshot-test.mjs` 核两条路出的数相同。零不一致的门槛有两道，都在 CI 里：`scripts/judgment-compare-zero-test.mjs` 跑全量回放；`scripts/judgment-compare-sweep-test.mjs` 让六种身份把每条 GET 打一遍、写面挑代表。
  - 迁移出来的授予来源记 migration：`GET /api/grants?source=migration` 列出，`POST /api/grants/revoke-migration`（只有属主）整批撤销。迁移只给 `member` 和（身份来源说是管理员的）`admin`，不给 `management`：`scripts/judgment-migration-test.mjs` 守住管理员被迁之后团队分配仍 403、认领仍走提议、数据视图仍进不去。
- 管不到的：按 run 发的读凭据、自产台查看凭证是不记名的，各有各的期限和吊销，不随主体停用失效；已经建立的 WebSocket 连接不会被掐断，新的请求和新的连接立即拒绝。停用是按登录名对的：身份来源那边把登录名改了，就是另一个人。
- **读要凭据**：`GET /api/apps/<slug>/data`、`/files`、`/files/<id>` 要本台的台令牌（`X-App-Token`，服务端出台页面时注入）、管理员（口令或管理员登录，同源）或本机命令行；沙箱页的下载链接和图片带不了头，认登录门签给本台页面的查看凭证（`wm_av`）。不满足一律 403，先于查台。远程 agent 读台数据走 MCP（`app_data_list`、`app_files_list`，可按台授权）。设计上，能打开某个台页面的人就能读这个台的数据（台令牌在页面里）；「谁能打开哪个台」和按人读另行设计。

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
server/src/      （一个文件一行，按文件名排序；新文件只插一行）
  a2a-direct-sig.ts（/a2a/direct 入站签名校验：只从登记地址取卡·防重放·WM_A2A_DIRECT_SIG）
  a2a.ts（卡片/绑定/direct 准入）
  a2a/errors.ts（A2A 拒收原因表：错误码 → 中文原因与处理办法·公开计数的桶，对外同答的原因并桶）
  a2a/health.ts（`/api/health` 的 `a2a` 块：开关生效值、名片有效期、幂等窗口、出站积压、拒收计数·只出计数不出团队与地址·读数缓存 5 秒）
  a2a/peer-card.ts（对端名片：按投递的根地址取名片、上游 verifyCard 验签；投递时记下对端是谁、回执到达时用同一张名片验签名·不跟随重定向、5 秒、64 KiB）
  a2a/receipt-inbound.ts（席位的 A2A 回执入站：`/a2a/direct` 在签名校验和准入之前的窄分流——正文是回执、任务号是我们发出的、签名方是当初投递到的那台宿主，三条都成立才采信并写事件日志，事项照常推进；否则照原路，应答不变）
  a2a/reply-outbound.ts（市场回给团队的消息：人的答复与对席位消息的回复作为同一 context 的新任务发回；收下跟进后在 receipt-<跟进任务号> 上回结清回执（只用跟进的任务号，发不出去一直重试）；复用事件投递的发送函数、退避与签名）
  a2a/roster-stats.ts（团队名册入站的结果计数：收下、过期、不认、撞键、来源不是投递过的宿主、验签不过、名片没声明、超长、首行格式不对，各自的次数和最近一次的时间；给 health 的 `a2a.roster`，只出计数和时间、不出对端标识，进程内、重启清零）
  app-data-contract.ts（自产台数据契约：必填/枚举/格式/条件规则（含条件格式）/数组对象逐元素，POST 数据时服务端权威校验）
  app-html.ts（出自产台页面 HTML：注入按台令牌，认得出的人在当前上架版本上再注入提交人票据；出票抛错页面照常不带票据，别的出错回到原样页面并计数）
  seat-messages.ts（事项对话里的席位消息：跟进不进「关注」，在事项页列出、带未读数；看过标已读、回复作为同一 context 的新任务发回）
  cockpit-access.ts（谁能建、改、删驾驶舱：本机命令行和管理员照旧；登录的人交给判定，管理层的预设点名了 cockpit.create / update / delete；写路由、读应答的 can.edit、/api/auth/me 的 can.create_cockpit 都问这一处）
  attention-answers.ts（「关注」各来源的答法：转给原路由的换算表——路径固定、id 核形状后编码、请求体只取这种答法要的字段；席位提问的答复、事项的验收和退回直接实现）
  attention-forward.ts（进程内把答复转给原路由：全局中间件和原路由的守卫照走，身份头原样、来源地址照抄，应答原样交回）
  attention-names.ts（「关注」条目的显示名 waiting_for_name、creator_name：在汇总那一层统一补，只给看的人本来就看得到的人的名字——管理员、本人、管理层、同部门的；别的给 null，席位、对端这些非人键给 null，MCP 会话给类型加名字）
  attention-providers.ts（「关注」的七个提供方：各来源用旧接口自己的守卫判可见性，只读地取数；阶段三搬完再挪回各域）
  bench-card-delete.ts（删一张卡片时连带它的台库：台库里有数据时要持管理层授予（或本机命令行）并带 confirm_bench_data，只有管理口令、系统管理员身份、MCP 会话的一律 409，409 只给规模·删前备份进 bench-stores/.deleted/ 留 30 天·台的登记、授予、卡片在一个事务里删，之后删库文件、清 Redis 键，清不掉的由清扫补）
  bench-mcp-tools.ts（数据视图的 MCP 工具定义：纯数据，十五个工具的名字、说明、类别和参数；都必须限定到台，授予和执行在 services/bench-mcp.ts）
  bench-query.ts（数据视图的查询描述：台的作者和 agent 不写 SQL，只给筛选、分组、聚合、排序、行数上限；这里核对并翻成参数化语句·名字只认白名单且必须已定义·值全走参数·见 docs/data-views.md）
  bench-views.ts（数据视图的视图描述：保存前核对组件类型、键、引用的数据集和列、查询、筛选栏参数；两个版本之间的差异·第一批八种组件）
  config.ts（配置的落点：模块自己的 Config，defineConfig 声明认哪些环境变量、怎么解析，启动时取一次；服务类插件写成 static Config，由 Cordis 装插件时校验）
  admin-token-env.ts（启动环境给的管理口令 ADMIN_TOKEN：启动时取一次、全进程只认这一份；对外只给有没有、常量时间比对、登录门指纹三样，口令本身不出模块。index.ts 的口令校验、a2a.ts、管理口令路由都经它）
  content-access.ts（内容票据与准入）
  content-static.ts（无令牌静态资产读取）
  content-surface.ts（内容面终结分发与到期引导）
  context.ts（服务容器）
  db-busy.ts（库被别的连接锁着写时最多等多久：DB_BUSY_TIMEOUT_MS = 5000。市场主库、判定比对库用它，台库每次读写取它和那一次时限中较小的；部署切换时新旧进程短暂重叠写不直接报 database is locked，超过上限照样报错。多个进程同时写同一个库仍不支持）
  db.ts（schema+迁移）
  design-standard.ts（MCP design_standard 工具的 design token 标准只读读取）
  design-tokens-css.ts（DESIGN.md 生成的 tokens.css 服务端出口）
  endpoint-stats.ts（端点数）
  errors.ts（错误类型）
  eval.ts（#178 jev 评估客户端）
  extensions.ts（扩展挂载点·WM_EXTENSIONS_DIR）
  file-sniff.ts（上传按内容识别类型：签名为准、扩展名与内容不符或可执行文件拒收）
  github-source.ts（GitHub main 分支来源拉取：commits/trees/blobs 三段取内容·版本记 commit sha）
  health.ts（探测）
  http.ts  HTTP 服务（Cordis 服务 http）：持有 Express 应用；域模块经它注册路由，每条报上动作名和类别，注册可撤销
  identity.ts（身份契约：核心只经它认人·Cordis 服务 `identity` 认人与 whoami、`loginRelay` 业务台登录中继的窄接口·`/api/auth/viewer`·提供方认出的人要对到主体上才算数，主体停用即不认）
  index.ts（REST+静态+巡检装配）
  judgment-builtins.ts（内置身份：管理口令、本机命令行、本机页面、匿名，权限按动作逐条列出，进快照）
  judgment-compare.ts（判定的并行比对：WM_JUDGMENT_COMPARE 打开时比新旧结论、记不一致）
  team-relation.ts（「这个人或席位，对这个部门、团队、席位是什么关系」：dept-member、dept-lead、team-lead、seat-owner、team-seat、router，另带显示用的名字；过目、安排、事项详情、数据视图「谁能改这个台」共用）
  judgment-enforce.ts（判定切换的开关 WM_JUDGMENT_ENFORCE：读开关、核域、在切了的域里路由处理之前先判；「暂不切」清单在 judgment-builtins.ts）
  judgment-read-deny.ts（判定切换的读路：新判定拒也让旧处理函数照跑，在应答头发出去那一刻看状态码，旧的要放行才换成拒绝；不依赖服务，单独测）
  red-lines.ts（红线清单：越不过去的规则，每条写明在哪儿管着、哪个对抗组盯着；scripts/red-lines-test.mjs 核对每条都有带 [red-line:<id>] 的对抗例）
  judgment.ts（判定：Cordis 事件 `judgment/judge`，内置监听器照六步判）
  layerfs-shadow.ts（LayerFS 影子发布结果持久化：只回写 commit_id 为空的版本行，失败标记后可重试）
  login-gate.ts（全站登录门 WM_LOGIN_GATE：enforce 时页面 302 登录、API 401）
  mcp-tools.ts（MCP 工具注册表）
  owner-pending.ts（待属主看板的判断，服务端那一份：和 web/src/owner-pending.ts 跑同一份用例表 scripts/owner-pending-cases.json）
  outbound-gate.ts（对外断开 WM_OUTBOUND=off 的闸：在 net.Socket.connect、DNS、UDP、子进程这几层拦下一切出站并计数；index.ts 第一个引入它）
  path-inside.ts（路径落点判断，只此一处：规范化后等于根、或以「根加分隔符」开头才算在根里；/apps/ 静态托管、/go/ 转自产台、/sop/ 附件都用它）
  portal-observation.ts（无敏感原文的被动计数）
  portal.ts（/go/ 反代·白屏五层+登录态）
  redis.ts（Redis 连接和 SOP 执行实例的热态：连接只有这一条；SOP 的读写经共用状态层的 sop 句柄，只碰 wm:sop: 开头的键）
  request-person.ts  这个请求是哪个人：只经身份服务认请求带的登录凭据（登录提供方的会话或市场会话），主体须是启用的人；认不出就是没有，调用方照常放行（任务中心建录入、发布用）
  roles.ts（角色声明：平台四个内置角色 owner/admin/member/guest，组织角色初始集合 dept-member/dept-lead 或外部声明文件·启动时校验，不合格拒绝启动）
  root-context.ts（全进程唯一的 Cordis 根上下文·不开数据库）
  settings-view.ts（设置读出去的样子：管理员看全部、凭据类的值只说有没有；别人只看巡检参数和开关；导出用管理员那一级）
  sop-field-channel.ts（字段/上传/人工完成通道候选）
  sop-field-finish.ts（未挂载人工完成路由）
  sop-field-rules.ts（SOP 字段规则：从步骤 HTML 读 required/pattern/长度/类型、条件必填 data-required-if、字段间数值关系 data-check 与文件清单 data-type="file-list"，完成时服务端校验，文件清单另按文件面实际 hash 逐行核）
  sop-field-save.ts（未挂载字段保存路由）
  sop-field-upload.ts（未挂载惰性文件上传路由）
  sop-read-auth.ts（#309 run 私有读授权：读能力 + 主体 grant）
  sop-readonly-assembly.ts（冻结清单与run装配）
  sop-readonly-channel.ts（只读隔离字段通道）
  sop-run-access.ts（run授权、能力与revision事务）
  sop-runner.ts（SOP 执行页）
  sop-runner.ts（执行页）
  sop-state-checkpoints.ts（#337 热写检查点：逐 run 串行与 SQLite 落盘期限）
  sop-types.ts（SOP 类型）
  sso-ticket-store.ts（门户 SSO 回调一次性票据的 SQLite 存储：重启不丢、多实例原子取出）
  startup-gate-hold.ts（服务进程最先引入：拉上启动闸）
  startup-gate.ts（启动闸：后台任务——事项回填——等启动自检通过再开始；没拉闸的进程照旧马上开始）
  startup-security-self-probe.ts（#326 启动匿名安全面自检与门闩）
  submitter-ticket.ts  提交人票据：出台页面 HTML 时给认得出的启用的人一张票据（服务端密钥签名，绑主体、台、两小时，不续期），台页面提交时放在信封的 submitter_ticket 里带回，验过才在这个台的提交上记下这个人；别的入口一律不认；启动自检失败就关掉（不出、不认）
  surfaces.ts（#292 M1 业务面/控制面多端口监听·按 localPort 判面·浏览器标记与回环判定）
  task-center.ts（任务中心元台种子+收件发布）
  tasks-read-access.ts（#324 待办身份与来源授权）
  tasks.ts（定时任务）
  upload-integrity.ts（上传应答的核对结果：调用方带了期望的 sha256 / size 且对上才会存，应答写明 integrity 与 next，agent 不必下载回读；MCP 上传与 REST 上传共用）
  url-admission.ts（#258 R3 业务 URL 登记准入单核·WM_REGISTER_URL_ALLOWLIST）
  ygl-cli.ts（调 ygl-trees 的命令行：找入口（WM_YGL_CLI 或几处安装目录）、无 shell 调用、按 --json 契约读结果；统一待办、经验库、MCP 上游共用）
  vault-api.ts（凭据库 REST 面：17 条路由经 HTTP 服务注册，报动作 vault.*（管理类）；除状态外声明面门——服务端持有主密码时只在控制面或凭据库专用域名开放）
  vault/（dsh-vault 存储层引入件·见其 README）
  work-item-access.ts（事项上的四种人 itemRoles（建立人、成员的主人、负责人、管理层，成员的主人按团队服务的分配段和 inSegment（左闭右开，列表 seats 视角同一个口径，席位按（节点, seat_id）或（节点, 团队, 句柄）完整的键认），负责人按 relationOf，管理层按 work-items.view-all 这个拍板类动作认）和看得到的范围 canSee、列表的视角 viewScopes（mine、seats、team、all）；事项上这个人能做什么、是不是轮到他：canOf、turnOf、creatorOf，事项详情和「关注」共用；每一项和对应动作接口同一处判断（放行 canRelease、releaseRole（负责人；团队没有负责人时管理层代办；建立人勾了先过目由建立人放）、对话写入和验收 writerVerdict、回复 replyableMessages、提问 pendingAsksOfEvent））
  workbench-events.ts（工作台事件层 v1：人提交→事件→团队接单→决定回写）
  workbench-vars.ts（#336 工作台变量与常量：按台隔离、revision 乐观锁、常量保护）
server/src/login-providers/  登录提供方插件（身份的具体实现只放这里，核心不引用）：index.ts（清单：这个部署装哪些提供方） feishu/index.ts（飞书登录方式：授权码流程，向 `identity` 登记一个登录方式，凭证从凭据库取） odoo/index.ts（Odoo 提供方的插件入口：向 `identity` 登记、提供 `loginRelay`） odoo/odoo-viewer.ts（Odoo 查看人现查） odoo/odoo-session.ts（门户 Odoo 会话可信源判定与剥除、登录回调票据） odoo/odoo-login-proxy.ts（可选同源 Odoo 登录中继 WM_ODOO_LOGIN_PROXY：只放行登录面，不代理 Odoo 应用） odoo/odoo-browser-origin.ts（只给浏览器用的 Odoo 登录地址 WM_ODOO_BROWSER_URL：登录一跳送到可信内网地址，身份与代理目标不变）
server/src/services/  app·app-data·sop·skill·sandbox·cockpit·workbench·cookie·setting·mcp（域服务）；其余一个文件一行，按文件名排序：
  a2a-followups.ts（席位发来的消息（跟进）的登记：收下、按投递与对端计数、事项对话里的未读、看过、回复）
  a2a-handles.ts（市场 A2A 会话句柄 `market/<node8>` 的唯一性：生成时避开已占用的，存量撞车的不上卡、入站失败关闭）
  a2a-idempotency.ts（`/a2a/direct` 幂等登记：task_id → 指纹 sha256，30 分钟窗口，落库，重启后同一 task_id 仍判 replay / conflict；只存摘要不存原文）
  a2a-peers.ts（对端登记表：Cordis 服务 `a2aPeers`·一个节点一行·登记时取名片验签钉住公钥·公钥变了改成 key_changed 等管理员确认、不自动接受·停用是粘住的、只有管理员重新启用能解·canDeliver 供投递查（调用方阶段七接上，接上前对投递、入站没有效果）·按对端算健康·升级回填从现有绑定和投递建对端行）
  a2a-receipts.ts（回执入站的登记：我们发出的任务号 → 事件、投递、对端；采信过的回执按任务号去重；签名只认一次）
  a2a-roster.ts（团队名册：每台宿主一行、席位按「节点 + 团队 + 句柄」一行，以新替旧；入库时算出变化（新团队、新成员、成员消失、团队消失、换总工）记进 a2a_roster_changes；在办件数从事项现算；只当信息）
  a2a-replies.ts（市场回给团队的消息的发送状态：答复、来信回复、跟进回执；时间由代码生成后写入）
  a2a-stats.ts（A2A 出站积压的聚合读数：两张出站表按状态计数、最老待发、最近回执时长）
  attention-sources.ts（「关注」要用、来源里还没有现成函数的只读查询：席位未答的提问）
  bench-mcp.ts（数据视图的 MCP 工具：授予按「会话 × 台 × 工具」记在自己的表里，不放进会话的 grants·申请由会话提、台的管理层批·读也按台限定·执行时把台库的方法对到工具名上）
  bench-registry.ts（视图台的登记：主库里只记有这个台、叫什么、谁建的、绑到哪个部门和团队·登记过的台才有库，没登记的标识一律当作不存在·改绑留痕·卡片 id 为主、台标识为别名：入口写卡片 id 或台标识都认（resolveBenchRef），只给 workbench_id 就开出 wb-<卡片 id>·纯数字标识不许登记·删卡片时登记和授予一起删（removeCardBench））
  bench-store.ts（台库对市场进程的接口：读写不在市场进程里跑，这里只排队、转发给工作线程、看时限、线程出事时收拾·台按标识固定分到几条道上（一道一个线程，默认核数减一、至多 4）·大写入（按体量估，不按行数）全局一次一件、做完换线程·读 3 秒写 15 秒，时限加宽限过了还不停才强行终止线程并另起·排队有上限·接口全异步·还没有对外入口，不判权限）
  bench-store-core.ts（台库的逻辑本体，在工作线程里跑：每个视图台一份自己的库，在数据目录 `bench-stores/` 下·数据集与列定义的版本·整份替换、追加、按主键更新和删行（逐行校验、幂等键、上限）·快照与退回·视图描述的版本、生效指针、并发保存不覆盖、回退只移指针·变更与写入记录只存摘要·视图取数（一次取齐各组件的数据）和表单提交·三道数据量上限·时间由调用方给、一个台的读写排成一队·到时限自己停下并回滚·运行时不引用 `db.ts`，建表语句由调用方递进来）
  bench-store-worker.ts（台库的工作线程入口：一次做一件事，只认登记过的操作名和消息格式，回话带上这件事提交了的变更）
  bench-sweep.ts（台库的清扫：Cordis 服务 `benchSweep`·起来 1 分钟后一次、之后每天一次、随根上下文停·没有登记的库文件先备份再删·.deleted/ 里过了 30 天的备份删掉·Redis 里卡片已不在的台的键清掉）
  attention.ts（「关注」：Cordis 服务 `attention`·各来源注册提供方、可撤销·汇总当前这个人的条目和各类条数）
  binding.ts（A2A 人工绑定）
  change-request.ts（人审变更请求；detailOf 给审核卡片看内容所需的最少字段：版本从几到几、目标版本说明、删除连带几个版本几个文件、不可恢复）
  custom-role.ts（自定义角色：Cordis 服务 `customRoles`·从内置预设复制、改、删、属主放行、导出·每步留痕·带来管理类或决定类权限的要属主放行）
  department.ts（部门：Cordis 服务 `departments`·部门清单、负责人、成员归属、职能代号·部门标识即授予范围 dept:<标识>·还有没结束的部门授予时不能删）
  team.ts（团队与分配：Cordis 服务 `teams`·团队登记（认领、挂部门）、负责人（另外指定的加所挂部门的负责人）、成员分配（起止时间、同一席位只有一条生效、按时间点查那时归谁）·键和节点名册一致·状态读的时候推·每步留痕 team_events）
  relation-proposal.ts（关系的提议：Cordis 服务 `relationProposals`·部门负责人、团队负责人只有属主能确认，团队认领到部门要管理层或接收部门的负责人确认·提议期间关系不存在、不带来权限·确认接口和页面的 can_approve 共用 confirmRefusal）
  dept-lead-grant.ts（部门负责人的字段和授予一起落：属主确认、属主直接指定时同一事务里写负责人字段、发这个部门范围的 dept-lead 授予并记进 dept_lead_grants；换人、移除只收回记着的那条；字段单独不带来权力，只有字段的是「待属主放行」，启动时补记一条负责人提议给属主）
  setup-wizard.ts（首次安装向导：Cordis 服务 `setupWizard`·按形态（small / standard）生成一批草稿授予、可重复跑、属主一次放行·「向导建的」记在 setup_wizard_runs / setup_wizard_grants，读的时候推出来源 wizard）
  grant.ts（授予：Cordis 服务 `grants`·草稿→待核→生效→撤销或过期只能往前走·不能给自己授予·管理员级只有属主能放行·决定类只给人·到期自动失效·每步留痕）
  judgment-compare.ts（判定比对的记账：Cordis 服务 `judgmentCompare`·按路由计数·不一致合并计数、有上限）
  knowledge.ts（经验库：Cordis 服务 `knowledge`·从 ygl-trees 的 library 出口（契约 ygl-library/1）按类增量同步目录、每天全量对账·正文按需取·给页面的键是带本库密钥的 HMAC，不露 ygl-trees 的 id·谁能看哪条按授予逐条判·有项目、没给范围的条目按「项目 → 部门」对照当部门级，对不上的只给管理层）
  login-session.ts（市场会话与登录 state：Cordis 服务 `loginSessions`·绝对期限·注销与停用即失效·state 一次性并绑浏览器）
  principal.ts（主体与外部身份：Cordis 服务 `principals`·把登录认出的人对到主体·停用与恢复）
  remote-allow.ts（远程写豁免面的快照）
  state-layer.ts（共用状态层：Cordis 服务 `state`·Redis 可选、没有就以 SQLite 为准·台的键 `wm:bench:<台 id>:…` 由 benchKey() 拼·删台按前缀清·随根上下文断开·别的域经 stateDomain(<域>) 拿句柄（现在只有 sop），只许碰 wm:<域>: 开头的键）
  submission-counts.ts（「人提需求」的提交计数：只记通道、有没有登录凭据、认没认出人，按天累计次数，不存内容；提交人票据验得过、验不过的次数）
  task-center.ts（任务中心：任务、事件、总开关、状态迁移）
  work-item.ts（事项与事项日志：Cordis 服务 `workItems`·按迁移表推进状态的唯一入口 `apply`·日志只增不改；听 workbench-events 每写一行事件日志发的 `workbench-event/logged`，在来源的事务里用保存点推进事项，出错不影响来源、按事实种类计数；`backfill()` 从事件表和事件日志补建存量事项，可重跑；建事项时记下交给方式（handoff：team / own-seat / lead-directed，存量是 team）、等谁过目（review_by）和指名的席位（directed_seat_id，只认 seatId），都从事件层 recorded 那一行取；建事项时标题取任务中心的任务标题（取不到退到来源坐标）、派给取投递的目标团队，存量里还是自动缺省值的启动时补上；建立人主体 `creator_principal` 只取发布时经身份服务认出、来源已验证的人，认不出就空着，「是不是他的」只认它（`isCreator`），`created_by` 只用于显示（认出提需求人时就是他的主体，认不出才用事件上自填的名字；不拿发布人顶替））
server/src/routes/    按域分的路由模块，各带一个注册函数（一个文件一行，按文件名排序）：
  a2a-direct.ts（A2A 入站 /a2a/direct：POST 收对端投递（回执分流、入站签名、绑定准入），GET 一律 404）
  a2a-outbound.ts（A2A 出站的两条管理面：/api/a2a/state 本节点 A2A 身份概况、/api/a2a/send 以市场身份发一条消息；都只给管理员，send 只发给对端登记表里 active 的对端，发往登记的根地址）
  a2a-peers.ts（对端登记表 /api/a2a/peers：列出和健康、登记、刷新名片、确认新公钥、停用、重新启用，只有管理员能用）
  admin-token.ts（管理口令 /api/admin/whoami、/api/admin-token）
  agent-card.ts（A2A 签名卡片 /.well-known/agent-card.json）
  app-data.ts（自产台的数据与文件 /api/apps/:slug/data、/files：提交、列表、软删，上传、改备注、下载；提交和上传是匿名提交面，不经写总门）
  apps-static.ts（自产台静态托管 GET /apps/<slug>/…：只是注册那一行，处理函数 serveApp（活跃版本或 ?version、CSP sandbox、注入本台令牌、LayerFS 冷回读）门户也用，留在 index.ts）
  apps.ts（自产台与 SOP 台的登记和生命周期 /api/apps：列表、单个台、task-center 直接发布、从 GitHub 同步、迁进 LayerFS、回滚、删台；台的数据与文件另成一域）
  attention.ts（「关注」的读 /api/attention：当前这个人在七个来源里等他处理的条目和条数。席位的提问全库直接查还没答的（不按最近多少个事件截断，和事项的 can/turn、列表的 decide 同一个口径），按提问先后分批取、按看得到的过滤，每人最多列 1000 条，他看得到的超了时这个来源的 sources 带 more: true）
  auth-viewer.ts（登录探测 /api/auth/viewer）
  bindings.ts（A2A 人工绑定 /api/bindings 和退役的旧面）
  change-requests.ts（人审变更请求 /api/change-requests：列表、批准、拒绝；批准、拒绝的判断和执行收在 changeRequestReview 一处，「关注」的审核卡片当场批也调它，审核人取认出来的管理员、不通过要写理由）
  cockpits.ts（驾驶舱 /api/cockpits：写不经写请求总门，处理之前问 cockpit-access.ts；读应答带 can.edit，不带建立人）
  content-observation.ts（门户观测状态 /api/content/observation）
  cookies.ts（Cookie 池 /api/cookies）
  departments.ts（部门 /api/departments：登录的人读列表、单个部门的成员、某人属于哪些部门；管理员建改删部门和成员）
  teams.ts（团队与分配 /api/teams：团队页（部门 → 团队 → 成员，按看的人的可见范围在服务端裁好）、「我的 AI 员工」；管理员认领、退回、指定和移除负责人；负责人分配、收回、改派成员（改派一个事务里收回并分给另一个人；状态码不代表授权）；团队的变更记录、某人各段分配的历史（按关系裁：管理员、管理层看全部，负责人看自己的团队，本人看自己的；读不到的按不存在回））
  access.ts（角色预设 ②：以某人的身份看 /api/principals/:id/access（管理员看任何人、登录的人看自己，带 action 给判定结论）、红线清单 /api/access/red-lines、首次安装向导 /api/setup/wizard（管理员跑，属主放行））
  design-tokens.ts（设计 token 固定路径 /design/tokens@<版本>.css）
  export-import.ts（导出与导入 /api/export、/api/import）
  grants.ts（角色与授予的管理接口 /api/roles、/api/grants：起草、提交、放行、撤销）
  health.ts（健康与就绪 /api/health、/api/health/ready：只回缓存的 LayerFS 结果、配了 LayerFS 才探；带 A2A 的开关、计数和时长；公开）
  login-events.ts（离职即时失效：/login/<方式>/events 失效通知、每日对账）
  login-flows.ts（登录方式 /login/<方式> 与回调：state、next、对到主体、发市场会话）
  login-gate.ts（登录门的四条路由：登录页 /login、口令登录、登出、我是谁 /api/auth/me；登录 cookie、限频、同源判断、认人留在 server/src/login-gate.ts，经参数传进来）
  mcp-protocol.ts（MCP 协议入口 /mcp（无状态 StreamableHTTP）：POST 收 JSON-RPC（initialize、ping、tools/list、tools/call），GET、DELETE 回 405；认证是 MCP 会话令牌）
  mcp-rest.ts（MCP 内嵌的 REST /api/mcp-rest、/openapi.json：OpenAPI 文档、工具调用、台文件上传（原始字节、multipart）列表下载（Range、ETag）、台数据、SOP run 与附件；认证是 MCP 会话令牌，授权映射到工具 grants）
  mcp.ts（MCP 网关控制面 /api/mcp：上游、会话、授权、工具目录、调用记录、权限申请的批准与驳回）
  principals.ts（主体管理 /api/principals：列出、停用、恢复、对一次外部身份、待对接清单，只有管理员能用）
  principals.ts（主体管理 /api/principals：列出、停用、恢复，只有管理员能用）
  remote-allow.ts（远程写豁免面的变更 /api/remote-allow/diff）
  settings.ts（设置 /api/settings）
  skills.ts（技能市场 /api/skills：发布、版本、导出、下载、钉装与校验、回滚、删除、迁移，和 /api/admin/rebuild-wm-skills）
  sop-page.ts（SOP 执行页 /sop/<slug>/：执行页和附件）
  spa-fallback.ts（页面兜底：前端构建目录在时，不是 /api/、/assets/、/health 开头的 GET 回注入过的 index.html，带扩展名的文件不兜底；注入的 sendSurfaceIndex、前面的静态托管和最后的 404 留在 index.ts）
  sop-run-access.ts（SOP run 的私有读授权管理 /api/sop/runs/:id/read-grants、/read-caps：授权、撤销、重签读能力、撤销全部读能力，只给管理员）
  sop-run-control.ts（SOP run 的开建、指派与进行中列表 /api/sop/runs、/assign、/active；开 run 是公开入口，task-center 的录入经身份服务认出提需求的人）
  sop-run-files.ts（SOP run 的交付文件 /api/sop/runs/:id/files：上传、列表、下载、引用已有文件；上传是公开入口，读要本 run 的读能力或管理员）
  sop-run-lifecycle.ts（SOP run 的列表、读、写一步、完成、升级预检、升级 /api/sop/runs、/:id、/finish、/upgrade-preflight、/upgrade；写一步和完成是公开入口，读要读能力或管理员，升级要管理员或本机命令行；「等你拍板」里待验收派单 run 的当场验收经导出的 sopRunAcceptance：不靠上传令牌的那两条（管理员、本机命令行）和完成接口同一处，执行就是完成接口那一个）
  sops.ts（SOP 台 /api/sops：列表、发布、废弃，和定义、治理时间线）
  sso.ts（SSO 回调 /sso/callback）
  stats.ts（端点命中统计 /api/stats）
  summary.ts（首页总览 /api/summary）
  task-center.ts（任务中心 /api/task-center：录入发布、任务、总开关、模板、任务锁、撤回、派发开关；录入发布：事项的建立人是提需求的人——建录入时经身份服务认出、记在录入上的那个，没有就空着；发布的人认得出就只留痕）
  tasks.ts（统一待办 /api/tasks 与 ygl 项目读授权的授予、撤销）
  bench-views.ts（数据视图的入口 /api/bench-views：台的登记、数据集、四种写入、查询、快照、视图描述与版本、取数、表单·在 `WM_BENCH_VIEWS` 开关后面，缺省关·先拒管理口令再问判定，放行两档：管理层（范围「全部」，读写都按「能不能写」问判定）；或者台绑了部门、这个人在这个部门上有已放行的授予（scopedVerdict，关系只收窄不放行））
  knowledge.ts（经验库 /api/knowledge：列表、详情、同步状态·跨站和管理口令 403、没登录 401·条目按范围判：全公司认业务的看，部门认这个部门范围的授予，其余只给管理层·看不到的和不存在的同一个 404·「项目 → 部门」对照 /api/knowledge/project-depts 只有管理层、属主看和改，每次改记一行）
  types.ts（类型管理 /api/types）
  relations.ts（关系的提议 /api/relations/proposals：列表（每条带 can_approve）、确认、驳回；确认人大多不是管理员，写请求总门放行这两条，路由内认人）
  a2a-roster.ts（团队名册的读 GET /api/a2a/teams：登录即可读，只有席位信息（团队、席位名、角色、在岗、在办件数从事项现算），不含事项内容；名册只当信息，判定一律不看它）
  work-items.ts（「安排一件事」POST /api/work-items：会话登录的启用的人直接建一件事项，建立人是本人，可带 cockpit_id 记下是从哪个驾驶舱安排的（只在安排那一刻记，之后不改，只是标签不给权限；列表 ?cockpit=<id> 在视角里收窄，不存在的驾驶舱回空列表），派给绑在任务中心上的团队（GET /api/work-items/teams 列出），缺省先过目，幂等键按人，限流和员工直派开关在设置里（arrange_rate_per_minute、arrange_rate_per_day、staff_direct_dispatch），规则在 task-center.ts 的 arrangeTask。事项列表 /api/work-items：按 state、object、phase 筛，按更新时间倒序游标翻页，带可见范围里按状态的计数和每件的最后一条进展；可见范围和详情同一个判断，看不到的不出现也不计数。各视角 views.<视角> 带 available、count，可用的视角另带 decide：这个视角里轮到看的人、能当场办的件数（work-item-access.ts 的 decidesNow，和「关注」里事项来源的 mine、答法同一处判，侧栏角标数的就是这些）。事项的读 /api/work-items/:id：事项和它的日志，事项页的时间线照着渲染；管理员看全部、登录的人只看自己建立的。建立人验收、退回 POST /api/work-items/:id/decision：不经管理门（写请求总门只对这一条子路径放行），经身份服务认人、主体须是启用的人、同源，事项服务判是不是建立人和能不能由建立人答，只收验收、退回，只对等验收的事项；建立人只认事项上的建立人主体，空着的只有管理员能看、能处理。放行 POST /api/work-items/:id/release：同样不经管理门（写请求总门只对这一条子路径放行），由事项交给的团队的负责人放，团队没有负责人时管理层代办（事件日志、事项日志记 acting_for = team-lead），建立人勾了先过目的由建立人本人放；放过的再来一次回 duplicate，不再放；「关注」里过目条目的 answer_via 指向它。管理员的 POST /api/workbench-events/:id/release 不变）
  workbenches.ts（工作台 /api/workbenches、/api/check-all）
  workbench-vars.ts（工作台变量与常量的五条路由 /api/workbenches/:id/vars：列表、读、留痕、写、删；查台和判权的外壳、读写规则留在 server/src/workbench-vars.ts，经参数传进来）
web/src/        pages/（Dashboard/Market/Sops/Types/Settings/UseWorkbench/Cockpit/McpGateways/Tasks/Skills/SopSpace/SopRunDetail/Vault/Reviews/OwnerPending/Attention/WorkItem/NotYet/Home/WorkItems） work-items-view.ts（事项列表的分组、计数、行说明，纯函数） home-view.ts（全景首页的行、格子、总结句，纯函数） work-item-view.ts（事项详情页的提示、进展、结果解析，纯函数） NotYet.tsx（还没有数据来源的入口：说清要显示什么、在等哪项接口） components/（Shell.tsx 外壳：侧栏与主区卡片；WmPage.tsx 页面骨架：顶栏与内容区） admin-token.ts（统一口令注入）
deploy/         Dockerfile.market（多阶段·非 root·HEALTHCHECK） docker-compose.yml（回环默认·profiles 隔离） layerfs-svc.mjs
docs/           layerfs-service-contract-v0/v1.md（LayerFS 服务契约） data-views.md（数据视图设计稿：模块化渲染组件、每台一份数据、经 MCP 更新；未开工）
data/           SQLite 数据文件（git 忽略）
```

`server/src/mcp-stdio-upstream.ts`（#474）：`settings.mcp_upstreams` 里 `kind` 为 `ygl-trees` 的上游不走 HTTP，由市场启动 `ygl-trees mcp`（stdio）子进程，工作区取该项的 `ygl_home`。子进程只拿运行必需的系统变量，不继承市场的口令和令牌；它的 `YGL_SESSION` 由市场设成 `market-<前缀>`。

结构上的约定（新东西该写在哪）见仓库根的 `CONTRIBUTING.md`。`node scripts/tech-route-check.mjs` 把这些约定量成数字，对照 `tech-route.json` 里的基线；CI 每次把体检表写进摘要页。预算档的检查比基线多了、红线档的检查高于目标，CI 就失败；其余只报告。每项现在是哪一档，以 `tech-route.json` 为准。

路由正在按域从 `server/src/index.ts` 搬进 `server/src/routes/<域>.ts`，终点是 `index.ts` 只做装配。域模块导出一个注册函数，`index.ts` 在这组路由原来的位置调用它，所以挂载顺序不变。注册经 HTTP 服务（`server/src/http.ts`）：路由还是挂在同一个 Express 应用上，处理函数原样传入；每次注册都能撤销，由插件注册的随插件卸载一起撤销（`scripts/http-service-test.mjs`）。搬一个域是纯移动，下面的路由快照和录制回放都必须零差异。

周期任务的定时器挂在上下文的 effect 上：在 `root.effect(() => { …; return () => clearInterval(t); }, '名字')` 里建，返回清掉它的函数，上下文卸载时一起停。`scripts/timers-unload-test.mjs` 起一个最小实例、卸载根上下文，核对 `index.ts` 之外的周期定时器一个不剩、进程自己退出。体检的「裸的 setInterval」只数代码里不在 `.effect(` 括号里的调用（注释、字符串、模板正文里的浏览器脚本不算），按文件记预算。

经 HTTP 服务注册的每条路由都要报上动作：`http.post('/api/x', { action: 'x.create', kind: 'admin' }, handler)`。动作名写成 `<域>.<动词>`，类别四种：`read` 读、`write` 写、`decide` 决定、`admin` 管理。没报、形状不对、同一个动作报了两种类别，都注册不上（启动失败）。这一步只登记，不判定，每条路由原有的守卫不变。还直接挂在 Express 上的存量路由没有动作，搬进域模块时补；体检的「没报动作的路由」按文件记预算，只减不增；它是正则计数，另有一条红线拿它和动作快照里「未登记」的条数对账，换个写法绕开计数（比如经 `expressApp()` 或先存进变量再挂）两边就对不上，直接失败。扩展目录给扩展的仍是 Express 应用本身，扩展的路由也不带动作。

对外的面有四份快照，放在 `surfaces/`：路由（带挂载顺序）、动作（`actions.json`：和路由一行对一行，「方法 路径 -> 动作 类别」，存量记「未登记」；MCP 工具沿用工具自己的类别）、MCP 工具、表结构，由 `scripts/surface-snapshot.mjs` 从一个隔离实例里导出。动作清单和路由对不上，导出直接报错。改了面就加 `--write` 重新生成，把快照和代码一起提交。

快照管的是「有哪些路由、按什么顺序」，应答对不对由录制回放管。`surfaces/replay/<域>.json` 里是一组请求和录下来的应答：状态码、响应头、响应体。`scripts/route-replay-test.mjs` 按场景各起一个隔离实例，对同一组请求重放，有一处不一样就失败。搬路由之前先录，搬完重放必须零差异。有意改了行为，就加 `--record` 重录，把录制和代码一起提交。

每次都不一样的东西不比：`Date`、`Connection`、`Keep-Alive` 三个头不录；时间里的数字换成占位，写法留着（所以时间的写法变了看得出来）；按内容算出来的 ETag 只留长度。值每次都变的响应头只遮那几个字节，在请求上用 `vary` 点名：`$location: ['port', 'query:state']` 把跳转地址（`Location` 头和写进正文的地址）里回环地址后面的端口换成占位（分「市场端口」和「别的端口」，回调地址写死成别的端口看得出来）、点名的查询参数的值换成只留长度的占位，主机、路径、别的参数照比；`$cookies: { 名字: ['value', 'max-age'] }` 把这个 cookie 的值换成只留长度的占位、`Max-Age` 按分钟四舍五入（差一秒不报，期限改了照样报），cookie 的名字和 `Path`、`HttpOnly`、`SameSite`、`Secure` 等属性照比。不许为了会变的内容整段不比（`compare: 'status'` 只给借别的域布置现场的请求用）。

应答里由「现在」算出来的数（还有几天过期、今天是哪一天）每次也不一样。这样的场景在请求集里写一个 `clock`（ISO 时刻），实例的时钟就从那一刻开始走（`scripts/replay-clock-preload.mjs`，只在测试环境可用），这些数才能录下来比。数据库自己取的时间不受影响。应答体里每个实例随机生成的值（密钥、签名），在那条请求上写 `vary`：点名的字段换成占位，只留类型和长度；由「现在」算出来、带毫秒的数也可以点名，往下取整再比。`vary` 之后签名只比长度，所以签名卡片的请求另写 `verify: "a2a-card"`：换占位之前先用卡片里的公钥验签名，验的结果录下来比。要认人的路由，场景写 `fixtures: ["identity-fake"]`，登录提供方换成假的（`scripts/identity-fake-provider.mjs`，只在测试环境可用），不访问外部系统。要从 GitHub 同步或要碰 LayerFS 的路由，场景写 `fixtures: ["github-fake"]`、`["layerfs-fake"]`：进程里起一个只听回环地址的假服务，同步和影子发布指过去（`scripts/github-fake-preload.mjs` 预先放好几个仓库，`scripts/layerfs-fake-preload.mjs` 的 commit 号按内容算），都只在测试环境可用。统一待办的路由写 `fixtures: ["tasks-fake"]`：ygl-trees 的工作区和命令行调用、A2A 状态端点、三个扩展来源都换成假的（`scripts/tasks-fake-preload.mjs`，命令行调用在进程里截下，不起子进程），只在测试环境可用。要录页面兜底这一层（前端外壳、静态托管、最后的 404）的场景写 `fixtures: ["web-dist-stub"]`：进程里 `web/dist` 之下的路径改读一个内容固定的占位目录（`scripts/web-dist-stub-preload.mjs`，真的构建产物不碰），本机有没有构建、CI 有没有构建，录下来都一样；只在测试环境可用。经 HTTP 建不出来的磁盘前提（比如台已经物化好的版本目录），场景写 `seed_files`：`{ path, content }`，路径是数据目录下的相对路径，不许 `..`、绝对路径和隐藏段。

每条路由都要有未授权、参数非法、正常三类请求。类别按录下来的应答核对：未授权是 401 或 403，参数非法是其余的 4xx，正常是 2xx 或 3xx；请求上标的类别和应答对不上，脚本就失败。确实没有某一类的路由（比如不读任何参数，就没有会被拒的输入），在请求集的 `exempt` 里写明理由，并指给一条打在这条路由上、照常应答的请求。

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。


> **验证资产为本地产物不入库**（隐私治理·监督席处置单）：`evidence/`、`verify/`、`tmp/` 已 gitignore——E2E 摘要/判据冻结包/运行截图属本机生成物，fresh clone 后先跑一轮 E2E 再 make-submission（摘要门 fail-closed 即本义）。冻结报告另存 `~/.ygl-trees/verify/archives/`（zip 可携带）。**既有克隆合并 untrack 批后须恢复本地验证资产**（untrack=索引删除语义·合并即删工作树文件·全机验证链静默断）：`git checkout <untrack 前 SHA> -- evidence verify && git restore --staged evidence verify`——文件回工作树·不回流索引·gitignore 罩住。**净克隆自举**（#95 修正）：`verify/material.md`/`candidates.json`/`reviews.json` 三件套由 `node scripts/gen-verifier.mjs` 从**单一事实源再生成**（生成器自建 `verify/` 目录·净克隆一条命令重建 175 判据）。干净克隆跑验证链步骤：`node scripts/gen-verifier.mjs` → 跑一轮 E2E 产 `evidence/e2e-summary.json`（摘要门 fail-closed 即本义）→ `node scripts/make-submission.mjs --source-db <绝对库路径> --target-mode isolated --isolated-root <合成数据根>` → `ygl-trees verify submit/prepare/run`。


### 文件面 URL 语义（#164 P1②）

| 面 | 语义 |
|---|---|
| `POST /api/apps/:slug/files` | multipart 上传（`file` 字段·≤100MB）；可带 `note`/`created_by` 表单字段 |
| `POST /mcp` `app_files_upload` | **MCP 侧上传**：`{slug,name,content_base64,size?,sha256?,mime?,note?,created_by?}`——同表同链（app_files+落盘）。有的 MCP 客户端会把过长参数截短（常见截在 64KB），所以 base64 严格校验、带了 `size`/`sha256` 不符即拒收不落库、恰好 65536 字符又没带时按疑似截断拒收；大文件优先用 REST 原始字节上传。成功应答带 `integrity`（带了 sha256 且对上为 `sha256-verified`，只带 size 为 `size-verified`，都没带为 `unverified`）和给 agent 的 `next`：应答的 `sha256` 是服务端对已保存字节算的，与本地一致即完整，不需要下载回读 |
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
- **路由报动作**：新写的路由用 `ctx.routes.add(method, path, { action, kind, who, statusNotVerdict? }, handler)`，经 HTTP 服务注册，和核心路由一样报动作。
  - 动作名 `<扩展名>.<动词>`（只有一个点，动词里分段用连字符，比如 `lifecycle.board-read`）。
  - 扩展名（也是动作前缀和路径首段）不能和核心动作的域、核心路径的首段重名：`api`、前端页面的首段（和 `web/src/App.tsx` 对得上）、内容面和资源的首段写在 `server/src/extensions.ts` 的保留名单里；核心路由栈里的首段（含直接挂在 Express 上的）在全部路由注册完之后自动收集再核一次。撞上了拒绝启动——否则扩展会抢走比它晚挂的核心路由。
  - 路径只能在 `/api/<扩展名>/…` 或 `/<扩展名>/…` 下，只收字符串。
  - 类别和方法要对得上：POST、PUT、PATCH、DELETE 不能报 `read`。处理函数实际写不写库没法在注册时看出来，报窄只有方法这一道检查，其余靠评审。
  - `who`（谁能调）只能从市场已有的口径里选：`anonymous`（登录门关着时匿名也能调）、`member`（登录认出来的人）、`admin`、`owner`；管理类只能给 `admin`/`owner`，`anonymous` 只能配 `read`/`write`。判定（阶段六）照它算，扩展不改核心的内置清单。
  - 不合格都在注册时抛错，拒绝启动并点名扩展。旧扩展按 `ctx.routes` 有没有来判断能不能用（`apiVersion` 不变）。
- **中间件**：用 `ctx.routes.use(path, { purpose }, handler)`，路径在自己的命名空间下，写明用途（进扩展的面）。
- **直接挂的**：经 `ctx.app`（或别处拿到的 Express 应用）挂的路由、中间件、子路由器照旧能跑，但每个扩展 `register` 前后对比路由栈，没报的逐条点名（日志 `source: extensions`、`event: route-undeclared`；中间件和子路由器记 `middleware-added`，子路由器里面的路由看不见，整层算没报）并合计。`WM_EXTENSION_ROUTES=enforce` 时只要有没报的层（路由、中间件、子路由器都算：中间件一样能直接应答）就拒绝启动（阶段六切换判定时打开）。`register` 之后才挂的点不出来。
- **扩展的面**：`node scripts/surface-snapshot.mjs --extensions <扩展目录> [--out <文件>]` 带扩展起实例，只导出扩展那一节（报了动作的路由和没报的），缺省打到标准输出；不写 `surfaces/`、不进核心快照和体检预算，部署方放进自己的私有仓库。
- 冒烟：`node scripts/extensions-smoke.mjs`、`node scripts/extension-routes-smoke.mjs`。

## 鉴权边界与代理相对路径（#132 ⑨⑩）

### REST vs MCP 鉴权差异表

| 面 | 写操作 | 读操作 |
|---|---|---|
| REST `/api/apps`（发布） | `X-Admin-Token` 必带（远程写另经 T1 豁免面清单） | 开放（GET） |
| REST `/api/apps/:slug/data`、`/files` | 提交、上传开放（台的匿名提交面）；删、改备注要管理员 | 本台的台令牌、管理员（同源）或本机命令行；下载另认本台页面的查看凭证（`WM_APP_DATA_READ`） |
| REST `/api/sop/runs`（开建） | 开放：开建的人在应答里拿到这个 run 的上传令牌和读凭证 | — |
| REST `/api/sop/runs/:id`（保存一步）、`…/finish`（完成） | **这个 run 的 `X-Run-Upload-Token`**（run 还在执行）、管理员（同源）或本机命令行，先于查 run，不满足 403（`WM_SOP_RUN_WRITE`）；执行页自己带上；换了浏览器、本地没存令牌的旧 run 只能管理员处理 | — |
| REST `/api/sop/runs/:id/files`、`…/files/refs` | **run-scoped `X-Run-Upload-Token`**（启动响应/派单回执取）或管理员口令；refs 另逐条核源 run 读凭证 | 开放 |
| MCP REST `/openapi.json`、`/api/mcp-rest/*` | 与 `/mcp` 同一套：只认 `Authorization: Bearer <会话令牌>`，不走浏览器登录与管理口令 | 同左 |
| MCP `/mcp` | 无独立口令——网关模式下按会话 `grants` 工具白名单授权（`Authorization: Bearer <token>`）；`access_info` / `access_request` 和读技能的 `skills_list` / `skill_search` / `skill_read` 免授权（仍要有效的会话令牌），缺权限的会话据此看目录、提申请、自学 | 同左 |
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
| `PUT {rest_base}/apps/{slug}/files/{文件名}` | `app_files_upload` | 请求体就是文件的原始字节，边收边落盘，不整包读进内存，单文件 ≤100MB；可带 `?note=&created_by=`（`created_by` 缺省为 `mcp:<会话名>`）；推荐带请求头 `X-Content-SHA256`（期望的 sha256），不符 400、不保存 |
| `POST {rest_base}/apps/{slug}/files` | `app_files_upload` | multipart：字段 `file`，可选 `note`、`created_by`、`sha256`（期望的 sha256，也可放请求头 `X-Content-SHA256`，两处都带须一致） |
| `GET {rest_base}/apps/{slug}/files` | `app_files_list` | 列文件，倒序分页（`limit`、`before_id`），带 `quota` |
| `GET {rest_base}/apps/{slug}/files/{id}` | `app_files_list` | 二进制下载 |
| `GET {rest_base}/apps/{slug}/data` | `app_data_list` | 读台数据（分页） |
| `GET {rest_base}/sop/runs/{id}` | `sop_run_get` | 结果与 sop_run_get 相同；没有 run 读授权时只返回元数据 |
| `GET {rest_base}/sop/runs/{id}/files[/{fileId}]` | `sop_run_get` + 该 run 的读授权 | 附件列表与下载 |

- 上传和浏览器上传走同一套入库核心：按内容识别类型（扩展名与内容不符、或是可执行文件返回 415），并检查台文件数配额。返回 `id`、`sha256`、`mime`、`size`、`url`（REST 下载地址）、`download_url`（台页面用的下载地址）、`integrity`（`sha256-verified` / `unverified`）和 `next`；`sha256` 是对已保存字节算的，与本地一致即完整，不需要下载回读。
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
