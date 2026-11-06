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

### 合成 SOP-only 逻辑备份恢复演练

`scripts/pg-sop-backup-restore-test.mjs` 仅由一次性 PG 夹具调用：在已核 nonce/镜像身份的 tmpfs 容器内，用非超级用户所有者执行 pg_dump custom 格式，记录大小和 SHA256，再恢复到同实例另一个全新隔离数据库。比较全部行/私有字段、列定义、版本触发器和序列状态，恢复库中新建 ID 与同值更新也要验证；源库前后摘要不得改变，截断归档必须拒绝。归档仅存在本次容器 tmpfs，清理即消失，不是长期留存的生产备份。

这是合成 SOP-only 的逻辑格式/恢复行为证据，不是 #402 G1 的生产全量备份，不覆盖其他市场表、Redis/WAL 热态冻结、附件字节、角色/权限恢复、异机灾备、PITR 或真实网络丢 COMMIT 恢复。生产 G-pre 未满足时不通过该演练宣称生产门槛通过。

### 原生 PG settings 存储（未接入配置/认证调用链）

`server/src/pg-settings.ts` 为 settings(key,value) 提供显式新表 bootstrap 与注入 pool 的 get/has/all/put/putMany/delete；不提供同步 Statement 替身、不播种默认值、不读取生产配置、不回退 SQLite。空值与缺键分开，原始文本参数化保存；返回可能含敏感设置，只允许内部调用，不直接暴露给 API。批量输入在 checkout 前复制校验，拒重复键和非法文本，按键排序同连接事务写入，失败整体回滚，不自动重试。

隔离专项验证原子批量失败回滚、参数等待快照、并发写、初始非法零 checkout、schema冲突及缺键/空值，并将合成 settings 行纳入 pg_dump/pg_restore 读回。SOP 旧负例测试曾一次性创建三个拒绝 Promise 后逐个观察，可能提前触发 unhandled rejection；现改为逐个创建并立即 await 同一精确错误断言，不修改产品逻辑或弱化判据。设置服务原有同步调用方、认证启动、缓存失效与历史 settings 导入尚未接入，不代表市场已改用 PG 或已迁移私有配置。

### 原生 PG 工作台登记存储（未接入 API）

`server/src/pg-workbenches.ts` 明确创建 workbenches 20 列候选表，保留 cookie_set_id 与 auth_config；提供 create/byId/list/全字段编辑/健康结果写入。输入原始值在 checkout 前复制校验，整数受安全范围限制，健康写仅更新探测列、编辑不覆盖探测结果。API 准入、URL 校验、认证与凭据治理、类型/按台 Cookie 引用和删除级联仍归未接入的上层，不因存储层接受文本就放宽业务授权。完整行含私有 auth_config，不可直接返回公共 API。

候选 bootstrap 不播种、不接受既有表碰撞，不做历史导入；部分约束较旧 SQLite 严格（如 enabled 与整数范围），未来导入必须先核历史差异，不能遗漏或强制改写。隔离测试核创建/编辑/探测跨等待快照、探测与编辑并发互不擦除、失败无半写、SQL参数化、排序及schema碰撞；合成登记行加入逻辑备份恢复读回，不是全市场关系或生产恢复证明。

### 原始 settings 空目标导入（内部原语）

`scripts/pg-settings-import.mjs` 接受独立授权冻结采集的 key/value 行（仅这两列），原始字符串在首 await 前固定，重复键/非法文本/未知列直接拒绝。目标/schema/角色及完整采集须由调用者独立核实；无 URL/凭证解析、源文件读取或 CLI。仅锁已初始化 settings 空表并按原字节插入，不用 upsert、默认播种、秘密过滤或解密，事务内全量读回不一致则回滚。

回执不列键、值或逐秘密摘要，仅计数和全集摘要；全集摘要仍非匿名保证或签名，审计材料应受保护，底层 PG detail 不可外露。隔离测试覆盖空字符串、中文、__proto__ 字面键、SQL形状参数、输入等待快照、非空/重复拒绝、行/trigger读回/延迟COMMIT失败回滚和并发单一胜者，导入后的合成设置纳入真实逻辑恢复比较。历史私有设置未实际采集/迁移，且认证、启动配置与跨表一致性仍未接入，不构成生产迁移或恢复门槛通过。

### 原始登记 20 列空目标导入（内部原语）

`scripts/pg-workbenches-import.mjs` 接受独立完整冻结采集的原始 20 列，不从运行默认值重造旧登记。原 ID、auth_config、cookie_set_id、时间、健康结果和允许的 NULL 原样保留；精确列集合、重复 ID、必填文本和整数范围在首 await 前预检，不能满足 PG 候选约束的历史值明确拒绝，不静默强转或省略。目标/catalog/角色与完整 capture 必须另核，无 URL/凭证解析、源采集或 CLI。

仅锁空 workbenches 表，事务性 identity RESTART 在参数化插入前执行，全 20 列读回摘要一致后才提交；非空/未知列/trigger改值/延迟约束拒绝均回滚，回执仅计数、全集摘要及下一 ID，不列名称/URL/凭据/逐字段摘要。原始 SQL 错误留受保护诊断。该导入只保留 cookie/type 的引用值，不证明对应对象或 vars/cockpit/权限引用已迁；未来必须跨表核对，不能在独立导入后直接切生产。合成导入登记也参加逻辑恢复比较，不是生产全量恢复或历史数据已迁证明。

### 原生 PG 变量/常量与原子审计（未接 HTTP/MCP）

`server/src/pg-workbench-vars.ts` 以 workbench_vars + workbench_var_audit 显式新表实现创建、读取、按 revision 更新/删除以及同事务值摘要审计。更新必须给代号，旧代号拒绝；既有常量改/删须显式 override 且可信 caller.admin，既有键改 kind 只限管理员。actor/admin/value/原因等在 checkout 前固定；每台先锁父 workbenches 行，序列化新键与 512 键配额，数据或审计任一失败则一起回滚，不自动重试。

该模块的 caller 是内部可信身份结果而非可由请求者自报的权限；工作台访问准入、Cookie/Odoo/MCP 主体映射仍须上层独立认证授权，本切片没有接入，不能称安全门已经迁移。审计仅记 value 摘要而非原值，但仍含 actor/键/原因及可猜值摘要，受保护读取；变量全值读取也不可直接对匿名返回。该版本未覆盖历史常量属主回填/未来主分支规则演进、变量/审计历史导入或删台级联，schema约束差异必须迁移预检，不按当前空表重造历史记录。

隔离测试覆盖并发代号单胜、常量限制、kind修订、actor快照、配额竞争、create/update/delete审计失败整体回滚；合成 vars/audit 与其他已覆盖表共同参加逻辑恢复逐行比较，不代替完整市场恢复。

### 变量与审计历史双表导入（内部原语）

`scripts/pg-vars-import.mjs` 原样保留变量 value/kind/revision/updated_by/时间及审计 ID/action/actor/hash/原因/时间；不回填属主、不重新计算旧审计摘要、不补造丢失历史。首 await 前固定原列和值，未知/重复/非法整数或 JSON 拒绝。目标/catalog/角色及完整授权冻结 capture 仍须独立核实，无源采集/URL/CLI。

事务先锁父 workbenches，再锁空 vars/audit 两表；当前变量须能引用已导入父登记，历史审计允许对应对象已删除，不能为“消孤儿”丢审计。原 ID 参数化导入、audit identity 事务性重置、双表完整读回摘要，任一行/读回/延迟 COMMIT 失败整体回滚并恢复序列。回执仅计数和全集摘要，仍为受保护审计材料。该切片不验证历史审计链真实性、owner回填、quota合规或完整跨表迁移；真实数据尚未读取，不能据合成回归与逻辑恢复放行生产。

### 原生 PG 表单提交存储（未接 HTTP/MCP）

`server/src/pg-app-data.ts` 以原 app_data 七列候选表和同台非空幂等键部分唯一索引实现 submit/page/softDelete。序列化参数在首次 await 前固定；并发同键 insert-on-conflict 等待胜者后以独立 READ COMMITTED 查询读回，按原序列化 JSON 精确字节判断 duplicate/conflict。无幂等键可重复提交，软删行不在列表返回，但仍占原幂等身份，重试不复活或重造。ID/分页参数受安全整数与上限校验。

这只是内部存储，不判断 app 是否存在/发布、调用身份/数据契约/附件引用，也不记录投递事件；生产 submit 的 contract 检查和事件/outbox事务尚须整合，未接入之前不改变现有服务。原行数据是私有内部材料，底层 PG detail 不可直接发 API。合成测试覆盖幂等竞争/冲突/空键/跨台隔离、软删重试、参数快照、提交失败与恢复读回；历史 app_data 导入、完整事件关系与实际业务路径仍未实现。

## 验证范围

迁移回归的无效目标用例自行构造旧格式的声明摘要，不调用会提前拒绝该目标的新引擎来生成测试输入；按实际引擎拒绝顺序核对稳定错误码与失败报告，并用 Socket 正控证明空 host/歧义库名在连接前拒绝。另用旧身份函数测试本地守卫，避免新引擎的先拒绝掩盖迁移工具自身回归。

`node scripts/ygl-task-source-test.mjs` 检查配置、目标身份和失败不回退；`node scripts/tasks-read-authority-http-test.mjs` 以合成身份验证读取范围。`scripts/ygl-task-pg-integration.mjs`、`scripts/ygl-pg-migrate-test.mjs` 和直接调用上游 DDL 的 `scripts/ygl-pg-catalog-baseline-test.mjs` 需要显式的隔离 PG 和测试引擎；测试临时数据库和种子不得指向生产或个人工作区。

上线须对最终整合提交和实际配置独立评审，按既有迁移/备份/恢复方案核对，再做真实业务回读；单项合成测试、健康检查或空任务列表均不代表全量迁移完成。
