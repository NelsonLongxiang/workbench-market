# SSO2 v5：具名产品断言与裸夹具断言分流（NOT_FREEZE_READY）

依据独审6482341442与总工direct-c173c128；父稿1fc3d91原件不改。只修构造驱动，不重跑旧47组，不实施业务/生产变更。

## 修订
run-unit每次evaluateUnit建立私有WeakSet，仅本次check(condition,name)抛出的断言对象加入。catch不能靠error.code=ERR_ASSERTION推断产品违约。
- 本单元具名check记录false且抛出其对象→FAIL/value0。吞false后正常结束仍锁存FAIL。
- createWorkbench500/audit500/端口安全/listener归属/helper形状等裸assert，无具名false→ERROR/valueNULL，保code/rc，执行完整性守卫FAIL阻总PASS，业务候选仍NM，不伪称SSOFAIL。
- 已具名false后发生裸夹具断言/TypeError→ERROR，同时business_verdict=FAIL、latched_failed_assertions保留，不覆盖任一证据。
- 明确缺少可核前置仍MissingFixture/NEEDS；不把安全保护或基础设施异常统改成MissingFixture。

## 实测原件
fixture-classification-v5-selftest：13/13，直接调用既有helper配合仅返回合成500的对象（不是可运行服务、无auth模型），覆盖createWorkbench/audit/坏形状/9800安全/listener错进程/伪ERR_ASSERTION/具名业务/吞断言/双证/明确缺前置。
fixture-error-v5-engine-selftest：actual engine0.117.0，9类×47本期+3域污染=426记录，经过evaluateUnit→共享packObservations→SQLite→runVerify，逐单元守卫/业务分列；原49业务/延期+49守卫不减。
旧v4分类24/24仍通过；98候选lint通过，只表示结构/锚/schema，不是独立复核或产品通过。

## 身份/批准未完
GitHub评论「评审席」前缀仅文本，不当身份真值。真实审批须既有可信A2A/确认来源+引用+被批commit/required_controls hash/驱动版本绑定。当前实际verifiedApprovals=[]，所有PENDING，不自填VERIFIED、不造签名、不索凭据。受信来源核验装载仍未实现，本次不冒称闭合2b。

## 冻结状态
仍缺完整子控清单/完成标记、业务register前置、受信审批装载、独立构造与自检/meta；NOT_FREEZE_READY。旧业务10F/36NM/boot1P不套用新驱动；本次所有数字均机制反例而非业务复跑。
