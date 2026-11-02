# #309 第一段：列表最小投影与上传写凭据处置

基线main a13f1de2250f34ac6df4b19c1fe8f76e150dcc49，独立PR，不包含#296内容原语或#308接线。测试机工作台运行同套代码时同样受旧读面影响；本轮未向任何生产/测试机发探测、不读真实库。

## 已改边界

SopService所有run列表族（slug/recent/running/dispatchedAll/dispatched/query及active快路的runByIdRunning）统一显式构造元数据：id/sop_slug/sop_version/status/started_by/开始更新时间/完成时间/steps。无对象spread，不返回data/upload_token/storage_path或将来新增列；步骤数仅对象键数量，不回字段键和值。非法历史JSON计0不崩。REST普通/slug/status/active/dispatched和MCP list共域；dispatched默认关闭仍为空，打开后同元数据契约。内部为计算steps可读原行，**只承诺出口不含私有值，不宣SQL本身不读取data**。

A2A status/note响应也不再重发upload_token。REST/MCP新建run及A2A start是发行新写能力的创建响应，仍只给该次创建者，沿既有业务合同，不把“所有查询去token”误做“无法新建上传”。新签发用crypto.randomBytes(32)。旧A2Acaller绑定的可信度、任意context查询范围与写权限另案，不以本次字段剔除声明A2A身份已升级。

管理页执行记录Drawer只用元数据/服务端steps，不展开或额外fetch单run数据；执行人字段暂保原元数据语义。旧单项GET的全步data与附件list/download/HEAD匿名行为**本段刻意不变、风险仍存在**；第二段先盘调用方再引入有效会话+run范围能力，不能说本PR修完#309。

## upload_token究竟能做什么

旧POST /api/sop/runs/<id>/files只在run.running、配额内处理上传。settings.run_upload_require_token='1'时，正确X-Run-Upload-Token是该run附件写凭据，错误403/缺失401，管理员另有既有通路；令牌不直接授权step-save/finish，但这两个旧写接口本身的权限另案，不将它们错归令牌能力。

严格开关缺省0，关闭时附件写根本不要求令牌，**轮换token不能关闭这个匿名上传入口**。列表曾外露的token必须按已外露写凭据处置；不能因现在出口删字段就把旧值视为已失效。已存token属于业务授权，agent不接收、展示、保存或复用真实值。

## 部署窗口方案（需属主本人另批，本轮未执行）

1. 属主批准代码上线与旧上传暂停/中断影响、备份保留和恢复路径；先通知用户暂停附件提交。必须排空/停止旧应用上传处理后再离线轮换，避免已过token校验的在途multer请求继续提交。不是用不明PID杀进程；真实停启使用既有明确属主批准方案。
2. 在维护窗口用持权流程将run_upload_require_token设为字符串1，确保新上传确实验token；此脚本不自动改settings或启停服务。不做该步时旧token虽被替换，匿名上传仍可继续，不能宣写面封住。
3. 显式给离线DB路径运行dry-run，输出仅running数量与不含明文的plan摘要：

```sh
node scripts/sop-upload-token-rotation.mjs --db <ABSOLUTE_OFFLINE_DB_PATH>
```

4. 比对计划后由持权人执行，命令中不输入任何旧/新token：

```sh
node scripts/sop-upload-token-rotation.mjs --db <ABSOLUTE_OFFLINE_DB_PATH> --apply --expected-plan <DRY_RUN_PLAN> --ack-upload-interruption
```

代码要求DB文件已存在、路径绝对、参数不重复；默认只读query_only。apply在BEGIN IMMEDIATE内复核全部run id/status/token摘要，给所有running行crypto随机64hex新token，非running清token，事务失败全回滚；不改data/status/revision/业务时间，不输出token、新映射或其哈希。来源自plan后变化拒，先重做dry-run，不能盲复用旧plan。
5. 原因是暴露风险，**不能回滚到旧已外露token**。轮换后严格模式下旧页localStorage缓存令牌、旧脚本会上传403；普通填字段/已保存数据/已存附件不因本轮换改变，未提交的附件需重新选文件。仅刷新旧页不会获得新token（单run GET不返回token），且本段不新增匿名重领端点。属主可选择受控维护人员的安全上传流程或显式新开run继续附件，后续受权重发/历史迁移方案另段实现；旧run仍保历史。不能在不可信市场页输入管理员口令来兜底。
6. 持权人用安全本机流程核strict1、running token已换/finished清空、旧值失败；agent不读取真实token作探针。上线后受控真实验收另批，当前合成HTTP已证旧token先201→轮换后403→新值201。已提交上传/在途已接受请求不被token轮换追溯撤销，因此步骤1不可省。

## 验证与限制

- 原domain-before.log先红（data仍在列表）；新actual域SQL方法VM+内存SQLite10项，含所有列表allowlist/非法JSON/单项内部访问保原。
- 真实新合成index HTTP15观测含6类列表无data/token、single仍全步、附件仍可读、MCP网关匿名401、strict上传及旧token失效/新token成功。真实socket仅自有回环随机口，带合成跨源标记不冒LAN现场。
- A2A实际函数+受控adapter3项：status/note不读取或返回token，start发行保留；不是远端身份认证证明。
- 轮换内存5项：dryrun零写/实际新签并清完成/快照变拒/中途fault全回滚/完成行token变化也拒旧plan，无真实库apply。
- 实际构建React/antd页面+拦截合成API4项，元数据可渲染/steps/无展开/无单项fallback fetch；不是现网GUI验收。UI取消列表“展开所有字段”是预期最小收口变化，不改旧单run接口。

尚未完成：第二段单项字段与附件读scope、匿名调用方完整盘点、真实人员归属来源/旧run迁移、生产配置切换与真实令牌轮换。全部部署/合并留属主本人，不混#296/#308，不动186180/网络/LC/.88/WinSW。
