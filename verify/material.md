判据1：类型的 key 字段不得为空。
判据2：类型的 health_method 字段必须等于 GET 或 HEAD。
判据3：类型的 expect_status 字段必须为空或落在 100 到 599 之间。
判据4：类型的 default_port 字段必须为空或落在 1 到 65535 之间。
判据5：每个已注册工作台的 enabled 字段必须等于 0 或 1。
判据6：工作台的 last_status 字段必须等于 up、down、unknown 之一或为空。
判据7：工作台的 last_latency_ms 字段必须为空或落在 0 到 60000 之间。
判据8：工作台的 last_http_code 字段必须为空或落在 100 到 599 之间。
判据9：工作台的 sort 字段必须落在 0 到 9999 之间。
判据10：类型库中的工作台类型不少于 8 个。
判据11：内置类型 web 必须存在于类型库。
判据12：ollama 类型的探测路径必须为 /api/tags。
判据13：streamlit 类型的探测路径必须为 /_stcore/health。
判据14：巡检设置必须包含 health_interval_seconds、health_timeout_ms、health_concurrency 三个键。
判据15：工作台表中至少注册了 1 个工作台。
判据16：封装提交物必须包含 README.md。
判据17：封装提交物必须包含根目录 package.json。
判据18：封装提交物必须包含 pnpm-workspace.yaml。
判据19：封装提交物必须包含 server/package.json。
判据20：封装提交物必须包含 web/package.json。
判据21：封装提交物必须包含 server/src/index.ts。
判据22：封装提交物必须包含 server/src/db.ts。
判据23：封装提交物必须包含 server/src/health.ts。
判据24：封装提交物 web/src/pages 目录下的页面组件不少于 6 个。
判据25：封装提交物 web/src/components 目录下的组件不少于 2 个。
判据26：封装提交物必须包含 web/dist/index.html。
判据27：封装提交物 web/dist/assets 目录下的 JS 产物不少于 5 个。
判据28：封装提交物必须包含 scripts/make-submission.mjs。
判据29：封装提交物必须包含 scripts/verify-report.mjs。
判据30：封装提交物必须包含 verify/material.md。
判据31：封装提交物必须包含 verify/candidates.json。
判据32：封装提交物必须包含 verify/reviews.json。
判据33：封装提交物必须包含 design-system/workbench-market/MASTER.md。
判据34：封装提交物必须包含 evidence/e2e_test.py。
判据35：封装提交物 evidence 目录下的 PNG 截图证据不少于 10 张。
判据36：main.tsx 主题必须包含主色值「#1E3A5F」。
判据37：main.tsx 主题必须包含次级文字色值「#5A6577」。
判据38：main.tsx 主题必须包含成功色值「#059669」。
判据39：main.tsx 主题必须包含错误色值「#DC2626」。
判据40：App.tsx 侧栏 token 必须包含深底色值「#0F172A」。
判据41：index.css 必须包含焦点环色值「rgba(5, 150, 105, 0.6)」。
判据42：index.css 必须包含选中边框色值「rgba(5, 150, 105, 0.45)」。
判据43：App.tsx 标题区必须包含强调色值「#059669」。
判据44：设计规范 MASTER.md 必须包含主色值「#1E3A5F」。
判据45：设计规范 MASTER.md 必须包含次级文字审计色值「#5A6577」。
判据46：Dashboard.tsx 统计标签必须包含次级色值「#5A6577」。
判据47：Dashboard.tsx 在线环必须包含成功色值「#059669」。
判据48：Dashboard.tsx 离线卡必须包含错误色值「#DC2626」。
判据49：Dashboard.tsx 辅助文字必须包含轴色值「#94A3B8」。
判据50：index.css 必须包含主色淡底色值「rgba(30, 58, 95, 0.1)」。
判据51：index.css 必须包含深底色值「#0f172a」。
判据52：E2E 摘要记录的用例总数不得少于 25。
判据53：E2E 摘要必须标记全部用例通过。
判据54：E2E 摘要必须带有完成时间戳。
判据55：渲染层对比度探针覆盖的文字目标不得少于 9 处。
判据56：渲染层对比度探针不得存在未通过的目标。
判据57：index.css 必须包含深底状态文字规则选择器「.wm-use-bar .ant-badge-status-text」。
判据58：index.css 必须包含深底浅色文字色值「rgba(255, 255, 255, 0.85)」。
判据59：驾驶舱的 name 字段不得为空。
判据60：封装提交物必须包含 web/src/pages/Cockpit.tsx。
判据61：server/src/index.ts 必须包含驾驶舱路由「/api/cockpits」。
判据62：server/src/index.ts 必须包含「createProxyMiddleware」。
判据63：server/src/index.ts 必须包含剥禁嵌头的「x-frame-options」。
判据64：封装提交物 server/package.json 必须声明依赖「http-proxy-middleware」。
判据65：web/src/pages/UseWorkbench.tsx 必须包含「/go/${w.id}/」。
判据66：自产台的 slug 字段不得为空。
判据67：内置类型 market-app 必须存在于类型库。
判据68：server/src/index.ts 必须包含发布路由「/api/apps」。
判据69：server/src/db.ts 必须包含版本快照表「app_versions」。
判据70：自产台表中至少发布了 1 个应用。
判据71：server/src/index.ts 必须包含注入头名「authorization」。
判据72：web/src/components/WorkbenchForm.tsx 必须包含凭据表单字段「authValue」。
判据73：evidence/e2e_test.py 必须包含凭据注入断言字面量「e2e-bear-tok」。
判据74：server/src/index.ts 必须包含 WS 升级挂载「goServer.on('upgrade'」。
判据75：server/src/index.ts 必须包含握手 Origin 改写「req.headers.origin = u.origin」。
判据76：server/src/db.ts 必须包含运行真源表「sop_runs」。
判据77：server/src/redis.ts 必须包含状态层写入函数「runStateSave」。
判据78：server/src/index.ts 必须包含 Runner 服务端渲染「renderSopRunner」。
判据79：server/src/index.ts 必须包含运行 API 前缀「/api/sop/runs」。
判据80：evidence/e2e_test.py 必须包含 SOP 台用例字面量「e2e-sop」。
判据81：server/src/index.ts 必须包含 MCP 端点挂载「app.post('/mcp'」。
判据82：server/src/index.ts 必须包含工具注册表「MCP_TOOLS」。
判据83：server/src/index.ts 必须包含 JSON-RPC 错误码「-32601」。
判据84：evidence/e2e_test.py 必须包含 MCP 用例字面量「e2e-mcp-app」。
判据85：封装提交物必须包含 web/src/pages/Sops.tsx。
判据86：web/src/pages/Sops.tsx 必须包含状态语义表「SOP_STATUS」。
判据87：web/src/App.tsx 必须包含 SOP 路由「path: '/sops'」。
判据88：evidence/e2e_test.py 必须包含演示 SOP 字面量「demo-rack-sop」。
判据89：server/src/index.ts 必须包含列表掩码函数「maskSensitiveQuery」。
判据90：server/src/index.ts 必须包含掩码回传保护字面量「=****」。
判据91：server/src/index.ts 必须包含 API 出口统一脱敏函数「maskForApi」。
判据92：server/src/index.ts 必须包含 CORS 白名单「CORS_ALLOW」。
判据93：server/src/index.ts 必须包含 draft 拒绝文案「未上架不可执行」。
判据94：evidence/e2e_test.py 必须包含 MCP 泄漏探针字面量「token=8sKZ」。
判据95：server/src/index.ts 必须包含 Location 改写的 id 备份「goWid」。
判据96：evidence/e2e_test.py 必须包含 Location 改写断言字面量「redir-relative」。
判据97：server/src/index.ts 必须包含巡检重挂锚「issue #5」。
判据98：server/src/index.ts 必须包含删 SOP 清注册锚「issue #6」。
判据99：server/src/index.ts 必须包含导入 mode 锚「issue #7」。
判据100：scripts/import-smoke.mjs 必须包含运行时批探针字面量「e2e-import-probe」。
判据101：scripts/make-submission.mjs 必须包含干净克隆自愈「issue #13」。
判据102：README.md 必须包含验证器判据数锚「144 条判据」。
判据103：server/src/a2a.ts 必须包含上游一致签名面「canonicalPayload」。
判据104：server/src/index.ts 必须包含绑定管理口令头「x-admin-token」。
判据105：server/src/a2a.ts 必须包含节点短 id 持久化「a2a_node8」。
判据106：scripts/a2a-smoke.mjs 必须包含上游裁判「verifyCard」。
判据107：server/src/index.ts 必须包含 run 持久化链共用核心「sopRunStepSaveCore」。
判据108：server/src/index.ts 必须包含 MCP 执行数据工具注册「sop_run_step_save」。
判据109：evidence/e2e_test.py 必须包含人机同链断言字面量「agent-填-1」。
判据110：server/src/index.ts 必须包含导出脱敏锚「compliance 二期首项」。
判据111：server/src/index.ts 必须包含导入掩码跳过锚「掩码行（url 含 =****）不落库」。
判据112：evidence/e2e_test.py 必须包含导出脱敏断言字面量「E2E MaskImport」。
判据113：server/src/index.ts 必须包含注册 CRUD 共用核心「workbenchCreateCore」。
判据114：server/src/index.ts 必须包含 MCP 凭据拒绝锚「凭据不接受 MCP 写入」。
判据115：evidence/e2e_test.py 必须包含 CRUD 行为断言字面量「E2E MCP 台」。
判据116：evidence/e2e_test.py 必须包含导入隔离锚「import-smoke」。
判据117：README.md 必须包含执行数据工具名「sop_run_step_save」。
判据118：README.md 必须包含注册工具名「workbench_register」。
判据119：evidence/e2e_test.py 必须包含 CORS 行为断言锚「access-control-allow-origin」。
判据120：evidence/e2e_test.py 必须包含协议错误断言锚「-32601」。
判据121：evidence/e2e_test.py 必须包含 draft 泄漏探针锚「SecretStep」。
判据122：server/src/a2a.ts 必须包含 direct 准入核心「a2aDirectHandle」。
判据123：server/src/index.ts 必须包含 DELIVERED 路由桥「a2aDirectHandle」。
判据124：server/src/a2a.ts 必须包含幂等族锚「-32003」。
判据125：scripts/a2a-smoke.mjs 必须包含 P2 行为锚「TASK_STATE_DELIVERED」。
判据126：server/src/index.ts 必须包含网关开关「MCP_GATEWAY」。
判据127：server/src/index.ts 必须包含会话表「mcp_sessions」。
判据128：server/src/index.ts 必须包含审计表「mcp_calls」。
判据129：server/src/index.ts 必须包含远程收口锚「REMOTE_ALLOW_EXACT」。
判据130：scripts/gateway-smoke.mjs 必须包含网关行为锚「WWW-Authenticate」。
判据131：web/src/pages/McpGateways.tsx 必须包含管理页语义锚「默认拒绝」。
判据132：web/src/App.tsx 必须包含管理页路由「'/mcp-gateways'」。
判据133：ADMIN-TOKEN-SETUP.md 必须包含主人操作锚「setx ADMIN_TOKEN」。
判据134：server/src/index.ts 必须包含 cookie 池表「cookie_sets」。
判据135：server/src/index.ts 必须包含 Cookie 注入锚「goCookies」。
判据136：scripts/cookie-smoke.mjs 必须包含行为锚「过期 cookie 被过滤」。
判据137：server/src/index.ts 必须包含数据面表「app_data」。
判据138：scripts/appdata-smoke.mjs 必须包含行为锚「游标翻页」。
判据139：server/src/index.ts 必须包含文件面表「app_files」。
判据140：server/src/index.ts 必须包含文件名编码修复「fixFileName」。
判据141：scripts/appfiles-smoke.mjs 必须包含行为锚「50MB 上限 → 413」。
判据142：server/src/index.ts 必须包含远程白名单前缀「REMOTE_ALLOW_PREFIX」。
判据143：server/src/index.ts 必须包含读工具「app_data_list」。
判据144：evidence/e2e_test.py 必须包含 MCP 读工具行为锚「app_files_list」。
判据145：server/src/index.ts 必须包含分页校验「pageLimit」。
判据146：server/src/index.ts 必须包含上游聚合核心「mcpAggregatedTools」。
判据147：scripts/upstream-smoke.mjs 必须包含行为锚「taste__rules 转发成功」。
判据148：server/src/index.ts 必须包含上游身份透传锚「X-Market-Client」。
判据149：web/src/components/AppDataDrawer.tsx 必须存在且包含数据/文件双面锚「提交数据」。
判据150：scripts/a2a-smoke.mjs 必须包含就绪探测「waitReady」。
判据151：server/src/index.ts 必须包含口令库存储「admin_token_sha256」。
判据152：web/src/pages/Settings.tsx 必须包含口令设置 UI 锚「/api/admin-token」。
判据153：server/src/index.ts 必须包含上游凭据出口掩码「maskUpstreamsSetting」。
判据154：scripts/appfiles-smoke.mjs 必须包含孤儿文件断言「404 不落盘」。
判据155：server/src/index.ts 必须包含口令加盐哈希「hashAdminToken」。
判据156：scripts/token-smoke.mjs 必须包含出口剔除断言「无 admin_token_sha256」。
