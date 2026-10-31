# #296 内容面装配（Draft，默认关闭，未部署）

原98259e0已merge固定main09fb3888，保公开历史/旧报告；#294已实合，不再等待M1。此PR仍须属主看过再合，不合并部署、不开LC审批授权、.88不动。

## 实际接线
index在共享CORS/body-parser/portal/SPA前mount终结分发，按socket.localPort选content；复用registerSurface，显式IP/port。未知/API/mcp/a2a/sop/apps/错target均404，不next回市场SPA。HTTP与WS先验context、每次现查原viewer，最后才读取目标凭据与连接业务上游；/GO/id分类与代理前缀一致，不复用旧market goPrefix。

可信市场GET /content/open/id只收固定target及market authority；只保唯一合法Odoo session_id，在固定可信源现查内部身份后签一次票据。用户点击form以noopener新标签POST目标内容主机，严格Origin等于market，不用匿名票据/上游凭据补救；票据不进URL。exchange返回200文档提交host-only/Strict/HttpOnly context cookie，再location.replace固定/go/id/，不发303。

实际浏览器发现启动表单页no-referrer/noreferrer会让POST Origin变null，故仅启动表单页采用strict-origin和rel=noopener，不发送来源路径/query；内容到期页仍no-referrer。原失败保留，未放宽Origin gate。内容cookie仅随机id+HMAC，Odoo SID只在进程内引用。

## 硬300秒退路，不滑动续期
resolveOdooViewer现查get_session_info能核uid/username/internal，但无可信viewer expiresAt/独立撤销epoch。采用派单d：引用从签发起至多300秒，context交换起至多300秒，取更早；活动不延长，不实现“闲300秒续至8小时”。每请求用原SID向固定可信Odoo现查，不缓存成功；注销/转门户/无身份/源不可达全部401。await后再核core/时钟，仍不宣数据库事务级撤权原子性。

- 到期顶层GET/HEAD导航静态401：唯一同target的可信/content/open/id链接，人工点击，不自动跳转。原路径不保存，固定首页，拒任意return URL切台。HTTP缺Metadata时GET/HEAD+Accept:text/html按导航兜底；明确XHR/cors等得JSON，分类只影响错误表现不参与授权。
- fetch/XHR/POST等非导航固定401 JSON {"error":"content_context_expired"}，不redirect、不重放body；WS握手同401拒。重启引用/签名key全部丢弃，体验同到期。
- 可信入口未登录时给/lifecycle登录入口，随后需手动回同target启动页；自动跨Odoo保target回程尚未接，不冒无缝SSO。已升级WS与未结束HTTP响应现在有主动租约重验，具体界限见下一节；不是逐帧强一致授权，不能宣每帧即时失效。

## 第1段：已连HTTP/WS主动撤权

每条未结束的HTTP流/已upgrade双工连接独立监视，重验完成后1秒再查，单次等待上限5秒；不重叠发同连接重验。对同一原Odoo SID仍只向已配可信Odoo查询，不读上游身份。发现注销/无效/异常或超时即销毁两侧业务连接；不发送重登录redirect、不重放HTTP body或WS消息。响应finish/close/abort取消监视，WS关闭清远端与待升级请求；重验超时不能阻止关闭。

**断开合同：正常可运行的Node事件循环下，身份撤销在固定Odoo源可见后，保守上界11秒**（可能有一个撤前已发起的5秒校验返回旧成功，再间隔1秒+下一次5秒校验失败）。空闲无在途时通常约1秒，校验挂起约6秒；不能拿测得约1秒替代最坏上界。外加事件循环调度/OS传播误差；主机挂起或事件循环长期阻塞不是实时系统保证，不宣墙钟绝对11秒。期间在途/已缓存字节不能撤回，关闭前仍可能收发，不称撤权瞬间原子隔断。

300秒硬期限单独定时，不等身份校验完成；计时器触发再核同一时钟，假时钟与真实时钟不混用；身份源挂起也不能把本地硬期限续长。每个连接到期/撤销会使对应viewer引用失效，兄弟连接在其下次重验关闭（同上界），不支持跨进程广播。

验收content-stream-revocation-test：真实HTTP长响应及HTTP101双工持续收发，撤销/身份异常/挂起/硬到期后旧连接断、后续收发计数不再增加、上游也关闭；原guard取消/expiry与挂起检查另有机械时钟用例。原raw101夹具只证透明传输，真实Chromium+完整index另以有效RFC6455握手/服务端text帧验证旧WebSocket撤权后close且不再收消息。所有身份均合成，不是真实Odoo时延SLA。

## 目标代理范围与限制
显式WM_CONTENT_TARGETS固定{id,origin,upstreamUrl}；当前registry URL须全文相同，否则503，不能让agent改URL后用旧target上下文去另一源。HTTP/WS流式传输，按/go/id剥前缀，重建目标Origin；不转browser Cookie/Authorization/X-Admin-Token/forwarded头，只用服务器目标Bearer/Basic。上游Set-Cookie不透出以防覆盖context，跨目标/源跳转拒502。

Cookie池/动态上游登录容器尚未装配：绑定cookie_set_id的台在实际index拒503，不从browser拿身份兜底。HTML/JS/CSS根路径重写、SOP/自产台内联、MessageChannel字段通道未接；本段只适合自持相对路径HTTP台及准入证明，不能称真实Odoo台/任意网站完整交互可用。

## 显式配置，未配置不启
- WM_CONTENT_PORT缺省/0不开；启用还须WM_CONTENT_IP（非通配显式IP）、WM_CONTENT_MARKET_ORIGIN完整origin、WM_CONTENT_ODOO_ORIGIN（精确origin且属于WM_ODOO_ORIGINS/LC_ODOO_URL信任集合）、WM_CONTENT_TARGETS JSON数组。错配拒启动，不造常量epoch。port不同market/control。
- 每target origin为http://w-<数字id>-test|gray|prod.internal[:port]，单label，port匹配且hostname不同market。upstreamUrl固定完整http(s) URL，无userinfo/hash。
- 现场专用IP、域DNS记录、环境/target列表及可信Odoo源仍待交付，不阻合成Draft审查、阻现场启用；browser只host-resolver-rules，不改hosts/DNS/firewall。
- 单进程内存引用<=2048/core票据会话<=4096，重启失效，不支持多worker；SID最长硬期限内存在heap，不把内存转储当无秘密。

## 被动观察
WM_PORTAL_OBSERVE=1显式启，默认不建表/不计数。market HTTP或upgrade入口各一次，只存已注册targetId/固定类别/UTC日/hits，无URL/query/UA/cookie/body/身份原文。GET /api/content/observation走adminGuard且no-store；writesHealthy与coverageVerified=false分开，完整工作周/重启缺口仍待运维核验。

## 验证与未完成
content-access-test原58、portal-observation-test原30、303红/200绿cookie对照保留；content-surface-test真实registerSurface+sharedExpress+counted upstream+假时钟核HTTP/WS/到期/撤权/restart/编码/fallback0。content-index-browser真实index+synthetic DB/home+假Odoo/上游+Chromium核跨站200/opener null/撤权XHR401/导航同target401，上游合法1次且不漏browser身份。不是真实Odoo/DNS或生产验收。

首launch Origin:null失败与从CSP到期页发fetch被connect-src:none拒的驱动错位均留原件；改为原业务文档发撤权XHR，不放松CSP/Origin。数量按本轮实际log。仍待非作者复核、真实身份/网络、cookie容器和资源路径兼容、真实Odoo撤权时延及连接规模、完整工作周观察、SOP通道及部署批准，不冒全树或完整隔离PASS。
