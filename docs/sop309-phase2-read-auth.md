# #309 第二段：run/task 私有读收口设计（Draft）

基线 main e9aa745（#310 列表收口＋#296 内容底座已合）。本段覆盖：单 run 字段（GET /api/sop/runs/:id）、附件（list／download／HEAD）、任务中心详情 /:id（含 events 载荷副本）。不塞 #311 现行热修 head；生产部署与维护窗口另行批准。

## 判据（先红）

匿名/无凭据：单 run 响应不含 data；附件 list 与字节下载/HEAD 403；任务详情不含 payload_json 复制副本；MCP sop_run_get 无 run 授权时只回元数据。均已合成环境复现为当前红（现状放行）。

## 授权模型（两条正路，缺归属即拒私有值）

统一判定 sopRunReadGrant(req, runId, op, fileId?)，在读取数据/查附件/开流之前执行；REST 与 MCP 共用：

1. **run 读能力（cap）**：创建 run 时（REST POST 与 A2A start）签发高熵 opaque read_capability（randomBytes 32，服务端只存 sha256 摘要，缺省 30 天过期，可撤销），响应仅创建时出现一次。调用方以 X-Run-Read-Capability 头（MCP 以 args.read_capability）出示。cap 绑定精确 run，不跨 run、不代表写权。管理员可对指定 run 重签（一次明文回显）。
2. **受权主体（grant）**：sop_run_read_grants(run_id, subject, role, expires_at, revoked_at)。浏览器路径要求**新鲜 Odoo 内部会话**（resolveOdooViewer：uid+登录名+is_internal_user===true，每次现查）且 subject=user:<login> 有有效 grant；MCP 会话要求已验证 Bearer 会话（未撤销+工具 grant）且 subject=mcp:<会话名> 有有效 run grant。管理员口令等价授权（受控导出通路）。

**旧 run 无权威归属**：不按 started_by／created_by／A2A caller／IP／localStorage 存档推权——无 grant/cap 即只回元数据（列表同款白名单+steps+receipt），附件拒。运维持权人依权威映射经管理 API 播种 grant 或重签 cap，双人复核按业务既有规范，本段不自设新门禁。

## 各面行为

| 面 | 未授权 | 授权（cap／grant／admin） |
|---|---|---|
| GET /api/sop/runs/:id | 元数据（无 data）+private_read 标记 | 现行全量（data+receipt） |
| GET …/:id/files | 403（no-store） | 现行列表 |
| GET/HEAD …/:id/files/:fid | 403 | 字节流（octet-stream+attachment+nosniff 语义不变） |
| GET /api/task-center/tasks/:id | taskListView 元数据+events，无 payload_json | 全量 taskView+events |
| MCP sop_run_get | 元数据（无 data） | 全量 |
| 列表族 / /api/tasks / timeline | 不变（#310 已收元数据） | 不变 |

## Runner 兼容

创建响应保存 read_capability 于本机（与 upload_token 同域 localStorage）；恢复/交付列表/下载带 cap 头。响应缺 data 时显式提示"需读授权/旧记录"并回退本地缓冲，不把授权失败伪装成空数据；文件 403 显式提示。旧页无 cap → 元数据+本地缓冲，不自动新建替代 run。

## 管理面（adminGuard）

- PUT /api/sop/runs/:id/read-grants {subject, role?, expires_at?}
- POST /api/sop/runs/:id/read-grants/revoke {subject}
- POST /api/sop/runs/:id/read-caps（重签，明文仅此一次）
- POST /api/sop/runs/:id/read-caps/revoke {all:true}

## 明确残余与后续

- **可信读面未建**：市场源仍承载 SOP 用户 HTML/自产台/go 代理，同源脚本可携环境 Cookie 或读本机 localStorage cap——本段的 cap+会话门挡匿名网络读，不挡被攻陷同源内容。人的私有阅读最终应迁至不承载不可信内容的只读壳（与 #296/#308 的隔离通道衔接），另行设计；在此之前这是已知限制而非已解决。
- MCP run grant 依赖人工播种（管理 API/DB），未做自动目录；仓内测试消费者已改为创建响应 cap 对齐。
- 访问统计脱敏聚合待属主授权，不在本段。
- 旧 run 迁移映射、真实 Redis/Odoo 环境、跨 worker 一致性未验。
