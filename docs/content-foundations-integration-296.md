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

## 第2段：逐target旧门户浏览器迁出（默认关闭）

可信部署配置WM_CONTENT_TARGETS每项可设migrateBrowser:boolean，只有严格true开启，缺省/false不开，字符串true/数字/null拒配置；不提供注册表/匿名HTTP改开关。index在旧portal前调用迁出路由，只在market localPort上生效。没有内容配置就没有迁出中间件，不暗改所有/go。

已开启target的GET/HEAD顶层document导航302到固定可信marketOrigin/content/open/id，不带原资源路径/query/return/票据/凭据。旧iframe导航或HTTP无FetchMetadata但Mozilla+text/html的兼容分流，返回200静态人工点击链接（仅可信market可嵌、target=_blank/noopener），不在iframe自动跨站登录，进入可信顶层启动页后再人工launch内容主机。无Metadata时不能可靠区分document/iframe，因此保守统一人工打开，不以放开frame-ancestors解决跳转。不能将此页面当已认证内容。

POST/其他方法、upgrade、fetch/XHR、curl/node/python/MCP及无提示unknown继续旧路，不消费body、不重放、不自动迁走。导航的大小写/编码路径使用同content逐段规则；对已选择target的绝对形式/点段/编码斜杠等拒404；未选择的错id/编码id不改变旧路由语义。Host不等可信market authority拒，不按X-Forwarded-Host决定可信入口。分流本身零viewer/目标凭据读取与业务上游连接。

**这是迁移体验开关，不是安全边界或完整切断旧源**：UA/FetchMetadata可伪造，浏览器也可能无提示；非浏览器旧/go仍保留，机器伪装浏览器也会被导向启动页，不会获匿名授权。被动观察8类只是线索、other不可忽略、coverageVerified仍false；开关何时开/哪些target开及非浏览器盘点迁移由属主/运维排期，本PR不启任何现场开关。先观察完整工作周/确认调用者，再逐台迁移，不宣所有机器调用已盘清。

实际index合成浏览器包含旧iframe人工noopener入口、旧/go顶层导航迁出丢query、机器旧路health探针不变，并复验内容launch/WS撤权/XHR与导航401。不会自动注册内容DNS或改网络/配置。

## 第3段首个适配：Bearer与URL参数凭据（受限HTTP，未启现场）

公开登记快照38台=25站内/13外部，Bearer1、URL凭据参数标志2、Basic0、Cookie池挂接0；这是类别而非真实运行需求证明，不读取任何参数/凭据值、不访问真实目标。Bearer沿现服务端Authorization重建，真实index合成链同时核browser头不透。Basic只保原有能力，不以未登记推永远不用。

可信WM_CONTENT_TARGETS可增queryCredentialKeys（仅键名，1–8个、不重复/大小写歧义，禁止值），upstreamUrl必须移除这批参数、无userinfo/hash。每请求严格准入及真实Odoo现验后，才从registry私有URL取每个精确单值参数，剥后URL须与pin全文相同；缺/重复/拼写歧义或其他URL变化503。向上游请求仅由服务器追加这些值；浏览器同名/大小写/百分号编码键一律400且在私有配置读取前结束，不接“浏览器覆盖值”。launch/context/browser路径/聚合观察不加入这些值。

query凭据目标WS暂403（在读取私有凭据及业务连接前）；HTTP响应先完整有界缓冲（压缩前与解压后各2MiB），gzip/br/deflate已知编码可解压，未知编码/超限/解压错拒502固定content_response_rejected，不提前发任何上游body。原值、URL编码、表单编码、Base64、JSON转义这几种表示在body及上游header发现则整响应拒；URL/form仅对合法%HH转义十六进制字母统一大小写后匹配，覆盖upper/lower/mixed标准等价，不对响应整体decode、不更改raw/JSON/Base64字节匹配；跨块拼接后核，敏感redirect/cookie/header同拒，不反射值。仅允许同target无敏感键跳转；不透Set-Cookie/Refresh/上游缓存/etag/任意header，响应private no-store/no-referrer。二进制按字节检查，不冒覆盖任意字符集或混淆。

**这是已列表示形式的回显防护，不是任意上游信息流保密证明。** 恶意/被攻陷上游可以分散/变换/加密凭据、编码成脚本计算或其他隐蔽信道；一般代理无法证明“任意响应绝无参数值信息”。长轮询/SSE/大下载、query凭据WS以及需要上游动态Cookie的目标不支持；2MiB缓冲存在每请求资源开销，不宣性能/并发SLA。真实两台仍需持权方提供无值兼容材料和目标级验收/风险评审，不因本Draft合成回归与浏览器链过就允许现场切流。若业务要求任意上游也零信息外泄，需要目标专用服务端适配/不向上游发送秘密的协议，不能继续堆字符串黑名单当证明。

测试只用随机合成secret，上游计数记录布尔不记值；捕获进程stdout/stderr与公开聚合检查无该值，不把测试日志事后遮盖当“未泄漏”证明。测试输出文件仍可能包含随机synthetic值的私有夹具配置，不能拿它推断生产配置无秘密；没有输出或读取真实secret。真实registry/API脱敏规则不由本段改变。

## 站内静态只读段（合成样本不等于17台逐台兼容）

可信配置的upstreamUrl可为精确/apps/<slug>/。只读当前target的kind=app、status=active活跃版已物化资产；workbench须启用、登记URL仍与pin相同。元数据只投影url/enabled与active_version/kind/status，不读auth_config、Cookie池或台级token，不借用会注入token/冷回读的legacy serveApp，也不经市场HTTP/API反代。GET/HEAD之外405，WS403在私有适配前；读前、读后均核身份及上下文，响应提交前重核URL/root/version，变化503。

每段decode一次，拒dot/隐藏/空段、分隔符、二次编码和ADS；逐段lstat拒symlink/junction并做realpath包含检查。文件句柄stat与有界读取最多8MiB，GET/HEAD超限拒，长度变化不发旧Content-Length。仅相对资产/嵌套index，无SPA fallback、历史版查询、LayerFS冷回读或根绝对路径重写。每请求上限不代表并发内存/性能SLA；路径核对不提供本地恶意写权限者并发替换/硬链接攻击的OS级无竞态保证。

响应no-store/nosniff/no-referrer；CSP允许本源脚本/样式与data图片，但connect-src、frame-src、form-action、object-src、base-uri为none，frame-ancestors也为none。依赖市场数据/上传API、外部CDN、绝对根路径或SOP协议的页面尚不支持。SOP/MessageChannel后续分段，三步完成前不切SOP。静态合成GET/HEAD/路径/无凭据读取与浏览器相对JS/CSS已测，**不是17台现场逐台兼容验收**。CI纳入content-static-test；不改真实DNS/IP/现场开关。

## 目标代理范围与限制
显式WM_CONTENT_TARGETS固定{id,origin,upstreamUrl}；当前registry URL（若有声明query凭据则去除这些参数后）须全文相同，否则503，不能让agent改URL后用旧target上下文去另一源。HTTP/WS流式传输，按/go/id剥前缀，重建目标Origin；不转browser Cookie/Authorization/X-Admin-Token/forwarded头，只用服务器目标Bearer/Basic。上游Set-Cookie不透出以防覆盖context，跨目标/源跳转拒502。

Cookie池/动态上游登录容器尚未装配：绑定cookie_set_id的台在实际index拒503，不从browser拿身份兜底。HTML/JS/CSS根路径重写、SOP/MessageChannel字段通道未接（非SOP活跃静态只读见上）；本段只适合自持相对路径HTTP台及准入证明，不能称真实Odoo台/任意网站完整交互可用。

## 显式配置，未配置不启
- WM_CONTENT_PORT缺省/0不开；启用还须WM_CONTENT_IP（非通配显式IP）、WM_CONTENT_MARKET_ORIGIN完整origin、WM_CONTENT_ODOO_ORIGIN（精确origin且属于WM_ODOO_ORIGINS/LC_ODOO_URL信任集合）、WM_CONTENT_TARGETS JSON数组。错配拒启动，不造常量epoch。port不同market/control。
- 每target origin为http://w-<数字id>-test|gray|prod.internal[:port]，单label，port匹配且hostname不同market。upstreamUrl固定完整http(s) URL（无userinfo/hash），或精确/apps/<slug>/静态pin。
- 现场专用IP、域DNS记录、环境/target列表及可信Odoo源仍待交付，不阻合成Draft审查、阻现场启用；browser只host-resolver-rules，不改hosts/DNS/firewall。
- 单进程内存引用<=2048/core票据会话<=4096，重启失效，不支持多worker；SID最长硬期限内存在heap，不把内存转储当无秘密。

## 被动观察
WM_PORTAL_OBSERVE=1显式启，默认不建表/不计数。market HTTP或upgrade入口各一次，只存已注册targetId/固定类别/UTC日/hits，无URL/query/UA/cookie/body/身份原文。GET /api/content/observation走adminGuard且no-store；writesHealthy与coverageVerified=false分开，完整工作周/重启缺口仍待运维核验。

## WS冷/热对照实验（仍未定因）

content-ws-startup-test默认20个全新进程各一次授权握手，再一进程20次热握手；--prelude先加原surface的资源GET/本台跳转/跨源拒绝三次上游访问。仅启动真实内容surface/注册监听/真实回环HTTP与raw WS，身份为即时合成viewer，**不是实际index/真实Odoo连接、DB或生产冷启动覆盖**。每进程记录runtime-ready/handler-registered/listeners-ready/context-ready、viewer调用起止、credential-read、content/upstream/proxy upgrade/error、listen至请求及握手耗时，不记录Cookie或凭据值；没有独立异步初始化的配置与同步handler注册不能虚报后台“已完成”。撤权监视器沿实际upgrade安装，无产品hook/修改。

本轮默认有效冷0/20失败、热0/20失败；加HTTP prelude仍冷0/20、热0/20。默认冷listen至请求23.78–36.07ms，加prelude34.38–44.85ms；handler均在listen完成前注册。首批另在cold9启动登录HTTP的connect发生EADDRINUSE，未到授权握手，保失败原件、不算握手失败或静默丢请求；完整后续批setup0失败。驱动最多40次尝试补足20有效冷样本并单列所有setup失败，不能把补样本当首次全绿。实验命令成功仅代表有效样本采集完成，失败率在summary单列，不作CI零失败门。

这两组数据不支持本夹具的“冷组明显更差”，也不能证明原空wire已修、不能排除真实Odoo或不同连接/时间序列条件。原surface少量重复中仍出现过授权空wire，**根因UNKNOWN**；已保留原件与请求诊断。没有据未证假设加等待/匿名兜底或归为暂态。冻结mode0的首STOP拒绝属于另一执行链，未证关联、也不因本实验通过被闭合。现场不启用，SOP协议另段。

## 验证与未完成
content-access-test原58、portal-observation-test原30、303红/200绿cookie对照保留；content-surface-test真实registerSurface+sharedExpress+counted upstream+假时钟核HTTP/WS/到期/撤权/restart/编码/fallback0。content-index-browser真实index+synthetic DB/home+假Odoo/上游+Chromium核跨站200/opener null/撤权XHR401/导航同target401，上游合法1次且不漏browser身份。不是真实Odoo/DNS或生产验收。

首launch Origin:null失败与从CSP到期页发fetch被connect-src:none拒的驱动错位均留原件；改为原业务文档发撤权XHR，不放松CSP/Origin。数量按本轮实际log。仍待非作者复核、真实身份/网络、cookie容器和资源路径兼容、真实Odoo撤权时延及连接规模、完整工作周观察、SOP通道及部署批准，不冒全树或完整隔离PASS。
