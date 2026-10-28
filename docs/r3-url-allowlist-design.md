# R3 业务 URL allowlist：注册准入最小设计与先红判据（草案，未实现）

来源：监督席派单 direct-dc91353f。状态：**只设计/判据，wm-review核后再裁**；无代码、旧spec或生产env变更。

## 1. 意图、现态与非目标

现有注册策略只判断网络类别（私网/回环等）+ALLOW_PUBLIC_NET宽豁免，无法证明一个公网URL已获业务许可。现REST与MCP注册/更新共用validateWorkbenchBody；批量import却仅assertHttpUrl后直插表，业务allowlist若只挂注册表单会被更新/导入绕过。

本期新增“哪个精确外部URL可以登记”的业务许可，不把已经存在的workbenches行当许可登记册（否则先写入再自授权）。公网URL默认仍拒。**业务许可不是用户认证，也不是完整出站SSRF防火墙**：DNS重绑定、CNAME、重定向每跳、已注册旧台/运行中连接的即时撤销属于后述部署边界，不假装字符串命中能解决。

## 2. 最小控制面：仅部署env，不加动态表/API

提案：WM_REGISTER_URL_ALLOWLIST=JSON字符串数组，未设为空[]。例（仅语法示例、不发真实请求）：

~~~json
["https://vendor.example:443/workbench/","http://203.0.113.10:8080/tool/"]
~~~

- env由受信部署维护者控制，固定进程启动快照；不从请求body/query/header或导入数据读取allowlist，REST/MCP调用者不能自行增加许可。不接受远程配置URL，不新增拉取/SSRF面。
- JSON非数组、非字符串项、通配符、CIDR、host-only/prefix/正则条目、非法URL均启动配置错误，不回落“放所有”。未设=[]是合法严格配置。
- 启动打印policy digest与条数，不打印完整URL/凭据。改列表需部署流程+重启，属于新配置生效；不暗改生产env。
- 本期**不提供**匿名/agent写白名单端点；如未来改数据库管理面，必须有效admin+canonical同源，另做审计/反例后裁。

## 3. 许可与ALLOW_PUBLIC_NET解耦：明确待裁的兼容性变化

**推荐语义（供裁，不冒充已生效）**：对于公网目标，精确allowlist是唯一业务授权。ALLOW_PUBLIC_NET=1仅保留兼容告警/部署风险提示，**不能绕过业务登记要求**；allowlist精确命中是受控“单URL例外”，不要求再开全局公网豁免。这把旧“flag=1全公网可登记”收紧为“即便flag=1也须登记”。flag本期不得扩大硬拒目标权限。

| 目标 | allowlist是否命中 | ALLOW_PUBLIC_NET | 提案结果 |
|---|---:|---:|---|
| 公网合法URL | 否/列表缺省[] | 未设/0/1任意 | 403 {error:"url_not_allowlisted"}，无写入 |
| 公网合法URL | 是 | 未设/0 | 准入201（更新200）+一条allowlist准入审计；无需开广域豁免 |
| 公网合法URL | 是 | 1 | 同上，另保持既有启动豁免告警；flag不新增权限 |
| 现有政策允许的私网/回环/内网短名 | 否 | 任意 | 沿现私网许可（本期不强制全内网逐URL登记） |
| 现有政策允许的私网/回环 | 是 | 任意 | 同样准入并审计命中，不减少原认证门 |
| 元数据/link-local等硬拒目标、非法URL | 即便列入 | 任意 | 拒（allowlist不能把红线变成许可） |
| 合法内部托管/apps、/sop路径 | 不适用外部URL列表 | 任意 | 保持自产台发布注册旧路径；不能把//evil当内部路径 |

**需裁点R3-A**：是否采上述“列表具体许可优先、旧flag不再广域授权”的收紧。另一方案是flag与列表AND，但那会让已登记URL仍依赖全局豁免，和派单“解耦/已登记放”不完全相符；未裁前不实现任一方案。
**需裁点R3-B**：私网本期保持既有准入，还是也改全部逐URL强制（后者影响内网建台工作流，需显式迁移与更多判据）。

## 4. 精确URL匹配（无隐式域授权）

- 使用单一http(s)解析与规范化方法生成key=(scheme,normalizedHost,effectivePort,pathname,query)。host小写/IDNA按WHATWG URL；缺省80/443与显式缺省端口等价；空path=/。
- pathname大小写/尾斜杠有意义：/tool/不授权/tool、/tool/a或/tool-evil。**不是origin级或startsWith匹配**。query保留顺序与值的精确语义，不sort/删参数；若含token/password等凭据不纳入列表，须用现有受控auth字段，不把secret放env登记URL。
- userinfo、fragment、反斜杠、控制符、编码/双解码带来的路径歧义、点段/父段、非法主机/端口拒；不让解析器静默规整成另一条已授权地址。%大小写等正规化细节冻结前由review给同一fixture，不能两种解析器各判各的。
- 公网FQDN可以精确登记；“10.attacker.example”等数值label混淆主机、元数据169.254/16、未指定地址0/8与::、IPv4-mapped到硬拒地址、非http(s)不允许靠列表放行。**硬拒优先于许可与豁免**是安全收紧提案，现代码在ALLOW_PUBLIC_NET=1时整段跳过CIDR，不能说现main已达成。
- IPv6公网精确登记的支持与内网v6边界需review核：推荐允许合法公网v6字面精确登记，禁止link-local/mapped元数据；不把任意[]判私网。此处仍需材料裁定，不偷写现代码。

## 5. 全入口一致性与原有行处理

| 入口 | 检查与结果 |
|---|---|
| POST /api/workbenches / MCP workbench_register | 相同规范化+业务policy，先验证后写；拒绝无行/无审计allow |
| PUT /api/workbenches/:id / MCP workbench_update含新url | 新URL必须重新准入，不能先建内网再PUT成未登记公网；只改标签/描述且URL未变不借机删旧台 |
| POST /api/import merge/replace | **整批预检完才变更**；任一外部URL未登记→403、原库/类型/布局不变，尤其replace不能先清库再查policy；不导入白名单权限 |
| 复制工作台/GUI建台 | 仍走同一核心，不接受UI隐藏字段带allowlist=true绕过 |
| 自产台/SOP自动登记 | 内部路径按旧业务门；拒//、反斜杠伪站内，非外部业务URL豁免 |

现存未登记公网台不自动删除。启动只做脱敏缺口报告，后续URL变更必须准入；**本期注册许可不等于阻断所有既有/go/运行访问**。如属主要即时撤销出站访问，须新增运行时每跳目标验证与迁移裁定，不在小件里假称完成。

health_path不得把注册目标扩成另一个origin（绝对/协议相对health_path拒）；同origin实际探测路径/redirect仍属于网络执行面。若只有静态URLkey校验，本期验收称“登记准入可控”，不能称“DNS/redirect SSRF已全闭”。

## 6. allowlist命中审计（最小可测，不引入另一套账号体系）

提案：结构化单行日志event=workbench_url_allowlist，operation=register/update/import，policy_digest、url_digest(SHA256规范化URL)、workbench_id、outcome=allow、at=UTC；调用身份仅在原合法认证结果已知时填稳定标识，否则anonymous，不信任X-Market-Client自报身份当认证。

成功数据库提交后每条准入行恰1事件；失败验证不记allow，事务失败不写成功事件。原URL/userinfo/query/Authorization/Admin/App token均不写日志。拒绝可另记deny reason+digest，但不能泄候选URLsecret。

用测试实例捕获stdout/专用日志核查审计，不为小件加公开审计API。日志持久留存由部署日志采集承接，本提案不宣称append-only数据库审计已做。若需要admin分页查询/不可改删表，另裁表方案与体量。

## 7. 先红判据草案（需wm-review冻结；当前未跑新功能，不伪称已红→绿）

| ID | 输入/形态 | 期望 | 现态预计/依据 |
|---|---|---|---|
| R3-U1 | 空列表+flag未设，注册公网 | 403 url_not_allowlisted | 当前仅CIDR拒400，不是业务策略PASS |
| R3-U2 | 精确已登记公网+flag未设 | 201/200，allow审计1 | 当前仍CIDR拒400，待真实先红 |
| R3-U3 | 未登记公网+flag1 | 403，不能因flag绕过 | 现flag1公网可201（既有R2测试），真功能缺口 |
| R3-U4 | 已登记公网+flag1 | 201，allow1+启动警告 | 当前无allowlist命中审计 |
| R3-U5 | 同host改scheme/port/path/query、尾斜杠、子域后缀攻击 | 不精确则403 | 当前无业务URLkey |
| R3-U6 | metadata/link-local/mapped元数据/0地址+登记+flag1 | 硬拒，无写入 | 当前宽豁免可能放，需隔离反例实证 |
| R3-U7 | 私网/回环合法对照；内部自产台合法路径 | 旧业务可用 | 回归，不以牺牲内网默认能力假修 |
| R3-U8 | REST/MCP一致；更新/复制/批量import绕路 | 不得绕过；replace拒绝后库不变 | import现直插未共用验证，需重点先红 |
| R3-U9 | 匹配条目含默认端口/大小写host；非匹配path大小写 | 按唯一key规则可复现 | 材料+fixture先定 |
| R3-U10 | 非法JSON/通配符/含secret URL配置 | 启动拒（不退放开） | 新配置不存在，不冒判 |
| R3-U11 | 命中成功/事务失败/日志值 | 成功1事件、失败0 allow、无secret | 新审计缺 |
| R3-U12 | 试图请求body/header/import写allowlist条目 | 无配置权限变化 | 配置来源必须env受控 |

反例至少5组：公网未登记、端口/路径扩权、数值label/后缀、metadata、import替换绕过+内网合法对照；先用隔离DATA_DIR/端口与MCP合法测试票立红，材料/fixture不齐如实NEEDS-MATERIAL。CI须分列已覆盖/跳过，不在生产注册探针行。

## 8. 提交裁定与排期

1. wm-review独立核匹配与反例，尤其ALLOW_PUBLIC_NET兼容性与import原子预检。
2. 总工/属主裁R3-A（flag独立与列表优先）/R3-B（私网适用范围）/IPv6与硬拒边界/日志式审计是否足够。
3. 材料新冻→当前main真实先红→再发实现单；本轮**仅此设计，不实现、不改生产env、不提前报完成**。
