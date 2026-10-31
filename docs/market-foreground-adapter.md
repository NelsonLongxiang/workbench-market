# 固定d908前台adapter（代码提案；未部署/未注册服务）

## 目标与不做的事
scripts/ops/market-foreground.mjs是拟交SCM服务宿主调用的前台程序，不是Windows服务本体。它不修改已冻结DB-ONLY入口或包、不建立service/task、不安装宿主，不将现网PID186180纳管，也不部署main/#296/#303。生产部署须另得属主明确的服务对象/宿主版本来源与摘要/运行身份及ACL/开机与恢复策略/迁移窗口/回退授权。VM/系统/DSH重启验证未授权，均未做。

原detached launcher不能用来充当前台监督：本adapter核同一固定d9080a61包，自己启动一个detached:false worker，保持ChildProcess句柄与退出事件，不以launcher结束当任务成功；只对自己仍保有的child句柄停止，不接受外部PID/任意命令。它只证明代码约束和所列合成测试，不证明已修原e791退出、DSH Job或端口耗尽问题。

## 信任输入与固定边界
- CLI只收--config <absolute JSON path>；无自定义pin、worker路径/argv、ADMIN_TOKEN或探针配置。固定PACKAGE SHA256=2a3c7070be89d11d989afb75a948ec74c7940fda9de6a47c7b8c3ed496c68e6c，source=d9080a61cd5c6ca7e070cfa64971ffdb342f6f58；逐项文件hash/realpath及server/src/index.ts在manifest中才可启动。冻结对象只读。
- 配置项：packageManifest/dataDirectory/homeDirectory/eventLog必须绝对路径、目录已存在；port合法且给相邻端口保留control0，bindHost默认127.0.0.1，只有显式0.0.0.0可改监听范围（须部署授权）。maxRestarts默认0、最大3；restartDelaysMs默认[30000,120000,600000]、每项10秒至10分钟；readyTimeoutMs默认15秒、允许1–60秒。没有隐含开恢复。
- 环境仅保OS运行变量，显式PORT/WM_CONTROL_PORT=0/DATA_DIR/YGL_HOME/MCP_GATEWAY=on/REDIS_URL空/NODE_ENV=production/YGL_NO_UPDATE_CHECK。无继承ADMIN_TOKEN/LC/NODE_OPTIONS。不修改profile/PATH或读取原凭据字段。
- 启动前包核验、自己data下独占锁、market与adjacent端口独占试绑、只读SQLite仅查询DB admin存在布尔；不输出或返回其hash。锁已存在只拒，不自动删除/杀“持锁PID”。SQLite只读WAL连接仍可能触SHM，不宣全文件无写。
- 启动后有界读取health、browser-marked admin state为db/settablefalse、匿名不存在工具401，核adjacent仍空，再核实际Windows PID/exe/创建ticks与netstat监听owner匹配。端口预检不是原子OS预留到spawn，后核防冒foreign响应；核失败只收自己worker，不杀竞争者。
- Windows身份查询有界10秒分别执行netstat和Get-Process；查询失败直接关闭，不绕过。非Windows CLI身份不支持而拒绝；CI非Windows的module夹具必须明确标注synthetic identity，不外推现场。

## 生命周期、有限恢复与日志
一个adapter同时最多一个worker。worker退出码/信号上报到结果及事件。正常code0不重启；非零运行后退出仅在显式maxRestarts预算内按对应退避，恢复前重新核hash/端口/DBadmin。初始启动门失败、包变化、目录/日志/身份/锁失败不自动恢复。SCM外层自动恢复若另开，必须与本预算协调，防多层无限循环；本提案未配置SCM行为。

ChildProcess error不等于exit：没有创建PID的spawn失败可结束等待；已有PID的error仅使监督失败，不作为exit证据、不清retained句柄。必须清自己的worker并收到真实exit后才释放锁；停止抛错或超时仍保锁、报owned_worker_cleanup_incomplete，不按恢复预算另起worker。原bbc02e0 ready后error无exit却清child/锁的红态保留，新增零worker反例覆盖pre-spawn、ready前/后error、延迟exit、永不exit、停止抛错及有恢复预算不重起。

SIGINT/SIGTERM停止自己的child；退避可被信号取消。退出清理有界5秒，无法证明worker退出时保留锁并报manual cleanup，不启动fallback。Windows服务的控制消息如何转换成Node信号/进程停止还需受审宿主真实验证，未声称SCM优雅停止已通。强杀supervisor绕过finally时的worker/锁残留属于未证明保障；不通过自动删锁恢复。

日志独立于包/data/home，调用者须提供受限Windows目录ACL。追加不截断、不透明转存worker内容：仅时间/source/supervisor与workerPID、ready创建身份、起止/失败类别、退出码/信号、stdout/stderr字节数。16MiB上限，不自动删/轮转，写失败/短写/超限失败关闭并清自己worker；不存在持久化fsync/断电不丢承诺。现阶段不记录worker任意错误行，因此具体业务错误原因需另审脱敏诊断，不能把字节计数当完整日志。配置目录、package manifest和权限是可信运维面，本代码不抵御拥有本地写权限者并发替换/hardlink攻击。

## 配置样例（只说明，不执行）
配置由持权人放在受限目录。生产路径/端口由批准指定，示意键：

    {"packageManifest":"<冻结entry>/DB-ONLY-PACKAGE.json",
     "dataDirectory":"<已核绝对数据目录>","homeDirectory":"<已核绝对home>",
     "eventLog":"<独立受限日志目录>/market-events.jsonl",
     "port":9800,"bindHost":"127.0.0.1","maxRestarts":0,
     "restartDelaysMs":[30000,120000,600000],"readyTimeoutMs":15000}

命令形式：node scripts/ops/market-foreground.mjs --config <config路径>。这不是本机现网执行命令；本PR不附sc create/Register-ScheduledTask可执行安装脚本。

## 测试与已知失败
- market-foreground-test：零worker进程、零网络请求，真实文件/SQLite与受控ChildProcess句柄覆盖参数、hash、原文件hash错、foreign端口拒、缺DBadmin、日志路径/既存追加/满、锁、worker code、默认不恢复、有限恢复预算、身份失败cleanup、spawn故障、SIGTERM和adjacent出现等。mock不代OS权限/SCM。
- market-foreground-lifecycle-test：一个合成库/home/worker，仅固定形态health/state/MCP拒绝；单个foreign listener负例。独立观察者持有确切合成启动父进程句柄，等worker-ready后仅结束该父进程；核adapter/worker继续健康，夹具文件指令令worker退出7，核记录/失败传播/无自动恢复/锁释放。不是d908真实应用完整运行，不含DSH Job、SCM或VM重启。新测试只用module注入的合成manifest pin，CLI不能以配置替换固定pin。
- 首OS夹具在旧组合CIM/监听身份查询10秒超时而fail-closed，保tmp/foreground-adapter/lifecycle.log和tmp/foreground-lifecycle-WsDVvn；adapter清自己worker、无现网操作。后换有界netstat+Get-Process后单次实验10项通过，失败不抹去。曾有spawn-failure夹具预期结果返回而实际按安全门抛错，修夹具认reject，未放宽产品。
- 当前数据/目录权限错误有真实缺目录/目录代日志等反例，完整Windows拒绝ACL故障尚须持权合成环境补测，不把无admin内容或目录不合法等同覆盖全部ACL情形。

## 正式迁移与回退仍待本人授权
先锁定adapter新head、完整受审服务宿主版本摘要、帐号权限/配置日志ACL与对象名、开机触发/恢复次数退避、明确现PID186180的停机窗口。原独立备份与冻结包保留。未注册前不影响现网。实施时先禁重入触发，精确身份核后停止原PID，核端口空，再启新宿主并验源/身份/control0/拒绝边界；任何不符只停本次新候选并保持停机。属主另明确允许才用原固定d908入口回退，绝不自动e791/main/DB恢复。

后续合成VM重启和真实宿主停止桥接另授权；原admin/MCP客户端连续性与口令轮换由持权人隐藏输入验证。此PR不接收/复述秘密，不自动轮换或建立新会话，不动网络、LC或.88。
