---
name: wm-report-governance
version: 0.1.0
description: 工作台市场报告治理。使用通用调用或 REST 提出单台单维度绑定或领域维度登记请求，查询本人会话的提案。
---

# 报告治理

用 `access_info { "capability": "report.governance-propose" }` 查当前开放的操作、参数和作用域。首个操作为 `bench-bind`。

申请时给出领域、`actions: ["report.governance-bench-bind"]`、具体用途和 `report_scope: { "bench": "台标识", "dimension": "维度标识" }`。负责人批准会话接入后，责任人仍须持有该台当前的报告绑定权限。

登记领域维度用 `dimension-create`，申请指定领域和 `actions: ["report.governance-dimension-create"]`。调用 `args` 填 `{ area, id, title }`。责任人和确认人都必须有该领域的维度治理权。确认后新维度没有生效模板。

把 `{ op, args, idempotency_key }` 交给 `invoke`，目标为 `report.governance-propose`。也可用同一会话令牌 POST `/api/report-governance/proposals`。绑定参数取自当前生效模板、视图和绑定，包含台标识、维度标识、模板/视图版本与 SHA-256、绑定基版和逐槽映射。同一键和相同参数返回同一提案编号。

提议后由有权人在站内「等你拍板」核对冻结内容并确认。会话可用 `report.governance-result { "id": "p-编号" }` 或 GET `/api/report-governance/proposals/p-编号` 查询。收到冲突时重新读对象再提；未授权时检查台与维度的接入及当前本人授予。不要提交身份、授予、任意路由或数据行。
