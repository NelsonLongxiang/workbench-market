# SSO2 v4 三缺口机制修订（待独立复审）

父稿9dcec766a5485fb75fb56ec3724b020a6da6bf73，依据独审6481167293及direct-940d74df。旧稿/旧spec/业务报告不改，不重跑47组。

## 2a 断言失败锁存与双证
run-unit只要observed assertions存在false，就不能被后续同名true、缺清单或MissingFixture覆盖。正常返回/缺控时为FAIL0；随后发生TypeError/网络故障时status=ERROR/valueNULL且保business_verdict=FAIL、latched_failed_assertions和code/rc，不能把崩溃藏为普通FAIL或NM。

## 2b 非作者批准与绑定
policy含author/approver/evidence，身份trim+小写校验，author=approver拒PASS。policy自报的APPROVED不是可信证据；runner context必须另有经核验receipt，匹配probe_id、作者/批准人、controls SHA256、目标SHA、驱动source SHA256。缺人/缺引/伪引/旧source或target/清单变均fail-closed NEEDS。
当前context.verifiedApprovals固定空，completion-policy全部PENDING，本席没有真实审批；合成receipt仅机制测试输入。真实引用核验/装载尚未落地，不能凭一个VERIFIED字串对外宣称已核验；独立席交可核评论/提交锚后再补受信装载与签章。这一未完项仍阻冻结。

## 3 执行完整性守卫
原49业务/延期候选完整保留，新增49个Gxx S1执行守卫（每个scan精确probe_id）。读取sso2_execution_integrity WHERE status=ERROR，含error_kind/error_code/exit_code/business_verdict/evidence_json；共享observation-pack给真实包装和机制测试同用。
ERROR不写假的业务value0；业务候选可NM，完整性guard FAIL明确属于探针/基础设施错误而非SSO违约。MissingFixture行非ERROR，guard可通过但业务NM，所以总判NM，不把全部NM降FAIL。缺单元记录时guard也空scope NM，不默认可执行。
端到端实际引擎0.117.0：TypeError、网络rc、失败再崩溃、吞失败后返回、显式MissingFixture5类×47本期+3域污染=238记录；保留raw结果、SQLite、engine报告、code/rc。两延期业务仍NM；合成守卫PASS不等产品延期正向通过。

## 本轮已验与未完
分类器新增吞断言/作者缺伪旧审批/双证机制反例；98候选lint含锚/schema覆盖；零业务重跑、零SSO实现或生产操作。
真实引用受信装载、完整批准子控清单、handler completion标记、register前置以及既有全部构造门仍缺；NOT_FREEZE_READY。引擎机制自测不代独立评审，也不证明所有业务坏实现必被handler抓住。
