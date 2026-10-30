# #288 源隔离核实（仅调查与拒绝反例）

基线：9e195dabac15c80121f149d0d3a8405e3d27fc5c。读取/测量：2026-10-30。未解除 LC_APPROVAL_READ_ONLY，未实现 grant，未用真实 Odoo/admin 凭据，未改生产。

## 结论

**源隔离前置①尚未通过。** 当前拒绝成立的原因是 approve 固定503、grant 没有业务路由404，不能据此宣布将来启用写面也安全。同源脚本能带着浏览器 HttpOnly cookie 发 JSON、自定义头、Sec-Fetch-Site=same-origin 的请求；它们也能读同源 CSRF 令牌。按钮确认与前端 root-grantor 可见性不是服务端授权。

## 执行面清单

| 面 | 代码证据（本基线） | 能否发送带用户cookie的市场POST |
|---|---|---|
| /go/ 外站代理 | server/src/portal.ts:255–257 删除上游X-Frame-Options/CSP；页面落市场源 | **能，浏览器实测**；不向外站转Odoo cookie只限制代理上行，不限制页面脚本向市场API发请求 |
| /sop/:slug/ Runner | server/src/sop-runner.ts:8–14 将step.body原样拼HTML；index.ts:1287–1307直接出HTML，无opaque sandbox | **能，浏览器实测**；页面自身也有/api/sop/*同源调用 |
| /sop/:slug/probe.html 等发布附件 | index.ts:1309–1326 HTML原文注入后同源输出，其他文件sendFile | **能，HTML浏览器实测**；脚本附件可能被Runner引用，非可信代码不能视为普通下载 |
| /go/ 指向SOP根/HTML附件 | portal.ts:47–68直接渲染/送文件，未走serveApp CSP | **能，两种入口分别实测** |
| /apps/:slug/ 自产台及历史版本 | index.ts:2077–2079 CSP sandbox，未含allow-same-origin | 不透明源；自定义头JSON预检被阻，但简单POST仍能到API（实测503/404），脚本读不到响应不等于没有副作用 |
| /go/ 指向自产台 | portal.ts:70–75走serveApp | 同上，浏览器实测 |
| 技能市场/快照 | web/src/pages/Skills.tsx使用React文本节点；index.ts:1999–2015导出application/x-tar + attachment | 未发现独立执行技能HTML的路由；快照目前是数据/下载，不冒称在CSP sandbox运行。若技能HTML作为自产台或SOP发布，按对应面处理 |
| app文件上传回显 | index.ts:1226–1236 MIME白名单inline+nosniff；HTML/JS/SVG MIME不在inline白名单 | 合成上传HTML验证attachment+nosniff，不作为顶层HTML执行面；允许inline的图片/PDF/纯文本仍属不可信内容，未来宜独立文件源，不能把Content-Disposition视作通用脚本隔离 |
| SOP run文件下载 | index.ts:1572–1583全attachment+nosniff | 合成上传HTML验证attachment+nosniff；不是Runner发布HTML附件路径，两者不能混同 |

HttpOnly仅禁止JS读取cookie文本，不禁止fetch由浏览器附带。以上实测只用合成HttpOnly session_id、未验证真实Odoo会话；没有发生真实业务写入。

## 可运行反例及测量范围

运行：

    node scripts/lifecycle-origin-smoke.mjs

依赖当前项目已装依赖、Python Playwright/Chromium。脚本创建全新DATA_DIR/YGL_HOME、随机回环端口、独立外站fixture；finally停止自己的子进程与fixture服务。不访问9800/真实Odoo、不创建grant、不签发断言。

- 7个真实页面入口，每个发approve/grant × JSON自定义头/简单POST，脚本执行4次结果均完成。
- 普通同源面的JSON POST收到503/404；浏览器记录cookie存在、same-origin。上游fixture原CSP default-src none被/go剥除，页面仍运行。
- opaque自产台的JSON预检404；简单POST在线路上到达并被503/404拒绝；CDP捕获网络响应以避免只看fetch TypeError误判为无请求。
- app与run两种上传HTML下载均attachment+nosniff。
- grant404仅表示当前未实现；以后实现时必须更新此组为明确拒绝码，不能以路由不存在证明隔离完成。
- 最终原件：tmp/lifecycle-origin-cvG0iH/browser-result.json、uploads.json、server.log；首轮缺SOP changelog的夹具失败保留，不放宽断言。

这是一组应用安全回归测量，不是CLI正式验证器的根PASS。未覆盖所有浏览器/PDF插件、上传MIME内容嗅探或所有HTML嵌套组合，不外推为全面审计通过。

## 推荐方案（供评审/排期，不在本PR实施）

1. **先做真正执行源隔离**：非可信/go、SOP正文/附件、自产台、可执行上传文件移到不接收市场身份cookie的独立内容主机名/站点；SOP壳与数据API保可信，非可信正文在sandbox iframe，必要交互只用窄能力、绑定对象的通道，不桥接approve/grant。不能把整个有业务写需求的Runner盲目挪端口后无约束开放CORS。
2. **只有换端口不够**：端口区分origin，不区分cookie作用域，Odoo host-only cookie按主机名跨端口发送；同站不同子域还需host-only市场cookie、严格目标Origin检查，且防同站CSRF。对Odoo session_id不能私自改Domain或代理到新内容源。优先不同站点/不共享cookie的内容域，保持现可信Odoo中继单独受控；具体域名配置另走授权。
3. **写面纵深门（隔离完成后）**：服务端只收可信UI精确Origin、JSON和自定义头，要求Sec-Fetch-Site=same-origin，并验证服务器生成、绑定session+动作+对象+短期有效+一次消费的CSRF/确认挑战；拒绝missing/null Origin与简单内容类型。不把这些门误当对同源恶意脚本的防护。
4. **grant服务端再授权**：root_grantor查decl/引擎，不信任前端是否显示按钮；人工二次确认与动作绑定，展示subject/domain/valid_to，2026-12-18上限在服务器/引擎校验。批准/授权和审计/锚点必须按原#288真实验收，不在本调查开通。
5. **SSO影响**：内容源不共享Odoo/市场cookie、不代持session_id。若需SOP身份，设计最小run-scoped能力；不以全站cookie或任意CORS恢复旧免登。#289内部用户门只是登录类别门，不替代ledger权限，也不解决同源脚本冒充。

## #288 与 #221 排序

调查、拒绝反例和执行源隔离可在#221之前推进；不应为了等待SSO整包停止安全修复。但**当前不建议先于稳定身份契约启用approve/grant**：#284未关，源隔离未通过，#221的市场身份与Odoo身份边界仍在裁定。实施写面宜排在#284恢复、源隔离独立验收、身份来源冻结之后；若属主明确批准独立的Odoo过渡写面，也必须有另行评审、绑定身份与权限的最小契约，不能把本报告当作该批准。

## 状态与限制

#284归本工作台开发线/持权运维恢复入口处理：已登记匿名MCP列表200差异、v4 START-ONLY工具已mock验收；尚未恢复，不能关闭。本PR仅文档和测试，无生产配置/授权/写面变更。#289独立复核评论6521672716是源码与合成范围，不是合并授权。本轮无品味规则裁决；推荐基于已证威胁边界，不冒充属主排期决定。
