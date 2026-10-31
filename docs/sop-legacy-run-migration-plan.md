# 旧SOP run归属迁移方案（只方案与合成，不执行真实库）

## 信任与禁止推断

旧sop_runs.started_by可由REST/MCP自填；a2a_run_ctx.caller/node是agent节点标识。两者都不等Odoo主体，禁止字符串补user:前缀、按显示名合并、以能猜run id或持台令牌认领。当前新入口只创建新run并把fresh Odoo sub+uid登记为属主，不接受旧run id/owner/assignee/manifest摘要；不是迁移接口。

迁移映射必须由持权人从可核来源提供：旧run精确id/slug/冻结version、run原JSON SHA256、该版本原始sop.yaml SHA256、唯一target登记、Odoo权威主体与可选指派主体、证据定位。主体须从可信Odoo目录/本人会话或已有受控指派记录解析，不由agent自选。现仓库无委托他人目录查询/指派关系权威API，因此指派运营入口尚未交，不能假造已有权限映射；将来另段接来源再验。

## 迁移顺序（未来另批，当前无apply）

1. 由持权流程冻结一致副本与旧数据只读清单，不从活库边读边迁；确认对应source/版本/备份回退。
2. 对每条归属生成审过的显式映射，缺证/一对多/同名或版本摘要冲突列pending；已有binding不覆盖。file/schema的旧中文键、{value}和任意extras单独版本化转换，保原值，不凭运行iframe注册字段。
3. 在隔离副本上dry-run比对run JSON、版本、target与人员证据；schema不兼容先给只读旧数据导出，不静默升级历史run。若需要新schema版本，新run明确关联旧记录，旧run不改号/不改原version。
4. 真apply需另授权并另实现事务：expected原JSON/manifest摘要+既有ACL revision比较，原子新增binding/revision及审计；已绑定/状态变更/冲突全批拒，不擅自restore覆盖新写入。回读每条ACL与无权限/撤权反例；失败回滚仅迁移事务，保原历史。
5. 完成后的受控读回/写route/Redis旧链迁出另验；不能把planner ready当已授权或已应用。

## 本次可执行物的严格范围

sop-run-migration-plan是无IO纯函数：输入审过的snapshot行和显式authority evidence，按run/slug/version/data摘要/主体格式/证据引用格式匹配；缺失/歧义/已有binding/mismatch列pending，超出审查snapshot的证据拒。**它只比对格式与一致性，不验证证据引用真实性或人员权限**；输入来源必须受控，不开放HTTP/MCP，不输出自动SQL/apply命令。

sop-run-migration-plan-test仅内存SQLite合成展示：只把planner明确ready行写入synthetic_bindings、历史值逐字未变，其余pending不动。没有真实库路径参数、生产迁移脚本或默认落库；本次未读/写现网DB、备份或真实身份数据。
