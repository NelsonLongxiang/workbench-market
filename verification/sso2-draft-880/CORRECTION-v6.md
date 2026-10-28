# SSO2 v6 迟到检查封口与不可变快照（NOT_FREEZE_READY）

父稿bb3bb34，依据复审6483452277及总工direct-cdaedae3。旧证/spec不改；本轮只有新机制反例，不重跑47产品组，不实施业务/生产变更。

## 快照与封口
evaluateUnit在await handler完成/抛错后立即seal，check与check.complete均先核sealed。结算后调用不追加assertions/completed/approval，不跨单元写值；返回对象是独立拷贝的assertions元素/子控清单/approval/error字段，并冻结本结果字段。外部policy/receipt后续变更不反映到已结算结果。
封口后的调用抛ERR_UNIT_SETTLED；即使被handler catch吞掉，也先向本单元+运行级独立完整性账本记录事件，不只靠throw。结果快照不可变，materialize只生成新ERROR视图、不原地改旧快照。

## 运行/报告边界
run-integrity持久事件JSONL与state绑定run_id/probe_id。runner自身await handler→await所属目标/fixture cleanup→输出报告→finalize为报告边界；不sleep等任意脱管异步，也不承诺进程退出后可捕获任意callback。handler异步必须显式await并归属。
终结前观测到迟到事件，在报告/packObservations的完整性视图抬为ERROR（原settled_status与business_verdict保留），业务valueNULL不伪FAIL，guard FAIL阻总P。
终结后新迟到事件：报告字节/先前SQLite包不静默变更，run sidecar标INVALIDATED/valid=false并记录invalidates_report=true。消费方必须读匹配run_id sidecar+事件后再pack/判有效性；旧report/旧engine结局不能再标fresh green。pack入口缺新sidecar拒打包，不把旧证套新驱动。
限制：sidecar只能记录仍能到达此runner的事件；不证明任意未知异步已完、不自动更正已外传报告。真实最终封包消费方/受信收件流程仍须独立核，未实现全局撤销/远端通知。

## 机制回归
受控Promise barrier释放漏await false（被catch）、late true、late complete，初态PASS/NM各覆盖，终结前后及其他单元不串写；不靠sleep定时猜完成。6种迟到场景+1 awaited正控，实际engine各为业务NM/本单元guardFAIL/其他单元guardPASS。报告和已打包库在迟到后逐字/逐值不变，sidecar失效，新物化/重打包看见ERROR。
旧分类24/24、fixture前置13/13、ERROR包装引擎426机制回归不退；吞false锁存/裸assertERROR/崩溃双证保持。
清理：execution模块级死check删除，more-handlers未用assert导入删除，未趁机重构业务。

## 剩余门
受信审批引用装载、完整非作者批准子控/complete标记、产品register依赖、构造/selfcheck/meta/正式冻结仍未齐。合成receipt只机制输入，不写真批准。NOT_FREEZE_READY。
