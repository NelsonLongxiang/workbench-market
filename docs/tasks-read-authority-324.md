# #324 统一待办读取：身份与来源范围

状态：独立 Draft 实现，不是合并或生产部署授权。现网固定 clean-r1 不受此分支影响。此前匿名可读与共享缓存问题只有新版本实际部署并验收后才算解决。

## 请求入口

GET /api/tasks 在任何私有来源查询前判权：

- 无有效管理员口令、无 Odoo 会话：401 tasks_auth_required，可带可信 Odoo 台的 login_url；不读取市场任务、不执行 ygl CLI、不向 A2A 状态服务发请求。
- Odoo 会话每次向已配置来源现查；失效401、门户或缺内部标记403，身份源故障503 tasks_identity_unavailable。Cookie、X-User、X-Subject、查询参数、MCP工具授权或 run capability 均不能自报整站任务身份。
- 有效管理员口令只由现有 adminHeaderOk 判定；跨源 Origin 或 Sec-Fetch-Site=cross-site 在入口拒绝。管理写继续由 adminGuard 的控制面/本机CLI规则约束，不能用本PR把口令搬回业务页面。
- 所有返回，包括拒绝：Cache-Control: private, no-store；Vary: Cookie, X-Admin-Token。

## 来源与对象范围

| 来源 | 管理员 | 新鲜内部会话 |
|---|---|---|
| market SOP run | 全量任务信封 | 只查既有 sop_run_read_grants 有效的 run；复用 runGrantActive 的最新未撤销授权及到期语义 |
| market 任务中心 | 已发布任务 | 只查 intake_run_id 获 run 读权的任务，不按标题、创建者、started_by或A2A caller推权 |
| 人审请求 | 可见 | 默认不可见，无来源授权不读该表 |
| ygl-trees | 明确配置工作区的全部 active 项目 | 只查单独显式批准的项目，不枚举其他项目 |
| A2A 状态 | 服务已配置时可读 | 默认无权，不查询 |
| lifecycle | 不能凭管理口令冒充Odoo查看人 | 沿用该来源自己的新鲜身份与授权；错误改成稳定码，不透传引擎消息 |

普通内部登录不是整个工作区读取权。没有来源授权时返回空任务及 source_not_authorized，与401未认证区分。run查询在SQL层带ID范围；任务中心在SQL层带intake run范围，不先取全库然后仅前端隐藏。ygl项目名以 --project=<原值> 单个argv传入，无shell，防止形似选项的项目名变成 --home 等参数。

## 显式 ygl 项目授权

新增 task_source_read_grants 仅存 source=ygl-trees、经验证主体 user:<login>、精确project、工作区真实数据库路径摘要、UTC到期、授予人、创建/撤销时间。没有默认授权、通配授权或自动迁移。工作区必须显式绝对YGL_HOME并已有ygl-trees.db；缺失时不回落个人默认库，源返回ygl_home_required。

经既有管理门：

- PUT /api/tasks/read-grants：{subject,project,expires_at}，expires_at 为未来UTC YYYY-MM-DD HH:mm:ss，成功201。无效主体/空项目/通配*/非法或过去时间400且零写。
- POST /api/tasks/read-grants/revoke：{subject,project}，撤销该主体/项目全部未撤销授权，返回数量；后续请求不命中已撤销值。

授权管理必须依据属主或持权管理者确认的真实主体、项目和期限，本PR不替任何现网用户播种授权，不签发新run capability。路径摘要绑定配置工作区路径，不是数据库内容完整性证明，也不声称防止持权本机人员替换同路径文件。

## 缓存、故障与显示

删除 ygl/market/A2A 聚合的30秒共享缓存与共享inflight；每次请求重新判身份/范围并查询，管理员结果不会预热给普通用户。已有 lifecycle 来源的缓存仍按其验证过的sub分区、每次现查会话；本PR不修改其内核授权或TTL语义。

源故障只出稳定错误码（ygl_source_failed、market_source_failed、a2a_source_failed、lifecycle_source_unavailable）和零/部分可用结果；不输出home路径、原始异常、任务正文或凭据。身份/授权表故障拒绝整次请求，不拿旧数据兜底。前端刷新、口令变化、Odoo会话确认、焦点/可见变化时清旧payload、取消旧请求；晚到旧身份响应不能重新填回任务。拒读/故障提示不能当成业务暂无任务，总览未取得数据时显示—而非假0。

## 验证与边界

真实index合成HTTP矩阵先红后绿，涵盖匿名与伪造身份、普通内部用户、显式项目/run授权、并发与前后两用户、管理员缓存污染、过期/撤销、工作区错绑、选项形项目名、最新run授权语义、跨源拒绝、身份源/任务源故障；fake Odoo/CLI/A2A、备用回环端口和新DATA_DIR/home，生产/个人库访问0。

真实React/antd TasksView的8项浏览器断言覆盖登录提示、来源拒绝、凭据变化清旧值、会话确认、旧请求晚到、源故障安全提示及焦点刷新；请求拦截的合成域名，无TCP listener。首浏览器断言后close挂起的原件保留，显式unroute/context.close后正常exit0，不靠扩大超时掩盖。

既有授权调用者迁移为带合成管理员口令，匿名测试仍明确401/403。旧inbox冒烟不再直读宿主ygl-trees清单，改用受控CLI正例与故障对照。项目上限测试在本机node同级已有真实CLI时按原契约SKIP，不把SKIP冒PASS；HTTP矩阵通过拦截真实execFile边界覆盖同一适配器。

未覆盖：没有生产请求/权限迁移；没有完整外部Odoo/生命周期内核部署；没有声称其他公开任务中心接口或#266自产台读取已被本PR收口。审批/合并/上线分别由独立评审和属主决定。

## 本轮判断（提案，未人工认定）

- workbench-market-issue-324-tasks-read-anonymous-response-contract · TASKS-ANONYMOUS-RESPONSE · A：401且不查询私有源 · ctx=decision:issue #324允许401或空；协调原链direct-3a407124第2项。
- workbench-market-issue-324-tasks-read-private-source-cache-strategy · TASKS-PRIVATE-CACHE · A：移除聚合缓存 · ctx=decision:issue #324允许分区或不缓存；既有collector为30秒共享缓存。

两条均pending，不充当已认定规则；性能代价、长期来源授权产品形态与同路径工作区替换仍是边界，不写成已解决。
