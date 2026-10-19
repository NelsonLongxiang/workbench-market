workbench-market 开发验证器 v3（闭集判定 + 封装提交物）

判定面：SQLite 快照与封装提交物目录，二者均由 scripts/make-submission.mjs 生成：
快照 tmp/verify-snap.sqlite 来自活库的一致性副本；提交物目录 tmp/submission 从仓库根
抽取 README.md、design-system/ 全量、evidence/e2e_test.py 与 evidence 下全部 PNG。
命令执行型检查（typecheck、lint、build、e2e）不属于本闭集，由开发流程自行执行；
以下 9 条判据全部可机械判定：

判据一：类型库中的工作台类型不少于 8 个。
判据二：内置类型 web 必须存在于类型库。
判据三：巡检设置必须包含 health_interval_seconds、health_timeout_ms、health_concurrency 三个键。
判据四：工作台表中至少注册了 1 个工作台。
判据五：每个已注册工作台的 enabled 字段必须等于 0 或 1。
判据六：封装提交物必须包含 README.md。
判据七：封装提交物必须包含 design-system/workbench-market/MASTER.md。
判据八：封装提交物必须包含 evidence/e2e_test.py。
判据九：封装提交物 evidence 目录下的 PNG 截图证据不少于 10 张。
