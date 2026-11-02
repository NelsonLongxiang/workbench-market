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

## 测试

1. scripts/redis-ready-state-test.mjs：提取当前真实startRedis/redisHealthy函数到VM，createClient仅受控事件；17项覆盖pending/connect/ready/error/reconnecting/end/重复/首连失败/迟到Promise/无配置。原实现6FAIL，修后全绿。此非真实Redis网络测试。
2. scripts/redis-ready-recovery-http-test.mjs：实际index HTTP、SQLite、owned child进程，Redis模块使用仅测试hook替换为文件型fake（支持实际on/ready/error/reconnecting事件），全新合成库/home/备用loopback。验证断连写persisted=sqlite、旧Redis仍残留、ready后persisted=redis+checkpoint、多轮恢复；另run跨进程冷重启排除内存ACK遮蔽，旧快照指纹不匹配→SQLite NEW→重新发布当前代次→hot续写/finish及active列表。最初空SOP定义400属setup失败保留；修正定义后原实现真实失败于ready未恢复热写，不当绿。
3. 原sop-state-restart20、HTTP14（含31秒静置）、checkpoint21继续运行；fixture旧offline/online现在发真实生命周期事件，无生产Redis网络连接。

CI增加两套#351测试，并保留其余安全矩阵。暂未模拟真实node-redis TCP断连/重新握手与命令重发；不以事件fake证明跨网络所有语义。自动重连策略、Redis持久化/TTL、30秒时限、跨worker一致性及生产配置未改。

授权来源direct-dd4e4bc8；当前规范v1.14，中档行为修复按scope自验+独立/机器复核及同head三CI绿后处理PR，不以旧v1.12另设门。未触个人YGL、生产库/Redis、服务、DSH检出，无新业务口味判断点。
