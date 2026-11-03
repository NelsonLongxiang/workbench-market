# #351 Redis恢复与SQLite缓存权威

独立修复，不修改已合PR344的checkpoint协议；未部署生产。

## 状态机

- create/connect pending保持降级；socket connect或connect Promise resolved本身不恢复热路径。
- 实际当前client的ready事件且isReady=true时解除degraded；重复ready幂等。
- error/reconnecting/end立即进入降级，error不输出上游错误原文（可能含连接信息）。旧client事件不改变当前client状态。
- 首连Promise失败记录固定文案；之后真正ready可恢复。迟到Promise resolve不会覆盖较新的error，迟到失败也不重新降级已经ready的连接。
- 未配置URL不创建client、不回落默认Redis地址；redisHealthy仍同时检查client.isReady。

## 恢复后旧缓存没有新权威

ready仅恢复transport可用性，不直接取出或合并Redis内容。实际index保存/私有读/finish仍按run队列，优先本进程已确认完整快照；无pending时调用runStateLoad并传SQLite当前runCacheCheckpoint。该指纹包含data目录命名空间、run ID/slug/version/started_at、cache_revision、status及原始data。runStateLoad只接受同指纹v2；降级期间任何持久写（同值也算）推进revision，残留旧Redis即miss。恢复发布始终使用当前SQLite指纹及完整已知数据，不能仅翻布尔就信旧缓存。没有修改/绕过该机制，不清生产Redis来伪造一致性。

## Regression testing

Test the lifecycle state machine with controlled client events, including pending connect, ready, repeated ready, errors, reconnecting, end, stale client events, first-connect failure, and late Promise settlement. Assert that transport readiness is the only recovery signal and that configuration absence does not create a client or use an implicit Redis endpoint.

Exercise the HTTP and SQLite persistence path with a disposable store and a controllable Redis test double. Verify that writes during disconnection are durable in SQLite; old Redis contents are not trusted after a checkpoint changes; recovery reloads the current SQLite generation; and cold process restarts, subsequent writes, finish operations, and active-run listings preserve that authority.

Add a mutation test that removes checkpoint comparison and assert the cold-recovery test fails. An optional real-network integration may use a temporary, digest-pinned Redis container with an ephemeral loopback-only port and no persistent volume; label and inspect the exact test container, remove only that container in a finally block, and never connect to an existing service. Do not report a skipped integration as a pass. These tests do not prove every network failure mode, offline command replay, cross-worker consistency, or production configuration behavior.
