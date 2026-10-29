# 工作台生命周期只读收件箱与签发原语——降级交付

> 当前候选：**禁止HTTP审批**。`POST /api/lifecycle/approve`无条件503 `LC_APPROVAL_READ_ONLY`，先于配置、会话、私钥和引擎访问；没有环境变量或请求参数可重新开启。界面只显示只读原因，不提供批准按钮。以下历史功能说明不代表当前支持HTTP批准；真正审批入口必须另完成源隔离、独立对抗验证与授权。生产LC配置未由本修复启用。

对应 lifecycle-os 设计 v1.1 第九节：业务审批人在工作台「统一待办」里看到并批准生命周期提议，点下去调用内核 `lc approve`。本仓只做工作台这一侧；飞书审批卡片（`feishu-card`）和 A2A 网关（`a2a-gateway`）的签发是后续工作。

## 1. 做了什么

| 面 | 位置 | 说明 |
|---|---|---|
| 断言签发 | `server/src/lifecycle.ts` `signLcAssertion` / `lcReqHash` | 与 lifecycle-os `tools/assert.cjs`、`plugins/ygl-lc` 同一契约（逻辑复制，不跨仓 import）：`base64url(声明JSON).base64url(ed25519 签名)`，声明 `{iss:"workbench", sub, aud:"lc", req, iat, exp, nonce}`，缺省有效期 300 秒（上限 600），nonce 每张 16 字节随机。只为人签：`sub` 必须是 `user:<登录名>`。 |
| 身份确认 | `resolveOdooViewer` | 取浏览器带来的 Odoo `session_id`，向 `LC_ODOO_URL` 的 `/web/session/get_session_info` 现查（每次都查，Odoo 侧注销即刻生效），`result.username` 即 Odoo 登录名 → `sub = user:<登录名>`。Odoo 地址只认环境变量，不取工作台注册表（注册表可经 MCP `workbench_register` 登记，不能当身份源）。 |
| 统一待办生命周期源 | `GET /api/tasks` 的 `sources.lifecycle` 与 `source:"lifecycle"` 条目 | 仅在配置了 `LC_*` 时出现。按查看人调 `lc inbox`（每次调用为 `inbox` 现签一张断言），条目带 `lc{proposal_id, grant, object, machine, from, to, effective_at, proposed_by, approvals, levels}`。同一查看人 30 秒内复用结果、批准后即失效；响应 `Cache-Control: private, no-store`。未登录/未配置/引擎失败 → `ok:false` 降级，不影响其它源。 |
| 批准（当前不可用） | `POST /api/lifecycle/approve` | 无条件503，错误码 `LC_APPROVAL_READ_ONLY`。不认证、不签发、不调用引擎。JSON/Origin门不构成同源攻击防线。 |
| 自检 | `GET /api/lifecycle/status`（要 `X-Admin-Token`） | 回 `configured / missing / problem / engine_version / pubkey / key_error / test_mode`，公钥给属主核对登记；不回私钥路径与环境变量值。 |
| 门户会话转发 | `server/src/odoo-session.ts`、`portal.ts`、`index.ts` 的 WS 升级段 | 只有**可信 Odoo 源**（`LC_ODOO_URL` 的源 ∪ `WM_ODOO_ORIGINS`，按 `new URL(url).origin` 精确比对）的台走 SSO v1、拿得到 `session_id`；其余台——包括登记成 `type=odoo` 或地址里带 `:8069` 的——HTTP 与 WS 升级都剥掉它、也不再给 SSO 跳转，其它 cookie 照旧。可信源的 SSO v1 行为不变（过 state 后只透 `session_id`，未过 state 仍剥）。`lifecycle.ts` 用同一模块取会话，所以缺这一改动本功能编译不过。 |
| UI | `web/src/pages/Tasks.tsx` | 生命周期条目与查看人可显示，审批控件已移除，逐条显示“仅查看：同源门户/SOP隔离未完成，工作台审批已停用”。 |

调用 lc 的方式：`node "$LC_YGL_BIN" lc <动作> --旗标 值…`，子进程环境是白名单——只有 `PATH/HOME` 等运行所需、`YGL_HOME=$LC_YGL_HOME`、`YGL_SESSION=lc-proto`、`YGL_NO_UPDATE_CHECK=1`、`LC_ASSERTION`；不继承本进程的 `LC_ACTOR`/`LC_CLOCK` 等。引擎版本不等于 0.116.1 就不调；版本按引擎文件的真实路径、大小、mtime 缓存，同一路径换了包会重新核对。`LC_TEST`/`LC_IDENTITY_FILE` 只在工作台进程自身 `LC_TEST=1` 时透传，仅供端到端测试。

历史HTTP批准曾记一条审批；当前HTTP批准不具执行能力。`lc release`仍是独立授权动作，本候选不提供替代审批入口。

## 2. 部署配置

| 环境变量 | 含义 |
|---|---|
| `LC_YGL_BIN` | ygl-trees 引擎入口（钉 0.116.1，例如 `…/ygl-trees/tmp/wt-0.116.1/dist/bundle/bin.cjs`） |
| `LC_YGL_HOME` | 运行工作区（`~/.ygl-trees-lc`），须绝对路径；`LC_TEST=1` 时指向运行工作区（含子目录）直接拒，启动时打印原因 |
| `LC_WORKBENCH_KEY_FILE` | 工作台签发私钥（PKCS#8 PEM）：绝对路径、不在本仓内（软链目标也查）、权限 600、ed25519，否则拒签 |
| `LC_ODOO_URL` | Odoo 地址（与门户 SSO v1 同一个 Odoo，例如 `http://<同主机>:8069`）；它的源自动算可信 Odoo 源 |
| `WM_ODOO_ORIGINS` | 其它可信 Odoo 源，逗号分隔（例如 Odoo 台登记的地址与 `LC_ODOO_URL` 不同源时——服务端走回环、浏览器走主机名——把台的源加进来）。非法项忽略并在启动时列出 |

以下仅说明经另行批准后只读源的配置，不允许据此启用HTTP审批。四项任一设置即尝试只读生命周期源，缺项时源显示「未配置：缺 …」。前提：Odoo 与市场**同主机名**（SSO v1 的前提——Odoo 的 `session_id` cookie 按主机名共享给市场端口，`/api/*` 才收得到）；工作台进程能执行 `git`（插件非测试模式要核对 lifecycle-os 的 `decl/` 已提交）。

## 3. 属主需要提供

1. **工作台签发密钥对与公钥登记**
   - 在跑市场服务的机器上生成：`node tools/assert.cjs keygen --issuer workbench`（lifecycle-os 仓内执行；私钥写到 `~/.config/yuanguang-lifecycle-os/keys/workbench.key`，权限 600，打印公钥十六进制）。把 `LC_WORKBENCH_KEY_FILE` 指向这个私钥文件。
   - 把公钥十六进制填进 lifecycle-os `decl/identity.yaml` 的 `workbench` 行，替换占位 `__P:ISSUER-KEY-WORKBENCH__`，**提交并推送**（非测试模式下 `decl/` 有未提交改动插件就拒写；只提交不推送，导出的声明哈希对不上已推送的提交）。
   - 起服务后用 `GET /api/lifecycle/status` 核对 `pubkey` 与登记的一致。
2. **Odoo 用户表的账号类型字段**：`decl/identity.yaml` 的 `principal_source.account_type_field`（占位 `__P:ODOO-ACCOUNT-TYPE-FIELD__`）要定成 `res.users` 上区分「人 / agent」的字段。工作台用的是 Odoo 登录名（`res.users.login`，即 `get_session_info` 的 `username`），主体镜像必须以同一登录名写成 `user:<login>`，否则 lc 报「主体未登记」。
3. **同步 Odoo 用户的服务账号**：一个只读 `res.users`（登录名、是否启用、账号类型字段）的 Odoo 账号，供 `tools/sync-principals.cjs` 直连拉取（现在只吃导出的 JSON）。同步以 `system:odoo-sync` 身份写入、用 `ops` 入口签断言，所以 **`ops` 入口的密钥对与公钥登记（`__P:ISSUER-KEY-OPS__`）** 也要一并到位，否则运行工作区没有主体镜像，所有审批人都会被拒为「未登记」。
4. **可信 Odoo 源**：门户只把 Odoo 会话转给 `LC_ODOO_URL` 的源与 `WM_ODOO_ORIGINS` 里的源。Odoo 台在工作台里登记的地址若与 `LC_ODOO_URL` 不同源（例如服务端用回环地址、浏览器用主机名），要把登记地址的源写进 `WM_ODOO_ORIGINS`，否则这个 Odoo 台的单点登录会退回 Odoo 自己的登录页；两项都不设时所有 Odoo 台都不免登。
5. **审批人授权**：业务审批人要在 lc 里有覆盖对应域的 `grant`（`lc grant --grantee user:<login> --domain …`），否则待办为空、批准被门禁拒。

## 4. 安全边界与已知限制

审批身份就是用户的 Odoo 会话：谁拿到 `session_id`，谁就能以这个人的身份让工作台签出审批断言，lc 的「只有人能批、不是提议人、授权有效」三道门都会通过。所以边界取决于这个 cookie 会落到谁手里、谁能替浏览器发请求。

**已修（评审 P1，两轮）**：
- 门户原先把浏览器的整个 Cookie 头转给非 Odoo 类台，台的运营方（台可由 agent 经 MCP 登记）拿到 `session_id` 后能从服务端伪造审批。现在 HTTP 与 WS 升级两条路径都剥掉它（S4a–e，main 上先红）。
- 第一轮修复仍按「类型含 odoo / 地址有 :8069」决定谁算 Odoo 类台，agent 登记一个 `type=odoo`（或地址里带 `:8069`）的台就能绕过：台自己的页面与市场同源，脚本用 `document.cookie` 造一个 `wm_sso_ok_<id>=1`，门户就把会话转过去。现在只认可信源（S4h–k、S4p，修复前在本分支先红 4 例）。S3n 走完整收割链：普通台与两种假 Odoo 台把门户转来的 Cookie 头从服务端重放给审批接口，一律 401、引擎零调用；把判定临时改回旧口径时，假 Odoo 台的重放拿到 200、真签出了审批。
- 一个可信源都没配（`LC_ODOO_URL` 与 `WM_ODOO_ORIGINS` 都不设）时谁都不转（fail closed）：登记成 `type=odoo` 或地址带 `:8069` 的台既不给 SSO 跳转，HTTP 与 WS 也收不到 `session_id`（S4r–t；改动前在本分支先红：首访 302、会话照转）。代价是这种部署里 Odoo 台的免登不生效，台内显示 Odoo 自己的登录页，启动时提示把 Odoo 台的源写进 `WM_ODOO_ORIGINS`。

**硬限制（PR 说明须原样写明：人的审批只和市场同源下每一个页面一样安全）**

- **同源页面里的脚本**：`/go/<id>/` 代理台与市场同源；SOP Runner（`/sop/<slug>/`）把步骤 HTML 原样嵌进页面且不加 CSP sandbox，SOP 可由 agent 经 MCP `sop_publish` 发布。这两类页面里的脚本能带着用户的 cookie 调 `/api/lifecycle/approve`，请求门（JSON + `X-WM-Lifecycle` + 同源 Origin/Sec-Fetch-Site）挡不住同源请求。自产台（`/apps/`）有 CSP sandbox（不透明源，`Origin: null` 被拒），不在此列。真正的修法是源隔离：把 `/go/` 与 `/sop/` 挪到独立的源或子域，或把审批确认放到这些页面驱动不了的源上。
- **`wm_sso_ok_<id>` 可被同源脚本伪造**：服务端设的值恒为 `1`；虽带 HttpOnly，cookie 不存在时同源脚本仍能用 `document.cookie` 新建同名 cookie。现在只有可信 Odoo 源会收到会话，所以伪造它不会把会话交给不可信方，但会绕过 P10 的防会话固定（先种下攻击者的 `session_id`，再造 `wm_sso_ok`）。把值绑定到服务端（state 的 HMAC）另立 issue。
- **同主机名的其它服务**：cookie 不按端口隔离，用户直接访问与 Odoo 同主机名的任何端口时，浏览器都会把 `session_id` 带过去。市场管不到；部署上不要在 Odoo/市场的主机名上跑不可信服务。
- **为什么没做「市场自签审批 cookie」**：签发这种 cookie 的那一步本身也只能凭 Odoo 会话确认身份，拿到被盗 `session_id` 的人同样能先签一张，所以它单独关不掉服务端伪造。要关掉，必须让台根本拿不到会话，也就是上面已修的转发剥除。SSO v2（`docs/sso2-contract-v2.md` 的市场自建会话）落地后，身份确认应改为「市场会话 → Odoo 登录名」。
- **nonce 账本增长**：每次实际调 lc 都在 `lc_nonce`（只追加）留一行；统一待办每个查看人最多每 30 秒一次 inbox。
- **测试模式**：`LC_TEST=1` 只在端到端测试里设；运行工作区 `~/.ygl-trees-lc` 本身不认测试模式。入口公钥仍是占位时，运行工作区只能读，生命周期源会显示 lc 拒绝原因（「公钥未配置」）。

## 5. 历史测试与证据（仅遏制之前的作者结果，不用于当前head放行）

当前候选S3要求所有HTTP审批（含完整同源头/SOP Referer/合法形状session）503，Odoo/引擎零调用；旧表“批准成功”不再是本版目标。签名原语单测保留，E2E的HTTP段改为拒绝/nonce及账本不变，直接插件绑定测试保留。缺真引擎/声明仓时仍NEEDS，不冒通过。

| 命令 | 内容 | 结果（feat/lc-workbench-issuer，2026-10-29） |
|---|---|---|
| `node scripts/lc-issuer-unit.mjs` | req 哈希 8 例与整张断言 3 例金向量（由参考实现生成，ed25519 确定性签名逐字节对比）；本机有 lifecycle-os 时与 `tools/assert.cjs` 随机对拍 300 例；声明结构与插件同款验签；只签人、有效期、nonce；命令行组装；私钥文件门；请求门；配置门（测试模式不许指向运行工作区）。CI 已挂。 | 56 / 0 失败 |
| `node scripts/security-lc-approve.mjs`（亦由 `security-adversarial-smoke.mjs` 作为 S3 组调用） | 隔离实例 + 替身 Odoo + 替身引擎。11 例对抗全拒且引擎零调用；对照放行：命令行恰为 `lc approve --proposal P --grant G`、断言验签与 req 重算、子进程不带 `LC_ACTOR/LC_CLOCK`、两次审批两张 nonce、统一待办按查看人出现、`no-store`；状态面要管理员口令；S3n 会话收割链（HTTP 与 WS）重放 → 401；S3o 同一路径换成 0.117.0 引擎 → 503 不调用。 | 15 / 0；main 上先红 |
| `node scripts/portal-odoo-session-smoke.mjs`（S4 组，同上接入） | 判定谓词 10 例（类型/端口/userinfo/相似主机/换协议/换端口都不算可信）与可信源合并；两个记录型上游（可信 Odoo / 攻击者）看门户实际转发了什么：普通台 GET/POST/只有会话/多个同名/WS 都收不到 `session_id`；攻击者源登记成 `type=odoo`、路径或查询带 `:8069`，走完 SSO 回跳（门户给的话）再加伪造的 `wm_sso_ok`，HTTP 与 WS 都收不到；对照：可信源走真实 state 回跳后只收到 `session_id`，未过 state 仍剥。 | 16 / 0；main 上先红 2 / 7（剥除前），按类型/端口判定时先红 7 / 4（h–k），未配可信源仍回落时先红（r–t：首访 302、HTTP 与 WS 照转会话） |
| `node scripts/lc-issuer-e2e.mjs` | 真引擎 0.116.1 + lifecycle-os 插件，`$LC_OS_DIR/work/wb-issuer-e2e/<ts>/` 全新工作区、`LC_TEST=1` + `LC_IDENTITY_FILE` 换测试公钥、`sync-principals.cjs` 写主体镜像。经 HTTP：pm-a 看到 4 条、pm-b 为空、停用/未登记被拒；批准 applied 且账本行 `caller.iss=workbench`、声明哈希对得上；pm-b 批被门禁拒。直接对插件：为请求 A 签的断言用于 B 被拒、被拒后作废、inbox 断言不能复用也不能拿去批、成功的断言重放被拒、别的私钥/过期被拒。 | 26 / 0；main 上先红（缺模块） |

另：`pnpm check`（web tsc + server 语法核 28 文件）通过；依赖 Odoo 免登的三个既有冒烟（portal-sso、portal-sso-p8910、sso-gateway）在测试环境里显式设了 `WM_ODOO_ORIGINS`；门户/SSO/cookie 既有冒烟（portal-sso、portal-sso-p8910、portal-cookie、portal-p13、portal-rewrite、portal-p6711、cookie、remote-allow-obs）在本分支与 main 上结果逐一相同（sso-gateway 两边都是 5/7，sso-callback 两边都崩，均为既有）；`omni-a2a-smoke` 14/14；`omni-dashboard-smoke` 4/4（需先 `pnpm build`）；`omni-inbox-smoke` 12/13，唯一失败的 J1 要求本机 PATH 上有 `ygl-trees` CLI，在未改动的 main 上同样失败。

## 6. 拆分提交（建议）

评审要求门户修复先于本功能合入。改动按文件可以干净拆成两笔：

1. **门户：Odoo 会话只转给可信 Odoo 源**——`server/src/odoo-session.ts`、`server/src/portal.ts`、`server/src/index.ts` 的 WS 升级一行、`odoo-session.ts` 导入与启动时的可信源告警、`scripts/portal-odoo-session-smoke.mjs`、`scripts/security-adversarial-smoke.mjs` 的 S4 接入、README 的 `WM_ODOO_ORIGINS`。
   未配可信源时 fail closed（`isOdooSessionTarget` 不再回落类型/端口）与三个 SSO 冒烟设 `WM_ODOO_ORIGINS` 也属这一笔（已提交的 73cf1c2 之后在工作树里改，尚未并入）。
2. **工作台签发入口与生命周期源**——其余文件；`lifecycle.ts` 依赖第 1 笔的 `odoo-session.ts`，不会先于它合入。
