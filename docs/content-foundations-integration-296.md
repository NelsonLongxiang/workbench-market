# #296 接线前置及当前限制

本稿只解释Draft基础模块，不是运行实例或完整源隔离验收。index.ts/surfaces.ts尚未接入；等#294实际合入后按其localPort判面，内容面先执行contentSurfaceFence。围栏只放/__wm/launch与本target /go路径，大小写分类先归一，其余（含/API、/mcp、SPA、/sop、/apps）404；随后launch校方法/Origin/单次票据，代理校Strict上下文。HTTP与WS在凭据读取/上游连接之前共同准入；夹具不等生产handler。

## 内容分发终结清单（装配硬约束）

- `contentSurfaceFence`目前放行后`next()`；它只是筛路径，不是终结适配器。实际装配必须在所有市场共享路由之前，按`surfaceOf(req) === content`进入专用分发，`proxy`分支直接交内容适配器并结束响应，不得再`next()`回市场app。适配器大小写语义须与围栏一致；未知路由和代理失败返回受控4xx/5xx，不回退市场SPA。
- 现portal.ts的goPrefix区分大小写，不能拿共享market portal直接承接围栏放行的`/GO/1/`。`launch`大小写别名也必须在内容分发内拒绝/结束，不能落入SPA。
- 装配反例：内容端口`/GO/1/`、`/Go/1/x`要么由本台内容适配器处理，要么404，**不能返回市场SPA**；在真实共享Express夹具尾部放假市场SPA哨兵，内容HTTP正负例结束后哨兵命中计数必须为0。此反例尚未随实际listener装配执行，不冒称已通过。
- 此要求来源非作者续审6526587175；当前模块层58/30与浏览器对照通过只支持继续装配，不等于生产分发已终结。

## 200引导页硬约束
exchange返回cookie和bouncePath，不再返回容易被适配器用作3xx的location。适配器必须返回contentLaunchPage的200 HTML与no-store/CSP脚本哈希/Referrer-Policy，附Set-Cookie；不发302/303 Location。脚本只可跳固定/go/<数字id>/，不接任意URL。真实Chromium夹具以127.0.0.1可信壳跨站POST到w-1-test.internal：303对照随后不带Strict cookie、403；200文档location.replace随后带cookie、200；两者opener均null。这是scripts夹具，无生产测试路由/开关。测试需Python Playwright与Chromium，node scripts/content-launch-browser.mjs（Windows可用PYTHON=python选择已有解释器，不改PATH）。

## 非阻断项处理
- Node/undici mode=cors、无dest/site且UA为node/undici时观察类别为node；真实browser mode=cors+dest=empty仍归browser-fetch，未知无dest浏览器归other。提示可伪造，仅计数线索、不用于授权。
- 资源路径逐段decodeURIComponent一次，允许中文/空格编码；拒解码后的点段、斜杠/反斜杠、控制字、?#和残留百分号（拒双解码歧义）。结构/go/id不接受编码别名。上游若合法需要字面百分号/编码斜杠仍需单独兼容评审，不默放。
- 上下文固定300秒硬到期，当前不滑动续期；到期准入失败，装配须给可信入口重新登录/launch指引，不能以匿名凭据注入补救。此Draft尚未实现到期提示或工作时段续期，不称长期交互可用；会话时长/续期策略在真正代理装配前评审，不偷偷延长身份有效期。
- 票据/会话及签名密钥仅单进程内存，重启全部失效，不支持多worker共享；currentEpoch须由真实已核内部viewer会话撤销源提供，不能把夹具常量带生产。
- 观察计数持久库不含敏感请求原文，但coverageVerified恒false；完整工作周、重启缺口、持权读面/现场开启仍待装配和运维验证，不能从“没有写失败”推断观察完整。

## 验证和边界
node scripts/content-access-test.mjs：58项；node scripts/portal-observation-test.mjs：30项；node scripts/content-launch-browser.mjs：2条Cookie对照（各带cookie存在性及opener检查）。这些是定向开发测试，尚非正式根PASS，尚未验证真实Odoo登录、上游凭据/cookie容器、生产HTTP/WS装配、SOP字段通道或现场切换。

#294仍OPEN时不并改作者index.ts装配；不合并、不部署、不开LC写面、.88不动。
