# #288 执行源隔离实施方案（待属主审阅，未授权实施）

日期：2026-10-30。方案基线：main dcb36036251e532a73439e0c9d79c78bdf01636b，含 #289 内部门。依据：#290 的源面调查与浏览器原件，以及 #288 评论6521820976。

**本提交仅文档。未改产品、DNS/hosts、反代、证书、任何实例配置；未解除 LC_APPROVAL_READ_ONLY、未实现 grant。** 属主本轮仅批准先出本方案，审阅并明确批准实施后才动代码。下文主机名、能力接口、规模与时间均为候选/估计，不是已配置事实或已批准接口。

## 1. 推荐选择与要属主确认的一件事

**推荐：可信市场/Odoo保持原入口；不可信内容放独立站点的专用内容主机名，HTTPS，仅内容端点、零市场Cookie/零Odoo会话转发。**

提交属主确认的实施选项为：采用下表三套“独立内容站点”候选名，并由各机运维提供DNS/证书/回退；批准后先测试机隔离验证，再.156灰度；.88预备役不部署，另等上线令。不能把“批准写方案”解释成批准配置或生产切换。

| 环境 | 可信入口 | 内容主机名候选（未配置） | 解析/反代目标 | 谁需操作 |
|---|---|---|---|---|
| jfaiubuntuservers 测试机 | 保留现有市场:9800/Odoo:8069的实际同主机名；地址尚未核定 | https://wm-content-test.test | 由测试机运维确认该主机IP后，内网DNS或参与测试终端hosts指向它；HTTPS反代到仅回环内容listener | 运维核主机与容器、设DNS/hosts/证书与反代；admin浏览器测试由属主/授权人工 |
| .156 LONGXIANG 灰度 | 保留当前实际市场入口（IP或已有名），不在本阶段换可信登录authority | https://wm-content-gray.test | 内网终端解析到<灰度机LAN地址>（必要时VPN终端用<灰度机VPN地址>）；HTTPS反代到独立内容listener，后者不公开管理API | Windows运维设hosts/DNS/受信CA/反代；#284先恢复，部署操作须既有授权 |
| .88 预备役生产 | 未确认生产市场/Odoo入口，不能猜已有部署 | https://wm-content-prod.test（仅预留） | 未来运维按批准排期指向.88；本次不创建记录/证书/listener | 属主单独排期后由.88运维执行；当前只保A2A通路 |

.test 是保留测试后缀，不依赖公网注册；可作私网DNS/hosts+私有CA的测试/灰度候选。若公司要正式内网服务名，应换成公司实际控制的**独立注册域/站点**，不能编造已有公司域名。生产长期使用什么域与证书由属主确认；不能让用户忽略TLS错误。开发自动测试用不同*.test域配浏览器测试解析和测试信任链，不能把测试忽略证书错误带到部署。

HTTPS外端口优先443；内容内部listener端口由运维检查空闲后配置，方案不硬占一个未查端口。若终端只能访问非443 HTTPS，端口变化不破坏本方案站点隔离，但必须保持内容域和可信域不同。DNS记录指向同一台IP不意味着同源：浏览器按scheme/host/port判origin、按scheme/注册域判site。

### 候选比较与cookie论证

| 选择 | 结论 |
|---|---|
| 仅另端口、同主机名 | 不选作独立cookie边界。origin虽不同，host-only session_id仍按主机名跨端口发送；恶意内容可收到自己的请求Cookie，SameSite也不是端口隔离 |
| 同注册域的content子域 | host-only市场cookie通常不发到兄弟子域，但父域Domain cookie、同站CSRF和cookie投毒仍要单独收紧；当前尚未核全部Odoo定制Cookie，不能只凭子域就宣安全 |
| 独立注册域/站点（本推荐） | 现市场host-only session_id/wm_session不匹配内容域；市场不能合法设置Domain到独立内容域。内容反代还必须拒收/剥Cookie、Authorization及Set-Cookie，避免旧数据面意外带票 |
| 市场用IP、内容用新域 | 可作过渡，两个host不同；仍要精确Origin门与凭据不转发。不要反过来把市场改到新名后假设原Odoo cookie仍可用 |

不可信页面仍能主动fetch可信市场并指定credentials:include。跨站第三方Cookie限制不可当安全门：服务端必须拒跨源/opaque/simple写；可信市场父页CSP frame-src只放内容源，frame-ancestors只允许可信壳，内容侧CSP不授allow-same-origin。内容站点不承载任何登录/管理令牌；禁止把Odoo门户HTML连同session_id反向代理到不可信内容域。

## 2. 可信壳与路由搬迁

### 边界拓扑

    浏览器 → 可信市场（现有authority） → Odoo身份查询（原可信源）
               │
               ├─可信壳 /lifecycle /tasks /use/<id> /sop/<slug>
               │   只运行项目内可信JS，不拼非可信HTML
               └─sandbox iframe → 独立内容源
                      /go/<id>/...  /apps/<slug>/...  SOP正文/附件
                      无身份Cookie、无审批授权API、无管理API

| 现路由 | 方案中的处理 |
|---|---|
| /use/<id> 与驾驶舱 | 留可信市场，只负责可信iframe容器、显示状态、受控窗口通信；iframe URL改内容源 |
| 外站/go/<id>/* | 非可信HTML/JS/WS移内容源；可信市场原/go只做路由分类与安全迁移，不再执行外站响应。已有可信Odoo登录通道单列下一节，不泛化为所有go |
| /sop/<slug>/ 根 | 留可信Runner壳：受控步骤导航/表单与run API；step.body不能再直接拼入壳DOM。非可信正文移独立内容源的sandbox frame |
| /sop/<slug>/<attachment> 及/go的SOP快捷分流 | HTML、脚本、可执行附件统一内容源；不能留下portal.ts直接sendFile捷径。纯下载可留attachment策略但不向不可信类型升级inline |
| /apps/<slug>/ 与历史版本 | 静态内容移内容源，仍保opaque sandbox，不因跨域就撤sandbox；app token改为绑定slug/audience/version的窄能力，不是市场身份 |
| 上传文件 | 不可信inline文件迁内容源/专用下载源，不带身份Cookie或允许活动内容落可信源；app/run下载保attachment+nosniff；过渡期HTML/SVG/JS不inline；PDF等也按不可信处理 |
| /api/skills/* 与技能市场 | React文本与tar下载继续可信壳，不增HTML执行器；技能作为app/SOP运行时走对应隔离面 |
| /api/lifecycle/* /api/mcp/* /api/admin-* | 仅可信authority注册，内容listener路由404且反代不代理这些路径；approve/grant仍关闭到另批开启 |

**旧链接/书签**：保留旧路径定位slug/id/run/version，可信入口返回迁移壳或307到验证过的内容URL，目标由服务端配置生成，禁止任意return跳转。初期使用临时跳转（302/307）而非不可撤回的永久301。SOP根链接仍到可信壳，?run=精确保留；历史版本仅导向对应只读内容版本。portal URL重写、Location、相对asset和WS都需按新源重测。绝不为兼容旧书签继续返回旧源可执行HTML。

## 3. SOP/应用数据能力：只桥接本任务，绝不桥接人类身份

当前Runner有建run/存步/完成/附件需求，不能简单切域再开放全部/api。

### 推荐的最小路径

- 可信壳负责建run、选择run与用户操作。非可信步骤正文只运行在opaque sandbox frame，不拿Odoo cookie、管理员token、MCP token、wm_session或审批挑战。
- 若正文需要传数据：可信壳创建MessageChannel，绑定当次frame Window引用+随机通道nonce；opaque消息origin=null不能单独作为身份，校验event.source/通道句柄与销毁生命周期。只允许固定消息枚举和schema，禁止任意URL/HTTP方法/工具名桥接。
- 壳侧保存短期run-scoped能力：run_id、当前步骤/允许字段、操作枚举、过期时间、nonce/audience；后端按相同约束验证，默认拒绝其他run/批量读取/指派/删除/全局列表。能力不放URL/query/referrer或日志，撤销随run冻结/页面关闭。沿用现有run上传令牌可做兼容输入，但不能把“可上传”自动扩成其他操作许可。
- 不给非可信正文任意完成run权。若确需自动保存，仅保存当前受控字段；完成/重新提交等动作仍由可信壳按钮与当前run状态校验。此处设计的是最小本地能力协议，新增契约在实施PR前须评审/批准，不能本方案先发token或改现有API权限。
- approve、grant、签断言、admin与MCP路径永不在通道白名单；根授权人只在可信UI按另案动作绑定挑战确认。内容源不能把外站fetch请求“代转”到这些接口。
- app数据/文件面只收绑定slug与origin/audience的app能力，限定资源范围；现在Origin:null+CORS例外需逐端点列白名单，不能推广到SOP全部API。能力泄漏最多影响本app/run允许的字段，不成为ledger授权。

### 限制

单一内容站点内不可信项目之间仍非同等信任：保留opaque sandbox，后续必要时按app子域/独立frame能力隔离。**不在本次先造通用身份或微服务平台**；完整第三方站点依赖自己的登录时，用其原始外部源直连/受控iframe/独立浏览器登录，而不是复制用户Odoo session_id到代理。

## 4. 对Odoo SSO与#221影响

- 市场可信authority不变，浏览器同主机名:8069与:9800共享原host-only session_id的既有流程可保留；本阶段不要求用户更换Odoo主机名。若运维决定同时改可信域名，必然涉及cookie重登与Odoo/代理配置，属新增身份部署变更，要单独验收，不能顺带实施。
- Odoo登录入口/go/<Odoo-id>是特殊可信流：保留可信壳上的**仅登录中继/受控重定向**，浏览器去原Odoo authority登录，市场whoami轮询原接口。Odoo完整应用HTML不应继续通用同源代理，否则“可信上游源”中可被用户编辑的HTML仍可能突破界限；宜直接跳到Odoo原源/独立标签页。
- “上游URL在WM_ODOO_ORIGINS白名单”仅表示允许服务端验证/转发会话，不等于那份HTML可与审批UI同源。Odoo富文本/模块内容不应进入可信市场DOM。
- 内容页需要身份时只用run/app能力，绝不代持session_id；内容页需要Odoo功能则由用户在Odoo原源完成。不启任意Access-Control-Allow-Origin，不以credentialed CORS让内容源取得市场身份。
- #221未来wm_session仅市场native identity，不代理/保存Odoo session_id；本隔离边界不依赖是否已上线v2，能力映射层将来可换认证来源但内容源仍拿不到市场身份。

## 5. 预计改动（实施后才有实际diff）

| 文件/模块 | 预计工作 | 估算 |
|---|---|---|
| server/src/portal.ts、odoo-session.ts | 内容/go迁移、可信Odoo中继单列、Cookie/Authorization/Set-Cookie不转发、Location/WS改写 | 120–220行 |
| server/src/index.ts + 拟新增content-origin.ts | 可信/内容listener路由分开、CSP、旧入口壳/跳转、上传内容路由、精确origin门 | 180–300行 |
| server/src/sop-runner.ts + 拟新增run-capability.ts | 可信壳/非可信正文分离、最小MessageChannel与run能力验证、冻结失效 | 220–380行 |
| web/src/pages/UseWorkbench.tsx、Cockpit.tsx及app调用示例 | iframe源与旧链接迁移、明确无法嵌入的外站登录提示 | 40–90行 |
| 部署compose/反代模板/文档 | 独立内容origin配置，端口/证书/hosts说明，不新增镜像引擎pin | 80–160行 |
| scripts/lifecycle-origin-*及新增能力反例 | 真双站点cookie与UI/CSRF反例、原业务数据面回归 | 180–300行 |

约10–14文件、820–1450行范围（含测试/删除替换，非承诺），两阶段窄PR而非一包大改。若最小仅先阻断不可信step脚本以交降级版，可提前减少SOP富HTML功能，但属于业务行为降级，需在属主审方案时确认，不能悄悄删功能当修复。

## 6. 验收：不靠写面停用证明隔离

沿用#290脚本，保留旧基线作为红态；实施后换为真实双站点（可信+内容）测量，身份全用合成cookie/fixture。现网admin只由属主/授权人工在浏览器验证，不交agent。

1. **Cookie不抵达内容源**：带HttpOnly session_id、wm_session、管理员相关cookie访问内容域、iframe、WS、重定向/二级附件，内容请求头/上游fixture记录均无上述cookie与Authorization；测试记录只含存在性，不记录值。同主机不同端口反例必须仍能抓到cookie，证明判据不空转。
2. **非可信面脚本不能同源冒充**：所有/go、SOP正文/附件/快捷入口、apps及上传活动内容的location.origin不能成为可信origin；DOM/localStorage/sessionStorage不可访问父可信源。先验正常SOP保存/附件功能仍工作，别只把脚本全部断掉凑拒绝。
3. **拒绝是独立源门造成**：在隔离测试双进程提供测试专用无业务副作用mutation-sink，采用拟写面的Origin/CSRF/能力门，但**不调用lc、不签断言、不注册生产approve/grant实现**。先由可信UI合法一次性challenge调用sink成功，再从各内容面发同URL/简单POST/form/自定义头/credentialed fetch，要求明确403并且sink accepted_count不增加；不是拿503只读或404无路由充当隔离PASS。必要时production门函数可被测试入口复用，但该入口只能在测试fixture中存在，生产路由在位扫描必须证明不存在。
4. **能力边界**：合法run/step保存成功；跨run、跨slug、过期/重复nonce、冻结后、猜测目标、任意fetch URL、假origin=null消息、换frame、旧窗口/卸载重放均失败。能力/CSRF不出现在URL/referrer/日志；旧书签不能请求到可信源恶意HTML。
5. **CSRF/写前确认**：跨站、同站异源、null/missing Origin、错误Content-Type、缺自定义头/Fetch-Metadata、伪造/重放挑战拒绝；同源恶意脚本旧基线能拿token的反例仍保留，证明它必须被执行源隔离而非只加token。挑战绑定动作、对象、session及短期，失败不消耗别人挑战。
6. **SSO回归**：内部账号Odoo登录中继后whoami/顶栏同步正常，门户账号403，过期401；可信登录不循环，trusted Odoo实际原源保留，内容域零session转发。#289门持续在，不回退到缺字段放行。
7. **写面仍关闭**：以上全部通过之前approve503、grant无实现保持；通过后仍要另获#288真实写面排期/授权。是否接入审批不由本次隔离PR暗开。
8. **运维实况**：每环境固定SHA/镜像digest、证书链、DNS/hosts、端口owner、served资源哈希、会话及原MCP授权回读。#284匿名initialize/list/call均401先通过；不以175合成PASS覆盖生产配置问题。

## 7. 分段排期与#284先后

实施授权后估计：
- P0（半天）：运维核定测试机IP/可信authority、候选内容域/TLS与回退准备；#284持权恢复并现场验收。两项可并行准备，不能在当前网关回归上启写面。
- P1（1–2天）：内容listener/路由隔离+旧入口迁移、Odoo可信中继保留；先测试机，不写真实ledger。
- P2（1–2天）：SOP壳/能力受限通道+app数据兼容；定向浏览器/反例/独立复核（约半天至一天），再.156灰度。
- 预计3–5个工作日（依赖DNS/TLS/既有SOP富HTML复杂度，含合成独立验证，不含#288真实approve/grant验收或#221全量SSO）。.88上线不在此排期，等属主另令。

当前先交方案，#284回退/操作单为并行准备；**先恢复#284管理门，再切隔离灰度；隔离验收后再讨论写面**。不要求等#221全包才修源边界；写面开启则需稳定/获批的身份与授权契约，可能排在#221后或由属主另批过渡契约。

## 8. 回退与停止条件

- 实施前冻结旧/新固定运行包、静态manifest、启动配置引用与DNS/反代版本，不读/导出口令值；备同DATA_DIR的一致快照并验证只读副本兼容。非必要不改schema；必须新增能力记录时用增量独立表，不删旧状态。
- 先在独立端口/无真实身份的合成实例验证；内容域预演过再受控切流；保留旧路由映射但不能回退成“不可信HTML+已启写面”的组合。
- 任一cookie泄露、内容可访问可信DOM/令牌、跨run能力成功、合法内部用户失效或MCP匿名不401即停止切流/回到已验安全配置；优先回到“写面关闭+旧可用业务”降级。明确旧源面仍存在风险，不宣隔离完成。
- 不自动回退数据库覆盖现场新写；能力版本不兼容时只撤新流量/过期新capability，迁移另批。若未来已启approve/grant，再回退源码之前必须先关闭写面并验证，否则禁止回退旧同源执行版本。
- 所有进程操作只针对核过的本应用PID/容器，不杀DSH宿主。#284现有回退只是网关OFF不安全降级，与本方案的“已验安全回退”不是一回事，不可混称。

## 9. 本次要属主审阅/运维回填

属主只需先确认推荐边界与实施范围（含候选内容站点名和阶段排期）；测试机运维回填实际IP/可信入口与TLS方案，.156运维落实私网解析和证书，.88不动。若正式域命名与候选.test不同，替换配置表再实施，不按agent猜测建DNS。

收到明确“方案可实施”后再开代码PR，保持审批/授权写面关闭；高档身份/跨项目契约/生产配置动作按原授权面分别留下记录。本文为方案，不是这些动作的批准。

品味记录：本轮无业务口味裁决；方案取舍依据已证cookie/origin威胁与派活完成标准。未进行独立reader评审，交属主与已有评审者审方案，不伪称已经获批。
