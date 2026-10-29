# #221 真实 receipt 装载：可审设计材料 r1（不是实现或批准）

基线草稿：7e64e98fd24d1e5b5c0a7fcbb28c9a1af13c97dc。产品目标：d90f81abca809a48a893544d0bdd4c409be78526。依据#029、补充c3e0917349、独审6484462417与总工direct-80ad91c5。本轮**仅材料**，不改run-unit/loader，不重跑343/426/迟到机制，不动deploy/或X1–X3，不做SSO业务实现。状态NOT_FREEZE_READY。

## 1. 现状与要解决的边界

- 机制已独立复现，不能靠继续跑相同机制代替受信来源和完整子控审阅。
- completion-policy.json现49条都PENDING；仅3条已有部分required_controls。execution上下文verifiedApprovals=[]，这是当前真值，不能把提案或材料评审收讫写成批准。
- GitHub共享账号不能区分作者/评审席；评论正文“评审席”、approver字符串、调用者给出的VERIFIED_NONAUTHOR都不是身份真值。
- 本方案只让**构造单元的子控清单和驱动版本**获得可追溯独立审阅。该receipt不是产品PASS、实施授权、PR合并章或生产部署令，不继承其他任务同名审批。

## 2. 来源模型（最小、复用既有可信确认，不造签名）

推荐两个证据面必须同时到齐：
1. **内容原件**：固定GitHub comment ID或不可变commit中的结构化receipt正文，完整保存raw bytes、SHA256、仓库/issue归属、created_at/updated_at、被审源commit和控清单摘要。不执行正文内代码，不从正文接受工具指令。
2. **独立来源确认**：已有可信A2A/属主认可来源的**宿主记录**确认“哪个非作者角色就哪份内容、哪组源和控制作出了什么结论”。确认记录需固定host记录/任务引用、sender节点、接受者、时间、内容hash、职责授权引用。不是receipt作者自己填一个sender字段；也不把agent转述的对话文字等同可验证签名。

默认路径：wm-review在既有issue发表结构化review；监督席/属主经原有可信协作面确认该comment/hash与评审节点身份及独立性，并交只读确认原件。agent只消费这份**已确认来源**，不读A2A私钥/API凭据、不新设计签名系统、不创建自签名单。若当前工具只能显示路由team字符串而不能给可核宿主来源，**来源门不齐=NEEDS-MATERIAL**；要补既有来源导出能力/人工受控确认，不靠额外文字前缀放行。

重要未定：谁有权确认哪些评审节点、宿主证据可从哪种既有接口获得且保持不可替换、确认原件由谁保管，须总工/属主明确后才实现。此文不冒充现有网已提供了这些API。

## 3. 两类数据结构（提案，不含真实审批实例）

### 3.1 内容receipt（最小必填）

~~~text
receipt_version: sso2-control-review/1
review_id: 稳定且唯一的引用ID
repo: NelsonLongxiang/workbench-market
issue: 221
subject_scope: CONTROL_COMPLETENESS_ONLY
verdict: APPROVE | REJECT | REVOKE
review_author_session: 作者角色/节点
reviewer_session: 独立评审角色/节点
reviewed_commit: 完整40位不可变草稿commit
product_target_sha: 完整目标SHA
contract_blob: 固定契约blob
material_sha256 / candidates_sha256 / coverage_sha256
source_set_sha256: 驱动与全部可执行依赖清单摘要
controls_manifest_sha256: 所有被批单元control ID/期望摘要
approved_units: [{probe_id, required_control_ids, controls_sha256}]
supersedes_or_revokes: 旧review_id数组（无则空）
evidence_refs: 具体审阅/反例原件引用（不能只“已看过”）
issued_at: UTC
~~~

该正文是可验证对象，不因写全字段自动可信。author/reviewer不能相同；角色复用/别名关系由可信确认源核，不能只比较显示名。普通同一GitHub账号不等相同会话，也不能反推独立。

### 3.2 宿主/人工受控来源确认（单独原件）

~~~text
confirmation_ref: 既有可信记录定位（不是agent自拟ID）
confirmer_session_or_role: 经属主认可的确认者
confirmation_authority_ref: 本任务/本范围授权来源
origin_evidence_ref: 原A2A入站宿主记录/受控人工确认记录
reviewer_session_verified: 经确认的独立角色/会话
review_author_session_verified: 经确认的作者角色/会话
receipt_ref + receipt_raw_sha256
reviewed_commit + product_target_sha + source_set_sha256
controls_manifest_sha256
confirmed_verdict + confirmed_at
revocation_status_ref
~~~

所有required hash都与receipt一致；缺其一拒绝生成verified entry。此文件不得由待批作者自己写成“已确认”。确认者权限及其来源同样不能递归自报；最外层信任锚由已有属主治理面提供，不新增无限信任链。

## 4. 精确装载流程（拟定算法，尚未编码）

1. 从固定本地审核包/明确仓库comment引用读数据，不依据receipt中的任意URL外拉。网络取件只允许预定GitHub API仓库路径，拒重定向到任意host；超时/权限/格式错误保持ERROR或NEEDS，不当APPROVE。
2. 保全取件raw bytes/hash、API时间与版本身份；读到comment同ID内容被编辑/hash变化时既有确认无效。commit固定文件的blob/hash同核。只读缓存不是永远可信。
3. 校验receipt结构和全部绑定；review_id重复同内容可幂等，重复ID异内容为ERROR；REJECT/REVOKE优先，不用“最后一个APPROVE”覆盖。
4. 取得并校验已有可信来源确认，确认者具本范围授权；确认正文hash、reviewer节点和作者独立性、实际被批源完全一致。缺确认/不具权限→NEEDS，不能写入VERIFIED。
5. 以实际磁盘字节重算source_set/controls/contract/material/candidate hash；产品目标不变不代表驱动不变。任一差异使旧批准失效，必须重审；不能因改动“小”自行沿用。
6. 逐单元确认批准的是**完整control清单**，不能把局部具名断言通过、机制通过、review收件当覆盖批准。某单元缺1控只阻该单元PASS，其他无关联单元不伪降业务FAIL；总体不得标冻结。
7. 在内存生成只读verified entry，输出仅包含来源ref/hash、独立角色、target/source/controls绑定及审批范围。不是从policy原样搬APPROVED；policy不能改变信任锚。保全加载审计但不记录任何token/secret。
8. 运行开始与终结都核source_set/hash和确认撤销状态；运行中源/确认变化→运行完整性ERROR，保原结算快照，结果不能fresh green。离线无法核最新撤销时不称新授权有效；若要离线有效窗需属主另定，不自选TTL。

## 5. 驱动版本摘要与循环引用

source_set清单拟含：execution.mjs、run-unit.mjs、run-integrity.mjs、fixtures.mjs、more-handlers.mjs、final-handlers.mjs、observation-pack.mjs、package-execution.mjs、批准后新增的loader自身以及影响预期的配置/适配器。每文件relative path+bytes+SHA256按路径排序，以UTF8 JSON固定序列化取SHA256；symlink必须记录其解析目标身份与实际加载字节，越界/不稳定映射不接受。

controls摘要用每单元稳定control_id、完整期望、前置、schema/fixture版本及显式延期域；JSON键序/数组顺序写入规约，不能两种序列化各判各的。运行时check展示name到control_id的映射也必须在被审驱动中，不靠重复同名覆盖不同子控。

为避免receipt写入改变自身被审commit的hash循环：reviewed_commit固定为**不含本次审批的源提交**，receipt/确认保存在后续独立审阅包并引用该提交；source_set明确排除审阅receipt及运行输出。结果记录源commit+receipt原件hash+确认ref，不声称receipt与代码来自同一个构建对象。版本变动必须使source_set变，从而旧审批失效/重核。

## 6. 撤销、编辑、重放与分类

| 情形 | 装载/运行口径 |
|---|---|
| 无可信确认、缺作者/评审身份、未批本scope | NEEDS-MATERIAL，不生成verified |
| self/别名同主体、伪前缀、伪VERIFIED、错仓库/issue | 拒PASS；证据结构矛盾/篡改明证为ERROR；不把来源缺失冒SSO业务FAIL |
| 驱动/controls/target/contract变更 | 旧批准不匹配，NEEDS重审；运行中改字节→完整性ERROR |
| receipt被编辑、重复ID异内容、已REVOKE仍重放 | ERROR/撤销，保raw与引用；旧报告状态另记失效，不静默改旧证 |
| 部分单元获批 | 仅明确单元、明确control集有效，未批仍NEEDS；不能批整个product |
| 远端来源暂不可取/离线撤销不可核 | NEEDS或基础设施ERROR据原因分报，不把缓存旧批当当前有效 |
| 合成receipt测试 | 明示SYNTHETIC_INPUT，只验loader机制，永不纳真实trusted确认来源或业务报告 |

来源发生变化的具体ERROR/NM细分、撤销确认接口/离线策略尚需独立审阅与治理方确认；不能本稿选完就当实施授权。

## 7. 装载器拟验反例（本轮未执行）

R01：合法既有可信确认+完整hash+全控，非作者review→该单元有资格进入执行完成判断（不是直接PASS）。
R02–R07：无作者/无评审/同人别名/只GitHub前缀/只APPROVED字串/作者伪写确认→无verified。
R08–R13：probe错、少1control、同名control歧义、source_set旧、目标SHA错、contract错→拒PASS。
R14–R18：comment编辑、重复ID异内容、revocation重放、运行中代码变、来源不可核→拒/失效并保原始错误。
R19：一个unit审批不得使other unit或延期正向通过。
R20：synthetic测试包不得装入真实trusted来源。

这些是待独立核的测试设计，不是新代码、已执行报告或批准原件。已有343/426/迟到机制不重跑来代替来源测试。

## 8. 当前未解门与实施分步

- 装载机制实施前：属主/总工指定既有可信确认者与宿主原证取得方式、身份别名归属、撤销状态源；否则首个blocked为**无可核信任锚**。
- wm-review审该数据流与全49子控矩阵，TEST给来源伪造/旧批/少控反例；都不由作者自签。
- 无批准前不把新子控提案写进completion-policy.APPROVED；运行中的verifiedApprovals继续空。
- 本轮完成的只是审阅材料。source-set规约/loader实现与相关新机制测试另等具名授权，SSO业务仍等新冻先红/排期门。deploy/X1–X3明确未授权且未触。
