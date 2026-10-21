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

环境变量：`PORT`（默认 9800）、`DATA_DIR`（SQLite 数据目录，默认 `server/data`）。

## 功能

| 功能 | 说明 |
| --- | --- |
| 工作台 CRUD | 名称/URL/类型/图标/分类/标签/排序/Markdown 描述；一键复制为副本（全字段预填）快速创建变体；删除仅解除注册不影响服务 |
| 类型系统 | 每类型定义探测语义（方法/路径/期望状态码，留空=任意响应即在线）+ 默认端口；内置 9 种（web/openai-api/ollama/gradio/streamlit/jupyter/mcp-sse/docs/market-app），可自定义 |
| 健康检测 | 单测/全部检测（并发限流、超时控制）、后台定时巡检（间隔可配，0=关闭） |
| 总览仪表盘 | 统计卡（点击深链 `/market?status=up\|down\|unknown` 直达过滤）+ 数据卡（在线率环/平均延迟/分类巡检/上次巡检）+ 可拖拽缩放卡片墙（布局存 localStorage，15s 自动刷新） |
| 使用页 | `/use/:id` 全屏内嵌（经 `/go/:id/` 统一门户同源代理，禁嵌站也能嵌）+ 顶部状态条 + 新窗口逃生 |
| 任务驾驶舱 | `/cockpit` 把常用 2-4 个工作台拼成一屏分屏视图（iframe 面板可拖拽/缩放/刷新/单独移除），布局存服务端自动保存；按场景建多个驾驶舱一键切换——从「收藏夹」到「驾驶舱」 |
| 统一门户 | `/go/<id>/` 反向代理全部工作台到 9800 同域：一个端口号直达所有台、同源消灭 CORS、自动剥除上游 `X-Frame-Options`/`CSP` 禁嵌头（实测 DENY 站点经代理可嵌）；支持 WebSocket 升级（Jupyter/MCP）与 3xx Location 前缀改写——从「登记簿」到「统一入口」 |
| 凭据注入 | 工作台可配置 Bearer/Basic 凭据，经 `/go/` 门户访问时代理自动注入 `Authorization` 头：token 不必再明文拼进 url（token-in-url 会泄漏进上游访问日志/Referer）；url 自带一次性 token query 而请求未带时自动补全，已持认证 cookie 则不补（防重签死循环）；凭据值在详情抽屉脱敏展示 |
| 台生成器 | `POST /api/apps` 一发即得一个市场自产台：AI 会话（或任何脚本）把 `[{path, content}]` 文件集发上来，市场静态托管在 `/apps/<slug>/`，**发布即自动入册**（类型 market-app、探测短路=服务活着即在线），门户/驾驶舱/市场全链立即可用；**全版本快照**——同 slug 重发 = 新版本，`activate` 一键回滚任意历史版本——从「台的管理者」到「台的生产者」 |
| SOP 台 | 台生成器的 `kind:'sop'` 分流：`sop.yaml`（标题/编号/步骤，步骤 body 内嵌 HTML）发布为 SOP 台，`/sop/:slug/` 服务端渲染零构建执行页（步骤卡 + data-field 自动收集 + 800ms 防抖保存 + localStorage 缓冲 + 刷新恢复 run）；**状态机 draft→published→deprecated**（changelog 必填，draft 不入册防半成品上架）；执行数据**分层持久化**——状态层 Redis（HSET 热态 + 活跃索引，写路径 ~ms 级；不可达自动降级直写 SQLite）+ 持久层 SQLite（sop_runs 表为真源：开 run 钉版本、30s checkpoint、finish 全量沉淀；Redis 条目 1h 平滑淘汰） |
| MCP 生产通道 | `/mcp` StreamableHTTP（stateless，零依赖手写 JSON-RPC 2.0）：AI 会话/任意 MCP 客户端直连市场，7 个生产工具——`workbench_list`（找台）/`workbench_summary`（总览）/`workbench_check`（探测）/`use_url`（取 `/go/<id>/` 门户入口）/`app_publish`（**发布自产台与 SOP 台**，agent 原生供给通道）/`app_activate`（版本回滚）/`sop_publish`（SOP 上架）——市场从 REST 页面操作升级为 agent 可编程；已实测接入 DSH（dsh-mcp-connector 连接 `http://127.0.0.1:9800/mcp`，7 工具以 `mcp__workbench-market__*` 注入会话） |
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
GET              /api/export                    全量导出
POST             /api/import?mode=merge|replace 导入
GET              /api/health                    版本与运行时长
```

## 目录

```
server/src/   db.ts（schema+种子） health.ts（探测） index.ts（REST+静态+巡检）
web/src/      pages/（Dashboard/Market/Sops/Types/Settings/UseWorkbench/Cockpit） components/（StatusBadge/WorkbenchForm）
data/         SQLite 数据文件（git 忽略）
```

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。

## 开发验证器

基于 ygl-trees verify 管线（M13 spec validator）的闭集判定器 v24：**116 条判据**二十四维覆盖——数据域完整性（9：types/workbenches 全部数值与枚举列域）、种子与配置（6：类型数 ≥9、内置 web、ollama/streamlit 探测路径钉、巡检三键、工作台非空）、提交物结构（20：清单/源码/构建产物/脚本/自举档案/设计规范/证据资产）、**颜色可见性**（18：经对比度审计的色值钉位，如次级文字 #5A6577=5.9:1、焦点环 rgba(5,150,105,.6)、深底状态文字 rgba(255,255,255,.85)）、**E2E 行为证据**（3：用例规模（≥25 含驾驶舱/统一门户/自产台/凭据注入/WS 握手/SOP 台/MCP 生产通道/SOP 管理页/运行时批用例）、全绿、时间戳，源自 e2e_test.py 落盘的 evidence/e2e-summary.json）、**渲染层对比度探针**（2：E2E 内置 Playwright 实测 DOM 前景/背景配对——深底状态文字曾实测 1.18:1 不可见，此维度在行为层抓住同类回归，9 处目标全 ≥4.5:1 且 fail-closed）、**任务驾驶舱**（3：驾驶舱名称域完整、Cockpit.tsx 在位、/api/cockpits 路由钉位）、**统一门户**（4：代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走 /go/ 同源代理）、**台生成器**（5：自产台 slug 域完整、market-app 内置类型在位、发布路由与版本链表钉位、演示自产台常驻）、**凭据注入**（3：服务端注入头钉位、表单凭据字段钉位、E2E 注入行为断言钉位——认证类工作台凭据不再明文拼 url）、**WS 升级**（2：upgrade 事件挂载与握手 Origin 改写钉位——upgrade 不流经 Express 中间件链且不触发 proxyReq 钩子，缺位时 HTTP 通而 WS 死（DSH 台「重新连接中」的实测根因），E2E 以 socket 级 101 握手断言钉住行为）、**SOP 台**（5：运行真源表 sop_runs 与 Redis 状态层模块 runStateSave 钉位、Runner 服务端渲染与运行 API 钉位、E2E 行为断言钉位——状态层 Redis 热态 + 持久层 SQLite 真源的分层治理，Redis 不可达自动降级直写）、**MCP 生产通道**（4：/mcp 端点与工具注册表钉位、JSON-RPC -32601 协议合规锚点、E2E 行为断言钉位——AI 会话直连市场的 agent 原生供给面）、**SOP 管理页**（4：Sops.tsx 在位与 SOP_STATUS 状态语义表钉位、/sops 路由钉位、演示 SOP 常驻钉位——状态徽章可视化状态机 + run 记录直查分层持久化数据）、**凭据面防泄露**（2：maskSensitiveQuery 掩码函数与掩码回传保护钉位——REST/MCP 无认证出口对 url query 敏感参数与 auth.value 统一脱敏，代理侧 DB 直读不受影响）、**安全批整改**（2：auth.value+MCP 脱敏、CORS 白名单、draft 403 瘦身——外部评审 #1/#2/#3/#11）、**门户 Location 改写**（2：proxyRes 的 goWid 备份钉位与行为断言——3xx 跳转改写回 /go/ 前缀内，评审 #4）、**运行时批整改**（4：巡检重挂/删台清注册/导入 replace 语义钉位 + 组 19 断言探针——评审 #5-10）、**A2A 网络接入 P1**（4：上游一致卡片签名/绑定口令/节点短 id/裁判冒烟——GH #17 只读暴露）、**Agent 执行数据面**（3：run 持久化同链核心 + MCP sop_run_* 五工具 + 人机同链断言）、**导出脱敏**（3：默认 maskForApi + 导入掩码跳过 + 行为断言——compliance 二期首项）、**注册 CRUD MCP 化**（3：REST 同链核心/凭据硬拒绝/行为断言——agent 自主登记外部台）、**破坏性测试隔离**（1：导入 replace 永不碰活库——84 事故根治）。内容与 JSON 在 CLI 闭集不可直接判定，经三张提取表桥接：`verifier_text_facts`（色值与源码事实钉位）、`verifier_e2e_summary`（E2E 摘要）、`verifier_contrast_checks`（渲染对比度实测），由 make-submission.mjs 打包时从当前源码/证据重新提取写入快照。typecheck/lint/build 不在闭集内，由开发流程自行执行。

```bash
# 0) 再生成三件套（单一事实源 116 单元表 → verify/material.md + candidates.json + reviews.json）
node scripts/gen-verifier.mjs

# 1) 生成判定面：活库快照（含色值/E2E/对比度提取表）+ 封装提交物（幂等，干净克隆自愈——tmp/ 不存在时自动创建；E2E 判据依赖 evidence/e2e-summary.json，未跑 E2E 则 fail-closed）
node scripts/make-submission.mjs

# 2) 构造期（材料 → 候选 → 盲审 → 三重门 → 冻结 spec；材料/候选/盲审改动后需重新 submit；file 判据需 --attach 提交物 tar）
ygl-trees verify submit --title "workbench-market 开发验证器 v24" --text verify/material.md --attach tmp/submission-v16.tar.gz
ygl-trees verify prepare <material-id> --candidates verify/candidates.json --reviews verify/reviews.json --db tmp/verify-snap.sqlite

# 3) 执行期（可重复跑；--submission 指向封装提交物而非仓库根——file 型全仓扫描在 pnpm 联接点上不可行）
ygl-trees verify run <spec-id> --db tmp/verify-snap.sqlite --submission tmp/submission

# 4) 判定报告可视化（多 run 对照，单文件 HTML）
node scripts/verify-report.mjs <run1.json> [run2.json ...]
```

基线：`run_766e0c923b514232` 58/58 PASS（spec_24a0b30d47d1，2026-10-20）。红测四条：`run_8b5fa9dcc555773c`（删 ollama+README）V10/V12/V16 精确 FAIL；`run_45ce9306eb05a210`（源码改 #5A6577）V37 精确 FAIL；`run_79cacaa31cd69a45`（E2E 13/14 + 轴色漂移）V49/V53 精确 FAIL；`run_aa92adf654b5964a`（篡改对比度记录为 1.18:1）V56 精确 FAIL——DOM 探针 → 摘要 → 提取表 → 判据的 fail-closed 链路实证。判据源文件在 [verify/](verify/)：material.md（冻结材料原文）、candidates.json（VU 候选 + checker）、reviews.json（三问盲审结论）；58 单元表由 [scripts/gen-verifier.mjs](scripts/gen-verifier.mjs) 单一事实源生成。
