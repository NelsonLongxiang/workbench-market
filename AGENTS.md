# AGENTS.md — workbench-market 开发与运维守则

内网 web 工作台市场：登记/健康巡检/驾驶舱分屏/统一门户 /go//自产台发布。
本文件是 AI 会话与运维的作业基准；设计语言单一事实源在 `design-system/workbench-market/MASTER.md`。

## 项目结构与运行形态

```
pnpm workspace（根 package.json + pnpm-workspace.yaml）
├── server/   Express 4 + node:sqlite（DatabaseSync），Node 24 原生跑 TS，无构建步骤
├── web/      Vite 6 + React 18 + antd 5 + pro-components，构建产物 web/dist
├── scripts/  make-submission.mjs / gen-verifier.mjs / verify-report.mjs
├── verify/   验证器三件套（material.md / candidates.json / reviews.json，gen-verifier 生成，勿手改）
├── evidence/ E2E 脚本 e2e_test.py + 截图 + verify-report.html
└── design-system/workbench-market/MASTER.md
```

- 端口：**server 9800**（API + 静态托管 web/dist + 统一门户 /go/）；web dev 5173（代理 /api）。
- 数据：`server/data/workbench-market.db`（WAL；`DATA_DIR` 可重定向）+ `server/data/apps/`（自产台版本文件树）。
- 环境：node v24.12.0、pnpm 11.24.0。esbuild 构建白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`（pnpm 11 **不读** package.json 的 pnpm 字段）。

## 常用命令

```bash
pnpm --filter web typecheck          # tsc --noEmit
pnpm --filter web build              # vite build（六桶 manualChunks）
pnpm --filter server dev             # --watch 开发
(pnpm --filter server start > tmp/server.log 2>&1 &)   # 生产形态，分离式后台
npx antd-cli lint web/src            # antd 规范检查，必须 0 issues
python evidence/e2e_test.py          # E2E，要求 9800 存活；摘要落 evidence/e2e-summary.json
node scripts/make-submission.mjs     # 快照 DB + 封装提交物 tmp/submission + tmp/verify-snap.sqlite
node scripts/gen-verifier.mjs        # 重新生成 verify/ 三件套（改判据后必须重跑，否则 submit 到旧材料）
node scripts/verify-report.mjs <run_id...>   # 多代对照 HTML → evidence/verify-report.html
```

## 代码红线（本项目付过学费的坑）

1. **Node 24 原生 TS = strip-only**：不支持 constructor 参数属性、enum 等。`class HttpError { status: number; constructor(...) { this.status = ... } }` 显式赋值。
2. **node:sqlite 命名参数精确匹配**：`.run({...})` 的键必须与 SQL 命名参数一一对应，多余键（如整行对象带 last_status）直接 `Error: Unknown named parameter`。PUT workbenches 因此显式绑定 12 键。
3. **Express 挂载语义**：需要 middleware 读完整 req.url 时必须全局 `app.use(fn)` 自匹配；`app.use('/go', fn)` 会剥掉挂载前缀，正则与 pathFilter 全失配（404 是自诊断信号）。代理见 `server/src/index.ts` 统一门户节。
4. **antd 本机 5.29.3 vs antd-cli 6.6.4 版本错位**：lint 建议的 `railColor`/`showSearch` 对象式在 5.29.3 运行时未实现/类型缺失——用 `{...{ prop: value }}` spread 绕静态检查并留注释（先例：Dashboard.tsx Progress trailColor、Market.tsx optionFilterProp）。
5. **antd v5 cssinjs 注入顺序**：运行时注入的 `<style>` 排在静态 `<link>` 之后，同特异度按文档序后者胜——压运行时样式必须 `!important`（先例：`.wm-use-bar .ant-badge-status-text`）。
6. **验证器谓词与 schema**：TEXT 列禁数值谓词（SQLite 类型把戏）；`select` 禁裸 `*`；exists 助手 select 硬编码 `["key"]` 在无 key 列的提取表上会被 P2 **静默拒**——判据数对不上时 diff spec.json 的 vu[].source_clause 与 candidates。
7. **未提交工作区上的红测禁 `git checkout --`**：会连未提交功能一起回滚。用反向 patch（把篡改改回去）恢复。
8. **E2E 僵尸进程**：超时被杀的 playwright 会留 chrome 僵尸，累积后新 launch 挂死——`taskkill //F //IM chrome.exe`（确认无他人浏览器作业后）。
9. **http-proxy-middleware 4.x 三连坑**：① pathFilter 只认 string/glob/array/function，传 RegExp 直接抛错；② 默认 logger 是 noopLogger，配置错误**零输出**（配 `logger: console`），静默漏到 SPA fallback 返回 200 假绿；③ pathRewrite 会把结果**写回 req.url**，proxyReq 钩子里无法从 URL 反查工作台 id——需要按台注入的头（如凭据 authorization）必须在**前置中间件**（还知道 id 时）解析好挂到 req 上（先例：goAuth）。
10. **Playwright request.fetch 的自定义 Cookie 头会被 cookie store 接管忽略**：测 cookie 透传必须先 `page.context().add_cookies([...])` 再 fetch（先例：e2e_test.py 组 15）。
11. **WS upgrade 不流经 Express 中间件链、也不触发 HPM on.proxyReq 钩子**：`app.use` 挂的 goOrigin/goAuth 等准备全部缺席，upgrade 会被路由到默认 target 死端口；且浏览器 WS 握手必带门户源 Origin，上游 Origin-fence（如 DSH：Origin 必须等于 Host authority，cookie 名是 authority 的 sha256）会回 403/401。**upgrade handler 里必须重做全部准备并直接改 `req.headers`（origin=上游 origin、host=上游 host）再调 `goProxy.upgrade`**（先例：server/src/index.ts goServer.on('upgrade')；行为层由 e2e 组 15 的 socket 级 101 握手断言钉住）。

## 验证标准链（改 server/ 或 web/ 后必须全绿）

1. `pnpm --filter web typecheck` + `npx antd-cli lint web/src`（0 issues）
2. 9800 存活（`curl 127.0.0.1:9800/api/health`；死了按上面分离式重启）→ 重启才加载新 server 代码
3. `pnpm --filter web build`（改了 web 时；express.static 按请求读盘，重建后无需重启）
4. `python evidence/e2e_test.py` 全 PASS（当前 20 组；新增功能必须加用例）
5. 验证器：gen-verifier → make-submission → submit/prepare/run → 判据数符合预期 + 基线全 PASS；涉及新事实（端点/色值/文件）同步扩 gen-verifier.mjs 与 make-submission.mjs TEXT_FACTS
6. UI 改动跑 `tmp/ux_shot.py` 截图留证；新表面必须进 e2e_test.py 的 CONTRAST_TARGETS（对比度≥4.5，深底浅字配对）

## 运维要点

- **服务重启**：先 `netstat -ano | findstr :9800` 找 pid（注意 pnpm 包装父子进程，杀父 cmd 不够要杀 node 子进程），再分离式重启。
- **同机邻居进程勿误杀**：ygl webui :8642、DSH web :3080 是他人/别线进程；只动 9800。
- **备份**：`GET /api/export`（JSON 全量：工作台/类型/设置）或停服后文件级拷贝（WAL 模式拷 .db 需含 -wal/-shm；在线快照用 `VACUUM INTO`）。
- **导入**：merge 追加 / replace 清空（web 设置页有二次确认）。
- **统一门户**：`/go/<workbench-id>/` 反代任意注册台；代理剥 X-Frame-Options/CSP、改写 Location 与 Cookie；WS 升级已挂。自产台（url 以 / 开头）由门户中间件直接重写到 /apps/ 路径，不走代理。
- **自产台发布**：`POST /api/apps`（AI 会话直发通道；文件内联 JSON，UTF-8 文本，单文件≤2MB 总计），全版本快照存 `server/data/apps/<slug>/v<N>/`，发布即自动入册（type=market-app，探测短路=up）；`POST /api/apps/:slug/activate` 回滚版本。
- **SOP 台与分层持久化**：`POST /api/apps` 带 `kind:'sop'` + `changelog` 必填走 SOP 分流（首发 draft 不入册，publish 才入册，sop.yaml 见 parseSopManifest）；执行数据**Redis 热态 + SQLite 真源**：写路径 HSET `wm:sop:run:<id>:data/meta` + 活跃索引 SET，30s checkpoint 沉淀 SQLite（sop_runs 表），finish 全量沉淀 + Redis 条目 EXPIRE 3600 平滑淘汰。**Redis 接入**：环境变量 `REDIS_URL` 优先，其次 `server/data/redis.url` 文件（单行 URL，已 gitignore，现指向生产 `192.168.3.88:16379` jf-redis 容器），都没有则**自动降级全直写 SQLite**（redisHealthy()=false，所有状态层调用 no-op 回落，服务照常起）；启动日志 `[redis] 状态层已连接` 为准。**本机 6379 redis-server.exe（pid 会变）是他人服务，只进不用。**热态必须与真源同语义：retire 时同步最终 status（只清索引不改 status 会让 TTL 窗口内热读到过期 running——冒烟踩过）。

## ygl-trees 同步惯例（每次交付收口）

- `ygl-trees task add/done`（**省略 --project**——CLI 认项目名不认短 id；当前项目已 pin）
- 沉淀教训用 `kb add --title "..." -f <file> --tags a,b`（非位置参数）
- 收口 `ygl-trees doctor` 全绿后 git commit（master 单支；`tmp/` 已 gitignore，勿提交）

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 9800 | server 监听端口 |
| `DATA_DIR` | server/data | SQLite 与自产台文件根 |
| `REDIS_URL` | （读 `DATA_DIR/redis.url` 文件） | SOP 状态层 Redis 连接（优先级最高；缺省降级全直写 SQLite） |
