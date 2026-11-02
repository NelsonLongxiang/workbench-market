# #326 启动安全自检：固定匿名断言与启动门闩

范围：各面监听后，用固定 127.0.0.1 和实际监听端口对本服务做匿名安全断言；自检结束前，入口门闩拒绝外部 HTTP、市场 WS 和内容面 WS，不运行任何业务工具。失败只关闭本次进程创建的服务器并以非零退出，不查杀父进程或宿主。

固定表：market匿名MCP initialize=401且Bearer challenge；tools/list=401；market带本面Origin的POST /api/workbenches、固定空name/url=403；无Origin同一非法写=400（纯校验、零业务写对照）；control实际监听才测GET /api/mcp/sessions=403。控制面关闭或监听失败按既有面语义标skip；只有明确 NODE_ENV=development 或 NODE_ENV=test 时，显式MCP_GATEWAY=off 才把两条MCP行降为warning，其他行仍强制。production、未设、空值或其他运行模式配off时，两条MCP行具名fail（gateway-off-forbidden），启动门闩不开放且本进程非零退出。

门闩只给本轮私有随机标记、真实回环socket、预先登记的本地port/method/固定path组合放行；该标记只穿过门闩，不绕过原鉴权或输入校验、不出现在日志/health。伪造普通self-probe头不享受标记。请求无Cookie、无Bearer、无管理口令，禁redirect跟随，1.5秒超时失败。

health在完成前passed=false/at=null、503；通过后200与self_probe行摘要。失败行具名，不记录请求/响应正文、凭据、业务参数或原始异常。真实probe记录统一source=self-probe，采纳计数排除本轮内部请求。

合成测试：模块正反矩阵、真实 index.ts 的鉴权移除/浏览器写门移除/超时 mutation、内容面 HTTP/WS 门闩；所有测试只使用新 DATA_DIR/隔离 home 与回环备用端口，不读取生产或个人工作区。明确开发/测试模式的显式 off 仅减去 MCP 两个拒绝请求，仍检查管理写和无 Origin 对照；生产/未设/空/未知NODE_ENV+off必须拒绝。仓内匿名MCP合成实例显式声明NODE_ENV=test，生产控制面用例保持production并开启网关。控制面未监听不主动连接配置端口，避免探测其他进程。

拒写探针不运行成功路径，不调用 tools/call。启动初始化仍有产品本来的 schema/内置任务中心种子写入；“探针不落库”指探针自身不创建/变更业务对象，不能误称整个启动过程无数据库写。

这是离线实现/PR范围，不是生产操作或clean-r1改包授权。#309/#324仍各案处理；每次新安全修复须往固定自检表加行及对应正反测试，不用自检替代主体级授权。
