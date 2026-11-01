# clean-r1 前台托管适配方案（Draft，未实现迁移、未部署）

## 1. 状态与唯一目标

旧 d908 前台托管方案已经过时。本 PR 保留的 adapter 代码仍固定旧包格式和摘要，**不能用来托管 clean-r1**；原有合成测试通过只描述旧实现，不是本新方案的通过证明。此轮仅迁移方案，不安装服务、不建账号/计划任务、不接管现网 PID。

新方案只面向已按属主 r2 批准上线的固定 clean-r1：

- source **108f2fdf0acbf233bd2094f0723377193caa9649**（含 #312/#313，不含后来 #325/#327/#328）。
- FROZEN-MANIFEST.json 的 SHA256 **ce652914ae6d3b0977cc7729bca12b0de71eec5f550ce809b6ec2842ee0ecc9b**。
- 唯一服务入口是该冻结包的 scripts/sop309-v6-package-start.mjs；不得重新拼装 server/src/index.ts 的启动环境来绕过启动器前置。
- 同一包保持只读，运行库/home/日志均在包外；不往包内放锁、测试库、日志或重建清单。

## 2. 拟议调用契约（只说明，不执行）

前台宿主保留一个 launcher 的 ChildProcess 句柄，detached:false，默认不自动恢复；参数只允许已批准的绝对数据库路径、端口和隔离 home：

    node <固定包>/scripts/sop309-v6-package-start.mjs
      --db <已核绝对路径>/workbench-market.db --port <批准端口>
      --home <批准数据目录>/isolated-home
      --start --ack-owner-approved-maintenance

--ack 标志是启动器的技术前置，**不是属主批准来源**。实际切换仍须先确认服务对象/真实数据目录/停止范围，并取得绑定固定包的维护批准。配置不得接受任意 worker 命令、可覆写包 pin、隐式个人 home、ADMIN_TOKEN/LC/DSH 环境或原始任意异常输出。

启动器自己执行完整性、exact application database、strict1、上传凭据格式、home 库存在和端口空闲校验，固定 MCP_GATEWAY=on、control0、NODE_ENV=production。本托管层不复制或弱化这些前置。

## 3. 空隔离 home 与授权边界

- home 必须是属主批准的专用隔离工作区，不默认回退个人工作区。建库是独立维护写动作，只在明确批准后完成；发现已有非空库须报告，不能清空。
- readiness 只读健康、冻结静态资源及匿名 MCP 拒绝形状；统一待办只核源元数据及零 ygl 行，不记录标题/项目/正文。
- 默认 grant 清单为空，不运行播种工具、不重签旧 run 读 capability、不重置/延长既有授权、不轮换上传凭据。旧 run 回迁须真实 run/subject/TTL 及归属证据清单和独立批准。
- #324 market 任务信封匿名读仍是独立安全修复；空 home 不等于主体级鉴权。不得因进程健康就宣称全部数据可见性安全。

## 4. 进程归属：不能只把 launcher 当服务

clean-r1 launcher 会再启动一个 server 子进程。托管层须区分 supervisor、launcher、实际监听 worker 三层，记录 PID/创建时间/可执行文件及 parent-child 关联，证明监听端口归实际 owned worker；不能拿 launcher PID 与端口 PID 不相等当成功，也不能只认端口响应就纳管别人的进程。

- 不接收待停止外部 PID 配置。停止只针对自己保有句柄且身份仍可证的 launcher/worker，绝不宽杀、杀父 cmd 或 DSH。
- 必须验证 Windows 上信号转发/关闭子树后端口确实释放；error 事件不等于 exit，无法证明 owned worker 退出则保留锁并要求人工处置，不再另起实例。
- wrapper 需要明确所有权停止桥接；现有旧 adapter 的单 worker 测试不能证明新的双层子进程停止链。
- 默认 maxRestarts=0。有限自动恢复如需启用，须另外明确次数/退避及与外部宿主的恢复策略，防止多层无限重启；初始包、身份、目录、strict、home或端口校验失败不自动恢复。
- 不自动起旧包、降 strict、还原数据库或旧凭据。失败只清本次受管进程，保持停机并报固定失败类别。

## 5. 日志与部署前须完成的验证

日志在包外受限目录追加，只记固定source/pin、PID/创建身份、起止时间、退出码/信号及字节数；不得透明转存 worker stdout/stderr、请求正文、凭据或个人路径全集。ACL/日志容量与轮转方案由属主或运维指定，不能把 POSIX 0600 当 Windows ACL 保证。

新实现交付前须在隔离环境完成：

1. 真实固定启动器与 FROZEN-MANIFEST 格式、全文件集合/哈希、包外日志/锁；篡改/错误路径/错库/错home/strict/占用端口均拒绝。
2. 默认一次启动及失败不恢复；launcher/worker 实际 PID 链和监听归属；伪造 foreign listener 不可冒用。
3. launcher error/exit 与 worker error/exit 四态；信号停止、超时、强杀宿主后的 owned child/残锁状态，不能只用 mock 证明跨 DSH 生命周期存活。
4. 默认零grant、零cap签发、零凭据恢复；空home元数据不外露个人待办。
5. 包冻结前后全树相等、测试产物全部包外；独立非作者复核与同一 head CI，之后才可交属主决定正式部署。

本轮没有运行新宿主或生命周期试验，以上均为**待实现/待验证**。旧 31/10 项测试、旧四绿或当前线上 clean-r1 的21项结果都不能移贴成新托管层已通过。

## 6. 当前服务及下一步

本日22:07起 clean-r1 已按 r2 正式维护启动，运行包和空home边界见维护记录（仓外证据路径由持权人保管）。该批准仅针对那次包替换，**没有批准本 PR、WinSW 或任何常驻安装**；本轮不触碰它。

下一步由属主/运维选择保留前台、受审服务宿主或其他已授权持久化方式；需明确宿主来源/版本摘要、身份权限/目录ACL、开机触发/恢复策略、维护窗口和失败停机方式。未决定前本 PR 保持 Draft，不合并、不装服务、不建账号、不改网络/LC/远端节点；代码迁移与真实宿主验证另经受领后执行。

## 历史实现保留（非本方案支持范围）

scripts/ops/market-foreground.mjs 及其旧 tests 保留用于复核 d908 候选的曾有约束与失败记录；当前 FIXED_SOURCE/PIN 仍是旧 d908/DB-ONLY 格式。明确废止其生产使用建议，不把改文档冒充实现迁移。后续实现应复用可采的 owned-handle/error-vs-exit/日志边界，删除旧固定入口假设，并逐项新增 clean-r1 反例。
