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
```

环境变量：`PORT`（默认 9800）、`DATA_DIR`（SQLite 数据目录，默认 `server/data`）、`ADMIN_TOKEN`（管理员口令，控制面写操作用；也可在设置页手动设置）、`REDIS_URL`（SOP 状态层 Redis，缺省读 `DATA_DIR/redis.url`，都没有则降级直写 SQLite）、`MARKET_TEAM`（A2A 节点 team，默认 `market`）、`MCP_GATEWAY`（`on` 时 `/mcp` 启用会话令牌网关）。

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
| 台生成器 | `POST /api/apps` 一发即得一个市场自产台：AI 会话（或任何脚本）把 `[{path, content}]` 文件集发上来，市场静态托管在 `/apps/<slug>/`，**发布即自动入册**（类型 market-app、探测短路=服务活着即在线），门户/驾驶舱/市场全链立即可用；**全版本快照**——同 slug 重发 = 新版本，`activate` 一键回滚任意历史版本——从「台的管理者」到「台的生产者」 |
| SOP 台 | 台生成器的 `kind:'sop'` 分流：`sop.yaml`（标题/编号/步骤，步骤 body 内嵌 HTML）发布为 SOP 台，`/sop/:slug/` 服务端渲染零构建执行页（步骤卡 + data-field 自动收集 + 800ms 防抖保存 + localStorage 缓冲 + 刷新恢复 run）；**状态机 draft→published→deprecated**（changelog 必填，draft 不入册防半成品上架）；执行数据**分层持久化**——状态层 Redis（HSET 热态 + 活跃索引，写路径 ~ms 级；不可达自动降级直写 SQLite）+ 持久层 SQLite（sop_runs 表为真源：开 run 钉版本、30s checkpoint、finish 全量沉淀；Redis 条目 1h 平滑淘汰） |
| MCP 生产通道 | `/mcp` StreamableHTTP（stateless，零依赖手写 JSON-RPC 2.0）：AI 会话/任意 MCP 客户端直连市场，**17 个工具**——生产 7：`workbench_list`（找台）/`workbench_summary`（总览）/`workbench_check`（探测）/`use_url`（取 `/go/<id>/` 门户入口）/`app_publish`（**发布自产台与 SOP 台**，agent 原生供给通道）/`app_activate`（版本回滚）/`sop_publish`（SOP 上架）；执行数据 5：`sop_run_start` / `sop_run_step_save`（直接更新持久化执行数据，与 Runner/REST 同链）/ `sop_run_get` / `sop_run_list` / `sop_run_finish`；注册 CRUD 3：`workbench_register`（agent 自主登记外部台）/ `workbench_update` / `workbench_unregister`（凭据字段一律拒绝，人工配置）；台数据读取 2：`app_data_list`（读自产台表单提交数据）/ `app_files_list`（读文件提交列表，含下载 url）——**只走 MCP 的 agent 也能消费台提交的数据**；**上游聚合**（#20 P2）：`settings.mcp_upstreams` 配外部 MCP（如 taste-mcp），其工具以 `<prefix>__<tool>`（如 `taste__rules`）并入同一 /mcp 面，上游不可达自动降级不影响本地 17 工具；网关会话存在时以 `X-Market-Client: mcp/<会话名>` 透传调用方身份（上游据此判 judge 身份）——市场从 REST 页面操作升级为 agent 可编程；已实测接入 DSH（dsh-mcp-connector，工具以 `mcp__workbench-market__*` 注入会话） |
| 台数据查看 | 工作台详情（market-app）→「查看提交数据」Drawer：表单数据行（JSON 折叠/提交者/时间）+ 文件（类型/大小/下载）+ 游标加载更多——数据落库后在 UI 直接可查 |
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
GET/POST         /api/apps                      自产台列表 / 发布（body: {slug, title, description?, created_by?, files:[{path, content}]}；重发同 slug = 新版本；入册即用）
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
POST             /mcp                           MCP StreamableHTTP（initialize/tools/list/tools/call；7 生产工具；GET/DELETE → 405）
POST             /api/apps/:slug/data            自产台数据写入（JSON ≤1MB；台页 iframe 同源 fetch 直通）
GET              /api/apps/:slug/data            自产台数据列表（游标分页 ?limit=&before_id=）
POST             /api/apps/:slug/files           自产台文件提交（multipart 任意类型 ≤50MB；超限 413）
GET              /api/apps/:slug/files           文件列表（游标分页）
GET              /api/apps/:slug/files/:id       文件下载（content-type + nosniff；非白名单强制 attachment）
GET              /api/export                    全量导出
POST             /api/import?mode=merge|replace 导入
GET              /api/health                    版本与运行时长
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

**管理员口令（控制面）**：`设置` 页可手动设置/清除（库存**加盐**哈希 `salt$sha256(salt+口令)`，且 settings/导出出口一律剔除该键；仅本机可设；设置即生效）。优先级：启动环境 `ADMIN_TOKEN` > 页面设置值 > 无（未设则控制面一律 403 休眠）。口令控制 SOP 绑定、MCP 会话、上游配置；远程面收口不依赖它。

- 本机（loopback）REST 全开放——内网信任模型，凭据字段出口统一掩码。
- **远程节点**（非 loopback）：写请求只放 `/mcp`、`.well-known/agent-card.json`、`/a2a/direct`，以及**自产台数据/文件面**（`POST /api/apps/<slug>/data`、`/files`）——应用层写与发布面同口径（远程浏览器提交表单不会被 403）。
- 控制面（`/api/mcp/*` 会话令牌、SOP 绑定、工作台 CRUD）的远程写一律要 `X-Admin-Token`（未设置则 403）。
- **读面不拦**：远程 agent 用 `GET /api/apps/<slug>/data`、`/files` 直接读提交数据（掩码策略只作用于凭据，不作用于业务数据）。

## 目录

```
server/src/   db.ts（schema+种子） health.ts（探测） index.ts（REST+静态+巡检） a2a.ts（卡片/绑定/direct 准入） redis.ts（SOP 状态层）
web/src/      pages/（Dashboard/Market/Sops/Types/Settings/UseWorkbench/Cockpit/McpGateways） components/（StatusBadge/WorkbenchForm/AppDataDrawer）
data/         SQLite 数据文件（git 忽略）
```

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。


> **验证资产为本地产物不入库**（隐私治理·监督席处置单）：`evidence/`、`verify/`、`tmp/` 已 gitignore——E2E 摘要/判据冻结包/运行截图属本机生成物，fresh clone 后先跑一轮 E2E 再 make-submission（摘要门 fail-closed 即本义）。冻结报告另存 `~/.ygl-trees/verify/archives/`（zip 可携带）。**既有克隆合并 untrack 批后须恢复本地验证资产**（untrack=索引删除语义·合并即删工作树文件·全机验证链静默断）：`git checkout <untrack 前 SHA> -- evidence verify && git restore --staged evidence verify`——文件回工作树·不回流索引·gitignore 罩住。**净克隆自举**（#95 修正）：`verify/material.md`/`candidates.json`/`reviews.json` 三件套由 `node scripts/gen-verifier.mjs` 从**单一事实源再生成**（生成器自建 `verify/` 目录·净克隆一条命令重建 175 判据）。干净克隆跑验证链步骤：`node scripts/gen-verifier.mjs` → 跑一轮 E2E 产 `evidence/e2e-summary.json`（摘要门 fail-closed 即本义）→ `node scripts/make-submission.mjs` → `ygl-trees verify submit/prepare/run`。

## 开发验证器

基于 ygl-trees verify 管线（M13 spec validator）的闭集判定器 v68：**175 条判据**五十四维覆盖——数据域完整性（9：types/workbenches 全部数值与枚举列域）、种子与配置（6：类型数 ≥9、内置 web、ollama/streamlit 探测路径钉、巡检三键、工作台非空）、提交物结构（20：清单/源码/构建产物/脚本/自举档案/设计规范/证据资产）、**颜色可见性**（18：经对比度审计的色值钉位，如次级文字 #5A6577=5.9:1、焦点环 rgba(5,150,105,.6)、深底状态文字 rgba(255,255,255,.85)）、**E2E 行为证据**（3：用例规模（≥25 含驾驶舱/统一门户/自产台/凭据注入/WS 握手/SOP 台/MCP 生产通道/SOP 管理页/运行时批用例）、全绿、时间戳，源自 e2e_test.py 落盘的 evidence/e2e-summary.json）、**渲染层对比度探针**（2：E2E 内置 Playwright 实测 DOM 前景/背景配对——深底状态文字曾实测 1.18:1 不可见，此维度在行为层抓住同类回归，9 处目标全 ≥4.5:1 且 fail-closed）、**任务驾驶舱**（3：驾驶舱名称域完整、Cockpit.tsx 在位、/api/cockpits 路由钉位）、**统一门户**（4：代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走 /go/ 同源代理）、**台生成器**（5：自产台 slug 域完整、market-app 内置类型在位、发布路由与版本链表钉位、演示自产台常驻）、**凭据注入**（3：服务端注入头钉位、表单凭据字段钉位、E2E 注入行为断言钉位——认证类工作台凭据不再明文拼 url）、**WS 升级**（2：upgrade 事件挂载与握手 Origin 改写钉位——upgrade 不流经 Express 中间件链且不触发 proxyReq 钩子，缺位时 HTTP 通而 WS 死（DSH 台「重新连接中」的实测根因），E2E 以 socket 级 101 握手断言钉住行为）、**SOP 台**（5：运行真源表 sop_runs 与 Redis 状态层模块 runStateSave 钉位、Runner 服务端渲染与运行 API 钉位、E2E 行为断言钉位——状态层 Redis 热态 + 持久层 SQLite 真源的分层治理，Redis 不可达自动降级直写）、**MCP 生产通道**（4：/mcp 端点与工具注册表钉位、JSON-RPC -32601 协议合规锚点、E2E 行为断言钉位——AI 会话直连市场的 agent 原生供给面）、**SOP 管理页**（4：Sops.tsx 在位与 SOP_STATUS 状态语义表钉位、/sops 路由钉位、演示 SOP 常驻钉位——状态徽章可视化状态机 + run 记录直查分层持久化数据）、**凭据面防泄露**（2：maskSensitiveQuery 掩码函数与掩码回传保护钉位——REST/MCP 无认证出口对 url query 敏感参数与 auth.value 统一脱敏，代理侧 DB 直读不受影响）、**安全批整改**（2：auth.value+MCP 脱敏、CORS 白名单、draft 403 瘦身——外部评审 #1/#2/#3/#11）、**门户 Location 改写**（2：proxyRes 的 goWid 备份钉位与行为断言——3xx 跳转改写回 /go/ 前缀内，评审 #4）、**安全批双锚**（3：CORS/MCP 协议/draft 403 三面源码+行为双锚——防「代码在而行为回归」）、**运行时批整改**（4：巡检重挂/删台清注册/导入 replace 语义钉位 + 组 19 断言探针——评审 #5-10）、**A2A 网络接入 P1**（4：上游一致卡片签名/绑定口令/节点短 id/裁判冒烟——GH #17 只读暴露）、**Agent 执行数据面**（3：run 持久化同链核心 + MCP sop_run_* 五工具 + 人机同链断言）、**导出脱敏**（3：默认 maskForApi + 导入掩码跳过 + 行为断言——compliance 二期首项）、**注册 CRUD MCP 化**（3：REST 同链核心/凭据硬拒绝/行为断言——agent 自主登记外部台）、**破坏性测试隔离**（1：导入 replace 永不碰活库——84 事故根治）。内容与 JSON 在 CLI 闭集不可直接判定，经三张提取表桥接：`verifier_text_facts`（色值与源码事实钉位）、`verifier_e2e_summary`（E2E 摘要）、`verifier_contrast_checks`（渲染对比度实测），由 make-submission.mjs 打包时从当前源码/证据重新提取写入快照。typecheck/lint/build 不在闭集内，由开发流程自行执行。

```bash
# 0) 再生成三件套（单一事实源 175 单元表 → verify/material.md + candidates.json + reviews.json）
node scripts/gen-verifier.mjs

# 1) 生成判定面：活库快照（含色值/E2E/对比度提取表）+ 封装提交物（幂等，干净克隆自愈——tmp/ 不存在时自动创建；E2E 判据依赖 evidence/e2e-summary.json，未跑 E2E 则 fail-closed）
node scripts/make-submission.mjs

# 2) 构造期（材料 → 候选 → 盲审 → 三重门 → 冻结 spec；材料/候选/盲审改动后需重新 submit；file 判据需 --attach 提交物 tar）
ygl-trees verify submit --title "workbench-market 开发验证器 v30" --text verify/material.md --attach tmp/submission-v16.tar.gz
ygl-trees verify prepare <material-id> --candidates verify/candidates.json --reviews verify/reviews.json --db tmp/verify-snap.sqlite

# 3) 执行期（可重复跑；--submission 指向封装提交物而非仓库根——file 型全仓扫描在 pnpm 联接点上不可行）
ygl-trees verify run <spec-id> --db tmp/verify-snap.sqlite --submission tmp/submission

# 4) 判定报告可视化（多 run 对照，单文件 HTML）
node scripts/verify-report.mjs <run1.json> [run2.json ...]
```

基线：`run_766e0c923b514232` 58/58 PASS（spec_24a0b30d47d1，2026-10-20）。红测四条：`run_8b5fa9dcc555773c`（删 ollama+README）V10/V12/V16 精确 FAIL；`run_45ce9306eb05a210`（源码改 #5A6577）V37 精确 FAIL；`run_79cacaa31cd69a45`（E2E 13/14 + 轴色漂移）V49/V53 精确 FAIL；`run_aa92adf654b5964a`（篡改对比度记录为 1.18:1）V56 精确 FAIL——DOM 探针 → 摘要 → 提取表 → 判据的 fail-closed 链路实证。判据源文件在 [verify/](verify/)：material.md（冻结材料原文）、candidates.json（VU 候选 + checker）、reviews.json（三问盲审结论）；58 单元表由 [scripts/gen-verifier.mjs](scripts/gen-verifier.mjs) 单一事实源生成。

## 统一待办（omni-inbox）

三源任务聚合（只读，勾销回原系统）：`GET /api/tasks`（30s 缓存）返回任务信封 `{id,source,title,status,due,link,project}` 与源元数据；
- **ygl-trees 源**：server 侧 `ygl-trees task list --json`（5s 超时；CLI 不可用 → `ok=false` 降级，不阻塞其它源）
- **market 源**：派单 running 的 SOP run（待验收语义，深链 `/sop/<slug>/`）
- A2A 源为 v2 预留
UI：`/tasks` 页（源/状态过滤）· 总览待办聚合卡 · 驾驶舱「加待办卡」（kind=tasks 面板，布局服务端保存）。

## 鉴权边界与代理相对路径（#132 ⑨⑩）

### REST vs MCP 鉴权差异表

| 面 | 写操作 | 读操作 |
|---|---|---|
| REST `/api/apps`（发布） | `X-Admin-Token` 必带（远程写另经 T1 豁免面清单） | 开放（GET） |
| REST `/api/apps/:slug/files` | 上传=管理员口令；列表/下载开放 | 开放 |
| REST `/api/sop/runs/:id/files` | **run-scoped `X-Run-Upload-Token`**（启动响应/派单回执取）或管理员口令 | 开放 |
| MCP `/mcp` | 无独立口令——网关模式下按会话 `grants` 工具白名单授权（`Authorization: Bearer <token>`） | 同左 |
| 管理面（settings/mcp sessions） | `X-Admin-Token` 必带 | 部分开放（脱敏） |

**推荐路径**：agent 侧一律走 MCP（授权白名单可审计）；人工作业走 REST+口令；远程台面发布用 T1 豁免清单内的业务写面。

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

### 探活与数据

- **探活端点 `/api/health`**（镜像已带 HEALTHCHECK；`/health` 不再被 SPA 兜底成 HTML）
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
