# 开发验证器 v69.3：V111 掩码导入材料漂移修正

基线 main 58739994。v69.2旧正式run_975f4e10e3decc5d保留FAIL174/175，原归档不改、不重写为PASS。

## 新材料

v69.3 supersedes v69.2，175条编号保持，source_clause仅111变化：旧“掩码行跳过”注释锚改为当前错误码masked_import_value。候选/anchor.quote/review source_clause同步；100/112解释与总览删除旧skip/strip描述。导出附近一条过时注释改正，没有改变导入运行逻辑。material-version changed_criteria=[111]，不是把旧材料同ID直接覆写。

V111仍是文本事实exists，**只证明错误码在源码**；不能仅凭字符串断言预检/事务可达或安全。另加verifier-masked-import-test：提取真实/app/import回调，TS转译后执行，合成SQLite核merge/replace的url/auth掩码整批400+row_index+零写、合法导入与写中途故障回滚；移除mask guard的mutation证会漏入且被断言区分。generator与make-submission只在复制夹具和合成DB运行，真实快照fact为1，移除代码标记后fact0，不手填present。

## 验证边界

无TCP listener/生产数据库；使用受控依赖执行真实回调，不是实际HTTP/完整URL准入栈。首测试缺importErr依赖导致500，是驱动搭建错误，保checks-first.log，补同错误helper后不改产品行为再验。门户调用链原突变组保留，版本expect改为v69.3/changed111。新材料需要新的submit/prepare/run/archive，不能由局部检查宣正式175PASS，旧正式FAIL仍有效于旧材料。此PR不部署、不包含#296 SOP代码。
