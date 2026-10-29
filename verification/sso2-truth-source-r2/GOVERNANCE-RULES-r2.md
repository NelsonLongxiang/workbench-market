# #221 receipt身份真值源：已裁规则 r2（材料，不是单元批准）

全文依据：KB **5ecb32ccd4**，content_hash **b68d4701bbae6f60f806de554541ec4ca8a4fcb6**，本轮已读全文。接审阅包42feaacba9d5bb3c130b6e98ef5e2658b0c066be，构造驱动基线7e64e98fd24d1e5b5c0a7fcbb28c9a1af13c97dc、产品目标d90f81abca809a48a893544d0bdd4c409be78526。本文覆盖r1中未指定的治理角色，但不谎称安全交付接口已经落实。

## 1. 治理链与范围

| 角色 | 已裁职责 | 不拥有的默认权力 |
|---|---|---|
| 属主 | 根治理权，通过既有GUI/API直接确认 | 本规则不是自动给全部单元APPROVE |
| 总工 dsh/414d2b90 | 本任务逐件来源确认，核sender/独立性/原文与版本绑定 | 不代wm-review批准没实际审过的子控 |
| wm-review | 独立批准其实际审过的子控完整性 | 机制复现/收件不等全部334控通过 |
| TEST | 独立反例/夹具审验 | 不能替来源确认或子控批准 |
| 监督 dsh/f50b0456 | 保管与转交确认包 | **无默认身份认证权**，转投摘要不是真值 |
| 作者 dsh/cf31945f | 提供源、材料、子控、原件hash与缺口 | 不自批、不自写确认真值，不以自己的文件认证自己 |

receipt subject_scope仅CONTROL_COMPLETENESS_ONLY，不是SSO用户身份、GitHub账号、实施令、合并章或部署授权。

## 2. 允许的真值来源（两条既有治理路径）

A. 属主在既有GUI/API的**直接确认记录**：有可核记录定位和实际治理来源，不是作者贴一段“属主说”。确认须绑定具体review/rawhash及独立性与被批源/范围。

B. **宿主可核A2A原入站记录＋总工具名逐件确认**：绑定原record定位、实际发送会话身份、reviewer/author角色和独立性、内容rawhash、被批commit、contract、source_set、controls摘要、批准单元/子控集合。总工逐件确认引用也须由同一治理链确认来源，不能只自报confirmer字段。

以下都**不单独认证**：评论“评审席”前缀、共享login、路由team字符串、摘要、转投回执、task_id、KB、repo文件、sourcehash、自填VERIFIED。task_id只是定位；hash能查内容变化，不能认证谁发/谁有权批。

外部wm-review缺宿主sender原证时，不发明session映射：由属主既有人工治理渠道明确确认具体review/hash和独立性，否则该包NEEDS。

## 3. 别名／独立性

默认不自动归并不同显示名，也不按同GitHub账号推成同主体。属主/总工基于上述原证逐件确认会话到本scope角色映射。作者参与该批对应控或同主体别名，不批准该范围；未确认关系保持NEEDS。无自动团队继承/委托，监督保管不自动成为确认者。

## 4. 撤销与有序revision真源

属主或总工具名REVOKE(确认/receipt ID、hash、目标单元范围)，经**同一治理入口**追加台账；独立评审可撤自己的review。原件不删，REVOKE优先；review内容编辑/rawhash改变立即使旧确认失效，待新确认不能继续授权。文件删除/清缓存不等撤销证明。

受控清单必须显式有序revision，保留旧revision与前链证据；每次运行**开始和终结**都核受控最新revision与适用source/target/controls。无法证明最新（离线/读取失败/记录缺）→NEEDS或基础设施ERROR，不生成fresh批准。**无自选TTL/离线有效窗**。代码、依赖、控hash变化需重审。

## 5. 确认包交付与runtime边界

最外层信任来自已有治理入口，不是repo作者文件。仅治理方受控固定交付的确认包清单可装载；监督可以保管和交付，但不能自行把未确认记录变可信。runtime参数只能选择已在受控清单中的包，不可传入新信任者/任意JSON路径自行扩根。

未落实机读宿主导出时，自填JSON即使schema齐全也不能装VERIFIED；不读私钥、敏感session库或原进程env补造，不新建签名/身份平台，不索凭据。具体可用与不可得点见EXISTING-INTERFACE-NOTE.md。

## 6. 本次裁定不是批准或实施

49单元/334拟控全部PENDING，20拟验反例全部NOT_RUN；规则指定不让任何单元获批。总工direct-a5a3cd3e实答未有已核可交付raw/人工确认包及revision定位，故来源门是治理输入未交付的NEEDS，不是要求作者发明技术平台解锁；不再全机找/MCP重试/读取session私钥，待真实交付后才接线。真实装载器/controls映射实施仍需具名窄授权，产品SSO、生产恢复、凭据操作、deploy/X1–X3均不在本件授权内。机制面已独立确认的结论不重复跑来代替真实来源门。
