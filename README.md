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
| 类型系统 | 每类型定义探测语义（方法/路径/期望状态码，留空=任意响应即在线）+ 默认端口；内置 8 种，可自定义 |
| 健康检测 | 单测/全部检测（并发限流、超时控制）、后台定时巡检（间隔可配，0=关闭） |
| 总览仪表盘 | 统计卡（点击深链 `/market?status=up\|down\|unknown` 直达过滤）+ 数据卡（在线率环/平均延迟/分类巡检/上次巡检）+ 可拖拽缩放卡片墙（布局存 localStorage，15s 自动刷新） |
| 使用页 | `/use/:id` 全屏内嵌 + 顶部状态条；被嵌页面禁止 X-Frame-Options 时一键新窗口 |
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
GET              /api/export                    全量导出
POST             /api/import?mode=merge|replace 导入
GET              /api/health                    版本与运行时长
```

## 目录

```
server/src/   db.ts（schema+种子） health.ts（探测） index.ts（REST+静态+巡检）
web/src/      pages/（Dashboard/Market/Types/Settings/UseWorkbench） components/（StatusBadge/WorkbenchForm）
data/         SQLite 数据文件（git 忽略）
```

设计系统见 `design-system/workbench-market/MASTER.md`（Minimalism & Swiss，主色 #1E3A5F）。

## 开发验证器

基于 ygl-trees verify 管线（M13 spec validator）的闭集判定器 v6：**58 条判据**六维覆盖——数据域完整性（9：types/workbenches 全部数值与枚举列域）、种子与配置（6：类型数 ≥8、内置 web、ollama/streamlit 探测路径钉、巡检三键、工作台非空）、提交物结构（20：清单/源码/构建产物/脚本/自举档案/设计规范/证据资产）、**颜色可见性**（18：经对比度审计的色值钉位，如次级文字 #5A6577=5.9:1、焦点环 rgba(5,150,105,.6)、深底状态文字 rgba(255,255,255,.85)）、**E2E 行为证据**（3：用例规模、全绿、时间戳，源自 e2e_test.py 落盘的 evidence/e2e-summary.json）、**渲染层对比度探针**（2：E2E 内置 Playwright 实测 DOM 前景/背景配对——深底状态文字曾实测 1.18:1 不可见，此维度在行为层抓住同类回归，7 处目标全 ≥4.5:1 且 fail-closed）。内容与 JSON 在 CLI 闭集不可直接判定，经三张提取表桥接：`verifier_text_facts`（色值钉位事实）、`verifier_e2e_summary`（E2E 摘要）、`verifier_contrast_checks`（渲染对比度实测），由 make-submission.mjs 打包时从当前源码/证据重新提取写入快照。typecheck/lint/build 不在闭集内，由开发流程自行执行。

```bash
# 0) 再生成三件套（单一事实源 58 单元表 → verify/material.md + candidates.json + reviews.json）
node scripts/gen-verifier.mjs

# 1) 生成判定面：活库快照（含色值/E2E/对比度提取表）+ 封装提交物（幂等；E2E 判据依赖 evidence/e2e-summary.json，未跑 E2E 则 fail-closed）
node scripts/make-submission.mjs

# 2) 构造期（材料 → 候选 → 盲审 → 三重门 → 冻结 spec；材料/候选/盲审改动后需重新 submit）
ygl-trees verify submit --title "workbench-market 开发验证器 v6" --text verify/material.md
ygl-trees verify prepare <material-id> --candidates verify/candidates.json --reviews verify/reviews.json --db tmp/verify-snap.sqlite

# 3) 执行期（可重复跑；--submission 指向封装提交物而非仓库根——file 型全仓扫描在 pnpm 联接点上不可行）
ygl-trees verify run <spec-id> --db tmp/verify-snap.sqlite --submission tmp/submission

# 4) 判定报告可视化（多 run 对照，单文件 HTML）
node scripts/verify-report.mjs <run1.json> [run2.json ...]
```

基线：`run_766e0c923b514232` 58/58 PASS（spec_24a0b30d47d1，2026-10-20）。红测四条：`run_8b5fa9dcc555773c`（删 ollama+README）V10/V12/V16 精确 FAIL；`run_45ce9306eb05a210`（源码改 #5A6577）V37 精确 FAIL；`run_79cacaa31cd69a45`（E2E 13/14 + 轴色漂移）V49/V53 精确 FAIL；`run_aa92adf654b5964a`（篡改对比度记录为 1.18:1）V56 精确 FAIL——DOM 探针 → 摘要 → 提取表 → 判据的 fail-closed 链路实证。判据源文件在 [verify/](verify/)：material.md（冻结材料原文）、candidates.json（VU 候选 + checker）、reviews.json（三问盲审结论）；58 单元表由 [scripts/gen-verifier.mjs](scripts/gen-verifier.mjs) 单一事实源生成。
