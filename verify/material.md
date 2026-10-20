workbench-market 开发验证器 v9（全面覆盖矩阵 + 渲染层对比度 + 驾驶舱 + 统一门户 + 台生成器）

判定面：SQLite 快照与封装提交物目录，二者均由 scripts/make-submission.mjs 生成：
快照 tmp/verify-snap.sqlite 来自活库的一致性副本，并含文本事实提取表
verifier_text_facts(path, needle, present)——打包时对源码逐一检查钉位事实；
E2E 行为证据提取表 verifier_e2e_summary(total, passed, failed, all_passed,
finished_at)——源自 e2e_test.py 每次运行落盘的 evidence/e2e-summary.json；
渲染层对比度提取表 verifier_contrast_checks(label, ratio, min_required,
passed)——源自 E2E 内置的 Playwright 对比度探针（实测 DOM 前景/背景配对，
静态色值钉位无法覆盖的深底文字可见性）。
提交物目录 tmp/submission 从仓库根抽取根清单、server 与 web 源码树、构建产物、
脚本、验证器自举档案、设计规范与证据。
命令执行型检查（typecheck、lint、build）不属于 CLI 闭集，由开发流程自行执行
（E2E 与渲染层对比度结果经摘要表断言）；覆盖九个维度共 70 条判据：数据域完整性
（判据1-9）、种子与配置（判据10-15）、提交物结构（判据16-35）、颜色可见性
（判据36-51 与 57-58：经对比度审计的色值在源码与规范中的钉位，漂移即破坏已审计
的可读性）、E2E 行为证据（判据52-54：规模下限、全绿、时间戳在位）、渲染层对比度
探针（判据55-56：覆盖面下限与全达标——深底上的状态文字曾实测 1.18:1 不可见，
此维度保证同类回归被行为层抓住）、任务驾驶舱（判据59-61：名称域完整性、驾驶舱
页面在位、CRUD 路由钉位——工作台从收藏夹到分屏组合视图的功能面锚定）、统一门户
（判据62-65：反向代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走
/go/ 同源代理——从登记簿到统一入口的形态锚定）、台生成器（判据66-70：自产台
slug 域完整、market-app 内置类型在位、发布路由与版本链表钉位、演示台常驻——
从台的管理者到台的生产者的供给面锚定）。
以下判据全部可机械判定：

判据1：类型的 key 字段不得为空。
判据2：类型的 health_method 字段必须等于 GET 或 HEAD。
判据3：类型的 expect_status 字段必须为空或落在 100 到 599 之间。
判据4：类型的 default_port 字段必须为空或落在 1 到 65535 之间。
判据5：每个已注册工作台的 enabled 字段必须等于 0 或 1。
判据6：工作台的 last_status 字段必须等于 up、down、unknown 之一或为空。
判据7：工作台的 last_latency_ms 字段必须为空或落在 0 到 60000 之间。
判据8：工作台的 last_http_code 字段必须为空或落在 100 到 599 之间。
判据9：工作台的 sort 字段必须落在 0 到 9999 之间。
判据10：类型库中的工作台类型不少于 8 个。
判据11：内置类型 web 必须存在于类型库。
判据12：ollama 类型的探测路径必须为 /api/tags。
判据13：streamlit 类型的探测路径必须为 /_stcore/health。
判据14：巡检设置必须包含 health_interval_seconds、health_timeout_ms、health_concurrency 三个键。
判据15：工作台表中至少注册了 1 个工作台。
判据16：封装提交物必须包含 README.md。
判据17：封装提交物必须包含根目录 package.json。
判据18：封装提交物必须包含 pnpm-workspace.yaml。
判据19：封装提交物必须包含 server/package.json。
判据20：封装提交物必须包含 web/package.json。
判据21：封装提交物必须包含 server/src/index.ts。
判据22：封装提交物必须包含 server/src/db.ts。
判据23：封装提交物必须包含 server/src/health.ts。
判据24：封装提交物 web/src/pages 目录下的页面组件不少于 6 个。
判据25：封装提交物 web/src/components 目录下的组件不少于 2 个。
判据26：封装提交物必须包含 web/dist/index.html。
判据27：封装提交物 web/dist/assets 目录下的 JS 产物不少于 5 个。
判据28：封装提交物必须包含 scripts/make-submission.mjs。
判据29：封装提交物必须包含 scripts/verify-report.mjs。
判据30：封装提交物必须包含 verify/material.md。
判据31：封装提交物必须包含 verify/candidates.json。
判据32：封装提交物必须包含 verify/reviews.json。
判据33：封装提交物必须包含 design-system/workbench-market/MASTER.md。
判据34：封装提交物必须包含 evidence/e2e_test.py。
判据35：封装提交物 evidence 目录下的 PNG 截图证据不少于 10 张。
判据36：main.tsx 主题必须包含主色值「#1E3A5F」。
判据37：main.tsx 主题必须包含次级文字色值「#5A6577」。
判据38：main.tsx 主题必须包含成功色值「#059669」。
判据39：main.tsx 主题必须包含错误色值「#DC2626」。
判据40：App.tsx 侧栏 token 必须包含深底色值「#0F172A」。
判据41：index.css 必须包含焦点环色值「rgba(5, 150, 105, 0.6)」。
判据42：index.css 必须包含选中边框色值「rgba(5, 150, 105, 0.45)」。
判据43：App.tsx 标题区必须包含强调色值「#059669」。
判据44：设计规范 MASTER.md 必须包含主色值「#1E3A5F」。
判据45：设计规范 MASTER.md 必须包含次级文字审计色值「#5A6577」。
判据46：Dashboard.tsx 统计标签必须包含次级色值「#5A6577」。
判据47：Dashboard.tsx 在线环必须包含成功色值「#059669」。
判据48：Dashboard.tsx 离线卡必须包含错误色值「#DC2626」。
判据49：Dashboard.tsx 辅助文字必须包含轴色值「#94A3B8」。
判据50：index.css 必须包含主色淡底色值「rgba(30, 58, 95, 0.1)」。
判据51：index.css 必须包含深底色值「#0f172a」。
判据52：E2E 摘要记录的用例总数不得少于 18。
判据53：E2E 摘要必须标记全部用例通过。
判据54：E2E 摘要必须带有完成时间戳。
判据55：渲染层对比度探针覆盖的文字目标不得少于 7 处。
判据56：渲染层对比度探针不得存在未通过的目标。
判据57：index.css 必须包含深底状态文字规则选择器「.wm-use-bar .ant-badge-status-text」。
判据58：index.css 必须包含深底浅色文字色值「rgba(255, 255, 255, 0.85)」。
判据59：驾驶舱的 name 字段不得为空。
判据60：封装提交物必须包含 web/src/pages/Cockpit.tsx。
判据61：server/src/index.ts 必须包含驾驶舱路由「/api/cockpits」。
判据62：server/src/index.ts 必须包含「createProxyMiddleware」。
判据63：server/src/index.ts 必须包含剥禁嵌头的「x-frame-options」。
判据64：封装提交物 server/package.json 必须声明依赖「http-proxy-middleware」。
判据65：web/src/pages/UseWorkbench.tsx 必须包含「/go/${w.id}/」。
判据66：自产台的 slug 字段不得为空。
判据67：内置类型 market-app 必须存在于类型库。
判据68：server/src/index.ts 必须包含发布路由「/api/apps」。
判据69：server/src/db.ts 必须包含版本快照表「app_versions」。
判据70：自产台表中至少发布了 1 个应用。
