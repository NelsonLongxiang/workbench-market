# 架构图来源与状态边界

本文与[可编辑架构图](./workbench-market-arch.drawio)一起维护。2026-11-05（Asia/Shanghai）更新：新增固定源码结构页与 PG 候选证据页，原三页仅在页名加“历史记录”，其 mxGraphModel、节点／边和几何字节序列化结果与更新前完全一致。

## 视图如何阅读

1. **01 源码结构快照·199cd760**：固定在 `199cd760e736cbe69cfc9836c58d533c30e4e993` 的源码关系，简化为接入、身份、领域服务、持久层及扩展能力。它不是运行时拓扑或当前生产镜像清单，也不声明所有可选开关已开启。
2. **02 PG候选·未集成边界**：把工作台自身持久层、待办来源、PG 目标和联合测试覆盖区分开。黄框为目标或隔离候选，红框为待整合／未覆盖；箭头用于表达依赖或证据关系，不表示已执行生产切换。
3. **历史记录三页**：保留原架构、SOP 隔离候选与 SOP 状态候选的历史布局。旧工具数、旧模块或历史状态不应当作当前事实；本次没有借加图重判旧测试或删除历史。

蓝／绿框表达固定源码结构；紫框表达身份或部署扩展；实线为源码调用／数据流，虚线为可选耦合、目标或证据关系。

## 1. 固定源码依据

来源仓库：[workbench-market](https://github.com/NelsonLongxiang/workbench-market)，完整 pin：[`199cd760e736cbe69cfc9836c58d533c30e4e993`](https://github.com/NelsonLongxiang/workbench-market/tree/199cd760e736cbe69cfc9836c58d533c30e4e993)。从 GitHub Git blob API 读取文件，重算 Git blob SHA-1 与 API 对象一致。未根据旧本机检出的代码推断新主线，也未请求生产数据。

| 图中关系／范围 | 源码位置 | 说明 |
|---|---|---|
| 待办 API 先判读权限，再取授权来源 | [index.ts:2178–2191](../server/src/index.ts#L2178-L2191) | 扩展来源也按查看人身份收集，宿主不以管理员代取。 |
| 领域服务和部署扩展 | [extensions.ts](../server/src/extensions.ts)、[index.ts:2213–2224](../server/src/index.ts#L2213-L2224) | `WM_EXTENSIONS_DIR` 显式挂载；图中虚线不证明具体私有扩展在测试或生产中已加载。 |
| 浏览器登录 origin 与内部身份／代理源分离 | [odoo-browser-origin.ts](../server/src/odoo-browser-origin.ts)、[portal.ts](../server/src/portal.ts) | 只对所配置内部登录源替换浏览器目的地；Host 和 HTTPS 信号只收窄拒绝，不能自选新目的地。未配置时保持原行为；不是同域登录中继的等价物。 |
| 工作台自身数据库 | [db.ts:1–13](../server/src/db.ts#L1-L13) | `node:sqlite` 与 `workbench-market.db`；LC／YGL PG 成果不能替代工作台自身数据迁移。 |
| 内置 ygl 待办来源 | [tasks.ts:77–145](../server/src/tasks.ts#L77-L145) | 该固定源码要求专用 `YGL_HOME` 和工作区数据库，调用 CLI；PG 待办来源仍属右页候选，不将其画成这份主线已经实现。子进程环境继承行为不等于已发生外泄。 |
| SSO 票据与状态 | [sso-ticket-store.ts](../server/src/sso-ticket-store.ts)、[odoo-session.ts](../server/src/odoo-session.ts) | `DELETE … RETURNING` 保留共享库票据原子消费；过期清理／匹配另在调用链。来源计数再写入是多步操作，本图不声称并发签发配额已被原子验证。 |
| SOP 热态到 SQLite 的检查点 | [sop-state-checkpoints.ts](../server/src/sop-state-checkpoints.ts) | 按 run 串行及实际写入期限；图中 Redis／LayerFS 是独立基础设施角色，不声明当前健康或部署状态。 |

以下 Git blob 身份对应上述固定 pin；后续文件行号可能随版本改变，复核应优先按完整 pin，而非可变 main：

| 文件 | 固定 Git blob |
|---|---|
| [workbench-market-arch.drawio](../docs/workbench-market-arch.drawio) | `32de9c257d975d84ce06757b8e0386c59d54fa8a` |
| [db.ts](../server/src/db.ts) | `914d48cfd0cb532a5889b62d7b3192d3c740aa60` |
| [index.ts](../server/src/index.ts) | `192ac2dd89b2091bef09f08b09a7d1960f500cc3` |
| [tasks.ts](../server/src/tasks.ts) | `5888fc4f542a54bb0966a8032047ccfd97f3f92b` |
| [extensions.ts](../server/src/extensions.ts) | `ee0d29f67bb29718c7b9733a18dd4876a6204a73` |
| [portal.ts](../server/src/portal.ts) | `7bb5fc6ace9f0b054c76aa79e7b9e4bdef2244fc` |
| [odoo-session.ts](../server/src/odoo-session.ts) | `943cc10afc00454467c015c378b2dad2560638e3` |
| [odoo-browser-origin.ts](../server/src/odoo-browser-origin.ts) | `234386740a0dd5956f218f803cd6709b20291535` |
| [sso-ticket-store.ts](../server/src/sso-ticket-store.ts) | `6d7f61d0bd51079e4f9a111f6d5d0e656e5a55bf` |
| [sop-state-checkpoints.ts](../server/src/sop-state-checkpoints.ts) | `4978b498713f194f7fb9fdab79416d555f8315e3` |

## 2. 联合候选证据（转述层，非本次复跑）

公开原件已逐条读回：

- [PR #6 评论 6652106806](https://github.com/NelsonLongxiang/yuanguang-lifecycle-os/pull/6#issuecomment-6652106806)：同一进程内 PG 任务来源与合成登录 HTTP **13/13**。
- [PR #6 评论 6652278085](https://github.com/NelsonLongxiang/yuanguang-lifecycle-os/pull/6#issuecomment-6652278085)：在临时 PostgreSQL 15、实际 Chromium 121、合成 Odoo／SID 上 **18/18**。前两轮缺 HTML Content-Type 的夹具错误与失败历史保留，执行方只修夹具后重跑。
- [PR #6 评论 6650228094](https://github.com/NelsonLongxiang/yuanguang-lifecycle-os/pull/6#issuecomment-6650228094)：用户在执行节点选择 PG 唯一写入源，临时空 SQLite 上线步骤取消；这是该节点公开记录，不冒作本次亲见其他会话的用户消息。

联合候选的精确组成：

| 对象 | 固定提交 |
|---|---|
| Workbench 候选 | `07b898973588473be996455a2c1aae758fdf2caf` |
| ygl-trees 候选 | `a9f6ae4db2365de327b052db5af213e8b44704d8` |
| 登录回补文件来源 | `ea64cd44c32aa1185ad525e7737f638134a45910` 的 portal／helper 两文件 |

这些 pin 和运行结果来自原测试记录，本次没有独立重新运行该组合或审计全部候选源码。临时 PG／浏览器／网络已清理、无生产挂载等内容同样是原执行方观测，不改写为本文维护者的现场实测。

**不可省略的边界**：这不是单一集成提交或最终镜像；LC 扩展关闭，市场自身库仍为 SQLite。实际 Chromium 是真实软件，但表单、SID 和业务任务为合成数据，不是实际 Odoo 密码认证或飞书 OAuth。13/13、18/18 都不能当完整生产迁移、真实用户、公网入口、备份恢复或数据保全通过。后续若形成正式整合 SHA，应按该对象单独复审，再更新本页；不把本次图当新增授权或自动部署步骤。

## 3. 图本身的验证与范围

- 两张新增页经 drawio-skill 的结构验证：**0 error / 0 warning**，无节点重叠、穿越节点或连线交叉；原三页模型逐一与固定旧文件核对不变。
- 没有本机 draw.io desktop；使用 diagrams.net viewer 实际渲染器配合本机 Edge 生成预览，检查 SVG 路径、标签及 PNG。修正源码页顶部两标签重叠后再次渲染；PG 候选页的候选／未验范围在图中可见。预览、DOM 和本机验证输出保留在本任务临时目录，不向仓库提交远端脚本、浏览器配置或运行状态。
- XML 可编辑；新增视图不含真实节点 id、运行地址、账号或秘密。不调整服务、不变更数据、不启动替代 GUI，不以文档正确等同系统验收通过。
