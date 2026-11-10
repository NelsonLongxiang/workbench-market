# 架构图来源与状态边界

本文与[可编辑架构图](./workbench-market-arch.drawio)一起维护。2026-11-06（Asia/Shanghai）本轮更新只增两张固定来源视图，原五页均保留为历史；历史 mxGraphModel、节点／边及几何不变。图是源码与证据边界说明，不是实时生产拓扑、完整验收或新实施授权。

## 1. 三个对象不可混用

| 对象 | 固定提交 | 图中含义 |
|---|---|---|
| 当前主线源码快照 | [`4d15961ef5ce874e6e957ba058ff535783ec3f14`](https://github.com/NelsonLongxiang/workbench-market/tree/4d15961ef5ce874e6e957ba058ff535783ec3f14) | 第1页；tree `d11cdc5c66ecda192d6e97d51745d1c65f5e197d`。不表示生产运行该提交。 |
| PR #438 候选源码 | [`c30f0360013f227292bd9030c1ba8789952be6a6`](https://github.com/NelsonLongxiang/workbench-market/tree/c30f0360013f227292bd9030c1ba8789952be6a6) | 第2页；tree `4404f351da245f712652da02cb775146e4ce836f`。原生PG准备API与离线工具未接入市场运行入口。 |
| 部署取证请求 | [`e70adfccf29cad3c04c401db8485c7f7774cb0c8`](https://github.com/NelsonLongxiang/workbench-market/tree/e70adfccf29cad3c04c401db8485c7f7774cb0c8) | 独立取证单，不是上述主线／候选SHA的替代。G-pre未满足，见下述公开原件。 |

旧 `966d1a2` 部署请求已被[改钉说明](https://github.com/NelsonLongxiang/workbench-market/pull/402#issuecomment-6664144413)作废。图中三个对象不能互相证明已部署、已保全或已获全局放行。

## 2. 视图阅读

1. **01 主线源码结构·4d15961**：沿用上一版稳定节点与布局，更新源码关系。蓝色为服务，橙色接入，紫色身份／扩展，绿色自身持久层，灰色独立来源。实线为源码关系，虚线是可选耦合；不表示所有开关已开启、外部服务当前健康。
2. **02 原生PG准备与未接入边界·c30f036**：左侧为注入式事务及SOP store，中部为给定材料的离线计划／SOP-only导入，右侧明确未接入、局部证据与取证限制。图不把YGL任务来源PG支持等同市场本体已迁。
3. **历史五页**：保留199cd760源码页、旧PG混搭试验页与原三个历史设计页。旧pin、工具数、隔离结果均只在其历史范围内成立，不能当作当前状态。

## 3. 主线固定源码依据

| 图中关系 | 精确源码 | 解释 |
|---|---|---|
| 市场自身持久层 | [db.ts:1–13](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/db.ts#L1-L13) | `node:sqlite`、DATA_DIR、WAL与workbench-market.db；不是PG运行入口。 |
| 待办先授权后聚合、显式扩展 | [index.ts:2317–2375](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/index.ts#L2317-L2375)、[extensions.ts](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/extensions.ts) | 只查询该主体授权来源。WM_EXTENSIONS_DIR显式加载；图不证明某私有扩展当前加载。 |
| 主线内置YGL来源 | [tasks.ts:77–144](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/tasks.ts#L77-L144) | 仍要求专用YGL_HOME中的SQLite文件身份并调用CLI；候选PG来源身份不能倒画为这份主线已实现。 |
| 浏览器与内部Odoo源 | [odoo-viewer.ts:21–48](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/odoo-viewer.ts#L21-L48)、[portal.ts:32–40](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/portal.ts#L32-L40)、[浏览器地址说明](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/docs/odoo-browser-origin.md) | 显式同源登录中继开启时优先；否则可选可信浏览器origin。身份现查与已登录代理仍走内部配置源。不是实际密码／飞书认证验收。 |
| 门户带路径跳转防护 | [portal.ts:303–342](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/portal.ts#L303-L342) | 只拒绝路径段匹配的自增长循环，不是一概拒绝所有base外跳转；普通base外跳转保留原契约。 |
| 热态读取与严格完成边界 | [index.ts:1762–1786](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/index.ts#L1762-L1786)、[redis.ts:101–115](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/redis.ts#L101-L115) | 已确认热态可能尚未落盘。读错，或严格完成／升级时配置Redis不可用，会503而非静默当空。 |
| 同步checkpoint与候选差异 | [主线checkpoint](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/sop-state-checkpoints.ts)、[主线写适配器](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/index.ts#L1762-L1764) | 主线仍是同步写契约；候选异步提交准备不能外推主线已具备。 |
| SSO票据与独立基础设施 | [sso-ticket-store.ts](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/server/src/sso-ticket-store.ts)、[部署Dockerfile](https://github.com/NelsonLongxiang/workbench-market/blob/4d15961ef5ce874e6e957ba058ff535783ec3f14/deploy/Dockerfile.market) | 保留原子take；扩展构建上下文、secret、实际Compose必须另核，图未读取生产配置。 |

## 4. PG候选的可见进展与剩余接线

候选的[db.ts:1–13](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/db.ts#L1-L13)仍是SQLite；[运行index](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/index.ts)没有导入原生事务／SOP存储模块。候选[YGL来源解析](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/ygl-task-source.ts)显式区分后端及身份，不能等同市场自身库已切PG。

- [pg-transaction.ts](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/pg-transaction.ts)：注入pool、同checkout事务、scope过期、已发查询drain、错误poison、提交失败销毁且不重放。不是SQL防火墙，不证明真实网络丢COMMIT后的恢复。
- [pg-sop-runs.ts](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/pg-sop-runs.ts)：显式新表bootstrap，只覆盖SOP既有11列；行锁+expected revision+UPDATE触发器。内部byId含token不可直接暴露。c30修复create校验值跨await漂移。
- [异步checkpoint](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/server/src/sop-state-checkpoints.ts)：提交完成前不ACK／清状态，拒绝恢复和关闭等待；只是接口准备，实际服务仍同步，未解决冷进程未访问热态或30秒窗口。
- [sop-preservation-plan.mjs](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/scripts/sop-preservation-plan.mjs)：纯数据计划，不采集文件／Redis／DB。原DATA_DIR身份、完整durable/hot输入由授权冻结capture提供；不匹配／孤儿／stale等要求核对。私有行含数据和token需保护，summary仅摘要。
- [sop-preservation-import.mjs](https://github.com/NelsonLongxiang/workbench-market/blob/c30f0360013f227292bd9030c1ba8789952be6a6/scripts/sop-preservation-import.mjs)：空表独占锁、11列参数化、事务内digest读回及事务性identity RESTART。前提是独立验证目标schema／角色／身份与完整授权capture；不是跨表／文件／ACL或灾备证明。

仍未接入HTTP/auth/cap/manifest/字段与附件、回执outbox、全域服务及Redis恢复，也未完成全部历史数据／序列／触发器／权限等完整迁移。图不把只覆盖SOP表的候选画成整个市场PG-only。

## 5. 候选局部证据：按精确SHA，不移植PASS

以下公开原件均已读回；结果是本维护会话此前独立评审，不是本次画图时重新跑全套系统。

| 精确范围 | 原件与正式run | 含义／限制 |
|---|---|---|
| 异步checkpoint·622fb59 | [评审](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6678892998)，run_26d2fc9568127848（13/13） | 准备切片，不证明真实PG事务或未访问热态恢复。 |
| 事务基础·2f06e75 | [评审](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6679107440)，run_357ba1280aa34984（9/9） | 同连接生命周期；网络断开COMMIT结果恢复未验。 |
| 创建参数旧P2·a3178d9 | [FAIL](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6679291351)，run_250b8de3a626034e（3PASS/4FAIL） | 旧结果保留不改写。 |
| 离线计划·22f6cfa | [评审](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6679484172)，run_04c7811cbe24dc2a（5/5） | 只验给定材料规划，不证明输入真实性、完整性或实际冻结。 |
| SOP-only导入·d8a6ed3 | [评审](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6679641920)，run_af38e3c03293ec7c（6/6） | 显式前置下SOP表原子导入；非全量恢复。 |
| 原P2修复·c30f036 | [同席复验](https://github.com/NelsonLongxiang/workbench-market/pull/438#issuecomment-6679761540)，run_a1e9e1a0b2975b86（7/7） | 原spec_06ca1364b719 v1材料／冻结件不变。仅解除精确新头原P2；旧FAIL归档有效。 |

同c30精确头独立原套件：隔离PG16.4/SCRAM、非superuser owner下事务11/11、SOP24/24、导入13/13；确定性事务17、planner23、checkpoint35与语法73文件通过。runner只供驱动，源码只读挂载；不证明runner内含新代码，未重标旧fa87制品，不是生产或完整最终组合验收。

## 6. 部署取证状态：公开原件时点，不是实时监控

[部署前G0–G4要求](https://github.com/NelsonLongxiang/workbench-market/pull/402#issuecomment-6661725726)、[e70adfc改钉／冻结原件](https://github.com/NelsonLongxiang/workbench-market/pull/402#issuecomment-6664144413)与[2026-11-06取证实报](https://github.com/NelsonLongxiang/workbench-market/pull/402#issuecomment-6680204610)分别成链。图中仅反映该实报时点：NTP启用但未同步，chronyc未找到，偏差<5秒未证，不捏造具体秒数偏差；按要求停在G-pre，未执行G0–G4、备份／恢复／配置diff／业务计数或部署，不解除冻结。

任务到达pending1、消费后pending0不证明先前未知精确ID的三单已完成；口头对时／赋权／清队转述不当事实。实际满足G-pre后才可按授权继续取证，同SHA全局评估PASS及属主操作仍是另道门；本图和局部PR438PASS均非部署授权，不放宽PG唯一生产写入源约束。

## 7. 图本身的维护与验证

### 上下文

上一版两张新页固定在199cd760和历史混搭候选，已通过PR #434合入。源码与候选随后发展；若覆盖旧页或直接把局部PG测试画成生产，将丢失历史并模糊运行接线。

### 决策

新增两张固定pin视图，复用稳定节点、手工网格、颜色和走线。使用drawio-skill IR增量sync附来源元数据；新增页按源码审读更新，历史五个模型原样保留，只将前两张旧页标历史。生产取证证据与候选源码节点分别标不同provenance。

### 后果

七页可编辑XML保留演进链。图更长，但不会让旧试验自动继承新状态；以后更新须再次核完整SHA和证据时点。真实运行拓扑、最终配置／扩展、全量迁移和部署验收仍推迟到独立材料齐备，不由画图任务代决。

两新增页经结构检查0 error/0 warning，0重叠、0穿节点、0交叉；仅声明的no-direct-internet-to-database语义规则通过，不把它当运行安全验证。原五页mxGraphModel按解析序列化及原始页体核对不变。无draw.io desktop，使用既有diagrams.net实际viewer与Edge渲染，视觉和SVG/标签几何检查；初稿旧页脚及过泛“已验收目标”措辞已纠正。只提交可编辑图和本文，不提交renderer脚本、浏览器profile或运行地址。

## 8. 历史版本来源留存

以下为上轮2026-11-05来源说明原文，仅解释本图历史页及旧固定pin，不构成当前主线、候选或生产事实。

<details>
<summary>展开上一版固定来源与历史覆盖范围</summary>

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
| 浏览器登录 origin 与内部身份／代理源分离 | [odoo-browser-origin.ts](../server/src/login-providers/odoo/odoo-browser-origin.ts)、[portal.ts](../server/src/portal.ts) | 只对所配置内部登录源替换浏览器目的地；Host 和 HTTPS 信号只收窄拒绝，不能自选新目的地。未配置时保持原行为；不是同域登录中继的等价物。 |
| 工作台自身数据库 | [db.ts:1–13](../server/src/db.ts#L1-L13) | `node:sqlite` 与 `workbench-market.db`；LC／YGL PG 成果不能替代工作台自身数据迁移。 |
| 内置 ygl 待办来源 | [tasks.ts:77–145](../server/src/tasks.ts#L77-L145) | 该固定源码要求专用 `YGL_HOME` 和工作区数据库，调用 CLI；PG 待办来源仍属右页候选，不将其画成这份主线已经实现。子进程环境继承行为不等于已发生外泄。 |
| SSO 票据与状态 | [sso-ticket-store.ts](../server/src/sso-ticket-store.ts)、[odoo-session.ts](../server/src/login-providers/odoo/odoo-session.ts) | `DELETE … RETURNING` 保留共享库票据原子消费；过期清理／匹配另在调用链。来源计数再写入是多步操作，本图不声称并发签发配额已被原子验证。 |
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
| [odoo-session.ts](../server/src/login-providers/odoo/odoo-session.ts) | `943cc10afc00454467c015c378b2dad2560638e3` |
| [odoo-browser-origin.ts](../server/src/login-providers/odoo/odoo-browser-origin.ts) | `234386740a0dd5956f218f803cd6709b20291535` |
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

</details>
