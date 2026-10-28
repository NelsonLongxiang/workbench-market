# #221 执行面 NM 依赖与未完成项（不缩 scope）

目标 d90f81a 尚无SSO业务实现，夹具不能代实现。

真实进程/端口/hash → register拒绝组（现404与期望403/400不符=FAIL）
admin受控注册正向201（现404=产品前置缺失）→ login/session → 生命周期/TTL/多端/logout/disable/restart
login/session → 外部/go配置 → HTTP/WS/双闸 → D8真实服务审计 → a UPDATE/DELETE快照与b缺disabled中性审计
register/login → D5 P1/P2/P3代理锁桶；配置/会话 → outbound mapping/cookie/Odoo

## 非作者需核与尚未完整执行
- db-mapping-proposal.json仅拟定设计，不是事实表；用户salt/hash、审计表、session迁移须独立评审后纳新材料。未知/空表不算PASS。
- legacy fixture必须固定旧commit真实schema；目标无sso列=>NM，不添加未来列造旧库。
- keyless只经独立实例正常受控入口发行假票；无/错票负组可测（当前404≠403），正向发行缺仍NM。
- 49映射都有来源，47本期并非47完整handler；部分群组成功后显式抛MissingFixture或强制NM，不因函数存在计可冻结。
- a触发器明确errcode1811且副本可写对照；b{}独立入口；D5 P1/P2/P3编号固定，均当前register前置缺失，未执行到子断言。
- 真实浏览器登录/最终next跳转、合法MCP/app-token跨scope、cookie-map正负、数据库口令参数、完整锁窗/8h、限量警告、全部分页、旧迁移仍需补齐/非作者核。
- good/bad/empty只为谓词引擎夹具，绝非产品成功观测；尚未prepare/run，空scope守卫还待独立实证。
- 本轮不生成reviews.json、不作者自签；无submit/prepare/spec冻结/check-construction/selfcheck/meta/正式先红归档完成。

## 交付与门
保留a677aab原件；下一版本提交新增执行夹具及真实raw观测，不覆盖检查点。03:25+08交付时逐项列可执行与未齐，不把局部已编码等同可冻结。冻结/实施时间须独立席确认，不代承诺。
