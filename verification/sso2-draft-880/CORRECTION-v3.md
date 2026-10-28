# SSO2 构造修订v3（独审6479991735/总工direct-b0dd4995）

父稿d6ba8b0原件/业务报告保留，不重写旧spec，不重跑旧47组。此版只机制修订，NOT_FREEZE_READY。

## 1. 49条scan修订
每候选predicate.scan={op:and,conditions:[{col:probe_id,op:=,value:本单元ID}]}，find和scope同域。where为目标value IS NULL OR value !=1，目标NULL不误PASS。候选仍49（47本期+2延期），source_clause范围不删。
实际安装引擎0.117.0+原生SqliteRunner，synthetic spec直接runVerify，未prepare/冻结/签评审。49×7=343结果：空表/仅other→NM；目标1→PASS，目标0或NULL→FAIL；目标1+other0→PASS；目标0+other1→FAIL。逐VU报告+rendered scope/find及engine hash在scan-engine-report.json与scan-engine-tests/report-*.json。
历史移除scan的other-only反例实跑PASS，保留report，不覆盖独审原run。合成延期unit目标1机制PASS不代表其业务正向已实现；真实延期评价表仍空。

## 2. run分类与PASS可达条件
run-unit.mjs：必须policy.probe_id匹配、非作者APPROVED证据存在、required_controls逐一命中且handler调用check.complete()，才value1/PASS；单纯正常return不够。无批准/缺控/缺完成标记/零断言=>明确MissingFixture/NM；产品断言=>value0/FAIL；TypeError/网络/程序/基础设施异常=>valueNULL/ERROR，保error_kind/code/rc。
completion-policy.json全部PENDING，本席不自签。a/b现有细化控名已列，其他单位完整required_controls和completion marker待覆盖独审逐项确认；未批准并非语义硬编码非boot永不PASS。10个纯分类机制反例含synthetic approval标识（不是真审批）证明非boot PASS可达且部分组不通过。
execution新report单列ERROR与依赖，原始业务观察仍绑定d6ba8b0旧驱动，不拿新分类篡改旧结果。新版本未跑业务组，旧10F/36NM/bootP不是v3业务结论。

## 3. 未完成/独立门
47单位完整子控清单未齐，a/b业务register404依赖仍在；物理schema/迁移/合法机器scope/浏览器/默认时间窗/映射仍未全验。
需要wm-review独立复核新scan与分类、TEST独立引擎和控清单核证后，再按材料新submit/prepare/check-construction/selfcheck/meta。此版没有reviews.json作者签、没有冻结、零SSO业务实现/生产操作。
引擎机制测试不是业务红队全覆盖：合成0/1只验checker，不能证明产品错时各handler必写0；保持此差别。
