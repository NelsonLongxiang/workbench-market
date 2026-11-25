# 属主个人令牌

在市场设置的个人令牌区域，以属主账号签发、查看和撤销。市场在签发成功时显示一次令牌原文。关闭后需重新签发。留痕只记录属主主体与令牌名称。列表显示签发、到期、最近使用和撤销时间。

## 签发与撤销接口

设置页在市场同源调用这些接口，签发与撤销均须有效的属主登录。签发返回 201，撤销返回 204。

| 请求 | 请求体与结果 |
| --- | --- |
| GET /api/owner/personal-tokens | 返回 personal_tokens 列表，每行含 id、principal、name、scopes、benches、created_at、expires_at、last_used_at、revoked_at。时间为毫秒 Unix 时间戳。 |
| POST /api/owner/personal-tokens | 提交 name、scopes、benches 和可选 expires_in_days（默认 30，可选 1～90），返回 token 和 personal_token。 |
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
