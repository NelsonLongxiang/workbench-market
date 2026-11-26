---
name: wm-report-governance
version: 0.2.0
description: 工作台市场报告治理。使用通用调用或 REST 提出绑定、领域维度登记和模板发布请求，查询本人会话的提案。
---

# 报告治理

用 `access_info { "capability": "report.governance-propose" }` 查当前开放的操作、参数和作用域。首个操作为 `bench-bind`。

申请时给出领域、`actions: ["report.governance-bench-bind"]`、具体用途和 `report_scope: { "bench": "台标识", "dimension": "维度标识" }`。负责人批准会话接入后，责任人仍须持有该台当前的报告绑定权限。

登记领域维度用 `dimension-create`，申请指定领域和 `actions: ["report.governance-dimension-create"]`。调用 `args` 填 `{ area, id, title }`。责任人和确认人都必须有该领域的维度治理权。确认后新维度没有生效模板。

发布领域模板用 `template-publish`。单独申请该领域的 `report.governance-template-publish`，并填 `report_scope: { "dimension": "维度标识" }`。提案填 `dimension`、`body`、`body_sha256`、`criteria_sha256`、`expected_kind`、`expected_latest_version`、`note`。正文哈希取提交对象的 JSON 序列化字节。确认后只追加模板版本，发布者和起草责任人都进入同判据作者集合，生效指针保持原样。

把 `{ op, args, idempotency_key }` 交给 `invoke`，目标为 `report.governance-propose`。也可用同一会话令牌 POST `/api/report-governance/proposals`。绑定参数取自当前生效模板、视图和绑定，包含台标识、维度标识、模板/视图版本与 SHA-256、绑定基版和逐槽映射。同一键和相同参数返回同一提案编号。

提议后由有权人在站内「等你拍板」核对冻结内容并确认。会话可用 `report.governance-result { "id": "p-编号" }` 或 GET `/api/report-governance/proposals/p-编号` 查询。收到冲突时重新读对象再提；未授权时检查台与维度的接入及当前本人授予。不要提交身份、授予、任意路由或数据行。

请人复核用 `review-invite`，单独申请该维度的 `report.governance-review-invite`。参数为 `dimension`、`version`、`body_sha256`、`criteria_sha256`、`invitees`（1～5 位有权非作者）。同键重放不会重复产生站内待办。返回的 `i-` 编号可用 `report.governance-result` 查询。复核本人从站内待办查看精确版本并提交复核。

激活或回退模板用 `dimension-activate`，单独申请该维度的 `report.governance-dimension-activate`。指定 `dimension`、目标 `version`、正文和判据摘要、`expected_active_version`（尚无时写 null）、实际复核所在的 `review_version`。经授权本人确认后才会移动指针。

## 属主本人激活判据类模板

通常由作者以外的有权人复核判据。当前仍为有效属主的自然人本人激活时，只有同一维度、相同判据的每一版都由本人发布，且起草责任人为空（没有共同起草人）或为本人，才可免复核。任何一版有其他发布人或共同起草人，仍须由作者以外的有权人复核。符合豁免条件的属主可用本人站内会话请求 `POST /api/report-dimensions/<维度>/activate`，正文为 `{ "version": 2 }`，此处的 2 替换为目标版本。服务端每次重核当前身份、授予和作者集合。豁免只记在本次激活的维度和版本上，不能当复核记录借给别人或其他版本。激活提案仍按目录要求填复核来源。

## 变更报告槽的来源

保存视图收到 409「现行报告数据槽改了来源」时，请有停用权限的活跃自然人处理。先读本台绑定 `GET /api/bench-views/<台>/reports/<维度>/binding`，记下当前绑定版本和各槽位。然后向同路径加 `/stop` 发 POST，正文填 `{ "base": 1, "reason": "调整报告数据槽来源" }`，把 1 换成刚读到的绑定版本。停用产生下一版绑定，此时该维度暂不能生成新报告。

保存变更后的视图，重新读绑定，再用停用版的最新版本作 `base` 重绑。保留模板要求的槽名和列契约，把槽映射到当前视图块、参数和列。用原绑定的 PUT 路径，或按当前能力目录提出绑定。读回新绑定，确认已启用、模板版本和来源正确，再恢复生成。

编写模板、检查数据槽和生成报告，用 [wm-reports](../wm-reports/SKILL.md)。
