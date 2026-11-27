# 属主个人令牌

在市场设置的个人令牌区域，以属主账号签发、查看和撤销。市场在签发成功时显示一次令牌原文。关闭后需重新签发。留痕只记录属主主体与令牌名称。列表显示签发、到期、最近使用和撤销时间。

## 签发与撤销接口

设置页在市场同源调用这些接口，使用属主本人会话。请求使用 Cookie。签发返回 201，初次和重复撤销都返回无应答体的 204。接口级错误包含 error 代号与中文 message。已撤销的令牌继续出现在清单上，以 revoked_at 判定状态。

| 请求 | 请求体与结果 |
| --- | --- |
| GET /api/owner/personal-tokens | 返回 personal_tokens、available_scopes 和 limits。personal_tokens 每行含 id、principal、name、scopes、benches、delegate（`assistant` 或 null）、created_at、expires_at、last_used_at、revoked_at。时间为毫秒 Unix 时间戳。available_scopes 和 available_delegates 每项含 id、label、description。limits 含 default_expires_in_days、min_expires_in_days、max_expires_in_days。 |
| POST /api/owner/personal-tokens | 提交 name、scopes、benches、可选 expires_in_days（默认 30，可选 1～90）和可选 delegate（只收 `assistant`，表示交给团队助理代办；不代办时省略或填 null），返回 token 和 personal_token。 |
| DELETE /api/owner/personal-tokens/{id} | 撤销该条令牌，重复撤销返回相同结果。 |

benches 为台标识列表。单独签发 report-dimensions 范围时可以留空。维度模板发布、复核和激活按维度原有规则控制。把维度绑定到台时还须列出目标台。数据查询和报告读取用 bench:read，定义数据集和写行用 bench:write，视图保存用 view，MCP 授予列表和申请决定用 grants。按台的作用域须明确选台。

## 在终端使用

将令牌存进本人权限为 0600 的普通文件。仓库的 bin 目录加入 PATH 后运行下列命令，或者直接调用 bin/wm。远程市场地址使用 HTTPS；省略地址时连接本机市场。登录命令将凭据从文件导入权限为 0600 的配置文件，并绑定市场来源。

```sh
wm user login --token-file ./private-token --url https://market.example
wm user query demo '{"query":{"dataset":"items"}}'
wm user datasets put demo items @dataset.json
wm user rows demo items --op upsert @rows.json
wm user view put demo @view.json
wm user grants demo approve 1
wm user dims activate quality 2
wm user reports demo --subject item:123
```

view.json 使用接口的 {base, doc, note} 结构，base 是当前视图版本，首次保存填写 0。其他命令和参数见 wm user --help。令牌只在当前有效属主身份下使用，业务授权和模板复核规则继续生效。超出作用域或台范围返回 403，撤销或到期后立即返回 401。用完后在设置页撤销，可同时移除本机配置。

## 团队助理：读本队台与代办（#1064）

团队助理按报告验收、替属主办事时分两条路，授予与撤销各走各的入口。

**读本队台的报告和数据（助理自己的账户）。** 助理用自己的 MCP 会话令牌（席位换来的令牌也一样）按台申请只读工具，比如 `dataset_query@bench:<台>`、`report_list@bench:<台>`、`report_get@bench:<台>`。授予：台的管理层（属主或领域负责人）在台的授权页批申请，或用 `PUT /api/bench-views/<台>/mcp-grants` 直接给，授予记在助理的会话上。撤销：在同一页收回，或用同一接口把工具清单改小，收回后助理立即读不到。批了的台读得到；别的台 MCP 回 `Method not found`，REST（`/api/mcp-rest/tools/<工具>`）回 403。

**替属主办事（属主的令牌）。** 属主在设置页签发令牌时勾「交给团队助理代办」（接口里的 `delegate: "assistant"`），把令牌文件交给助理，助理用 `wm user login --token-file` 导入。令牌默认只开读；要让助理批 MCP 申请、激活报告维度或保存视图，签发时勾上对应作用域（grants、report-dimensions、view）。没勾的写回 403，`personal_token_scope_denied` 的 message 写明缺哪项。勾了的写入与属主浏览器操作结果一致，审计署名为「属主（令牌 <名>·助理代办）」；不代办的令牌仍记「属主（令牌 <名>）」。判据复核、属主本人激活的例外等规则照旧，令牌只换认证方式，不改授权。撤销：属主在设置页撤销，撤销后助理的请求立即返回 401。代办对象签发后不能改，要改就撤销并重新签发。
