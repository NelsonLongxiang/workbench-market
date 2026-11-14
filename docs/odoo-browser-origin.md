# 内网 Odoo 浏览器登录地址（WM_ODOO_BROWSER_URL）

可选，缺省不设。`WM_ODOO_URL` 和 Odoo 台登记的 URL 继续用服务端能连上的内部地址（例如容器名），身份查询和登录后的 `/go` 代理目标都不变。部署方可以另外设置 `WM_ODOO_BROWSER_URL=http://192.0.2.88:8069`，作为只给浏览器用的 Odoo 登录地址。这个地址有以下要求，配置不合法时拒绝启动：

- 必须已经在 `WM_ODOO_ORIGINS` 或 `WM_ODOO_URL` 的可信名单里；
- 不能带账号、路径、查询串或片段。

只有当 Odoo 台的源等于 `WM_ODOO_URL` 时才生效：return 页和普通 302 会把浏览器送到这个配置的地址登录。登录后的会话 cookie 是 host-only 的，所以同一主机名不同端口之间能共享。以下两种情况一律返回 503 `odoo_browser_host_mismatch`，不跳转：

- 浏览器访问市场用的主机名和配置地址的主机名不一致，因为会话 cookie 带不回来；
- 请求是 TLS，或者 `X-Forwarded-Proto` 里任一项声明了 https，而配置的是 http 地址，因为这样会降级。这个信号只用来拒绝，不决定跳去哪里。

Odoo 台登记的 URL 只写源（`http(s)://主机:端口`），不要带 `/web` 这类路径。门户把台地址里的路径当挂载前缀：`/go/<id>/<p>` 会转到上游的「路径+`<p>`」。Odoo 的语言跳转（`/web/` → `/zh_CN/web/`）会落在这个前缀之外，旧版本会把前缀逐跳叠成 `/go/<id>/zh_CN/web/zh_CN/web/…`；现在这种跳转直接返回 502 `go_redirect_outside_base`，并说明要把台地址改成不带路径的源。

这个设置不声称覆盖其他主机名或公网入口。开启同域登录中继（`WM_ODOO_LOGIN_PROXY=1`，见 [odoo-login-relay.md](odoo-login-relay.md)）时，中继优先，这个设置对中继覆盖的 Odoo 台不生效，启动时会给出提示。飞书登录和密码表单都在 Odoo 自己的入口上，不受影响。

回滚：去掉 `WM_ODOO_BROWSER_URL` 后重启，就回到跳转 Odoo 台源的原行为。

测试：
- `node scripts/odoo-browser-origin-test.mjs`：地址策略 19 项；
- `node scripts/odoo-browser-origin-http-test.mjs`：隔离 HTTP 27 项（2026-11-13 实跑），包括身份查询仍走内部地址、已登录代理仍走内部地址、HTTPS 降级拒绝、主机名不符拒绝、中继优先。

两项都只用合成数据，不访问生产，也不用真实账号。真实账号和飞书登录要由使用者自己验收。

release/b217168 线的生产补丁来源是 #425（cbc6290）；main 上的这份是移植版本，改用 `configuredOdooUrl()` 读取 `WM_ODOO_URL`，并让同域中继优先。
