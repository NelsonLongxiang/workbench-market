# SSO2 execution-v2：探针草稿运行与证据边界

## 身份与入口
- 产品目标固定d90f81abca809a48a893544d0bdd4c409be78526，来自GitHub tarball，不是当前共享checkout。
- 首检查点a677aab保留在远端；本轮只加test-only执行与夹具，不提交业务源码。
- 单一源dev；TEST独立核，wm-review独立审覆盖并构造新spec，作者不生成已通过的reviews.json。

## 运行顺序
1. 以extract-target.py抽取target.tar.gz白名单源目录；生产库/数据不复制。
2. target/server/node_modules和target/node_modules仅链接既有依赖（相对pnpm符号链接需要root store），不install/build。
3. node --check fixtures.mjs / execution.mjs / more-handlers.mjs / final-handlers.mjs。
4. node fixture-selftest.mjs：只验网络/SQLite夹具，6/6不是产品PASS。
5. node checker-fixtures.mjs：good47+延期2空/bad47+延期2空/empty49；这是合成评价表，不是服务审计。
6. node run-execution-versioned.mjs：真实目标子进程/非9800随机端口/独立目录；前后hash不变，结果按断言分FAIL/前置或fixtureNM。
7. node package-execution.mjs：从run_id+report hash核合后生成execution-observations与manifest-v2。
8. 独立prepare/checker run后才可证明good/bad/empty引擎行为；lint过仅形状/锚/schema，不是semantic PASS。

## 分账
机制账 mechanism-ledger.json：输入fixture版本/hash、命令、退出码、预期与实际（未跑引擎明确NOT_RUN）。
业务账 execution-report.json + execution-provenance.json + execution-coverage.json：真实请求/响应/监听PID/target SHA/源码hash；派生评价表不接受手造服务成功审计。
47 entries executed不等47完整子控；部分未齐以MissingFixture停NM，全部正向断言过但未经完整范围独立核也不给业务PASS。
register404直接拒绝契约失败组=FAIL；依赖合法账号/会话才能到达的audit/WS/disable子行为=NM，不把未执行子断言称已红。

## 真实发现的夹具缺陷与修复
- target依赖express初缺；root/server两级pnpm链接纠正，过程error不算业务失败。
- HTTP origin与Origin重复导致假CORS FAIL；现header key统一小写覆盖，复跑回到剩余SOP/MCP对照未齐NM，非产品缺陷。
- 第一次全组shell timeout保留进度，后改后台逐组close/incremental evidence；所有相关后台ID和输出已收，不为截止kill。
- SQLite snapshot UPDATE/DELETE必须精确errcode1811并验证副本可写，不接受readonly/lock异常当触发器拒绝。

## 未完成门
- 用户salt/hash、审计物理schema拟定映射待非作者；旧sso持久fixture无源NM；keyless正向不能直接INSERT票。
- 合法MCP/app-token跨scope、完整cookie/Odoo回跳、真实浏览器、默认8h与5/10m、全量分页/日志限量、锁桶中间跳与mapped更多子控仍未全齐。
- 无review签章、无正式submit/prepare/new spec、无check-construction/selfcheck/meta、无正式先红归档、无SSO业务实现或部署。
- 新增网络fixture仅localhost echo/401403/WS101；不会接管/auth API或生成wm_session。
