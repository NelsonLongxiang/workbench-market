# YGL 待办来源的 PostgreSQL 迁移候选

本切片只覆盖工作台的 **YGL 待办来源**及 YGL 内置表的迁移/核对工具。它不会把工作台自身数据库、Lifecycle 插件数据或其他独立工作区自动迁入 PG；没有运行环境切换，也不代表生产迁移完成。已有工作区彼此独立，不能按时间戳静默合并。

## 数据源配置

- `YGL_HOME` 必须是明确的绝对工作区目录，PG 工作区中不能有 `ygl-trees.db`。
- `YGL_DB_URL_FILE` 若已设置则优先，文件键为空或文件不可读/空时拒绝；否则才读取 `YGL_DB_URL`，该键显式为空或无效时拒绝。任何这些错误均不回退 SQLite；只有两个键都未设置时，才保留旧 SQLite 读取兼容。
- `YGL_BIN` 应是支持 PG 项目及任务读取的明确 CLI 入口。数据库 URL 仅通过环境或受保护文件传递，不放入命令参数、日志或提交。
- 授权绑定数据库目标身份；SQLite 到 PG 或切换到其他目标后不沿用旧项目 grants。由持权管理员按真实主体、项目和期限授权，不自动播种授权。

## 快照与迁移工具

`scripts/ygl-pg-migrate.mjs` 支持 `snapshot`、`migrate` 和 `verify`：只读源库并创建受保护的一致快照；迁入显式指定、原本为空的 PG 数据库；按表比较行内容摘要并检查 schema 与序列。`migrate` 与 `verify` 均将目标 catalog 与钉定 YGL 迁移模块对应、随本改动一同送审的独立 schema 基线比较，不以待验证目标自身首次生成的指纹充当基线；未知模块拒绝，外键、列、索引等结构漂移拒绝。它不提供覆盖已有库、双写、自动消费者切换或隐式合并。

`snapshot` 要求源 SQLite 文件、全新输出目录和已构建 YGL 引擎的绝对路径；输出的父目录必须已存在，且输出不能处于源文件所在工作区或其符号链接、bind 挂载等物理别名内。`migrate`/`verify` 使用受保护的 `YGL_MIGRATION_PG_URL_FILE`（优先）或环境变量、明确的目标身份摘要、快照目录及全新报告路径；目标 URL 不能放进 argv。快照是为恢复保留的旧数据副本，不是新的生产写入源。

目标身份按声明的 host/port/database 归一化：连接前把 URL 固定到身份摘要所声明的显式端口（省略端口即钉为 5432），使环境里的 PGPORT 之类变量无法改变实际写入端点；连接后再用 inet_server_port() 复核实际端点与声明一致，不一致即拒绝。目标必须显式给出 host；数据库名若含百分号编码的保留字符（驱动 decodeURI 与身份摘要的 decodeURIComponent 解码不一致，同一摘要可对应两个真实数据库），直接拒绝，不尝试猜测。

来源存在未登记表、触发器、视图或不支持的插件数据时，工具拒绝静默遗漏。Lifecycle 的 `lc_*` 插件状态须由其专用迁移方案处理；工作台自身持久层需另行适配。切换后若 PG 已产生新写入，不得直接指回旧 SQLite；先停写并按已验证的 PG 恢复方案处理。

## Schema 基线与安全边界

内置基线来自精确 YGL `a9f6ae4db2365de327b052db5af213e8b44704d8` 的编译后 `pgsync.js`（仅归一化 CRLF）；在全新隔离 PG14、15、16、18 用上游迁移 DDL 生成，PG18 的 NOT NULL catalog 表示不同，因此有两种候选指纹。其他版本只有实际 catalog 与所钉指纹一致时才可通过，不能由此推断整套引擎已在该版本验收。引擎迁移模块变更后先在隔离数据库重建基线、审查变更，再更新代码；不得从待验证的业务目标捕获指纹后自行当作可信基线。

核对覆盖列顺序、类型、默认值、约束及其有效/强制状态、索引定义与有效状态、表的持久性/复制身份、序列选项、触发器（含被关闭的内部外键触发器）、规则、策略和用户 schema 等；验证事务持有目标表只读锁到核对结束。它不证明 PG 角色授权、对象所有权、备份恢复、部署运行配置或目标在核对后永不发生变更，正式切换仍须按既有流程停写、保护基线并单独验收。报告仅保存 catalog 指纹和各类对象数，不保存任意目标 DDL 原文。

Windows 的 chmod 不能证明输出 ACL 私密：测试会明确跳过 POSIX mode 断言，部署者须单独验证受保护目录/文件 ACL。

## 工作台本体的原生 PG 缺口

YGL 来源候选不改变市场本体的 `DatabaseSync` 启动路径。市场认证/授权、提交数据与文件元数据、SOP、任务发布与事件事务仍在 SQLite；不能用空白 PG 代替原有数据或宣称已经完成唯一生产写入源切换。原生适配仍需明确事务连接归属、ID/RETURNING、SQLite 方言和触发器的等价实现，以及持久态和 Redis 已确认热态的保全/恢复。

第一块准备性改动仅让 SOP checkpoint 协调器接受异步持久化结果：首次/强制 checkpoint 在提交完成前不发布成功，失败保留先前已确认状态，定时重试和关闭均等待持久化完成；读取恢复热态与 A2A note 调用方同时 await。所有修改状态的操作沿用每 run 的 serial 队列。测试使用可控 Promise 验证提交/拒绝/关闭顺序，不以模拟结果冒充真实 PG 事务验收。

这不引入 PG 驱动、不改市场数据库选择、不解决冷进程未访问热态的恢复，也不消除现有 30s 热写窗口。迁移前仍须保护 SQLite/WAL 与 Redis，并在原身份下核对全部已确认热态；更改 DATA_DIR 或启动一个未读 run 的进程再优雅退出，不是热态已经落盘的证据。附件字节存储范围仍须业务确认，不默认删改原文件。

### PG 事务连接基础层（未接入运行入口）

`server/src/pg-transaction.ts` 注入兼容 pg 的 pool，单次事务只 checkout 一条连接，BEGIN/业务查询/COMMIT/ROLLBACK 均绑定该连接；不使用 pool.query 拼事务。callback 或任一查询失败（即使被 callback catch）都不返回成功，回滚失败和提交结果不确定时销毁连接，不自动重试或重放。查询 scope 在 callback 结束后过期，已发出的异步查询完成后才提交或回滚。callback 只接受可信服务端原生 PG SQL，不是 SQL 防火墙；不得自行提交事务或传入不可信 SQL。

本层不读取数据库配置、不导入 db.ts、不装载 SQLite，也没有接入市场启动或领域服务。`node scripts/pg-transaction-test.mjs` 用确定性注入检验生命周期；`scripts/pg-transaction-integration.mjs` 须显式给出本机已有的两个 sha256 镜像，自动创建 nonce 标记的内部网络、tmpfs PostgreSQL/SCRAM 与一次性 runner，拒绝 URL/host/生产目标参数，不发布宿主端口，结束核身份清理。runner 用测试镜像已有的 pg 驱动执行当前源码，因此不是该镜像本身通过新版验证，亦不代表原生领域迁移/部署完成。真实延迟约束提交失败只证明这一失败分支，不替代网络断开时提交结果不确定的恢复验证。

### SOP 原生持久层切片（未接入 HTTP）

`server/src/pg-sop-runs.ts` 提供显式全新表 bootstrap 和注入 pool 的 create/byId/checkpoint/saveStep/finish。schema 只覆盖 sop_runs 的既有 11 列；ID 与 cache_revision 为受 JS 安全整数范围限制的 bigint，数据保留 TEXT JSON 字节、时间保留 UTC 文本形状。status/版本/整数范围比旧 SQLite 更严格：不兼容历史值必须由未来导入预检点名，不能静默丢弃。bootstrap 遇既有对象即失败，DDL 同事务，不用于覆盖或原位迁移。

数据/状态 UPDATE 触发器以 OLD.cache_revision+1 生成新代号，同值写也失效旧缓存；保存与完成使用行锁+显式 expected generation，多个进程写同一旧代号最多一个成功。完成同时落数据/状态/时间，不可把归档重新打开；调用者提供的修改值在首个 await 前序列化；create 的 slug/version/startedBy/uploadToken 在校验前一次性读取局部快照，事务 callback 不再跨 await 重读可变输入。私有 byId 返回内部完整行（含 upload_token），不得直接用于未授权 API。认证/能力、SOP manifest/字段校验、附件与归档 outbox 事务尚未接入，本层不代替这些业务门禁，也不恢复 Redis 热态。

同一隔离 PG runner 可执行 `scripts/pg-sop-runs-test.mjs` 的真实并发、版本号、同值写、归档与触发器失败/DDL失败回滚测试；不代表生产数据保全、完整 schema 转换或最终镜像验收。

### SOP 持久态与已确认热态的离线核对计划

`scripts/sop-preservation-plan.mjs` 是纯数据函数，不连接 Redis/数据库、不读取文件、不采集生产数据，也不写入 PG。输入必须由另行授权、停写/冻结且完整的采集提供：原进程使用的 DATA_DIR 精确字符串、11 列 SOP 行和逐 run 的完整 `__wm_snapshot_v2` 原文。它不能证明输入真实性、完整性、冻结成功或备份恢复；空输入也只是空计划，不能代表现网没有数据。

核对使用现有运行时的原 checkpoint 公式，不能用还原目录替换原身份。只有 running 非 task-center 行、完整且同身份/版本/代号/主体的热快照才按现有读取语义合并；旧代号、孤儿、重复、已完成或 task-center 热态、未知列/信封字段、非法值一律拒绝规划，保留给数据核对，不静默丢弃。拒绝不意味着生产已丢数据，也不要求把正常过期缓存恢复成业务值；后续需依据冻结捕获的持久态及确认记录消解。

输出分私有行（含 upload_token 与实际数据，必须受保护）和仅含 run ID/选择/计数/摘要的 summary；summary 绑定原行、原热快照与选择结果。该计划不修改代号/时间、不生成旧源写入，不代表跨表引用、序列、权限、文件字节或 Redis+SQLite/WAL 已保全。`node scripts/sop-preservation-plan-test.mjs` 只跑合成输入，不宣称真实采集或恢复验收。

### SOP-only PG 导入原语（内部注入，无生产 CLI）

`scripts/sop-preservation-import.mjs` 从纯核对计划重新生成私有行；调用者须先独立验证 PG 目标/schema/角色并冻结完整授权采集，本函数不解析 URL/凭证、不建立目标连接，也不承担这些外部验证。只锁定已初始化的 sop_runs 空表（ACCESS EXCLUSIVE），检查列集合，原 ID/数据/时间/令牌/代号逐列参数化插入，事务内读回全部选中字段摘要，禁止覆盖非空目标。它不验收完整 catalog/权限或其他表，不能脱离前置条件当通用生产迁移器。

identity 用事务性 ALTER COLUMN RESTART（不使用不可随事务回滚的 setval），在插入前执行，避免 PostgreSQL pending deferred trigger events 阻止 ALTER。延迟约束在 COMMIT 才拒绝时，行和序列重置均回滚；成功提交后新 ID 从导入最大 ID 后开始。调用前输入会被复制为纯值，后续调用者修改不影响已选材料。回执只有计数/选择/摘要；底层 PG 错误可能包含私有 detail，异常必须留在受保护诊断，不得直接发给外部 API。

隔离合成测试覆盖原绑定热态保留、逐列读回、导入后继续写入、非空目标/并发导入拒绝、行失败/读回差异/延迟 COMMIT 拒绝及序列回滚；这不是 SQLite/Redis 实际冻结采集、跨表迁移或 pg_dump/restore 灾备恢复证明。市场运行入口、完整身份权限与回执事务仍未切到 PG。

## 验证范围

迁移回归的无效目标用例自行构造旧格式的声明摘要，不调用会提前拒绝该目标的新引擎来生成测试输入；按实际引擎拒绝顺序核对稳定错误码与失败报告，并用 Socket 正控证明空 host/歧义库名在连接前拒绝。另用旧身份函数测试本地守卫，避免新引擎的先拒绝掩盖迁移工具自身回归。

`node scripts/ygl-task-source-test.mjs` 检查配置、目标身份和失败不回退；`node scripts/tasks-read-authority-http-test.mjs` 以合成身份验证读取范围。`scripts/ygl-task-pg-integration.mjs`、`scripts/ygl-pg-migrate-test.mjs` 和直接调用上游 DDL 的 `scripts/ygl-pg-catalog-baseline-test.mjs` 需要显式的隔离 PG 和测试引擎；测试临时数据库和种子不得指向生产或个人工作区。

上线须对最终整合提交和实际配置独立评审，按既有迁移/备份/恢复方案核对，再做真实业务回读；单项合成测试、健康检查或空任务列表均不代表全量迁移完成。
