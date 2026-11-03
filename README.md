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
```

环境变量（13 面）：`PORT`（默认 9800）、`WM_LOGIN_GATE`（全站登录门·`enforce`=没有身份什么都访问不到：页面 302 `/login`、API 401；缺省/`off`=行为不变；其它值拒绝启动；见 [ADMIN-TOKEN-SETUP.md](ADMIN-TOKEN-SETUP.md)「全站登录门」）、`WM_CONTROL_PORT`（可选的独立管理端口·缺省不开·见「信任模型」）、`DATA_DIR`（SQLite 数据目录·默认 `server/data`）、`ADMIN_TOKEN`（控制面口令·可设置页改）、`MCP_GATEWAY`（#284 起**缺省开**：未设/空/`on`=会话令牌网关；只有显式 `off` 且 `NODE_ENV=development/test` 才允许关闭并启动告警；生产/未设/空/未知运行模式配 off 由启动自检拒绝，其它网关值也拒绝启动）、`REDIS_URL`（SOP 状态层·缺省读 `DATA_DIR/redis.url`·无则降级 SQLite）、`MARKET_TEAM`（A2A team 默认 `market`）、`MARKET_PUBLIC_URL`（对外基址·A2A 卡片用）、`A2A_API_KEY`/`A2A_STATE_URL`（A2A 外部面）、`WM_A2A_DIRECT_SIG`（`POST /a2a/direct` 入站签名·缺省 `accept`=带了 OriginClaim Sig2 就验、没带照旧走绑定准入；`require`=没签名或验不过一律 401；`off`=不验；`WM_LOGIN_GATE=enforce` 时强制 `require`；其它值拒绝启动。公钥只从调用方绑定上登记的 `notify_url` 取卡，不跟随重定向）、`WM_A2A_DIRECT_SIG_BODY`（缺省 `accept`；`require`=只认同时签了 body 摘要的 `X-WM-Body-Sha256`/`X-WM-Body-Sig`，现有 DSH 节点只发 Sig2，打开前对端要先升级；其它值拒绝启动）、`A2A_ORIGIN_CLAIM_UNBOUND`（v1 未绑定调用方签名兼容窗：`off`=停发 `X-A2A-Caller-Sig`，缺省继续发；v1 不绑路由，未升级对端上可被剥 Sig2 重放，全舰队升级后应设 `off`）、`LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS·缺一即禁用）、`AI_GATEWAY_API_KEY`（`skill_search` 评估模型令牌·缺=工具报错不降级）、`EVAL_GATEWAY_URL`（评估网关覆盖·验证器/代理用）、`SANDBOX_BRIDGE_URL`/`SANDBOX_BRIDGE_TOKEN`（sandbox 派发）、`PUBLISH_LOCK_MS`（发布锁窗口·测试可调）、`SOP_READ_CAP_TTL_DAYS`（SOP run 只读能力有效期·缺省 30 天·非数字回落缺省）、`WM_GITHUB_TOKEN`（自产台/SOP 台来源仓库读令牌·可选·私有仓库用）、`WM_GITHUB_API`（GitHub API 基址·只给测试替身用）、`WM_APP_FILES_MAX`（单台文件数上限·浏览器上传与 MCP 上传共用·缺省 2000）、`A2A_EVICT_COOLDOWN_MS`（台驱逐冷却窗·缺省 24h·测试可调）、`A2A_OUTBOX_BACKOFF_SCALE`（A2A 回执 outbox 退避倍率·测试可调）、`WM_REGISTER_URL_ALLOWLIST`（#258 公网登记精确许可·JSON 字符串数组·缺省 `[]`=公网一律 403 `url_not_allowlisted`·坏项/通配/硬拒/私网条目拒绝启动·见 docs/r3-url-allowlist-design.md）、`ALLOW_PUBLIC_NET`（#258 起**不再放行任何公网登记**，`1` 只在启动时告警）（网关开时 `/mcp` 启用会话令牌网关——**生产已开：所有 /mcp 调用须 `Authorization: Bearer <会话令牌>`**·会话经 `POST /api/mcp/sessions` 创建+`PUT …/grants` 授权）、`LAYERFS_SERVICE_URL`/`LAYERFS_SERVICE_TOKEN`（LayerFS 服务面·两者任一缺失则 LayerFS 集成整个禁用=降级直写）、`WM_ODOO_ORIGINS`（可信 Odoo 源·逗号分隔·门户只把 Odoo `session_id` 转给这些源与 `LC_ODOO_URL` 的源；都未设时谁都不转、Odoo 台免登不生效（fail closed·启动时提示））、`LC_YGL_BIN`/`LC_YGL_HOME`/`LC_WORKBENCH_KEY_FILE`/`LC_ODOO_URL`（生命周期源·四项齐备才可用·见「统一待办」；`LC_TEST`/`LC_IDENTITY_FILE` 只供端到端测试透传，生产不设）、`LC_LEDGER`（生命周期账本名→锚点文件名·PR#272 全景页用·合法字符 [A-Za-z0-9_.-]≤64·首字符非点）、`LC_ANCHOR_DIR`（锚点目录·缺省 /opt/lifecycle-os/anchors·文件不在就不带 --anchor 并告警）、`YGL_MAX_PROJECTS`（统一待办读 ygl-trees 的 active 项目数上限·缺省 200·超出部分在 `degraded_projects` 报 cap-exceeded）、`YGL_TOTAL_BUDGET_MS`（ygl-trees 源总预算·缺省 8000·超预算未读的报 budget-exhausted；两项非整数或越界都回落缺省）。内容面（Draft，默认关闭）：`WM_CONTENT_PORT`（显式内容端口，缺省/0不启）、`WM_CONTENT_IP`（显式绑定非通配IP）、`WM_CONTENT_MARKET_ORIGIN`（可信市场完整origin）、`WM_CONTENT_ODOO_ORIGIN`（须属于已配可信Odoo源）、`WM_CONTENT_TARGETS`（JSON数组，固定id/origin/upstreamUrl；migrateBrowser仅显式true才迁出该target浏览器导航（默认关）；queryCredentialKeys只列上游凭据参数键，不列值，pin URL需去除这些参数；origin为w-id-env.internal且端口匹配）、`WM_PORTAL_OBSERVE`（显式1才记录被动聚合，管理员读`/api/content/observation`；coverageVerified仍false），见[装配说明](docs/content-foundations-integration-296.md)。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。。凭据库：`WM_VAULT_PATH`（库文件·缺省 `DATA_DIR/vault/default.json`；指向 `$DSH_HOME/vault/default.json` 即与 DSH 插件共用——插件开着时同时写会丢更新）、`DSH_VAULT_PASSWORD`（主密码·设了就按需自动解锁、不闲置上锁·与插件同名；不设则在页面输入，只存进程内存）、`WM_VAULT_IDLE_MIN`（页面解锁后闲置自动上锁分钟数·缺省 15·`0` 不自动锁）。设置键：`run_upload_require_token`（`1`=SOP run 文件上传要令牌·缺省关=旧直传语义）。

## 启动安全自检（#326）

市场/控制面监听后先运行固定匿名回环自检，完成前 HTTP 和 WebSocket 业务入口均关闭；`GET /api/health` 返回 503，`self_probe.passed=false/at=null`。`WM_LOGIN_GATE=enforce` 时另加四行：远程匿名 GET `/`、`/apps/<台>/` 必须 302 到登录页、`/api/apps` 必须 401（浏览器写那一行改为期望登录门的 401），外加远程无签名 `POST /a2a/direct` 必须 401。强制行通过后才开放业务并启动后台巡检，health 可回读逐行结果。任一强制行失败或超时只关闭本进程监听并非零退出，不杀宿主或父进程；只有 `NODE_ENV=development/test` 的显式 `MCP_GATEWAY=off` 才把两条 MCP 行变成 warning，生产/未设/空/未知模式配 off 两行均 fail 并拒绝启动；控制面关闭则对应行 skip，不能视为完整认证验证。

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
| 凭据库（融合 dsh-vault） | `/vault`（**要管理员**：口令或 Odoo 管理员）：加密保存账号/邮箱/手机/密码/TOTP/SSH/API Key/Secret/OAuth 令牌/银行卡——存储层原样复用 [dsh-vault](https://github.com/Ox0400/dsh-vault) v1.10.75（scrypt + AES-256-GCM，磁盘无明文，文件格式与写锁协议与 DSH 插件一致）；缺省库文件在 `DATA_DIR/vault/default.json`。`WM_VAULT_PATH` 可指向 DSH 插件那份 `$DSH_HOME/vault/default.json` 共用，但**上游插件进程常驻一份内存库、写盘前不重读文件，DSH 会话开着时两边同时写会互相覆盖（丢更新）**，页面会显著提示——只在一边写；检索/列表/回收站/安全体检只给无密摘要（自定义字段只给键名），完整密钥只在单条详情显式读取并记审计；动态验证码倒计时、强密码/口令短语生成与强度评估、弱密码/复用/未开 2FA/http 站点/到期轮换体检、软删→回收站→永久删除两步；**新建库主密码门槛**：至少 12 个字符、不能全是数字、不能命中常见口令表（SecLists 前 1 万条 + 变形）、强度不能为「弱」，不过就拒且不落盘（阈值在 `server/src/vault-policy/policy.ts`）；已有库照常解锁，主密码低于标准只提示建议更换；**读写都要管理员口令**，业务面一律 403；主密码只在进程内存，闲置由定时器主动上锁（取验证码不算活动）；解锁/上锁/重开串行，连错 5 次冷却 30s；外部改动自动重开、不删别的进程持有的写锁（写锁被占回 503） |
| 台生成器 | **来源只认 GitHub 仓库 main 分支**（属主 2026-11-02 收敛：非挂载类工作台即自产台与 SOP 台，见下「来源：GitHub main」）：把台的文件合进仓库 main，调 `POST /api/apps/<slug>/sync` 或 MCP `app_sync`，市场拉 main 头静态托管在 `/apps/<slug>/`，**发布即自动入册**（类型 market-app、探测短路=服务活着即在线），门户/驾驶舱/市场全链立即可用；**全版本快照**——同 slug 重发 = 新版本，`activate` 一键回滚任意历史版本——从「台的管理者」到「台的生产者」 |
| SOP 台 | 台生成器的 `kind:'sop'` 分流：`sop.yaml`（标题/编号/步骤，步骤 body 内嵌 HTML）发布为 SOP 台，`/sop/:slug/` 服务端渲染零构建执行页（步骤卡 + data-field 自动收集 + 800ms 防抖保存 + localStorage 缓冲 + 刷新恢复 run）；**状态机 draft→published→deprecated**（changelog 必填，draft 不入册防半成品上架）；执行数据**分层持久化**——状态层 Redis（HSET 热态 + 活跃索引，写路径 ~ms 级；不可达自动降级直写 SQLite）+ 持久层 SQLite（sop_runs 表为真源：开 run 钉版本、真实30s定时checkpoint（停写也落盘）、同run串行保存/finish，全量沉淀；Redis 条目 1h 平滑淘汰） |
| MCP 生产通道 | `/mcp` StreamableHTTP（stateless，零依赖手写 JSON-RPC 2.0）：AI 会话/任意 MCP 客户端直连市场，**30 个本地工具**（+ 上游聚合）——权限自助 2（**免授权**：任何已认证会话都能调，`tools/list` 始终列出）：`access_info`（会话名、已授权工具、完整工具目录——本地 + 上游，每项带 `category`=read/write/admin 与 `granted`——以及本会话提过的申请与状态；缺工具时先调它）/ `access_request`（`{tools, reason}` 申请授权：工具须在目录里、reason 必填 ≤500 字、同组待批去重、每会话每小时 ≤10 条；管理员在「MCP 网关」页「权限申请」批准 = 并入现有 grants，立即生效、同事务记审计；会话不能自己批，已吊销会话不能批）；生产 6：`workbench_list`（找台）/`workbench_summary`（总览）/`workbench_check`（探测）/`use_url`（取 `/go/<id>/` 门户入口）/`app_sync`（**从 GitHub main 重拉已登记来源的自产台与 SOP 台**；`app_publish` 与草稿三工具已随来源收敛移除）/`sop_publish`（SOP 上架·`app_activate` 已移出 MCP·回滚走变更申请）；变更申请 2：`change_request_create` / `change_requests`（回滚/删除统一评审门·REST approve 需 managed 口令+reviewed_by）；执行数据 6：`sop_run_start` / `sop_run_step_save`（直接更新持久化执行数据，与 Runner/REST 同链）/ `sop_run_get` / `sop_run_list` / `sop_run_finish` / `sop_run_sandbox`（VM sandbox 派发·LayerFS commit 交付）；技能 4：`skills_list` / `skill_versions`（版本链） / `skill_install_plan`（钉装计划+expected digest） / `skill_search`（**语义搜**：需求→jev 评估模型打分·P(true)>0.7 严格·≤3 降序·不可用报错不降级）；注册 CRUD 3：`workbench_register`（agent 自主登记外部台）/ `workbench_update` / `workbench_unregister`（凭据字段一律拒绝，人工配置）；台数据 4：`app_data_list`（读自产台表单提交数据）/ `app_data_submit`（写一条表单数据：与 `POST /api/apps/:slug/data` 同一写入核心——1MB 上限、台的数据契约校验，违约返回 400 与逐条 `violations`；可带 `idempotency_key` 重试不重复写）/ `app_files_list`（读文件提交列表，含下载 url）/ `app_files_upload`（base64 上传附件）——**只走 MCP 的 agent 也能登记台数据、上传附件**；工作台变量 2：`workbench_vars_get` / `workbench_vars_set`（#336：按 workbench id 隔离的看板变量与常量，revision 乐观锁，MCP 不能修订常量）；设计标准 1：`design_standard`（只读取 `DESIGN.md` token 与 `PATTERNS.md` 页面模式·`part`=tokens/guide/patterns/all·`section` 按标题过滤·带版本与源文件 sha256——agent 做台/页面前先取）；**上游聚合**（#20 P2）：`settings.mcp_upstreams` 配外部 MCP（如 taste-mcp），其工具以 `<prefix>__<tool>`（如 `taste__rules`）并入同一 /mcp 面，上游工具的类别按其 `annotations.readOnlyHint` 判（明说只读才算 read，否则按 write），上游不可达自动降级不影响本地 30 工具；网关会话存在时以 `X-Market-Client: mcp/<会话名>` 透传调用方身份（上游据此判 judge 身份）——市场从 REST 页面操作升级为 agent 可编程；已实测接入 DSH（dsh-mcp-connector，工具以 `mcp__workbench-market__*` 注入会话） |
| 台数据查看 | 工作台详情（market-app）→「查看提交数据」Drawer：表单数据行（JSON 折叠/提交者/时间）+ 文件（类型/大小/下载）+ 游标加载更多——数据落库后在 UI 直接可查 |
| 工作台变量与常量 | `/api/workbenches/:id/vars`（#336）：每个登记台（自产台、SOP 台、外部 Web 台、Odoo 台）按 workbench id 各有一份隔离的键值空间，供看板读写——`GET …/vars`（列举·`prefix` 过滤）、`GET/PUT/DELETE …/vars/:key`；值是任意 JSON（≤64KB，每台 ≤512 键）；**乐观锁**：每次写 revision +1，改/删已存在的键必须带 `If-Match` 或 `revision`，缺 428、不符 409，响应都带 `current_revision` 与当前值；`kind:'const'` 写入后不能改也不能删，只有管理员（含本机命令行）显式带 `override` 才能修订，审计表只记值的 sha256（`GET …/vars/:key/audit` 管理员读）。**读写口径**：本机命令行与管理员（口令或 Odoo 管理员）可读写任意台；自产台、SOP 台页面凭本台 `X-App-Token` 只能读写本台（沙箱 `Origin: null` 有 CORS）；外部台没有按台令牌，只有管理员能读写；匿名一律 403。只存 SQLite，写返回即落库，不经 Redis。删台时变量随台删除、审计保留 |
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
GET              /sop/:slug/*                   SOP Runner 执行页（published；draft → 403）
GET              /api/sops                      SOP 台列表（含状态与版本）
POST             /api/sops/:slug/publish        draft/deprecated → published（首次入册）
POST             /api/sops/:slug/deprecate      published → deprecated（市场行停用）
POST             /api/sop/runs                  开 run（钉 sop_version；Redis 初始化）
GET              /api/sop/runs/active           活跃 run（Redis 快路径，miss 回落 SQLite）
GET/PUT          /api/sop/runs/:id              run 详情 / 步骤保存（{stepKey, value}；Redis 热写 + 30s checkpoint）
POST             /api/sop/runs/:id/finish       归档（热态全量沉淀 SQLite，Redis 条目 1h 淘汰）
POST             /mcp                           MCP StreamableHTTP（initialize/tools/list/tools/call；30 本地工具；GET/DELETE → 405）
GET              /openapi.json                  MCP 工具的 OpenAPI 3.1 文档（同 /api/mcp-rest/openapi.json；只列本会话可调用的工具；会话令牌必带）
POST             /api/mcp-rest/tools/:name      按 REST 调一个 MCP 工具：请求体 = 工具参数，返回工具结果 JSON（会话令牌必带；见「MCP 工具的 REST / OpenAPI 开放」）
PUT              /api/mcp-rest/apps/:slug/files/:name  原始字节上传（流式落盘 ≤100MB，返回 id/sha256/mime/url；需 app_files_upload）
POST             /api/mcp-rest/apps/:slug/files        multipart 上传（字段 file + note/created_by；需 app_files_upload）
GET              /api/mcp-rest/apps/:slug/files        列文件（分页 + quota；需 app_files_list）
GET              /api/mcp-rest/apps/:slug/files/:id    二进制下载（Range / ETag=sha256；需 app_files_list）
GET              /api/mcp-rest/apps/:slug/data         读台数据（分页；需 app_data_list）
GET              /api/mcp-rest/sop/runs/:id[/files[/:fileId]]  SOP run 元数据 / 附件列表 / 附件下载（需 sop_run_get；附件另需 run 读授权）
POST             /api/apps/:slug/data            自产台数据写入（JSON ≤1MB；按台的 data-contract.json 校验（必填/枚举/格式/条件规则 when 可带 require·equals·pattern/数组对象 items 可带自己的 when），违约 400+violations；{data, idempotency_key} 信封或 Idempotency-Key 头幂等；台页 iframe 同源 fetch 直通）
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
- **Odoo 管理员登录**：浏览器带着 Odoo 会话（`session_id`）访问时，服务端向 `LC_ODOO_URL` 现查 `get_session_info`，内部员工且 `is_admin=true` 即为管理员，不需另输口令；结论按会话哈希缓存 30 秒（Odoo 侧撤权最迟 30 秒生效）。`GET /api/admin/whoami` 返回当前身份（`via: token|odoo|null`），顶栏显示「Odoo 管理员 · 登录名」。
- 浏览器发来的管理写（带 `Origin` 或 `Sec-Fetch-Site`）在业务面即可做，但必须同源：跨源 `Origin` 或 `Sec-Fetch-Site: cross-site` 一律 403（Odoo 会话 cookie 是环境凭据，防跨站借用）。
- 持口令时使用页/驾驶舱不内嵌 `/go/`、离开市场页面即抹掉口令（#292 M4 止血保留）。
- **可选独立管理端口**：`WM_CONTROL_PORT` 显式给端口才开（缺省不开）；开了时它不提供 `/go/`、`/sop/`、`/apps/`、`/mcp`、`/openapi.json`、`/api/mcp-rest/*`、`/a2a/*`（404），响应带 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY`，管理写规则与业务面相同。
- 本机 CLI（回环直连、**不带** `Origin`/`Sec-Fetch-Site`、**没有** `X-Forwarded-For`/`Forwarded`/`X-Real-IP`）照旧免口令；逐路由自带 `adminGuard` 的写接口仍要口令。同机反代转进来的请求按远程处理。Node 自带 `fetch` 只发 `sec-fetch-mode`，按 CLI 算。
- web dev（vite 5173）：**默认关闭**；只有显式开启（`pnpm dev` 自带的 `--dev-origin` 启动参数，或 `WM_DEV_ORIGIN=1`）时，Origin 为本机 dev 源且本机直连的请求视同同源（仍要口令）。生产 `pnpm start` / 容器不开。
- **远程节点**（非 loopback）：写请求只放 `/mcp`、`/api/mcp-rest/tools/<name>` 与 `/api/mcp-rest/apps/<slug>/files[/<name>]`（路由内凭会话令牌鉴权）、`.well-known/agent-card.json`、`/a2a/direct`，以及**自产台数据/文件面**（`POST /api/apps/<slug>/data`、`/files`）——应用层写与发布面同口径（远程浏览器提交表单不会被 403）。
- 管理写（`/api/mcp/*` 会话令牌、SOP 绑定、工作台 CRUD 等）一律要管理员（口令或 Odoo 管理员），否则 403。
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
server/src/     index.ts（REST+静态+巡检装配） db.ts（schema+迁移） portal.ts（/go/ 反代·白屏五层+登录态） a2a.ts（卡片/绑定/direct 准入） a2a-direct-sig.ts（/a2a/direct 入站签名校验：只从登记地址取卡·防重放·WM_A2A_DIRECT_SIG） eval.ts（#178 jev 评估客户端） mcp-tools.ts（MCP 工具注册表） sop-runner.ts（SOP 执行页） redis.ts（SOP 状态层） sop-state-checkpoints.ts（#337 热写检查点：逐 run 串行与 SQLite 落盘期限） health.ts（探测） tasks.ts（定时任务） task-center.ts（任务中心元台种子+收件发布） endpoint-stats.ts（端点数） errors.ts（错误类型） context.ts（服务容器） sop-types.ts（SOP 类型） odoo-session.ts（门户 Odoo 会话可信源判定与剥除） lifecycle.ts（生命周期断言与审批接口） surfaces.ts（#292 M1 业务面/控制面多端口监听·按 localPort 判面·浏览器标记与回环判定） content-access.ts（内容票据与准入） content-surface.ts（内容面终结分发与到期引导） portal-observation.ts（无敏感原文的被动计数） url-admission.ts（#258 R3 业务 URL 登记准入单核·WM_REGISTER_URL_ALLOWLIST） vault-api.ts（凭据库 REST 面） workbench-vars.ts（#336 工作台变量与常量：按台隔离、revision 乐观锁、常量保护） vault/（dsh-vault 存储层引入件·见其 README） content-static.ts（无令牌静态资产读取） sop-readonly-channel.ts（只读隔离字段通道） sop-readonly-assembly.ts（冻结清单与run装配） sop-run-access.ts（run授权、能力与revision事务） sop-field-channel.ts（字段/上传/人工完成通道候选） sop-field-save.ts（未挂载字段保存路由） sop-field-upload.ts（未挂载惰性文件上传路由） sop-field-finish.ts（未挂载人工完成路由） sop-read-auth.ts（#309 run 私有读授权：读能力 + 主体 grant） design-standard.ts（MCP design_standard 工具的 design token 标准只读读取） design-tokens-css.ts（DESIGN.md 生成的 tokens.css 服务端出口） workbench-events.ts（工作台事件层 v1：人提交→事件→团队接单→决定回写） tasks-read-access.ts（#324 待办身份与来源授权） startup-security-self-probe.ts（#326 启动匿名安全面自检与门闩） github-source.ts（GitHub main 分支来源拉取：commits/trees/blobs 三段取内容·版本记 commit sha） app-data-contract.ts（自产台数据契约：必填/枚举/格式/条件规则（含条件格式）/数组对象逐元素，POST 数据时服务端权威校验） file-sniff.ts（上传按内容识别类型：签名为准、扩展名与内容不符或可执行文件拒收） sop-field-rules.ts（SOP 字段规则：从步骤 HTML 读 required/pattern/长度/类型，完成时服务端校验） login-gate.ts（全站登录门 WM_LOGIN_GATE：enforce 时页面 302 登录、API 401）
server/src/services/  app·app-data·sop·skill·sandbox·cockpit·workbench·cookie·setting·mcp（域服务）· sop-runner.ts（执行页）
web/src/        pages/（Dashboard/Market/Sops/Types/Settings/UseWorkbench/Cockpit/McpGateways/Tasks/Skills/Lifecycle/SopSpace/SopRunDetail/Vault/Reviews） components/ admin-token.ts（统一口令注入）
deploy/         Dockerfile.market（多阶段·非 root·HEALTHCHECK） docker-compose.yml（回环默认·profiles 隔离） layerfs-svc.mjs
docs/           layerfs-service-contract-v0/v1.md（LayerFS 服务契约）
data/           SQLite 数据文件（git 忽略）
```

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。


> **验证资产为本地产物不入库**（隐私治理·监督席处置单）：`evidence/`、`verify/`、`tmp/` 已 gitignore——E2E 摘要/判据冻结包/运行截图属本机生成物，fresh clone 后先跑一轮 E2E 再 make-submission（摘要门 fail-closed 即本义）。冻结报告另存 `~/.ygl-trees/verify/archives/`（zip 可携带）。**既有克隆合并 untrack 批后须恢复本地验证资产**（untrack=索引删除语义·合并即删工作树文件·全机验证链静默断）：`git checkout <untrack 前 SHA> -- evidence verify && git restore --staged evidence verify`——文件回工作树·不回流索引·gitignore 罩住。**净克隆自举**（#95 修正）：`verify/material.md`/`candidates.json`/`reviews.json` 三件套由 `node scripts/gen-verifier.mjs` 从**单一事实源再生成**（生成器自建 `verify/` 目录·净克隆一条命令重建 175 判据）。干净克隆跑验证链步骤：`node scripts/gen-verifier.mjs` → 跑一轮 E2E 产 `evidence/e2e-summary.json`（摘要门 fail-closed 即本义）→ `node scripts/make-submission.mjs --source-db <绝对库路径> --target-mode isolated --isolated-root <合成数据根>` → `ygl-trees verify submit/prepare/run`。


### 文件面 URL 语义（#164 P1②）

| 面 | 语义 |
|---|---|
| `POST /api/apps/:slug/files` | multipart 上传（`file` 字段·≤100MB）；可带 `note`/`created_by` 表单字段 |
| `POST /mcp` `app_files_upload` | **MCP 侧上传**：`{slug,name,content_base64,mime?,note?,created_by?}`——同表同链（app_files+落盘） |
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
- 生命周期真引擎测试：显式 LC_OS_DIR、YGL_BIN、--data-dir（测试输出根），不搜索个人checkout或引擎。lc-issuer-unit未给LC_OS_DIR时只跑内置向量并明确跳参考实现，不枚举个人路径。
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
- **生命周期源（只读降级）**：配置经另批准的 `LC_*` 后按查看人读取 `lc inbox`。当前 `POST /api/lifecycle/approve` 无条件503 `LC_APPROVAL_READ_ONLY`，不读Odoo会话、不加载签发私钥、不调用引擎；`/go/`及SOP源隔离未完成，故页面不提供批准按钮。没有环境开关重启HTTP批准。签名/请求绑定原语供独立测试保留，不等生产审批可用；生产配置与真实审批另批。详见 [交付说明](docs/lifecycle-workbench-issuer.md)。
UI：`/tasks` 页（源/状态过滤·生命周期条目标明「只读，审批停用」）· 总览待办聚合卡 · 驾驶舱「加待办卡」（kind=tasks 面板，布局服务端保存）。

## 鉴权边界与代理相对路径（#132 ⑨⑩）

### REST vs MCP 鉴权差异表

| 面 | 写操作 | 读操作 |
|---|---|---|
| REST `/api/apps`（发布） | `X-Admin-Token` 必带（远程写另经 T1 豁免面清单） | 开放（GET） |
| REST `/api/apps/:slug/files` | 上传=管理员口令；列表/下载开放 | 开放 |
| REST `/api/sop/runs/:id/files` | **run-scoped `X-Run-Upload-Token`**（启动响应/派单回执取）或管理员口令 | 开放 |
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
