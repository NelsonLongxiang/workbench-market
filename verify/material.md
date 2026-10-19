workbench-market 开发验证器 v4（全面覆盖矩阵）

判定面：SQLite 快照与封装提交物目录，二者均由 scripts/make-submission.mjs 生成：
快照 tmp/verify-snap.sqlite 来自活库的一致性副本；提交物目录 tmp/submission 从仓库根
抽取根清单、server 与 web 源码树、构建产物、脚本、验证器自举档案、设计规范与证据。
命令执行型检查（typecheck、lint、build、e2e）不属于 CLI 闭集，由开发流程自行执行；
覆盖三个维度共 35 条判据：数据域完整性（判据1-9）、种子与配置（判据10-15）、
提交物结构（判据16-35）。以下判据全部可机械判定：

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
判据24：封装提交物 web/src/pages 目录下的页面组件不少于 5 个。
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
