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

4. scripts/redis-ready-fingerprint-mutation.mjs：只在子进程loader移除checkpoint比较，同一恢复集成必须在冷读取SQLite NEW断言失败；驱动exit0表示成功观察预期红态，不是变异产品PASS。最初变异未传入清洁子环境的准备错误保留，修正后准确命中断言。
5. scripts/redis-ready-network-test.mjs：可选Docker实测，要求REDIS351_TEST_IMAGE为redis@sha256完整digest，只创建唯一标签、无卷的临时Redis容器，端口仅发布127.0.0.1随机端口。实际node-redis通过自有TCP代理，在保留Redis内容时断流→SQLite降级写→冷恢复/同进程恢复，检查hot路径、指纹更新、finish。finally按精确容器ID+本轮label复核后移除，仅触本轮容器；测试不连接默认6379或生产。此测试原件必须单独读取，不在无Docker环境报SKIP为PASS。

CI增加状态/HTTP/指纹变异三套#351测试，并保留其余安全矩阵。真实网络测试已在本机Windows Node24.12/Docker29.8.2，以redis@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f运行10/10 exit0并确认删除本轮容器；这是TCP断流测试，不证明所有网络错误/离线命令重放。自动重连策略、Redis持久化/TTL、30秒时限、跨worker一致性及生产配置未改。

授权来源direct-dd4e4bc8；当前规范v1.14，中档行为修复按scope自验+独立/机器复核及同head三CI绿后处理PR，不以旧v1.12另设门。未触个人YGL、生产库/Redis、服务、DSH检出，无新业务口味判断点。
