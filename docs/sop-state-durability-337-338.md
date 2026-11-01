# #337 / #338 SOP 状态持久化与活跃列表

独立候选，未部署；SQLite是持久真源，保持原30秒检查点语义，不改现网clean-r1或接口鉴权。

## 先红证据

- tmp/sop-state-checkpoint-red.log：真实index首次保存落库，30秒内第二、第三次保存仅在热态，静置31.1秒后SQLite仍缺后续字段。
- tmp/sop-state-active-red.log：Redis索引非空但不完整，漏新建未保存及task-center run。

## 实现

保存、私有读取、finish与A2A备注按run ID串行，不同run独立。A2A note等待SQLite写成功才返回DELIVERED，完整快照合并避免被后续checkpoint覆盖。新建先写SQLite，热态改为在队列内惰性初始化，避免fire-and-forget回填与保存/finish竞态。

首次保存立即checkpoint；随后已确认的完整数据快照保留至finish，挂真实30秒定时器。后续编辑不延后原截止时间（不是debounce）；无后续请求也会写SQLite。Redis失败时立即合并并写SQLite，包含本进程此前确认的未落盘字段；恢复缓存使用完整已知数据，避免只回填最后一个字段。

checkpoint失败保留待写快照并记录固定错误码，下个周期重试；首次/降级同步SQLite失败仍向调用者报错。finish先完成SQLite状态与数据写，成功后才清快照/定时器并尽力退役缓存。延迟checkpoint只更新running行；读取以SQLite status为准，不信已结束run的过期热态。

graceful shutdown先停止接收并排空请求，等待run队列/flush，再关闭SQLite；写失败或8秒排空超时非零退出。强杀不等于graceful shutdown，不保证强杀排空。

active列表始终查询SQLite running集合的既有元数据白名单；Redis集合仅作缓存提示，不决定哪些行存在。恢复running热态会补Redis索引，但列表正确性不依赖其完整。task-center保持SQLite直写，不强制进入Redis。

## 验证

scripts/sop-state-http-test.mjs使用真实index、全新合成DATA_DIR/home、内存Redis和回环备用端口；真实等待31.1秒，覆盖partial/空/故障恢复索引、未保存与task-center、元数据白名单、Redis丢失、降级合并、finish与并发保存。无生产Redis网络连接或业务库访问。

scripts/sop-state-checkpoints-test.mjs用虚拟时钟覆盖截止不延期、对象复制、写失败保留/重试、取消、同run顺序/不同run并行、错误不毒化队列、close排空与失败拒绝。它不是OS信号或网络Redis的证明。

两套测试接CI；最终fixed head的CI和非作者回验另记，不将打印PASS代替退出码。现有drawio新增专项候选页，旧总图仅历史背景，不冒当前部署。

## 已知边界

30秒是进程持续存活、队列可推进且SQLite可写时的目标；事件循环阻塞、慢Redis调用及SQLite故障可能延迟。这里不承诺每次热写fsync，也不保证进程和Redis在checkpoint前同时丢失时零丢失，未改Redis持久化配置。

本进程为触达的进行中run保留完整快照，内存成本与活跃run数据量相关；未证明跨worker/跨进程写或外部直接改库一致性。Windows child.kill可能强制终止，不能用它冒正常信号交付；单元close证据与系统层关停分开。

未动生产run/个人YGL/clean-r1、服务/WinSW/网络或DSH源码。不修其他权限问题、不合并不部署；按既有SQLite真源与30秒规范实现，无新增业务口味判断点。
