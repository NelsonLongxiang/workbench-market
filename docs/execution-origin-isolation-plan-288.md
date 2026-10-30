# #288 执行源隔离实施方案（修订稿，只改文档，待属主批准实施）

基线 main dcb36036251e532a73439e0c9d79c78bdf01636b；日期2026-10-30。依据#290调查、#288评论6521820976及非作者复核6522199937。本修订未改代码、配置、DNS、地址、证书或实例，不开approve/grant；文档合入不等于实施授权。

## 1. 定稿地址方向：HTTP＋每台独立.internal站点

属主原话：“员工电脑不能统一下发根证书，内容主机走 http 加每台各自的 .internal 域名，带凭据的工作台改新标签页打开。”据此采用下面默认方案；仍只定稿文档，须最后复核和属主明确批准实施才动代码/配置。

### 1.1 命名与DNS

    w-<immutable-target-id>-<env>.internal
    例：w-42-gray.internal、w-42-test.internal

env为test/gray/prod。internal前**只有一个标签**，禁止再分成w-42.gray.internal或w-42.gray.content.<zone>；目标ID不可变且由登记表分配，不能用标题/任意Host选择上游。域名改属或删除时先撤旧上下文，不复用旧授权。

该命名依据第三轮复核6522712132的Chromium实测：w-1-gray.internal与w-2-gray.internal分别为独立site，不只是独立origin；共同父后缀的Domain cookie设置被该浏览器拒绝。不是因为DNS目的IP不同——所有记录可以指同一内容IP。实施前必须在约定Chromium/Edge及实际员工浏览器上复测site/Cookie行为；未测Firefox/Safari不写已通过。HTTPS＋分层域名仅将来另审选项，不能在本HTTP方案恢复旧分层名。

请网管确认内网DNS能直接维护.internal区下的单层名字，客户端解析器/浏览器不把它转外部搜索或DoH绕过。**每target默认一条显式A记录**，必要IPv6另给已核AAAA。不配*.internal通配：它会将无关/拼错的.internal名字也解析到内容IP，可能卷入可信入口或其他内网服务，扩大命名接管范围；即使listener拒未知Host也不消DNS影响。域级通配若未来提出，须网管盘点整个.internal命名空间后另批，不是当前节省记录的默认。hosts逐客户端映射仅DNS故障时备选。

内容域名不得等于任何可信市场/Odoo访问host，也不得落入其实际Domain cookie覆盖范围。采集Cookie名称/Domain/Path/SameSite属性即可，不取值。可信市场IP:9800与Odoo原访问host:8069不动，原host-only session_id不匹配w-42-gray.internal，即使DNS解析到同一机器。

### 1.2 每环境一个内容IP，推荐专用

| 环境 | 可信入口 | 内容DNS/IP（均未配置） | 运维需做 |
|---|---|---|---|
| jfaiubuntuservers测试机 | 原市场IP:9800和Odoo访问host不变，地址待核 | 所有w-<id>-test.internal指一个专用<测试内容IP> | 核实际主机/容器及台数，网管保留一个专用IP，DNS逐台A记录、listener绑定/防火墙/客户端解析回读 |
| .156 LONGXIANG灰度 | 当前可信IP:9800不变 | 所有w-<id>-gray.internal指一个专用<灰度内容IP> | 网管分配同机别名或独立接口IP、排除DHCP池/检测冲突；Windows运维保现DHCP/地址/路由不变后配置，经LAN/VPN客户端验证 |
| .88预备役生产 | 未核定、不假设已部署 | 只预留w-<id>-prod.internal及一个内容IP的规划 | 不建记录、不加IP、不部署；等属主另令 |

推荐专用内容IP是为了降低误访问裸IP时可信Cookie进入内容进程的机会，不是每target再分配IP。若运维只能复用可信机现有IP＋另一内容端口，合法**域名URL**仍可隔cookie，但有人顶层访问http://<可信IP>:<内容端口>时，市场/Odoo host-only cookie会先随请求送进内容进程，随后拒绝不能撤销已接收。该兼容方式须属主知悉、实施严格裸Host拒绝并确保Cookie不落日志/上游；优先专用IP而非省略拒绝门。

网管保留/排除DHCP、地址登记和重复检测，运维核现网卡与持久化方案后才加地址，不能ping不通就认空闲；Windows DHCP网卡不可盲用New-NetIPAddress影响原DHCP，Ubuntu沿既有netplan保路由并试回退。HTTP不需要根证书/私有CA；具体端口由运维核空闲、配置白名单，不在方案猜一个未查端口。

### 1.3 首批数量和回填清单

.156在20:09掩码读取37登记=外部HTTP13＋站内路径24，Bearer1/Basic0，另2个URL凭据类参数目标不重叠；已知敏感并集3，cookie登录台尚未统计。首批至少3条w-<id>-gray.internal显式A记录（实际ID映射在脱敏部署表回填），它们**仅新标签页顶层打开**。其他10个外部台先核cookie/凭据，若全迁则13条；站内24按实际app/SOP目标去重规划，不直接按24增加。无凭据静态app/SOP照常可嵌入，但默认仍按target域名，不暗自合并同origin。

测试机数量未核，等运维提供可访问市场URL或只含target-id/credential-kind的脱敏台清单，不套用.156。.88只预留不配。

请提供四类非秘密信息：①DNS能否直接建.internal单层记录、命名空间既有冲突和可信入口Cookie Domain属性；②test/gray各一个内容IP及空闲端口（优先专用IP），prod仅规划；③记录创建/撤销负责人、员工LAN/VPN使用的DNS解析器与回读方式；④测试机地址或脱敏台清单。无需密码、cookie值、私钥。

### 1.4 HTTP代价

内网阶段仅HTTP、无私有CA，无传输保密/防中间人保证，secure-context API和第三方Cookie受限。**HTTP不要求Sec-Fetch-*在场，缺头不据此拒绝或放行；真正准入依据为本台有效Strict签名上下文＋精确Host＋有Origin时必须匹配。** Fetch Metadata只作为将来HTTPS的附加拒绝信号，不为兼容允许跨站cookie或匿名代理。带凭据台取消iframe以确保Strict上下文在顶层本台生效。

## 2. 阻断①：按台代理隔离与凭据注入前准入

现portal.ts:85–86/218给目标台注入Bearer/Basic，WS upgrade另有同款逻辑。仅剥浏览器Cookie/Authorization挡不住服务端注入。A与B共origin时，A可fetch B路径借用B凭据并读响应——本修订明确消除这个拓扑。

### 2.1 单目标listener和签名上下文

- 内容listener将规范化的真实Host（小写、处理末尾点、端口必须精确匹配配置）映射至预登记target白名单。**不信X-Forwarded-Host**选择target；未知Host、裸IP、可信Host、其他/go id、绝对请求行authority与Host不一致，在读凭据或连上游之前4xx纯文本拒绝，不出活动HTML。代理前置也只传约定的真实authority，不能把任意forwarded值变成信任根。可信listener拒内容Host。
- B只接受**B自己host上的host-only、HttpOnly、SameSite=Strict签名代理上下文cookie**，显式不设Domain，绑定target、viewer/会话、nonce、有效期和撤销版本。只接受一个有效上下文，错误/过期/撤权/重复歧义拒绝；验签失败不退匿名。这里不是Odoo session_id，也不是管理员/MCP/wm_session。
- 除下述不连上游的引导交换外，任何需要上游身份的B资源/操作在读Bearer/Basic/服务端cookie容器或连上游前均校验上下文；已分类为公开只读静态资源的请求不注入任何凭据，也不以签名上下文阻断正常嵌入；跨站A→B的img/script/link/iframe等即使无Origin，浏览器不带B的Strict上下文，B拒绝且上游计数0。**有Origin的请求必须精确等于B origin**（含scheme/port，null/缺格式不接受）；HTTP请求没有Fetch Metadata不作为失败，不用它取代Strict gate。Referer只辅助诊断，不作为凭证。
- 可信壳用noopener新标签页打开B启动页。启动页仅可信引导代码、无凭据读取/上游代理，首次无上下文可以显示引导但绝不发上游；通过独立、一次性B专属短期启动能力完成上下文建立，能力绑定已验证viewer与target，不能放URL/query/referrer/日志。交换若来自可信市场不同Origin，不可泛化为“B代理允许该Origin”：只能无上游副作用的专门引导流程，不依赖noopener切断的opener通信，具体采用独立已审挑战交换或服务端引导状态，另在实施PR明确状态机；任何业务代理仍有Origin只认B。引导后B在**顶层本台上下文**重新请求，再用Strict cookie代理。未审定安全引导前不得启带凭据台代理；不能为了免登在URL植入长期token。
- 内容进程/反代**不记录、不转发原始Cookie头**，不记录Authorization或启动能力。仅本地解析验证自己的签名上下文，丢弃其余cookie；可信Odoo/session、管理员/MCP等即使经裸可信IP误送入，也在Host拒绝路径不写日志、不发上游。上游需要cookie时只用服务端target+viewer隔离的cookie容器，不用浏览器原Cookie认证上游；禁止宽Domain Set-Cookie污染市场或其他target。HTTP不使用需Secure的__Host-前缀来虚构保障。
- 同一IP上不同w-A/w-B域名不等于相同site；本命名每台独立site，阻断旧分层兄弟域的父Domain投毒。仍需实测浏览器公共后缀规则、Cookie拒绝/重复参数、DNS rebinding等，不以签名cookie代替target授权。B不可信脚本可用B本来获准的能力，不可借A/C或市场审批授权。
- Bearer/Basic/cookie/凭据参数台一律顶层新标签页；不再在使用页/驾驶舱iframe运行。无安全启动能力、cookie兼容或用户授权时只给原站新标签页/暂停代理，不退到“知道URL就注入共享凭据”。

### 2.2 WS与入口绕行

index.ts的upgrade分支（原3418–3446附近）必须与HTTP共用target映射/准入，不再自行解析/go任意id后直接加Authorization。校验Origin、启动上下文、目标、时效/撤销，再建立上游连接；拒绝测试要求upstream连接计数为0。内容与可信listener均封堵旧/go对外站直接输出HTML的支路，SOP快捷分流不可绕回可信sendFile。

## 3. 路由迁移与用户可见变化

可信壳留/lifecycle、/tasks、/use/<id>、驾驶舱、SOP受控导航/按钮及登录中继；不把非可信HTML拼进壳DOM。

| 面 | 改法与用户变化 |
|---|---|
| 带凭据台登录前置 | Bearer/Basic/cookie/凭据参数目标必须先在可信入口完成Odoo内部账号登录（沿#289严格门），再获取绑定viewer与target的启动能力；匿名旧免登入口取消。不定义无viewer能力或无cookie注入旁路；需要例外须另批 |
| 外站/go/<id> | 去该target独立.internal站点；带Bearer/Basic/cookie/凭据参数的台一律noopener新标签页顶层打开，使用页/驾驶舱不再嵌；相对asset/Location/WS跟随本target映射，不能访问其他target |
| Odoo应用 | 定稿为原源新标签页打开，不再承诺驾驶舱并排嵌入；XFO/frame-ancestors不再为嵌入而剥除。可信登录中继仍留市场，不代理Odoo完整HTML到可信壳 |
| DSH等带凭据台 | 定稿仅新标签页顶层打开，不再嵌入使用页/驾驶舱；不靠第三方cookie反复登录，不设置SameSite=None回退，不承诺旧门户免登 |
| SOP正文/附件 | 富HTML在opaque frame；表单收集/回填/自动保存/上传/完成锁定依赖新通道全部做好后才切流，不能只挪iframe就称可用。旧?run保精确定位 |
| 只读无凭据静态app/SOP | 照常嵌入对应.internal站点并保opaque sandbox；不因普通静态请求缺Strict认证上下文而全部拒绝，也不读取/注入上游凭据。富表单另走字段通道；若需X-App-Token数据面须独立窄能力评审，不能冒称无凭据 |
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

可信入口IP:9800不动，Odoo同IP:8069的host-only session_id既有共享不变；若运维使用别名IP/不同host当新的可信入口，必须重登并另验，不把它和“仅内容IP”混用。内容host不匹配市场Cookie，但跨源写仍须服务器精确Origin/本台Strict上下文/动作挑战门，HTTP不强制Fetch Metadata，不依赖第三方cookie拦截。Odoo登录中继只跳原Odoo源、whoami现查；不在内容源持有或代理session_id。

#221将来wm_session仅市场native identity，不代理Odoo cookie；隔离的target/run能力可在身份契约冻结后接入，不因本方案先实现新账号/角色/ledger权限。审批/授权开启另按#288，#289内部门一直保留。

## 6. 验收（实施授权后做，不以503/404冒充隔离PASS）

### 固定HTTP Cookie三行（复核6522712132为依据，实施时原样保留并复跑）

先在B顶层建立真实合成host-only、HttpOnly、SameSite=Strict签名上下文；只记录有无，不记录值。以下是拟验收期望，不冒称本轮文档修订已实测：

| 场景 | 必须观察的Cookie/门结果 |
|---|---|
| B新标签页顶层已处于B站点后，请求B自己资源 | 带B Strict上下文；合法资源成功且只注入B凭据。由市场跨站首次跳B不能假设立即带Strict cookie，先无副作用引导，再B本台请求 |
| B页面同站同源fetch B | 带B上下文；若Origin存在必须为B；HTTP无Sec-Fetch-*也正常，不以缺头拒绝 |
| 市场或A跨站iframe/子资源访问B | 不带B Strict上下文；需凭据资源明确403，读取凭据/上游请求计数为0。因此带凭据台不嵌入 |

保原分层兄弟域红对照：w-1.gray.content.corp→w-2.gray.content.corp带B真Strict cookie且父域投毒成功（据复核Chromium）；改用w-1-gray.internal→w-2-gray.internal不带B cookie、Domain=internal投毒被拒。目标浏览器升级/PSL规则差异需重验，不依赖未知浏览器推断。

1. 沿#290七入口、补每target两个代理A/B以及HTTP/WS升级、上传活动内容/快捷路由。A带自己的有效上下文fetch、form简单POST、img/script GET、WS到B，B必须在注入凭据前明确403且**上游B请求计数0**；错误authority、裸IP/错port、伪X-Forwarded-Host、null/不匹配Origin、跨站缺Strict上下文、需身份的顶层导航未完成引导同样拒；合法GET缺Origin与HTTP缺Fetch Metadata不能单独判拒，须按Host及Strict签名上下文判断。合法B启动+自己请求正例成功，不能把所有台断掉凑绿。
2. 每target域名共享IP的合法正例、同IP跨端口共享cookie反例及兄弟域父Domain cookie投毒反例并存；市场HttpOnly session_id/wm_session不抵达内容host或上游。内容A不可读B响应/DOM/存储/上下文。内容iframe不可读wm-admin-token/run令牌或parent.document；只记录存在性，不输出秘密。HTTP方案不证明传输机密，TLS/安全上下文另验。
3. SOP声明字段：简单/复杂值、required、类型/上限、回填、debounce自动保存、错误提示、超时COLLECT、文件上传/超限、finish与finished禁写、run重载、旧frame/跨step/跨run/旧nonce/假null origin重放。壳不再采集父文档里的旧data-field而漏数据；现seed-demo-sop与生成器产出的SOP皆做迁移对照。
4. **mutation-sink仅scripts/夹具自己的测试进程注册**，server/src无任何路由/环境开关。测试可信UI合法动作正例通过，再从内容各面模拟写：明确拒绝且accepted_count不变。CI双检：server/src源码搜不到sink实现/开关、实际生产app路由表枚举也无测试路径；不能以grep单独代动态检查，不为导出路由表新增生产HTTP端点。
5. 保原approve503/grant未实现，未到独立隔离验收与属主另批不启。将来写面严格精确Origin/JSON/自定义头和session+动作+对象绑定一次性短期挑战；Fetch Metadata在HTTPS作为附加门；它们只能纵深防御，原同源恶意脚本能读挑战的反例不能删。
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
| 部署文档/反代模板 | 逐台DNS记录/Host白名单/target映射/共享内容IP端口/回退，别名IP与TLS备选，不自动配置 | 80–150 |
| 定向浏览器/反例/旧冒烟迁移 | A/B代理凭据零上游副作用、SOP全数据面、WS、sink CI双检 | 220–380 |

约12–18文件、1190–2000行，身份/跨源/部署实施属高档，需方案批准及独立验收。顺序三段：① per-target内容listener+/go迁移（1–2天）；② SOP字段通道及迁移（2–3天）；③ app/上传与兼容回归（1天），独立测试与修正约1天；合计**5–7个开发工作日，不含DNS/IP配置、运维排期及其等待时间**；第三方登录适配不足可能延长，停在明确降级而非放宽隔离。.88不计入此轮。

#284恢复准备与地址调查可并行，但现场灰度切流前先恢复并验网关；不等#221全包才调查/修执行边界，approve/grant开通仍须稳定身份契约与另案授权。已转入经属主批准的候选代码准备（只开PR、逐PR审后才合）；本方案修订本身不部署或切换。

## 8. 非浏览器调用盘点、迁移和回退

实施前按以下清单逐调用方迁移；代码搜索证明存在调用路径，不等于已查齐所有现场客户端。未识别调用方保持未迁移，不能先切再让机器伪造浏览器cookie。

| 调用方/依据 | 类型/当前证据 | 迁移去向与验收 |
|---|---|---|
| 品味席经/go调用taste-mcp tools/call | index.ts:64–66的历史事故注释已证该路径曾使用；本轮没有读取其机器配置/凭据，现场是否仍用待该席回填 | 改市场/mcp上游聚合taste__*，使用各自原MCP会话/grants；或服务端直连taste-mcp用自己凭据。机器路径不经过内容listener；由品味席只回脱敏endpoint类别/验证结论，不索值 |
| MCP use_url生产工具及其agent调用方 | README和mcp-tools/index分发返回/go浏览器入口，不能当机器RPC入口 | 返回用户打开入口仍可保留；机器要读台数据/调用上游改已有受授权本地工具或/mcp聚合，不让use_url成为匿名凭据代理能力 |
| scripts/cookie-smoke、portal-cookie/odoo-session/sso/sso-p8910/p13/p6711/gzip/rewrite、spa-asset-rewrite、sso-callback/gateway、echo-fixture | 仓库内合成非浏览器HTTP/WS冒烟；明确是测试，不是现场客户端 | 迁为内容host+合法合成启动上下文/明确拒绝反例；保持可信SSO中继原回归，不关闭保护只换期望 |
| security-adversarial S4、dispatch-smoke相关portal断言、evidence/e2e_test.py http.client/socket/page.request | 跨源/授权与底层透传测试；部分仍假设同源可读/无cookie上游 | 逐条归类浏览器行为或机器协议；浏览器用真实origin/site，机器fixture用独立直连/受限聚合；新的裸/go负例必须403且上游计数0 |
| docs/README/gen-verifier/make-submission中同源portal锚点 | 文档/冻结判据输入，不是执行客户端 | 新行为原标准受影响时先报维护席，按材料/先红反例正常修订；不临时绕门/删断言凑PASS |
| 其它现场agent/定时/外部客户端 | 仅仓内搜索不能证明不存在；待各持有方脱敏清单和原有日志计数核对（不读token/body） | 维护者回填consumer→target→read/write→迁移endpoint→原授权→已验状态，所有需凭据机器调用从/go移走后再切流 |

现成迁移通道：settings.mcp_upstreams经人工控制面配置、/mcp网关原会话授权默认拒绝，或服务端自有凭据直连。迁移不新增工具grant/静态身份头、不复制用户Odoo session_id、不为无Origin CLI在内容面开豁免；发现接口缺口给具体API/调用与测试，不加匿名fallback。

### 8.1 切换前观察期（测试机与.156分别完成）

现场只读基线：.156在UTC日桶2026-10-25～10-30合计/go命中5085次；现endpoint_stats把数字target折成:id，仅有endpoint/day/hits，无UA、来源、方法及逐请求时间。不能从这些总量识别非浏览器，不能宣布机器调用方已迁完；测试机也需另建覆盖，不复用本机数字。

第一段实施PR随附**只计数、不拦截**的观察组件；不修改原代理响应、认证或请求头，不借观察器启用内容源拒绝，也不与M1另造第二套listener。观察器在原/go入口解析已登记target-id后计数，HTTP和WS upgrade均要覆盖；部署由属主审PR/批准对应实例观察配置后执行，本文修订本身不部署。

唯一持久维度：target_id × client_class × UTC日期 × count。类别只从Sec-Fetch-*与UA在内存粗分：browser-top-navigation、browser-iframe、browser-fetch、curl、node、python、mcp-client、other；无元数据/冲突/无法判断归other，不因HTTP缺Fetch Metadata就冒称非浏览器。UA可伪造、MCP客户端无统一UA，类别是迁移线索不是身份认证。**不存完整UA、原路径/查询参数、来源IP明细、Cookie、Authorization、正文、票据或指纹**；记录仅已登记数字target与固定类别，防任意路径造成键空间无界。聚合写入/持久化失败必须显式标观察不完整，不能丢计数后宣布“零机器调用”。观察数据只经既有持权面读取，内容源不开放统计接口。

每环境观察**至少一个完整工作周**：连续覆盖当地完整周一至周五（至少5个完整工作日，含业务上下班批次/已知定时作业），UTC桶同时标明当地覆盖边界；若周中启动，则延续到下一个完整工作周结束，期间重启/数据丢失形成缺口须补齐。不能把首尾两个零点之间的5个日期标签算满5天。已知低频月度/周末调用者另由持有方回填并验证迁移，不把一周未出现当不存在。观察结束保留聚合与缺口记录，不采集敏感原始日志补洞。

观察后按target和非浏览器类别与持有方对账，形成consumer→target→类别→迁移通道→原授权→验证结果的脱敏清单；curl/node/python/MCP/other需逐项核实，UA不能直接给出具名调用方。机器调用迁至已有受权/mcp聚合或服务端自有凭据直连；不新增工具grant，不伪造浏览器Strict cookie，不开无cookie注入旁路。

**.156启用拦截前必须同时满足**：完整观察周无缺口、发现的机器消费者已迁移且持有方验证、other已归因或明确处理、测试机同口径验收、#284恢复、DNS/内容地址就绪及属主切换批准。任何未迁完target保持未切流/禁凭据代理的新标签页降级，不用“只计数阶段”无限保留未经授权的旧暴露。必要临时封口由#284持权流程决定，不能为观察完整而阻止应急恢复。

开发估计仍5–7工作日（不含运维），**观察窗口是额外上线日历约束**。可在代码开发同时启动已获批观察以重叠，但当前尚未部署；故不能承诺原5–7天内切换.156，最早也在首个已完整覆盖的工作周结束、迁移/验收/授权完成后。测试机先行，.88仍不配置。

### 8.2 回退与属主待决

实施前冻结新旧固定包、配置引用/target-Host-DNS映射、served清单，备一致库副本并验兼容；迁移字段schema属于SOP版本变更需保旧记录、不可静默改已冻结run。切流失败回“写面关闭+旧可用业务”降级，明示旧同源执行风险；禁止“不可信旧HTML＋已启写面”组合。不同目标逐台回退映射，未过目标禁凭据代理可保原站新标签页；不全盘重建会话/授新权限。

任一跨台凭据被使用、上游B副作用计数非0、令牌可读、跨run保存、内部账号失效或匿名MCP非401即停止/撤新流量；不自动restore库覆盖新写入，不杀DSH宿主。#284网关OFF回退仅不安全应急，不混称安全回退。

**待属主/网管回填**：确认DNS能直接建立w-<id>-<env>.internal单层A记录及无命名冲突；提供test/gray各专用内容IP/端口（需网管分配并排除DHCP冲突）、记录创建撤销负责人、LAN/VPN解析器和测试机地址或脱敏台清单。.88只预留不配。默认无*.internal通配，HTTP无私有CA；HTTPS/分层域名将来另审。用户可见变化与5–7开发工作日（不含运维）已写明，最后复核并经属主明确批准实施后才动代码/配置，也不启审批授权。

本轮按非作者复核修订技术缺口，不作人工品味规则裁决；原3–5天/单内容origin方案已被本稿取代。实施完成仍须独立测量，不因文档修订而宣隔离PASS。
