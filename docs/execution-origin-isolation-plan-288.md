# #288 执行源隔离实施方案（修订稿，只改文档，待属主批准实施）

基线 main dcb36036251e532a73439e0c9d79c78bdf01636b；日期2026-10-30。依据#290调查、#288评论6521820976及非作者复核6522199937。本修订未改代码、配置、DNS、地址、证书或实例，不开approve/grant；文档合入不等于实施授权。

## 1. 本次请属主决定的默认方案

**内网测试/灰度默认HTTP＋同机独立内容IP，可信市场IP:9800与Odoo IP:8069不变；代理按工作台目标独立origin，带凭据/cookie的目标优先每台独立内容IP（host），不是所有/go共用一个站点。** 运维先确认可分配地址、路由与客户端可达性，属主确认后实施。HTTP不提供传输保密或防中间人保护；这是当前内网HTTP条件下的隔离方案，不是安全上下文升级，不宣称公网可用。

| 环境 | 可信入口 | 内容地址（占位，未配置） | 运维动作 |
|---|---|---|---|
| jfaiubuntuservers测试机 | 保留该机现有IP:9800及Odoo同IP:8069；IP待运维回填 | http://<测试内容IP-A>:<内容端口>、http://<测试内容IP-B>:<内容端口>；每target固定映射 | 测试机运维核主机/容器，申请空闲别名IP并确认无地址冲突/路由/防火墙；反代严格按本地地址+Host映射一台；不猜该机等于.156 |
| .156 LONGXIANG灰度 | 当前真实可信入口保持不变，不换登录host | http://<灰度内容IP-A>:<端口>等，不能使用用户同时当作可信入口的LAN/VPN地址 | Windows运维分配经批准的别名地址、绑定/反代/端口规则；LAN与VPN两类终端分别验可达。现有Tailscale地址不是当然可用的内容IP |
| .88预备役生产 | 未核定，不假设已部署 | 仅保地址池/目标映射规划，不实际配IP/listener | 等属主另行生产排期；本次不部署、不改.88 |

默认不要求DNS/hosts/证书；代价是每个需身份代理目标占一个内容host，地址池不够就不得悄悄合并origin。无可用额外IP时，备选每台独立内容主机名（hosts或内网DNS），与可信域不同且不得受可信父域Domain Cookie覆盖；正式域需公司实际控制。先前.test＋私有CA改为备选：测试可用w<id>.wm-content-gray.test等加hosts/DNS，若需HTTPS则客户端安装受信私有CA并处理续期/撤销；不让用户忽略证书错误。生产域/TLS由属主与运维决定。

### IP＋端口能否替代每台IP

- **可信host与内容host必须不同**，仅换可信IP上的端口会直接收到Odoo host-only session_id，不接受。
- 同一独立内容IP＋每target独立端口能隔DOM/origin，但**cookie仍跨端口共享、同site**，不能声称凭据/cookie按台隔离。A脚本可向B端口发带内容cookie请求；Cookie Path也不是安全边界。
- 因此默认：带Bearer/Basic或浏览器cookie的外部台用每target独立host/IP；不满足时降级原站新标签页，不承诺免登嵌入。只读无凭据、无cookie的静态app/SOP可考虑同内容IP不同端口，仍需按target准入；任一目标需要身份后须迁独立host或完成无浏览器cookie的代理会话设计并另审。
- 若为节约地址改用“同内容IP多端口＋服务端保管上游cookie”，必须额外证明代理会话本身不依赖跨端口共享cookie、每请求有不可跨target复用的能力、客户端可兼容。**不作为本轮默认，不靠端口隔离单独放行。**

## 2. 阻断①：按台代理隔离与凭据注入前准入

现portal.ts:85–86/218给目标台注入Bearer/Basic，WS upgrade另有同款逻辑。仅剥浏览器Cookie/Authorization挡不住服务端注入。A与B共origin时，A可fetch B路径借用B凭据并读响应——本修订明确消除这个拓扑。

### 2.1 单目标listener约束

- 运维静态配置 approved target id → content origin → upstream origin。listener从可信配置绑定target，不从任意/go/<id>、Host、query或消息自选上游；Host只校验，不能控制路由。未知/不匹配authority与/go其他id直接拒绝，**在查询/注入B凭据、发上游HTTP前**结束。
- 每origin只服务自己target的资源、WS、旧路径迁移；不注册市场API/任意URL代理/其他target别名。Host/header与本地地址不匹配拒绝；反代覆盖伪造forwarded头，拒绝绝对URL及跳转逃逸，防DNS rebinding/跨台重写。
- 以同源fetch/子资源身份访问自己的台可允许；跨origin A→B的fetch、表单简单POST、图片/脚本GET、预检与WS均拒绝，不只是阻CORS读响应。**请求准入先于凭据注入与任何上游副作用**。
- 浏览器请求校验精确Origin（存在时必须等于B origin）及Fetch Metadata。POST/PUT/PATCH/DELETE和WS缺Origin/null Origin/非same-origin一律拒绝；GET子资源也不能让A通过img/script借B凭据做副作用，cross-site与same-site异origin均拒绝。Referer仅辅助、不能单独授权；不按字符串路径前缀当身份。普通HTTP非安全上下文可能不发送Fetch Metadata，缺头默认拒绝而非伪称一定存在；只有另有已审、绑定target且不可跨台复用的能力能独立完成准入时才考虑兼容，否则该台用原站新标签页。HTTP默认方案不保证全部第三方台可嵌入。
- 顶层首次导航只有可信壳签发的单次短期**B专属启动能力**可换B代理上下文，绑定目标、当前viewer/会话、有效期与nonce；不把GET导航“都放行并注入凭据”。建议通过可信壳表单POST启动，Origin精确为可信壳且Fetch Metadata符合顶层启动流程，能力在body不入query/referrer。A源没有同源权限读取壳的能力，知道B的URL不是许可。
- 后续B请求需B专属短期上下文；默认每target独立host时可用host-only、最小Path且不跨host的代理上下文cookie，不能接受所有B来访者共享一套长期Bearer/Basic。HTTP下无Secure、第三方cookie可能不可用，**不因此回退到凭URL匿名注入**；选择原站/新标签页或暂停该台嵌入。cookie过期/缺失/撤权立即拒绝、零上游调用。
- 代理剥市场Odoo/session、管理员/MCP/市场会话凭据；上游自有Set-Cookie若允许仅留该独立内容host、不得宽Domain跨target，绝不接收session_id冒充市场登录。对长期Bearer/Basic的读取仍仅服务端凭据库引用，不在JS、错误、日志里发值。
- 不可信B脚本可使用B本来已获准的功能，这是target内风险；无权借A/B以外台或市场审批授权。完整未知第三方站点无法适配上述准入时新标签页，不关闭门兼容。

### 2.2 WS与入口绕行

index.ts的upgrade分支（原3418–3446附近）必须与HTTP共用target映射/准入，不再自行解析/go任意id后直接加Authorization。校验Origin、启动上下文、目标、时效/撤销，再建立上游连接；拒绝测试要求upstream连接计数为0。内容与可信listener均封堵旧/go对外站直接输出HTML的支路，SOP快捷分流不可绕回可信sendFile。

## 3. 路由迁移与用户可见变化

可信壳留/lifecycle、/tasks、/use/<id>、驾驶舱、SOP受控导航/按钮及登录中继；不把非可信HTML拼进壳DOM。

| 面 | 改法与用户变化 |
|---|---|
| 外站/go/<id> | 去该target独立origin；相对asset/Location/WS跟随目标映射，不能访问其他target。旧链接先临时302/307或迁移壳，不永久301、不接受任意return |
| Odoo应用 | 原源访问大概率受XFO/frame-ancestors阻嵌入，默认新标签页；驾驶舱并排嵌Odoo可能取消。可信登录中继仍留市场，不能把Odoo完整可编辑HTML当可信市场代码 |
| DSH等跨站iframe | 自有会话cookie是第三方cookie，HTTP不能用SameSite=None;Secure，Safari/Firefox等也可拦；可能反复登录/无法嵌入。明确提示“原站新标签页”，不保证原门户免登。服务端cookie托管是额外设计不是悄悄兼容 |
| SOP正文/附件 | 富HTML在opaque frame；表单收集/回填/自动保存/上传/完成锁定依赖新通道全部做好后才切流，不能只挪iframe就称可用。旧?run保精确定位 |
| /apps/与历史版本 | 每app目标映射、保sandbox；X-App-Token数据/文件面核scope/audience/version。预览URL变，业务接口兼容需回归，不承诺完全无感 |
| 上传inline文件 | 活动内容、图片/PDF/文本等不可信回显走对应内容/下载target；HTML/SVG/JS不在可信源inline，app/run附件保attachment+nosniff |
| 技能快照 | 保React文本/tar下载；作为app/SOP执行时走该目标隔离，不新增可信HTML执行器 |
| /lifecycle、/tasks、顶栏、Odoo登录中继 | 保可信源与既有登录authority，显示与登录中继行为不变（需原回归验证） |

旧书签保id/slug/version/run，可信壳用配置映射到对应target，不泄露能力在URL；返回origin不可由用户注册数据任意指定。无可分配安全origin或第三方登录不兼容时明确不可嵌入，不重新剥安全头回可信源。

## 4. 阻断②：SOP字段与文件协议（完整替换父DOM采集）

当前sop-runner.ts在父文档querySelectorAll('[data-field]')采集、fill、上传和disabled；正文进opaque iframe后父页不能访问。必须把这组能力显式改为下述协议，而非保留失效选择器。协议仍为待审设计，不先加服务端接口。

### 4.1 字段声明与兼容

可信壳从冻结sop.yaml/步骤元数据建立字段schema：step_key、field_key、类型(text/number/boolean/multi/file)、required、长度/枚举/数量上限、允许操作。旧HTML data-field声明由**受控迁移提取/审查**转成schema；不能相信iframe运行时随意注册可写字段。重名/未知字段/超限拒绝并点名步骤，原生成器与seed-demo-sop的字段夹具一起迁移。

iframe加载受控bootstrap（不拿身份或通用令牌），读自己DOM的控件。frame发READY(version,step,field_keys)，父壳按schema比对，发INIT(values,field_schema,readOnly,revision)；不允许frame自选run_id/其他步骤。动态富HTML若需新增字段，走版本发布声明，不在运行期扩大权限。

### 4.2 MessageChannel交互

| 消息 | 发送方向 | 行为/约束 |
|---|---|---|
| READY/INIT/ACK | frame↔壳 | 壳创建通道，握手校验event.source==当前iframe.contentWindow、版本、nonce/step；opaque origin=null不是身份。仅初始化时向这一个Window转移port，握手nonce一次消费 |
| CHANGE/VALIDATE_RESULT | frame→壳→frame | frame监听input/change，发送字段键和值/seq，不发URL或HTTP方法；壳校验schema与当前step，受控节流保存，后端校验run能力/expected revision；回保存成功/字段错误，失败不虚标已保存 |
| COLLECT/VALUES | 壳→frame→壳 | 完成前取当前字段快照，有有界超时、request_id/seq；与声明schema核对，不能因frame不响应默默完成 |
| HYDRATE | 壳→frame | 已保存值按类型回填；DOM变更发生在frame bootstrap里，父壳不再querySelectorAll非可信正文；旧{value}与复杂字段兼容由版本转换显式定义 |
| UPLOAD_REQUEST/RESULT | frame→壳→frame | frame文件选择后通过MessagePort传File/Blob（结构化克隆），字段键/文件大小/MIME/数量受schema与服务器校验；壳凭**只在壳持有的run上传能力**向固定上传端点发送；不接收文件路径/任意fetch URL；结果回该字段文件id/状态，不泄市场令牌 |
| LOCK/UNLOCK_ALLOWED/LOCK_ACK | 壳→frame→壳 | 后端finished/冻结真源决定只读，壳广播LOCK，bootstrap禁用控件/上传并ACK；但frame可不遵守，**服务器能力撤销/状态检查才是禁写门**。不能由frame要求解锁已完成run |
| TEARDOWN | 壳→frame | 切步骤/run、重载、关闭时销毁port/nonce、取消未决收集，旧frame消息不再接收 |

壳保run-scoped短期能力（run/step/字段/动作/audience/到期/nonce），内容页不拿Odoo cookie、wm-admin-token、MCP token、wm_session、CSRF确认挑战。后台只收固定字段与当前run操作，不桥接approve/grant/admin/指派/删除/跨run列表。完成动作由可信壳人工按钮→COLLECT→校验→后端finish，成功后立即LOCK与能力失效；网络失败保原状态，不允许frame自报完成。

nonce不是同源授权替代，MessageChannel也不是天然安全：每次消息校schema/序列/通道绑定，拒假null-origin消息、旧port重放/交换frame、跨target/step。上传不为agent/内容页新增身份。Origin:null CORS例外（index.ts:41–63）逐个按app/run能力复核，不能为了opaque表单通畅开放全部/api。

## 5. 存储与SSO边界

现行风险不只未来写面：同一标签页下同源portal/SOP可读市场sessionStorage的wm-admin-token和父DOM；run上传令牌位于市场localStorage（具体键按Runner源核）。验收必须让内容页访问这些存储与parent.document抛错/拒绝，绝不把token搬进frame或URL解决兼容。

可信入口IP:9800不动，Odoo同IP:8069的host-only session_id既有共享不变；若运维使用别名IP/不同host当新的可信入口，必须重登并另验，不把它和“仅内容IP”混用。内容host不匹配市场Cookie，但跨源写仍须服务器精确Origin/Fetch-Metadata/动作挑战门，不依赖第三方cookie拦截。Odoo登录中继只跳原Odoo源、whoami现查；不在内容源持有或代理session_id。

#221将来wm_session仅市场native identity，不代理Odoo cookie；隔离的target/run能力可在身份契约冻结后接入，不因本方案先实现新账号/角色/ledger权限。审批/授权开启另按#288，#289内部门一直保留。

## 6. 验收（实施授权后做，不以503/404冒充隔离PASS）

1. 沿#290七入口、补每target两个代理A/B以及HTTP/WS升级、上传活动内容/快捷路由。A带自己的有效上下文fetch、form简单POST、img/script GET、WS到B，B必须在注入凭据前明确403且**上游B请求计数0**；错误authority、直接IP/换port、伪Host转发、missing/null Origin、cross-site/same-site、顶层导航无启动能力同样拒。合法B启动+自己请求正例成功，不能把所有台断掉凑绿。
2. target独立IP与同IP跨端口共享cookie反例并存；市场HttpOnly session_id/wm_session不抵达内容host或上游。内容A不可读B响应/DOM/存储/上下文。内容iframe不可读wm-admin-token/run令牌或parent.document；只记录存在性，不输出秘密。HTTP方案不证明传输机密，TLS/安全上下文另验。
3. SOP声明字段：简单/复杂值、required、类型/上限、回填、debounce自动保存、错误提示、超时COLLECT、文件上传/超限、finish与finished禁写、run重载、旧frame/跨step/跨run/旧nonce/假null origin重放。壳不再采集父文档里的旧data-field而漏数据；现seed-demo-sop与生成器产出的SOP皆做迁移对照。
4. **mutation-sink仅scripts/夹具自己的测试进程注册**，server/src无任何路由/环境开关。测试可信UI合法动作正例通过，再从内容各面模拟写：明确拒绝且accepted_count不变。CI双检：server/src源码搜不到sink实现/开关、实际生产app路由表枚举也无测试路径；不能以grep单独代动态检查，不为导出路由表新增生产HTTP端点。
5. 保原approve503/grant未实现，未到独立隔离验收与属主另批不启。将来写面严格精确Origin/JSON/自定义头/Fetch-Metadata和session+动作+对象绑定一次性短期挑战；它们只能纵深防御，原同源恶意脚本能读挑战的反例不能删。
6. 迁移现有依赖/go同源的portal-sso*、security-adversarial S4、dispatch-smoke及WS冒烟，验证拒绝理由/合法正例均合理；不只改期望凑绿。能力跨slug/null CORS/上传原功能回归。
7. SSO：内部账号正常、门户403/缺字段403、过期401、顶栏同步；Odoo若被XFO挡嵌入给新标签页提示，DSH第三方cookie失败给可用原站入口，不无限跳转。旧书签/run/version精确保留且不返回可信恶意HTML。
8. 现场：#284匿名initialize/list/call401、原admin与原session/grants不丢；固定source/镜像、配置引用、served SHA/端口owner回读。纯合成PASS不覆盖生产。账户/权限只由持权人操作，agent不使用admin凭据。

## 7. 改动规模与排期（重估5–7工作日）

| 模块 | 内容 | 行数估计（含替换，不作承诺） |
|---|---|---|
| portal.ts、index.ts WS upgrade、odoo-session.ts及拟target-origin模块 | per-target路由/准入/启动上下文/凭据注入顺序、Location/WS与旧链接 | 250–400 |
| index.ts内容/上传路由及Origin:null CORS | 可信/内容入口分离，按app/run能力局部兼容 | 180–300 |
| sop-runner.ts、拟字段bootstrap/能力模块 | 字段schema、MessageChannel、上传/回填/锁定/超时与旧SOP迁移 | 400–650 |
| UseWorkbench/Cockpit等前端 | 每台origin、新标签页/登录限制提示、书签迁移 | 60–120 |
| 部署文档/反代模板 | 别名IP/target映射/端口/回退，TLS备选，不自动配置 | 80–150 |
| 定向浏览器/反例/旧冒烟迁移 | A/B代理凭据零上游副作用、SOP全数据面、WS、sink CI双检 | 220–380 |

约12–18文件、1190–2000行，身份/跨源/部署实施属高档，需方案批准及独立验收。顺序三段：① per-target内容listener+/go迁移（1–2天）；② SOP字段通道及迁移（2–3天）；③ app/上传与兼容回归（1天），独立测试与修正约1天；合计**5–7工作日**，运维地址资源/第三方登录适配不足可能延长，停在明确降级而非放宽隔离。.88不计入此轮。

#284恢复准备与地址调查可并行，但现场灰度切流前先恢复并验网关；不等#221全包才调查/修执行边界，approve/grant开通仍须稳定身份契约与另案授权。本次不实施。

## 8. 回退与属主待决

实施前冻结新旧固定包、配置引用/target-IP映射、served清单，备一致库副本并验兼容；迁移字段schema属于SOP版本变更需保旧记录、不可静默改已冻结run。切流失败回“写面关闭+旧可用业务”降级，明示旧同源执行风险；禁止“不可信旧HTML＋已启写面”组合。不同目标逐台回退映射，未过目标禁凭据代理可保原站新标签页；不全盘重建会话/授新权限。

任一跨台凭据被使用、上游B副作用计数非0、令牌可读、跨run保存、内部账号失效或匿名MCP非401即停止/撤新流量；不自动restore库覆盖新写入，不杀DSH宿主。#284网关OFF回退仅不安全应急，不混称安全回退。

**请属主确认**：内网HTTP独立内容IP＋需身份台每target独立host的默认边界及用户可见降级，测试机→.156三段5–7天范围；如IP池不足，选每台内容主机名或原站新标签页，不默许共origin。运维回填可用IP/端口/路由后再开高档实施PR；私有CA/.test仅备选。.88等另令。未批准前不动代码/配置，也不启审批授权。

本轮按非作者复核修订技术缺口，不作人工品味规则裁决；原3–5天/单内容origin方案已被本稿取代。实施完成仍须独立测量，不因文档修订而宣隔离PASS。
