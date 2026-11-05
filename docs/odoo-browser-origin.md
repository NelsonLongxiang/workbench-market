# 内网 Odoo 浏览器登录地址

`LC_ODOO_URL` 与登录台注册 URL 继续使用服务端可达的内部地址，不改 Odoo 身份查询源或 `/go` 已登录代理目标。可单独设置 `WM_ODOO_BROWSER_URL=http://192.0.2.88:8069`，但该 origin 必须已在 `WM_ODOO_ORIGINS` / 内部身份源的可信名单，禁止 userinfo、路径、query、fragment；配置非法拒启动。

仅当登录台 origin 等于内部身份源时，return 页面和普通302将浏览器送到明确配置的浏览器地址；同IP跨端口共享host-only session cookie。浏览器Host不一致返回503；请求为TLS或X-Forwarded-Proto任一项声明https时，禁止跳转至http浏览器origin并返回503（该信号只收窄拒绝，不授权目的地）。不声称固定IP配置覆盖其他hostname或公网。未设置时保持旧行为。飞书与密码表单在 Odoo 自己的入口上保留，不启动不完整的同域登录代理。

部署使用 `deploy/docker-compose.odoo-browser-origin.yml` 叠加原文件，钉已审镜像，保留原三个 env-file，`up -d --no-deps --no-build workbench`；不重启内核、PG、LayerFS、Odoo，不改注册表、不清会话。回滚去掉该 override 并恢复原精确镜像。

验收：浏览器origin策略19项；真实隔离HTTP18项（含HTTPS降级两入口拒绝与HTTP正例）（含身份查询仍走内部源、已登录代理仍走内部源、匿名401、不改注册URL）；原门户会话16项、退出27项、web typecheck/server语法检查通过。真实用户密码/飞书认证需用户自己操作，agent不索要密码，不把匿名表单200当认证完成。
