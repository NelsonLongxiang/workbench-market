# R3 业务 URL 登记准入契约 v2（#030 A–F，breaking，#258 已实现·未部署）

状态：**已实现（#258，属主 2026-10-31 本人排期并确认破坏性收紧的迁移），未部署**。代码在 `server/src/url-admission.ts`，回归在 `scripts/r3-url-allowlist-smoke.mjs`（U1–U15）。上线另需第 9 节的部署材料与窗口，不以代码合入报生产已收紧。
原状态行（保留）：材料修订 → wm-review独立核 → 新spec先红 → 按另行实施/部署授权落地。
完整依据：KB **069ad84a83**，content_hash **b1afd0f5a9d2e30bfac556d725db980a29057830**；全文已读，A–F逐条映射。前稿=PR#256 head6002c6ee、merge751e19ec。本稿明确替代前稿“需裁R3-A/B”的方向；以下精确分类表和schema为待review冻结的材料，不暗改旧spec。

## 1. A：精确公网许可独立flag（breaking）

唯一新配置：WM_REGISTER_URL_ALLOWLIST，JSON字符串数组，未设=[]。来源仅受信部署维护者、进程启动快照；不从register/update/import请求体、header、query或现有workbenches表自授权。无远程配置URL、无新增公开管理API。

| 分类 | 精确列表命中 | ALLOW_PUBLIC_NET未设/0/1 | 结果 |
|---|---:|---|---|
| 可许可公网IP/FQDN | 否（含空列表） | 全相同 | 403 {error:"url_not_allowlisted"}，无写入 |
| 可许可公网IP/FQDN | 是 | 全相同 | 注册201/更新200/导入成功；正常commit后准入行allow日志；**无需再开flag** |
| 合法私网/回环/内网短名 | 不要求命中 | 全相同 | 沿已批准准入，仍需原有合法认证；命中列表不升级控制权限 |
| 硬拒/语法歧义 | 即使误登记 | 全相同 | 硬拒优先；非法配置启动拒；请求不准入 |
| 合法内部托管路径（§3明确形态） | 不适用外部列表 | 全相同 | 沿内部发布/登记原安全门 |

ALLOW_PUBLIC_NET=1不再扩大任何许可，只保留兼容检测与显式“legacy flag no longer grants public registration”告警。这是对旧flag=1广域放行的**breaking收紧**，不是悄悄改变开关意义。新配置不能配置为宽通配、host前缀、CIDR、regex或origin-only。配置有坏项/非数组/非字符串项/硬拒项即整体启动配置错误；重复的规范化精确key可以去重并打印条数，不变成更宽许可。

## 2. F：变更说明、迁移确认、已知风险（不得等全部修完才登记）

现态代码风险（只读依据：validateWorkbenchBody、workbenchCreateCore/updateCore、POST /api/import）：
1. 公开/业务注册入口的网络许可不是调用者身份；本件不将其改成管理员专用，也不声称新用户认证已完成。
2. 当前import仅assertHttpUrl后直插，未走注册policy；replace先deleteAll再循环，非法/掩码行可被skip。**这是当前实际策略旁路和潜在破坏性导入风险**，不等allowlist实现完才记录；本轮不生产复现。
3. 现ALLOW_PUBLIC_NET=1会跳过网络类别检查；未登记公网及硬拒目标可能被该旧豁免放行，不能宣称main已具备新policy。

迁移材料必须包含：配置来源受信维护者、policy digest、是否使用旧flag、旧公网行/新列表缺口的id+URL digest+分类/原因（不含原query/secret）、受影响register/update/import调用方、回滚方案、维护者**显式确认**与部署窗口。确认缺失不部署；不因文档PR合入自动重启/改env。

旧行不删除，不启动删台；未改URL的纯元数据更新不借机拒后删行。旧公网URL原样回传的元数据PUT可视为URL未变（需同一规范化key，不能顺带换query/端口）；任何新URL和复制新行必须准入。现有/go执行访问不自动撤销，不宣称防火墙化；如要撤销出站执行另立迁移与每跳验证。

回滚不建议退回旧宽豁免；配置遗漏时优先补精确许可。确需回旧版本须属主另批风险和窗口，不能由agent静默恢复flag=1。

## 3. B/C：单核分类与完整硬拒集合（v2提案待独立review冻结）

先标准语义解析IP再做数值CIDR集合运算，不能按字符串首段、[]存在与否猜分类。IPv4-mapped IPv6先归IPv4再用同一分类：::ffff:127.0.0.1与127.0.0.1都为合法回环，不可绕过或无故变成公网许可；mapped元数据必须同拒。

### 3.1 IPv4 精确定义

合法私网/回环集合 P4 = 10.0.0.0/8 ∪ 172.16.0.0/12 ∪ 192.168.0.0/16 ∪ 127.0.0.0/8。

硬拒集合 H4（以下逐项穷举本期policy，不以“等”扩解释）：

| CIDR | 用途/为何硬拒 |
|---|---|
| 0.0.0.0/8 | 未指定/this-network，非业务外连许可 |
| 100.64.0.0/10 | 共享/运营商地址，非本期批准私网集合 |
| 169.254.0.0/16 | 链路本地，含云元数据169.254.169.254 |
| 192.0.0.0/24 | IETF协议特殊用途，保守整体硬拒（含其中可全球使用子项，需将来单裁例外） |
| 192.0.2.0/24 | 文档TEST-NET-1 |
| 192.31.196.0/24 | 特殊用途AS112-v4，非本期业务目标 |
| 192.52.193.0/24 | 特殊用途AMT，非本期业务目标 |
| 192.88.99.0/24 | 6to4 relay/deprecated特殊用途 |
| 192.175.48.0/24 | 特殊用途AS112服务 |
| 198.18.0.0/15 | benchmark网络 |
| 198.51.100.0/24 | 文档TEST-NET-2 |
| 203.0.113.0/24 | 文档TEST-NET-3 |
| 224.0.0.0/4 | multicast，不允许单URL业务许可 |
| 240.0.0.0/4 | 保留用途，含limited broadcast255.255.255.255 |

不在P4/H4且为合法标准IPv4的地址=公网候选 G4，必须精确URL登记。P4/H4不重叠；硬拒不能由allowlist或flag覆盖。分类表属于明确保守业务policy，不宣称完整实时IANA注册表，新增特殊用途变更须改材料新冻，不运行时外拉表默改。

### 3.2 IPv6 精确定义（先处理mapped）

1. ::ffff:0:0/96：识别IPv4-mapped并解码为IPv4，按P4/H4/G4；不把mapped当独立公网例外。
2. 允许不逐URL登记的P6 = ::1/128（回环） ∪ fc00::/7（ULA，沿批准私网用途）。
3. 可精确许可公网候选G6 = 2000::/3 **减去**下表H6-in-global。
4. 其余所有128位IPv6地址（既非mapped/P6/G6）均硬拒。这个集合补集定义穷尽范围，不漏“无法分类”分支。

H6-in-global（明确保守整体阻断的特殊用途前缀）：2001::/23（协议分配块，含Teredo/benchmark/ORCHID相关子项；保守拒绝块内全部，不开放子项例外）、2001:db8::/32（文档）、2002::/16（6to4）、2620:4f:8000::/48（AS112特殊用途）、3fff::/20（文档）。

补集内主要类别的具体fixture（非另设隐式例外）：::/128未指定、::/96 IPv4-compatible（除::1已在P6）、64:ff9b::/96 NAT64、64:ff9b:1::/48本地转换、100::/64 discard、fec0::/10旧site-local、fe80::/10 link-local（含元数据fe80::a9fe:a9fe）、ff00::/8 multicast，全部硬拒。补集中的其他值同拒，不凭“看着像v6内网”放。

zone-id（%eth0或%25eth0）、非法缩写/溢出段/括号错、含端口歧义或解析失败均格式400；在配置中则拒启动。拒IPv6 zone-id和未标准化嵌套编码，不靠移除zone后命中许可。合法公网v6字面只有G6精确URL命中才放。

### 3.3 主机名与内部路径

- 数值IP别名：只接受标准IPv4四段十进制（无多余前导零）/标准IPv6；十六进制、八进制、整数短IPv4及少段IPv4即使WHATWG可变IP也拒，防静默normalize越权。
- FQDN先经同一IDNA/URL解析，生成lowercase ASCII host；有效标签语法、无空标签/尾点/通配。任一全数值label的非IP主机拒（10.attacker.example、127.0.0.1.nip.io），与#242回归一致。IDNA转换后的同一ASCII host可匹配，不能按Unicode展示名/后缀startsWith授权；混淆/解析失败拒。
- 内网短名=单个非纯数值ASCII DNS label（1..63、小写字母数字/中横线且首尾字母数字）；localhost按回环。短名后补点/域或加数值label不是同一个被授权目标。
- 内部路径本期只允许 /apps/<slug>/、/sop/<slug>/ 及其合法相对资产子路径；slug=[a-z0-9][a-z0-9-]{0,63}；无query/fragment/反斜杠/点段/编码分隔符；路径必须属于已存在/本次合法发布将建立的托管台。//evil、/反斜杠evil、其他任意/路径不因startsWith('/')被放行。若现有别的内部托管形态确需兼容，先列路径和依据补材料，不“等”字兜底。

### 3.4 v4/v6 等价与边界fixture（不发外网请求）

| 类 | 输入组 | 预期 |
|---|---|---|
| 私网等价 | 10.1.2.3 / ::ffff:10.1.2.3 / ::ffff:a01:203 | 同P4准入 |
| 回环等价 | 127.0.0.1 / ::ffff:127.0.0.1 / ::1 | 合法回环准入，不需要公网列表 |
| 元数据等价 | 169.254.169.254 / ::ffff:169.254.169.254 / ::ffff:a9fe:a9fe | 同硬拒，flag/list均不救 |
| 公网等价 | 8.8.8.8 / ::ffff:8.8.8.8 | 同G4分类；URLkey统一mapped到v4后精确许可，不能未登记别端口 |
| v4边界 | 172.15.255.255 / 172.16.0.0 / 172.31.255.255 / 172.32.0.0 | G4/P4/P4/G4 |
| v6边界 | fbff::1 / fc00::1 / fdff::1 / fe00::1 / fe80::1 / ff02::1 | 拒/P6/P6/拒/拒/拒 |
| v6公网/特殊 | 2001:4860:4860::8888 / 2001:db8::1 / 2002::1 / 3fff::1 | G6待精确许可/硬拒/硬拒/硬拒 |
| 未指定/保留 | 0.0.0.0 / :: / ::ffff:0.0.0.0 / 255.255.255.255 / 198.18.0.1 | 全硬拒 |
| 非标准输入 | 2130706433 / 0177.0.0.1 / 0x7f000001 / [fe80::1%25eth0] | 格式拒；不normalize成已许可目标 |

## 4. A/C：单一精确URL规范化与许可key

key=(scheme,normalizedHost,effectivePort,pathname,query)，标准库IP/URL语义；scheme/ASCII host小写、缺省80/443等价、空path=/。mapped host先归v4；公网FQDN许可不证其DNS当前/未来地址安全。

- path大小写/尾斜杠有意义：/tool/不许可/tool、/tool/a、/tool-evil。query按序保留，不sort/删值；无query与空?按同一URL序列化规则冻结fixture，不得两个入口各判各的。
- 拒userinfo/fragment/控制字符/原始反斜杠/点段与编码父段。路径内编码分隔符%2f/%5c/%3f/%23或%25引发重复解码歧义拒；有效非分隔编码只做hex大写、**不解码后扩大路径权限**，UTF8百分号编码须合法。冻结用完整正反fixture核序列化。
- 配置URL含凭据不能靠日志脱敏变安全：拒userinfo与敏感query键token/password/secret/api_key/access_token（大小写不敏感）；凭据只放原受控auth配置。原请求URL存储不因key规范化把secret新放日志。
- 列表条目精确匹配，不能host suffix、regex或origin-only；不同端口/scheme/path/query不命中。合法大小写host与显式缺省端口等价；path大小写不等价。
- health_path必须解析后同origin；拒//协议相对、反斜杠及绝对跨origin值；同origin绝对health URL可按声明health用途接受，不把登记URL许可拓成任意出站。请求时的DNS/redirect每跳与代理运行面本期未做，非目标须保留。

## 5. D：全入口同核与import全事务

| 入口 | 同核契约 |
|---|---|
| REST register / MCP workbench_register / GUI /复制 | 同一normalize+classify+allowlist决策，先验后写；相同输入相同格式/策略错误；复制是新登记必须查许可 |
| REST/MCP update新url | 新key重新查；原key未变且纯元数据沿旧合法写门，不自动删台 |
| 自动登记（外部/内部发布链） | 都调用同一policy；内部形态只按§3.3托管白名单，不能另开startsWith('/')后门 |
| import merge/replace | 整批结构+策略预检全过后才进全事务；写期故障全回滚，不skip非法/掩码行，不先deleteAll |

import错误精确形态：结构/URL格式/掩码值400 {error:invalid_import 或 invalid_url 或 masked_import_value,row_index}；业务未登记403 {error:url_not_allowlisted,row_index}；硬拒403 {error:url_hard_denied,row_index}。不回显原URL/query/secret；row_index从0开始。任一行失败整批零写，不能已导一半却回“成功”。

事务写集合至少覆盖实际写入的workbenches、types、cockpit layout引用修复；若实现有额外DB写必须纳同事务清单。replace的deleteAll/type删除、导入插入、布局引用剔除全部在同事务；BEGIN前预检不替事务。第k行、类型写、布局修复各注入失败→原行id/内容/计数/类型/布局逐字节不变。测试用隔离DATA_DIR及已有快照，不碰生产。

masked导出恢复本期选**整批显式拒绝400 masked_import_value**（含URL=****或auth.value=****），指导维护者从合法受控备份/重新录入恢复；不skip后整体成功、不静默剥auth或丢行。若需部分导入另开有逐行结果与事先确认的新契约，默认replace绝不部分执行。

## 6. E：commit后allow日志、deny限量与故障边界

输出渠道=单行JSON至stderr，UTF8，每成功commit的准入行正常流程恰一条：

~~~json
{"event":"workbench_url_allowlist","operation":"register","policy_digest":"sha256hex","url_digest":"sha256hex","workbench_id":1,"subject":"anonymous","outcome":"allow","at":"UTC-ISO"}
~~~

operation=register/update/import；policy digest取规范化排序去重列表+分类policy版本；url digest取精确key；subject仅原合法认证已核标识，否则anonymous。X-Market-Client不当身份认证。字段无原始URL/userinfo/query/auth/admin/app token。合法私网不命中可另用普通准入日志，不伪装为allowlist命中。

- 预检/事务失败不能产allow；每行成功commit后正常路径发1条，不在预检时抢先写“成功”。批量n个命中行→n条。
- deny行event=workbench_url_admission_denied，reason用具名错误码+URL摘要（格式坏到无可规范化key时digest=null），无原值；限量固定每个reason每60s最多10条，窗口重置，丢弃计数在下一条摘要提示，不做无限攻击日志。
- **不是事务outbox，不承诺跨崩溃exactly-once**。commit后进程崩溃/日志管道断/磁盘留存故障可导致缺log；DB提交不因日志失败逆称“未发生”。正常响应保持201/200并加响应头X-WM-Audit-State:degraded（若还能响应）+独立 stderr event=workbench_url_audit_failure（若stderr本身坏则只能部署监控发现）。不自动重试业务写，避免双建。
- 日志输出序列化失败/流error必须捕获，不杀主服务；服务启动发现不可写日志渠道时拒启动。commit后日志丢失只报审计降级/NEEDS-MATERIAL，不报“所有allow日志已留存”。输出渠道与留存配置作为部署验收材料，留存由部署采集承接，无新公开审计API或不可篡改DB表承诺。

故障判据：precheck403/事务回滚→allow0；正常commit→allow1且JSON可解析；commit后注入日志失败→行仅1、无重试、服务仍活、明确degraded标记；commit后强制崩溃可无log=已声明边界，不伪判exactly-once绿。日志全断时缺可观测证据须NEEDS-MATERIAL，不拿HTTP成功代替审计成功。

## 7. 新spec先红判据（草案，不冒称已执行新功能）

| ID | 输入/反例 | 期望 |
|---|---|---|
| U1 | 空列表/flag任意+公网 | 403 url_not_allowlisted，零写 |
| U2 | 精确G4/G6/FQDN已登记，flag未设 | 201/200+commit后allow1；flag独立 |
| U3 | 未登记+flag1 | 403；旧breaking宽豁免不再生效 |
| U4 | 私网/回环/短名、内托管对照 | 合法沿旧门；//evil/任意内路径拒 |
| U5 | H4逐CIDR代表+H6补集/特用逐前缀+mapped等价 | 硬拒优先，flag/list不能覆盖；精确分类fixture不能只8.8.8.8单例 |
| U6 | host大小写/默认port vs path/query/端口/尾斜杠变体 | key等价/非等价逐项与§4一致 |
| U7 | 数值label/IDNA后缀/整数IP/zone/编码点段/控制符 | 格式或硬拒，不能normalize越权 |
| U8 | REST/MCP/GUI/复制/update/自动登记 | 同核一致，既有合法认证仍在 |
| U9 | import任一结构400/policy403/掩码400 | 整批零写，replace不先清库；row_index具名 |
| U10 | import写第k行/type/layout注错 | 全事务回滚，原workbenches/types/layout快照等价 |
| U11 | allow/deny格式、限量、secret扫描 | 正常成功每命中行allow1；失败0allow；deny≤10/reason/60s；无原secret |
| U12 | 日志流error/commit后崩溃 | 故障边界按§6，业务不重复、服务不中断，审计降级如实不计PASS |
| U13 | 配置格式错/通配/硬拒条目/请求自行加许可 | 启动拒或配置无变化；不能扩权 |
| U14 | 存量公网行缺许可/原key元数据更新/新key | 不删旧行；旧元数据不趁机丢台；新key需准入；/go不假称执行防火墙 |
| U15 | health_path绝对/协议相对/跨origin | 同origin规则明确，不可扩登记许可 |

至少5类拒样本：未登记公网、路径/端口/query扩权、元数据/特殊地址、数值/IDNA混淆、import旁路与写期故障；配合法私网/回环/已登记公网对照。IP组为纯解析/测试实例stub，不向metadata或真实第三方发探针请求。CI状态区分PASS/FAIL/SKIP/NEEDS-MATERIAL，未建新叶不报新功能已红→绿。

## 8. F流程事实与冻结出口

PR#256 merged_at=2026-10-28T11:44:09Z；CI run40682179542（head6002c6ee）success完成=11:44:13Z。成功晚合4秒，故**合前CI尚未终结**，不得追溯称三核合格。现CI成功只能作后验，不抹该流程缺口。未来先终态success再满足门；豁免必须事前授权，docs低风险不自豁免。

独立评审重点：完整IPv6/H4/H6集合是否一致可测、IP标准解析与raw歧义拒、import全事务注错回滚、日志流失败。分类保守子块与masked导入整拒为材料细化提案，若与#030边界矛盾先回needs-decision，不代码代裁。

材料无歧义后新submit/new spec、selfcheck/meta、当前main真实先红，再另派实现；不改旧spec消红。部署另经显式迁移确认/窗口，零生产写/配置/部署。本稿不是实现插队授权，#159与SSO在途不重复派。

## 9. 实现落点与部署迁移（#258）

**实现取舍（评审请重点看）**
- 严格 URL 形态（拒 fragment / 点段 / 编码分隔符 / 非法百分号）只约束**公网许可 key**与许可配置条目；私网/回环/短名沿旧准入，仍收 `#/spa` 这类 fragment，不借机收紧既有内网台。userinfo、控制字符、空白、反斜杠、非标准数值 IP、zone-id 对所有目标都拒。
- 敏感 query 键（token/password/secret/api_key/access_token）只在**许可配置条目**里拒；登记 URL 带 token 的既有内网台不受影响（列表/导出照旧掩码）。带敏感 query 的公网目标因此无法许可，凭据请走 auth 配置。
- 许可配置里出现私网/回环/短名/内部路径条目按坏项拒绝启动（它们本就不需要许可，放进去只会造成「列表能升级权限」的误解）。
- 「无 query」与「空 `?`」按 WHATWG 序列化视为同一 key。
- 内部路径要求台在 `apps` 表里已存在（`/sop/` 对 kind=sop，`/apps/` 对其余）；自产台发布链的自动登记同走这一核。
- 残缺或跨 origin 的绝对 `health_path` 现在登记时 400 `invalid_health_path`（以前落库后靠巡检记 down）。
- deny 日志对格式坏到无 key 的输入 `url_digest=null`；导入预检里每个被拒行也计一条 deny（同受限量）。
- 审计主体：REST 只认已核管理口令（`admin`），MCP 网关会话为 `mcp:<会话名>`，其余 `anonymous`。

**存量与迁移（属主已确认破坏性收紧）**
- 启动时对现有 workbenches 跑一遍新规，按新规会被拒的行输出一条 `workbench_url_legacy_gap`（stderr 单行 JSON：policy_digest、count、每行 id + url_digest + 原因码；不含原 URL/query）。这就是部署前要对照补许可的缺口清单。
- 存量行不删不停；原 url 原样回传的元数据更新照收；换新 url、复制成新台、导入都要过新规。`/go` 执行访问不因此撤销。
- 部署步骤：① 在候选实例上用生产库副本启动，取 `workbench_url_legacy_gap`；② 维护者按缺口逐条决定写进 `WM_REGISTER_URL_ALLOWLIST`（精确 URL）或接受该行不能再改 url；③ 记录 policy digest 与是否仍设旧 `ALLOW_PUBLIC_NET`（可去掉，设了只告警）；④ 窗口内切换，确认启动日志 `[R3] URL 准入 policy …` 与缺口数；⑤ 回滚=回退到上一个代码包，**不**以恢复 `ALLOW_PUBLIC_NET=1` 当回滚（它已不放行）。
- 日志渠道：allow/deny/legacy_gap/audit_failure 都走 stderr，留存由部署采集承接；本实现不承诺跨崩溃 exactly-once（第 6 节边界不变）。
