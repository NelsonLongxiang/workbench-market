# product/sso2 构造材料草稿（仅外部门户HTTP全子路径+WS）
目标SHA d90f81abca809a48a893544d0bdd4c409be78526
权威KB3aa49039e3+c3e0917349；contract.md为固定远端blob6eb65e85f7461bcb54f77e9d0fcdcb969627dac9完整字节。
此草稿未submit/prepare/冻结；无作者自签reviews。每个复合探针的全部子断言均需成功才value=1，失败value=0，前置/fixture缺失不允许伪value=1。
sso2_probes保存全部观测/状态；各候选仅读取独立sso2_eval_<probe_id>(probe_id,value)评价表；仅实际完成的0/1断言入评价表，未完成/延期表为空。
每候选scan必须精确probe_id=本单元，同时作用scope与find；混入其他单元行不构成本单元材料。目标value=NULL或非1是违例；无目标行才空scope。独审6479991735已证旧无scan混行假PASS，本稿49条全补scan；旧空/好/坏引擎结局见独审run，不冒称新候选已获核证。
延期正向保留独立候选与空评价表，不删除范围，不计PASS。
TEST三补充映射：S29 audit_append=UPDATE/DELETE分别拒且事件不变；S30 audit_patch_invalid必须含schema缺disabled子形恰一条；D5部署组P1=direct(S18)、P2=trusted-chain(S19)、P3=forged-XFF(S18/S20)。任何checker/期望变更需非作者核。

S00 [boot] (§0) 探针必须记录被验SHA、源码hash、进程PID、监听端口归属、独立DATA_DIR与启动配置并真实完成HTTP请求，不得误连旧进程。
S01 [switch_defaults] (D1/D4) WM_SSO未设为off，台sso.enabled默认false；四种双闸组合的HTTP与WS与预期一致，off不解除旧认证。
S02 [http_gate] (D1/D2) 双闸on的外部台全子路径：无有效会话的HTML GET/HEAD302到安全/login?next，HEAD无body；JSON GET/POST及静态子资源401，不转发上游secret。
S03 [ws_gate] (D1/D2) 双闸on外部台WS无或错会话401断开，有有效会话才101；握手单列不依赖Express中间件。
S04 [internal_target] (D1) 内部/apps或/sop台启用sso返回409 unsupported_target；关闭合法配置可200；直接内部入口与API不冒称被SSO保护。
S05 [machine_no_ticket] (D2) 缺wm_session时Authorization/X-App-Token/X-Admin-Token无论存在或在原scope合法，都不替代/go会话；不把MCP工具grant变成台scope。
S06 [machine_unavailable] (D3) machine_auth除none外全部409 machine_auth_unavailable，拒绝无持久写；validator正向DEFERRED不计PASS。
S07 [legacy_machine_config] (D3) 持久历史非none机器配置与内部enabled非法配置在启动/迁移显式配置错误，不静默归none/false后放行。
S08 [register_guard] (D4) POST /api/auth/register须有效admin与canonical同源JSON；无/错admin403，错/空/null Origin403，普通会话无admin权。
S09 [register_schema] (D4) 注册只建普通用户；username trim+lowercase后匹配[a-z0-9._-]{3,64}，password12..256不trim，未知role/admin字段400，重复名409。
S10 [register_ui] (D4) /register只显示受控开通说明，不承诺匿名创建；/login是真登录表单，SPA fallback200不算实现，页面不含管理员票。
S11 [login_session] (A1) 登录200返回user/expires_at/redirect_to并设置32字节随机opaque wm_session；HttpOnly、Path=/、SameSite=Lax、无Domain、no-store，不回显票值。
S12 [me_invalid] (A6) 无/伪造/撤销/过期/禁用wm_session到/me统一401 unauthenticated，合法/me200返回脱敏user/expires_at。
S13 [absolute_ttl] (A4) WM_SESSION_TTL默认8h，s/m/h显式单位；活动不滑动续期、重启不延长；秒级TTL到期/me及HTTP/WS入口拒。
S14 [multi_device_logout] (A3/A5) 多端独立；logout同源撤当前票并Max-Age=0，重放旧票401，另一端仍有效；无/旧票logout幂等200、重启不复活。
S15 [password_storage] (A1/A2) 同口令两账号持久salt/hash不同且无明文；每账号salt>=16字节+scrypt参数N16384/r8/p1/keylen64，接口日志无salt/hash/密码。
S16 [failure_same_bytes] (A2/D5) 未知用户/错密/锁定/禁用登录status及UTF8 body逐字节同401 invalid_credentials，不以Retry-After暴露差别。
S17 [lock_bucket] (D5) 失败按规范username+有效IP独立5次/10m/锁10m；锁期不滑动，秒级配置可测解锁，不设置跨IP全局用户名硬锁。
S18 [proxy_direct] (D5) 可信代理表空时仅socket IP；直连不同IP分桶，伪XFF/Forwarded/X-Real-IP不改身份或锁桶且限量告警。
S19 [proxy_chain] (D5) 仅peer命中WM_TRUSTED_PROXIES CIDR才从XFF右向左剥可信链；首非可信处停、不信首项/hop=true，mapped IP归v4；两客户端桶隔离。
S20 [proxy_invalid] (D5) 可信peer非法XFF400 invalid_forwarded_chain且不改认证/失败锁；无链回socket并告警；反代未配可信表启动告警不假报独立保护。
S21 [invalid_config] (D4/D5/D6) WM_SSO非法、TTL和三WM_AUTH_*显式非法、代理CIDR非法均拒启动，未设才默认；MAX_FAILURES整数无单位、TTL/window/lock需单位。
S22 [canonical_origin] (D6) MARKET_PUBLIC_URL仅http(s)绝对origin，无userinfo/query/fragment/非根path；on未配拒启动、off未配loopback，Host/XFH不改canonical。
S23 [secure_cookie] (补充1) 登录发票/登出清票Secure只依canonical scheme，https+伪XFP:http仍Secure，http+伪XFP:https仍不Secure。
S24 [next_validation] (补充4/B5) next缺省或scheme//反斜杠/控制符/编码多解码歧义均redirect_to=/，合法站内/go路径保留，最终跳转同验且不传播secret/state。
S25 [admin_disable] (D7) admin+同源PATCH disabled:boolean成功200脱敏，未知字段400，无admin403，无用户404；普通会话不能禁用。
S26 [disable_replay] (D7) 禁用事务撤所有旧票；后续/me/HTTP/WS握手拒，重启后仍拒，重新启用旧票仍拒；不承诺已建WS立即强断。
S27 [users_paging] (D7) GET users仅admin倒序游标分页limit默认50/1..200，字段仅id/username/disabled/created_at，无盐hash/session票，非法query400。
S28 [audit_read] (D8) GET audit仅admin只读倒序游标分页；普通会话403，非法query400，事件字段完整脱敏，不提供写改删口。
S29 [audit_append] (D8) 真实服务动作产生审计；数据库快照上的UPDATE/DELETE触发器拒绝，两操作后事件数据不变，不手造成功事件冒充。
S30 [audit_patch_invalid] (补充3) 有效JSON的schema错误或准入失败PATCH恰1 user_state_update/deny，主体未知null、target独立；零用户/session写、不存原body/secret。
S31 [audit_patch_valid] (补充3) 合法schema布尔PATCH按目标user_disable/user_enable每请求1allow/deny，重复设同值也1事件，404目标null，错误后正确请求不污染。
S32 [json_parser_boundary] (补充3) malformed JSON/413在全局parser先拒者不虚报路由中性事件恰1覆盖，保留原全局日志并单列捕获边界。
S33 [audit_navigation] (D8) 双闸有效时每HTML GET/HEAD入口决策恰1 portal_access，302也deny；普通CSS/JS无增，伪text/html仍按实际规则计1。
S34 [audit_upgrade] (D8) 每WS握手决策恰1 portal_upgrade，401deny亦记；101后的多帧不增入口或login事件。
S35 [audit_upstream] (D8) 市场会话allow后上游401/403不抹市场allow；中心/台off不新增SSO通过事件，既有审计不删。
S36 [mapping_modes] (C1/C3) none只门控；header-bearer/basic沿既有受控凭据配置；缺映射409，读配置无secret；入站wm_session不转发上游。
S37 [cookie_mapping] (C1) cookie-map仅允许cookie_name单键，禁wm_session/wm_sso_*；唯一目标domain匹配未过期池值可注入，0/多匹配409，无新secret写通道。
S38 [odoo_compat] (C2/D6) v1 Odoo state/回跳回归不破；外部台SSO启用的回跳须可信canonical origin一致，不把302起点当完成上游登录。
S39 [scope_preserve] (D1/D2) 既有/apps、/sop、/api/apps数据文件CORS与/mcp授权合法/非法对照保持；不把SSO门off等同允许控制面或匿名加权。
S40 [config_guard] (D1/D3) GET/PUT workbench sso仅admin，PUT同源/schema/目标/machine/支持范围/映射依次校验，所有拒绝零持久写。
S41 [audit_update_rejected] (D8/TEST-a) 快照数据库探针UPDATE审计行必须被触发器拒绝，错误后审计快照逐值不变；不是仅缺HTTP更新端点。
S42 [audit_delete_rejected] (D8/TEST-a) 快照数据库探针DELETE审计行必须被触发器拒绝，错误后审计快照逐值不变；不得构造伪事件冒充真实服务审计。
S43 [patch_missing_disabled] (补充3/TEST-b) 有效admin且合法Origin发有效JSON {} 的PATCH，因缺disabled返回400，恰一条user_state_update/deny，零用户/会话状态写，不记录原body/secret。
S44 [proxy_P1_direct] (D5/P1) P1直连组：独立客户端socket IP各自锁桶，mapped等价，未配置代理时伪XFF不改变clientIP。
S45 [proxy_P2_trusted] (D5/P2) P2可信反代组：实际peer命中CIDR，从右向左剥完整可信链，在首非可信处停，两客户端桶隔离，不取任意左首项。
S46 [proxy_P3_forged] (D5/P3) P3非可信peer伪造XFF组：伪造XFF/Forwarded/X-Real-IP不能改变clientIP/失败锁桶；忽略并限量告警，不自动信头。
S47 [deferred_validator] (D3延期) target-validator合法机器主体正向本期DEFERRED，材料不足必须NEEDS-MATERIAL，不以伪fixture或负向409计正向PASS。
S48 [deferred_internal] (D1延期) 内部原生SSO、企微LDAP IdP与已建WS强断不属本期出口，不计已实现PASS，后续补独立材料判据。

## 执行完整性守卫（非业务谓词）
G00 [integrity_boot] 执行完整性守卫：boot 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G01 [integrity_switch_defaults] 执行完整性守卫：switch_defaults 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G02 [integrity_http_gate] 执行完整性守卫：http_gate 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G03 [integrity_ws_gate] 执行完整性守卫：ws_gate 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G04 [integrity_internal_target] 执行完整性守卫：internal_target 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G05 [integrity_machine_no_ticket] 执行完整性守卫：machine_no_ticket 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G06 [integrity_machine_unavailable] 执行完整性守卫：machine_unavailable 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G07 [integrity_legacy_machine_config] 执行完整性守卫：legacy_machine_config 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G08 [integrity_register_guard] 执行完整性守卫：register_guard 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G09 [integrity_register_schema] 执行完整性守卫：register_schema 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G10 [integrity_register_ui] 执行完整性守卫：register_ui 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G11 [integrity_login_session] 执行完整性守卫：login_session 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G12 [integrity_me_invalid] 执行完整性守卫：me_invalid 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G13 [integrity_absolute_ttl] 执行完整性守卫：absolute_ttl 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G14 [integrity_multi_device_logout] 执行完整性守卫：multi_device_logout 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G15 [integrity_password_storage] 执行完整性守卫：password_storage 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G16 [integrity_failure_same_bytes] 执行完整性守卫：failure_same_bytes 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G17 [integrity_lock_bucket] 执行完整性守卫：lock_bucket 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G18 [integrity_proxy_direct] 执行完整性守卫：proxy_direct 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G19 [integrity_proxy_chain] 执行完整性守卫：proxy_chain 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G20 [integrity_proxy_invalid] 执行完整性守卫：proxy_invalid 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G21 [integrity_invalid_config] 执行完整性守卫：invalid_config 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G22 [integrity_canonical_origin] 执行完整性守卫：canonical_origin 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G23 [integrity_secure_cookie] 执行完整性守卫：secure_cookie 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G24 [integrity_next_validation] 执行完整性守卫：next_validation 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G25 [integrity_admin_disable] 执行完整性守卫：admin_disable 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G26 [integrity_disable_replay] 执行完整性守卫：disable_replay 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G27 [integrity_users_paging] 执行完整性守卫：users_paging 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G28 [integrity_audit_read] 执行完整性守卫：audit_read 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G29 [integrity_audit_append] 执行完整性守卫：audit_append 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G30 [integrity_audit_patch_invalid] 执行完整性守卫：audit_patch_invalid 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G31 [integrity_audit_patch_valid] 执行完整性守卫：audit_patch_valid 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G32 [integrity_json_parser_boundary] 执行完整性守卫：json_parser_boundary 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G33 [integrity_audit_navigation] 执行完整性守卫：audit_navigation 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G34 [integrity_audit_upgrade] 执行完整性守卫：audit_upgrade 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G35 [integrity_audit_upstream] 执行完整性守卫：audit_upstream 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G36 [integrity_mapping_modes] 执行完整性守卫：mapping_modes 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G37 [integrity_cookie_mapping] 执行完整性守卫：cookie_mapping 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G38 [integrity_odoo_compat] 执行完整性守卫：odoo_compat 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G39 [integrity_scope_preserve] 执行完整性守卫：scope_preserve 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G40 [integrity_config_guard] 执行完整性守卫：config_guard 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G41 [integrity_audit_update_rejected] 执行完整性守卫：audit_update_rejected 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G42 [integrity_audit_delete_rejected] 执行完整性守卫：audit_delete_rejected 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G43 [integrity_patch_missing_disabled] 执行完整性守卫：patch_missing_disabled 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G44 [integrity_proxy_P1_direct] 执行完整性守卫：proxy_P1_direct 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G45 [integrity_proxy_P2_trusted] 执行完整性守卫：proxy_P2_trusted 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G46 [integrity_proxy_P3_forged] 执行完整性守卫：proxy_P3_forged 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G47 [integrity_deferred_validator] 执行完整性守卫：deferred_validator 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。
G48 [integrity_deferred_internal] 执行完整性守卫：deferred_internal 的ERROR必须显式阻断总判定；保留原error_kind/code/rc与独立business_verdict，不把探针故障冒充SSO业务FAIL，不把NEEDS普遍降FAIL。

## 权威契约原文（完整）
# product/sso2 契约 v2：仅外部工作台门户 HTTP 全子路径与 WS 会话门

状态：**设计材料，待独立评审 → 新冻结 → 先红验证 → 实现**。不宣称当前功能存在，不改旧 spec 消红，不改生产 env。

## 0. 权威与变更边界

已完整阅读决策 #029：ygl KB **3aa49039e3**，content_hash **2387fb02dba186cb6306dce79048bedb2f941063**（D1–D8 全文，非派单摘要）。前置 #019/#024，评审意见见 #221 issuecomment-6462565120、6466660531；本稿替代提案 v1（6465922763）。追加全文依据：#029补充KB c3e0917349（content_hash f5545a5864ed7be1e65f08468791132297337209），覆盖dev此前validation_failed临时选择，该选择不再有效。下文 D1–D8 与裁定逐条对应；精确 schema、解析边界为供评审冻结的材料细化，不冒充新的已裁方向。

本期交付名：**市场自建会话 + 外部工作台门户准入门**。不是所有站点原生 SSO，也不是内部自产台/SOP 的全入口保护。现 main 的共享上游凭据注入只是出站代理能力，不能作为“已验证入站身份”的证据。

## 1. D1 范围、双闸与入口

- 外部目标：workbench.url 为 http(s) 绝对 URL。内部目标：workbench.url 是市场 /apps、/sop 等站内托管路径。
- effective = (WM_SSO === "on") && (workbench.sso.enabled === true)。中心默认 off，逐台默认 false；任一 off 维持旧认证，**不解除原 admin/MCP/app-token/上游门**。
- effective 外部台的 **/go/:id HTTP 全子路径和所有方法**、WS upgrade 都检查 wm_session，静态子资源也不能仅因“不是 HTML”绕过。HTML 仅决定未认证的应答形态，不决定是否认证。
- 内部自产台/SOP 本期不支持启用，配置 enabled:true 返回 **409 {"error":"unsupported_target"}**。中心开启不能隐式启用任何台。关闭内部台 SSO 配置（enabled:false、mode:none、machine_auth:none）可200；已有非法内部 enabled 配置在启动/迁移检测时报配置错误，不静默关掉后当作受保护。
- **范围外**：直接 /apps/*、/sop/*、/api/apps/:slug/data|files、/mcp 及既有控制 API。它们沿原合法规则，不声称受 wm_session 保护；现 app-token 的 CORS 行为不等于完整身份系统。
- /use/:id 是市场外壳，不是身份票；其嵌入的 /go/:id 必须走同一有效门。直接外部上游地址不在市场控制内，不能宣称被市场会话拦住。

双闸矩阵（每种均提供 HTTP 与 WS fixture）：off/false、off/true、on/false = 旧行为；on/true + 外部台 = 会话门；任意中心值 + 内部台启用请求 =409。

## 2. D2–D3 HTTP/WS 分流与机器面延期

本期 /go/ 的入站准入**只接受有效 wm_session**：服务端随机 token 摘要存在、未过绝对期限、未撤销且用户未禁用。没有 cookie、伪造 cookie、过期/撤销/禁用均为“未认证”。

| effective 外部 /go/ 请求 | 未认证 | 已认证 | 审计 |
|---|---|---|---|
| GET/HEAD，Accept 值含 text/html（大小写不敏感） | 302 Location=/login?next=<安全相对路径>；HEAD无body | 过市场门后按已配置的出站 mode 代理；上游仍可401/403 | 每入口决策恰1条 portal_access |
| 其余 HTTP（含 JSON GET、POST tools/call、非HTML静态资源） | 401，固定JSON {"error":"unauthenticated"}；不注入共享上游secret，不302 | 同一市场会话校验；HTTP body保持原代理读流，不提前消费 | 不复制 HTML 导航事件 |
| WS upgrade | 握手 HTTP401 + 断开socket，不302 | 同一会话/用户/双闸校验后才upgrade | 每握手决策恰1条 portal_upgrade，不逐帧 |

- 删去 v1 /go/ 表中的 **X-App-Token、mcp-session、target-validator 正向放行行**。任意 Authorization/X-App-Token/X-Admin-Token 的“存在”或其在别面合法，均不能替代 /go/ 的 wm_session。Accept伪装亦不能获得免认证。
- 本期 machine_auth **仅支持 none**。配置非 none（包括历史 app-token、mcp-session、target-validator）明确 **409 {"error":"machine_auth_unavailable"}**，不默默归none后放行。持久化历史非法值启动/迁移显式报配置错误，不能静默升级权限。
- /mcp grants 仍只是工具名，不投影成台/路径scope；/api/apps 的 app-token仍只按其原slug/method规则；管理员票只管原控制面。**不放宽也不额外收紧**现匿名业务写/读面。
- 有效 wm_session 加其他头不会升级权限；准入依据仍只有会话。无会话而头合法也不能进有效门。出站secret只能在有效市场身份之后按台配置注入；wm_session cookie本身绝不转给上游。
- 原 C2 的 Odoo 映射器保留，#185回归继续跑；**v1“不回归”不代表其forwarded-host已知风险已修复**。外部 Odoo 启用须新增可信canonical origin测试（见D6）。
- 延期正向 validator 另立材料：可信验证器属主、固定目标scope、请求/响应schema、timeout/错误、SSRF隔离、签名/防重放，再冻独立叶。延期=DEFERRED/NEEDS-MATERIAL，不计PASS，不用伪fixture解锁。

## 3. 端点清单与精确数据形态（D4/D7，A1–A6、C1/C4）

所有 JSON 写面拒未知字段、错误类型；用户名输入 trim 后转小写，匹配[a-z0-9._-]{3,64}；密码12..256字符，不trim；user={id:正整数,username:字符串}；时间UTC ISO8601；所有auth响应 Cache-Control:no-store。普通用户固定非admin，不能发控制票。

认证写面同源：Origin 必须等于 D6 canonical origin；缺Origin、Origin:null、外站、仅伪造Host/XFH均403 {"error":"origin_denied"}。管理员操作还须既有有效X-Admin-Token；普通会话不能代替。黑盒探针显式带合法Origin，不借回环免同源。

| 方法 路径 | 准入/请求 | 成功响应 | 错误 |
|---|---|---|---|
| POST /api/auth/register | **有效admin + 同源JSON** {username,password}；只建普通角色；role/admin额外字段拒 | 201 {user}，不自动发session | 无效admin403；schema400 invalid_request；重名409 username_unavailable |
| POST /api/auth/login | 同源JSON {username,password,next?:string} | 200 {user,expires_at,redirect_to} + 新wm_session cookie；不回显token | 未知/错密/锁定/禁用统一401字节体 {"error":"invalid_credentials"}；schema400 |
| POST /api/auth/logout | 同源JSON {} + 当前cookie | 200 {ok:true}；撤销当前会话+清cookie；无/已失效cookie同样200 | 同源/schema错误同上 |
| GET /api/auth/me | 当前wm_session | 200 {user,expires_at} | 无/错/撤销/过期/禁用401 {"error":"unauthenticated"} |
| GET /login | next?:string | 真登录HTML，表单调用login；显示“请管理员开通” | SPA fallback 200 **不算实现**；不显示匿名注册成功承诺 |
| GET /register | 无身份可看开通说明；实际创建仍admin门 | 200说明HTML（无匿名可用创建表单） | admin开通操作使用受控管理面，不将ADMIN_TOKEN放URL/静态文档/日志 |
| GET /api/workbenches/:id/sso | 有效admin | 200 {enabled:boolean,mode:Mode,machine_auth:"none"}；默认{false,"none","none"} | 无admin403；无台404 |
| PUT /api/workbenches/:id/sso | 有效admin+同源 {enabled:boolean,mode:Mode,machine_auth:string} | 200同GET（字段不省略） | schema400；非none409 machine_auth_unavailable；内部enabled409 unsupported_target；缺出站映射409 mapping_unavailable |
| PATCH /api/auth/users/:id | 有效admin+同源JSON {disabled:boolean}，拒额外字段 | 200 {user:{id,username,disabled}} | 无admin403；无用户404；schema400 |
| GET /api/auth/users | 有效admin；limit默认50/1..200，before_id正整数可选 | 200 {items:[{id,username,disabled,created_at}],next_before_id:int或null}，id倒序 | 无admin403；query400；绝不含盐/hash/sessiontoken |
| GET /api/auth/audit | 有效admin；同上倒序游标 | 200 {items:[AuditEvent],next_before_id:int或null} | 无admin403（有普通wm_session仍403）；query400 |

Mode = none/header-bearer/basic/cookie-map/odoo-relay。mode=none只做市场门，不许宣称上游免登；其余依赖管理员已有出站台凭据。配置读口不回secret，SSO配置写口不接明文secret新通道，沿既有凭据配置门。

cookie-map schema细化提案：SSO配置GET/PUT仅此mode增加cookie_name:string（1..64，HTTP cookie token字符，禁止wm_session、wm_sso_*），其他mode不得带此字段。值来自该台既有cookie_set_id池里同名且domain匹配目标host、未过期的唯一项；缺失/多项歧义→409 mapping_unavailable，无秘密值回传。不从入站wm_session生成上游cookie，不接收新的value字段。评审用目标echo fixture对照仅选中cookie出现、wm_session不出现。header-bearer/basic分别要求既有w.auth.type=bearer/basic且值有效，Odoo fixture检state安全流程。
配置校验顺序：管理员+同源→schema→目标存在→machine_auth可用→目标支持→映射可用；每次拒绝无持久写。默认开关与配置迁移单独探测。

## 4. 会话生命周期、TTL、口令与next（继承可测部分，D1/D4/D5）

- cookie为32字节密码学随机opaque票；只持久token摘要（SHA256是会话索引，不是口令算法）。Path=/、HttpOnly、SameSite=Lax、无Domain；**Secure仅按D6 canonical origin的scheme决定**：https→带Secure，http→不带Secure；永不读X-Forwarded-Proto/Host/XFH或未受信代理头来决定此属性。登录发票与logout清票同一依据；每次登录新票，不接受调用方指定session id。
- WM_SESSION_TTL默认 **8h**；正整数后缀s/m/h（2s、10m、8h），拒裸数字/0/负数/非法值，启动配置错误。**绝对非滑动**：expires_at=issued_at+TTL，访问不续；重启保留原期限。
- 多端独立：cookieA注销→重放/me401、有效门HTML302/数据401/WS401；cookieB仍可用。logout响应同Path清cookie Max-Age=0；撤销持久化，重启不复活，不以浏览器删cookie替代服务端撤销。
- 每用户独立≥16字节salt + Node scrypt（N=16384,r=8,p=1,keylen=64），定长安全比较；同密码两账号存值不同；未知账号使用同成本dummy验证。数据库无明文密码，API/日志/导出不泄secret。ADMIN_TOKEN既有机制本期不换。
- 认证失败未知/错密/锁定/禁用的status和UTF8 JSON字节完全同体401；不额外发不同Retry-After，不用粗略时延宣布无侧信道。
- next缺省/缺字段时redirect_to固定为/；恶意值同样回落/。next只收单斜杠站内相对路径。scheme绝对URL、//、反斜杠、控制符、编码/重复解码后跨origin或有歧义形态统一回落/；不回显攻击URL。服务端生成redirect_to并在最终跳转再核，不让前端直接使用原next；口令/token/已消费state不拼入next。

## 5. D5 锁桶与可信代理（精确配置schema）

| env | 默认 | schema/含义 |
|---|---|---|
| WM_AUTH_MAX_FAILURES | 5 | 正整数，秒级测试可置小值 |
| WM_AUTH_FAILURE_WINDOW | 10m | 正整数+s/m/h；失败计数时窗 |
| WM_AUTH_LOCK_TTL | 10m | 同上；锁期不滑动，不被锁期请求延期 |
| WM_TRUSTED_PROXIES | 空 | 逗号分隔IPv4/IPv6 CIDR字符串（trim各项）；空串=[]；非空坏CIDR/空项/主机名拒启动；不接受true、hop数或任意字符串 |

WM_AUTH_MAX_FAILURES / WM_AUTH_FAILURE_WINDOW / WM_AUTH_LOCK_TTL 三项显式设置为非法值（空、0、负数、非整数或非法单位）均**拒启动并给配置错误**，不得静默回落默认或变成无限。未设置才用上表默认，行为与WM_SESSION_TTL一致。

失败桶 = 规范化username + effectiveClientIP。未知用户名也计数；禁止退为单一全局用户名硬锁。IP正规化需把IPv4-mapped IPv6归同一IPv4（防两种拼写分桶绕过）。

clientIP算法：未配置代理或socket peer不在可信CIDR→只用socket地址，忽略所有XFF/Forwarded/X-Real-IP；peer可信才解析X-Forwarded-For，从右向左跳过完整可信链，第一个非可信地址是clientIP，不能取任意首项；其他转发头不参与本批。可信peer的XFF含非IP、空元素等非法链→400 {"error":"invalid_forwarded_chain"}，不产生认证/失败锁状态写；没有XFF→socket地址并告警缺客户端链。该错误形态是schema细化提案，独立评审需核一致性。

启动WM_SSO=on且WM_TRUSTED_PROXIES空→显式告警“若部署反代会合并客户端IP；未验独立锁桶”，不能把有告警的反代部署说成已独立保护。非可信peer携带XFF/Forwarded→忽略并限量告警，绝不自动信任。配置正确前，不声明反代客户端隔离验收通过。

部署验收三组（临时实例/可控代理，无生产改动）：直连不同有效IP桶独立；可信反代+两客户端IP独立；非可信peer伪造XFF不改变clientIP/锁桶。可信链中混入未信代理要在该跳停，不能越过它采用左侧声称的clientIP。

## 6. D6 单一canonical market origin

- 统一解析MARKET_PUBLIC_URL：只收http(s)绝对origin；无userinfo/query/fragment、无非根path（根/允许）；无效值拒启动。WM_SSO严格on/off，缺省off，非法值拒启动。
- 未配且off：canonical=http://127.0.0.1:PORT（沿a2a旧回落）；未配且on：**拒启动**，不能回落Host、X-Forwarded-Host或请求authority。
- SSO同源校验、绝对回跳、本期触及的a2a advertised base全部读同一解析结果；相对next仍单斜杠校验。测试篡改Host/XFH不改变canonical origin或回跳。
- v1 Odoo使用forwarded-host的已知风险另挂#185回归面，不将“不回归”说成已修复。外部Odoo启用的回跳必须验证canonical origin一致；不能拿旧302起点冒充真人登录全闭环。
- 不改生产MARKET_PUBLIC_URL/WM_SSO/可信代理env；部署另审批。无明确canonical origin的SSO on实例不能被当作有效测试环境。

## 7. D7 账号禁用与多端持久撤销

PATCH disabled:true在同事务内持久禁用并撤销该用户所有旧会话；后续/me、有效门HTTP、后续WS握手即拒。重新启用只是允许重新登录，旧cookie仍拒；禁用/启用+重启三组均要测。普通用户不能禁用他人或自己，不将普通wm_session当admin。

合法schema且disabled为布尔值的PATCH每请求恰追加一条user_disable/user_enable（action按布尔目标值，成功allow/其他业务拒绝deny；即使重复设同值亦一次审计、状态幂等200）。**缺disabled、非布尔、未知字段或其他schema400，统一action=user_state_update、outcome=deny；准入失败（无效admin/Origin在schema前拒）也用user_state_update+deny**。不猜禁用动作，不静默不记。subject_id只表示已认证管理员（未知为null）；目标独立用target_user_id（能安全确定且存在则id，否则null），不要把被操作用户冒充操作者。所有上述失败均零用户/session状态写，审计不存原body/密码/票据，每请求一次而非多层重复。

**JSON解析边界**：本批至少覆盖进入认证PATCH路由的有效JSON里的准入失败与schema失败。malformed JSON或body超限如已在全局body parser拒绝且未到该路由，明确不在本期该action“恰一条”保证内，保持原400/413与既有全局安全日志；不得因此宣称全局HTTP失败全已审计。若新增路由前捕获则需另列判据、与路由事件去重，冻结材料未新增时不暗做全局承诺。评审冻结用请求数与事件差量确认，不把状态未变化当作可省审计。不承诺对已建立WS即时强断，本期只核后续握手；若要强断另增连接生命周期判据，不能写“所有在途立即失效”。

## 8. D8 审计字段、触发点与恰一条

AuditEvent={id:int,at:ISO,action:register/login/logout/user_disable/user_enable/user_state_update/portal_access/portal_upgrade,subject_id:int或null,target_user_id:int或null,workbench_id:int或null,auth_kind:wm_session/anonymous/admin,outcome:allow/deny,client_ip:IP字符串}。
仅admin只读GET游标分页；不提供审计写/改/删HTTP口，SQLite触发器拒UPDATE/DELETE（仅快照数据库探针）。无口令/盐/hash/cookie/Authorization/X-App-Token/带secret query；普通用户看审计403。

- 有效外部门下GET/HEAD且Accept含text/html：在**市场门最终allow/deny**时每入口请求恰一条portal_access，302同样deny。相同Accept伪装按实际规则计事件，不猜是不是“真实浏览器”。同路径HEAD一请求也一条。
- 不为每个普通CSS/JS/文件子请求复制该HTML导航事件；若其Accept刻意含text/html，按上项规则仍记一条。非HTML数据门401不记portal_access（其他既有安全日志保留）。
- WS每次握手决策恰一条portal_upgrade，无身份401断开也记deny；已升级后不按帧重复，不虚增登录事件。
- 上游再次401/403不抹市场门allow，不把目标拒绝改成市场deny；probe以目标独立stub故意401验证两层分离。
- register/login/logout/禁用等按服务端实际动作追加，失败也留痕；subject未知时null，不泄完整尝试口令。注销无效票的幂等返回不等于认证allow。中心/台off不新增“SSO通过”的入口事件；旧审计不删。

## 9. 评审阻断→D1–D8映射与必测反例（不得漏项）

| 原阻断/问题 | 裁定映射 | 可执行材料/反例组 |
|---|---|---|
| /go app-token无现流量、内部直连范围不清 | D1/D2 | 内部启用409；直接/apps、/sop、/api/apps旧合法规则保持；外部/go全子路径双闸矩阵 |
| MCP tool grants无台scope | D2/D3 | 合法市场MCP token、伪造Bearer、X-App-Token、admin票均不能替代缺失wm_session；不能新建隐式grant映射 |
| target-validator合法fixture缺 | D3 | 非none409、旧非法值迁移拒；正向DEFERRED不建伪PASS |
| 公开注册/中心开关未定 | D1/D4 | 无/错admin、合法admin+错Origin、role字段提升均拒；普通账号成功；双闸off/on各组合 |
| 反代合桶/伪造IP | D5 | 空可信表直连、可信CIDR完整链、非可信XFF伪造、链中断、非法CIDR/非法XFF |
| canonical回落冲突 | D6 | on缺origin拒启动；off缺=loopback；非法userinfo/path/query/fragment拒；伪Host/XFH不改变origin |
| 禁用状态不可黑盒造 | D7 | admin PATCH造态，多端旧cookie拒/重启仍拒/启用不复活/后续WS401；已建连接强断单列延期 |
| portal_access计数不明确 | D8 | 单GET+HEAD=各1，CSS/JS默认Accept无增，伪text/html仍1，WS握手各1，frame0，上游401保持市场allow |
| TTL/next/logout/口令安全 | D1/D4/D5与继承A组 | 秒级绝对期限、多端、旧票重放、next恶意组、相同密码不同盐/hash、401错误逐字节同体 |

## 10. 新冻结出口与仍需独立核对的细化

- 本期出口只列外部门户会话门与自建账号/审计，不算内部原生SSO、validator正向、IdP企微/LDAP已交付；出站共用凭据注入不证明目标已识别用户个人身份。
- 评审独立检查本稿范围、schema、反例与实现路径一致性；无歧义后**新submit/new spec**，selfcheck/meta过，再以当前main真实FAIL/NEEDS-MATERIAL立红叶。不更改旧spec掩盖历史失败。
- 评审6467860215已接受：可信peer非法XFF=400策略、cookie-map单键配置schema、每次PATCH含幂等调用一审计、username规范化。本次写死四项冻结口径：Secure依canonical scheme、WM_AUTH_*非法值拒启动、非法PATCH统一user_state_update中性deny审计、缺next→/。action由#029补充KB c3e0917349确定，交评审纳入新spec；若发现矛盾回needs-decision，不先代码自决。
- 原B1 harness的“未配置台也应302”、无admin注册、12h、/login SPA200当绿均作废；必须按新双闸外部fixture重建真实先红（含WS）。现无SSO实现/验收证据，不报完成。

## 11. 最后四口径冻结反例（评审6467860215）

| 项 | 正/反对照 |
|---|---|
| Secure | canonical=https时即便X-Forwarded-Proto=http仍带Secure；canonical=http时即便X-Forwarded-Proto=https也不带Secure；logout清票同样属性 |
| WM_AUTH_*非法配置 | 三项逐一探0、负数、乱码/非法单位、显式空值均拒启动；未设才取默认；合法秒级窗口/锁TTL可用于测试 |
| 非法PATCH中性审计 | 合法admin+同源下缺disabled/字符串/额外字段→400且user_state_update/deny恰1；无/错admin或错Origin→403且同样中性deny1；未知subject/target为null；user_disable/enable零增量、用户与会话不变，无原body。解析前错误另按边界列，不虚报已覆盖 |
| 缺next | login未给next→redirect_to=/；合法/go路径保留，恶意next回落/ |

schema400 PATCH的选择不证明实现已存在。本轮依然只有材料更新；新spec/selfcheck/meta/先红均归独立评审执行。

## 12. 任务映射与实施门（#029补充，不修改路线图）

提请监督席在#145正式登记SSO任务与#221/#029关联，本稿不擅自改路线图：
1. 材料工作：当前文档四口径与中性审计→独立评审无歧义。
2. 验证器工作：新submit/new spec→check-construction/selfcheck/verify meta全过→当前main真实先红；validator正向/internalSSO延期不计PASS。
3. 实施前置：正式任务/排期与既有施工授权门确认；文档PR254或本PR合并不构成代码开工/生产启用许可。
4. 实施验收出口：本期外部门户+会话+审计逐条翻转，保留旧面回归与部署独立审批；通用全局FAIL29/PASS数量均不代表SSO叶已建立或通过。
