# #266 自产台读面：可信身份、读票据与分阶段收口（设计稿，待裁）

状态：**只是设计，未实现、未部署**。不改 `server/`、`web/`，不碰生产，不读真实数据。交属主或总工裁定，§9 列出要裁的点。
基线：main `044d18c`。实施前要按当时的 main 重新核对文中的行号。
配套测试矩阵：[`app-read-scope-266.matrix.json`](app-read-scope-266.matrix.json)。

本文延续 #266 已审过的第一章结论：「HMAC(slug) 是服务能力，不是身份」「CORS/Origin/loopback 不能当主体」「只给三条 GET 加门不等于封口」。它补上当时缺的那一环，也就是**授权真源**。理由：#309 第二阶段（`sop_run_read_grants`）和 #324（`task_source_read_grants`）已经合入 main，形成了一套现成的口径——**新鲜的 Odoo 内部会话给出主体，管理员显式授权，按对象记录，带到期和撤销**。本稿把同一套口径搬到自产台读面上，不另起 IAM，也不新建 cookie 账户体系。

---

## 0. 现状（main `044d18c` 上的代码事实）

| 位置 | 事实 |
|---|---|
| `server/src/index.ts:1278` `GET /api/apps/:slug/data` | `getApp` 后直接按 slug 分页返回全部记录，没有任何读门 |
| `:1351` `GET /api/apps/:slug/files` | 同上：返回原文件名、大小、note、下载 URL |
| `:1395` `GET /api/apps/:slug/files/:id` | 同上：直接回原件字节流。`image/*`、`pdf`、`text/*` 白名单 `inline`，其余 `attachment`，统一 `nosniff` |
| `:240` 写总门 | `GET/HEAD/OPTIONS` 一律 `next()`，读面不拦 |
| `:110–132` 按台 CORS | `Origin: null` 时比对 `X-App-Token == HMAC(slug)`，只决定发不发 ACAO；不匹配也照样 `next()`，服务端不拒 |
| `:629` `wmAppToken` | `HMAC-SHA256(key, slug)`：不含主体、期限、动作，永久有效 |
| `:2302` `serveApp`、`:1494` SOP 子页、`portal.ts:75` `/go/<id>` → `serveApp` | 把 `wmAppToken(slug)` 注入**任何人**都能打开的 HTML |
| `:3315` MCP `app_data_list` / `app_files_list` | 只看工具授权，`args.slug` 任意 |
| `web/src/components/AppDataDrawer.tsx:30` | 市场页的「数据」抽屉，同源普通 `fetch`，不带 `X-Admin-Token` |

现网补证（#266 最后一条评论）：匿名 `GET` 可以翻页列出文件、下载原件、读出全部数据。攻击链：匿名打开 `/apps/<slug>/` → 从 HTML 里取出令牌 → 带令牌也行，不带也行，都能读。

**已有可复用的部件**

| 部件 | 位置 | 用途 |
|---|---|---|
| `resolveOdooViewer(cookie)` | `odoo-viewer.ts` | 每次向 Odoo 现查：只认 `is_internal_user === true`，得到 `user:<login>` 和 `admin` 标志 |
| `odooAdminOf` / `markOdooAdmin` | `index.ts:202–221` | Odoo 管理员认定，按会话哈希缓存 30 秒 |
| `adminHeaderOk` | `index.ts:2707` | 管理员口令或 Odoo 管理员，且请求为同站 |
| `rawLoopback` + `browserMarked` | `surfaces.ts` | 本机命令行：回环直连、无浏览器标记、无反代头 |
| `runGrantActive` 的授权表口径 | `sop-read-auth.ts` | 主体、对象、`expires_at`、`revoked_at`；以最新一条未撤销记录为准 |
| `downloadAuthed` | `web/src/api.ts:82` | 同源 SPA 带头 `fetch` → Blob 下载，已经在用 |

---

## 1. 可信身份从哪来

### 1.1 身份来源与判定

| 主体 | 凭什么认 | 主体名 | 读权范围 |
|---|---|---|---|
| 本机命令行 | `rawLoopback(req) && !browserMarked(req)`（属主口径：本机命令行免口令） | `cli` | 全部台 |
| 管理员口令 | `adminHeaderOk(req)`：口令正确且同站 | `admin` | 全部台（审计记 `via=admin`） |
| Odoo 管理员 | `markOdooAdmin` → `odooAdminReqs`（#359） | `admin:<login>` | 全部台 |
| Odoo 内部员工 | `resolveOdooViewer` 现查成功，`is_internal_user === true` | `user:<login>` | **只限授权表里列出的台**（§1.2）；或者该台策略为 `internal` |
| Odoo 门户/公共账号 | 现查返回 403 | — | 无 |
| MCP 会话 | 网关已验证的 Bearer 会话 | `mcp:<会话名>` | 只限授权表里列出的台（第 3 阶段） |
| 读票据持有者 | 服务端验签、未过期，**并且签发依据此刻仍然有效** | 票据里的主体 | 票据里写的那一个台 |
| 旧 HMAC(slug) 持有者 | — | — | **无读权**。过渡期只用来给写请求放 CORS |

不能当身份的：`Origin`、`Referer`、`Host`、`X-Forwarded-*`、`Sec-Fetch-*`、IP 白名单、`created_by`、MCP 工具授权、`args.slug`、`X-User` 一类自报头。以上字段一律不进入授权判定，只用于拒绝。

### 1.2 普通业务用户：Odoo 登录态 → 「能看哪个台」

新增授权表 `app_read_grants`，字段照搬 `task_source_read_grants`：

```
app_read_grants(
  id INTEGER PK, app_slug TEXT NOT NULL, subject TEXT NOT NULL,   -- user:<login> | mcp:<会话名>
  expires_at TEXT NOT NULL,                                        -- UTC，必填；建议上限 180 天
  revoked_at TEXT NOT NULL DEFAULT '', granted_by TEXT NOT NULL, created_at TEXT NOT NULL)
app_read_settings(app_slug TEXT PK, policy TEXT NOT NULL DEFAULT 'grant',  -- 'grant' | 'internal'
  read_epoch INTEGER NOT NULL DEFAULT 0, updated_by TEXT, updated_at TEXT)
```

- **判定**：`grantActive(slug, subject)` 取该主体在该台最新一条未撤销的授权，要求未过期，语义与 `runGrantActive` 相同。
- **台策略**：`grant` 为缺省值，只放行授权表里的人。`internal` 表示「本单位任何内部员工都能看」，由管理员对单个台显式打开，用于本来就面向全员的看板。没有全站通配，也没有 `*` 主体。
- **谁来授权**：只有管理员（`adminGuard`），通过管理 API 或市场页操作。暂不引入「台属主」角色，等出现真实需求再另行设计。
- **不推权**：`created_by`、发布者、A2A 节点名、上传人都不能推出读权。这与 #309 的判据一致。
- **为什么不用 Odoo 权限组**：`get_session_info` 不返回权限组。要用权限组就得多一次 RPC，还要维护「组 → 台」的映射，复杂度高于授权表。可以作为第 3 阶段之后的可选项。

### 1.3 已知残余：同源的不可信内容

`/go/<id>/` 外站代理和 `/sop/<slug>/` 页面与市场同源，而且不在 sandbox 里（见 #288、#292）。在这些页面里跑的脚本可以带着用户的 cookie 调读接口，也能读出带票据的 `/apps/` HTML。所以只要读面接受 Odoo cookie，就存在「用户能看的数据，同源的恶意页也能看」这条残余。#309 和 #324 目前带着同样的残余。根治办法是 #291 的独立内容源，不在本 issue 的范围内。**本方案堵的是「匿名、任何能连上端口的人」这一层，不宣称已经实现同源隔离。**

---

## 2. sandbox 页面怎样合法读本台数据：读票据

### 2.1 为什么要用票据

自产台响应带 `CSP sandbox`，没有 `allow-same-origin`，页面是不透明源。它发出的 `fetch` 属于跨站请求，浏览器不会带 `SameSite=Lax/Strict` 的 cookie；`SameSite=None` 又要求 HTTPS，而现网走 http。所以页面脚本**发不出 Odoo 会话**。

但**加载页面 HTML 的那次文档请求**是同站导航（顶层打开，或者 `/use`、`/go` 里的 iframe），浏览器会带上 `session_id`。服务端就在这一刻认人、查授权，然后把一张短期票据注入页面。页面拿到票据后，照旧放进 `X-App-Token` 头调本台接口。**现有台页面基本不用改**：它们读的本来就是 `window.WM_APP_TOKEN`，只是这个值从永久的 HMAC 换成了短期票据。

### 2.2 读票据格式

```
wmr1.<base64url(payload)>.<base64url(HMAC-SHA256(readKey, "wmr1." + payload))>
payload = {"t":"read","s":"<slug>","sub":"user:<login>","via":"grant|internal|admin",
           "gid":<授权行 id，没有则 0>,"ep":<该台 read_epoch>,"iat":<秒>,"exp":<秒>}
```

- 签名密钥 `readKey` 存放在**新文件** `DATA_DIR/.wm-app-read.key`（0600），与旧的 `.wm-app-token.key` 分开。两者互不认对方签出的值。
- 票据是无状态的，不落库。每次请求都按下面的顺序验：签名 → `t === "read"` → `s === 路由 slug` → `exp` 未到 → `ep === 当前 read_epoch` → **签发依据仍然成立**：`via=grant` 时授权行 `gid` 仍有效；`via=internal` 时该台策略仍为 `internal`；`via=admin` 时只看 `exp`。
- 票据只能放在 `X-App-Token` 头里传。出现在查询串、URL userinfo 或请求体里一律不认。同名头出现多个时直接拒，不挑第一个。

### 2.3 发给谁、在哪发

| 签发点 | 条件 | 注入什么 |
|---|---|---|
| `serveApp`：`/apps/<slug>/**/*.html`，包括 `?version=N` 历史版本、冷回读、SPA 回落 | 文档请求带的 cookie 能认出主体，并且对该 slug 有读权（§1.1） | `WM_APP_TOKEN = 读票据`，`WM_APP_READ = true`，`WM_APP_TOKEN_EXP = exp` |
| 同上 | 认不出主体，或者没有读权 | `WM_APP_TOKEN = 旧 HMAC`（只用于写请求的 CORS），`WM_APP_READ = false` |
| `/go/<id>/` 映射到自产台 | 与 `serveApp` 同一套逻辑（`portal.ts:75` 本来就调它） | 同上 |
| `/sop/<slug>/` 子页 HTML（`index.ts:1494`） | 同上 | 同上 |
| 冷回读分支（`serveApp` 里的 layerfs 读取） | 现在返回的是原样文件、**不注入任何令牌**。保持不变，第 1 阶段要用测试把这一点钉住 | — |

带票据的 HTML 响应加 `Cache-Control: private, no-store` 和 `Vary: Cookie`。不带票据的 HTML 也加 `no-store`，防止共享缓存把带票据的版本发给别人。

管理员口令用户的情况：口令存放在 `sessionStorage`，文档请求带不上，所以打开台页面时拿不到票据。这部分用户看数据可以走市场页抽屉（第 1 阶段改为带口令头），或者登录 Odoo 管理员账号，或者用本机命令行。**不把管理员口令注入 sandbox 页面。**

### 2.4 有效期

| 票据 | 缺省 | 上限 | 环境变量 |
|---|---|---|---|
| 读票据（`via=grant/internal`） | 60 分钟 | 240 分钟 | `APP_READ_TICKET_TTL_MIN` |
| 读票据（`via=admin`） | 30 分钟 | 60 分钟 | `APP_READ_ADMIN_TICKET_TTL_MIN` |
| 下载票据（§3） | 10 分钟 | 30 分钟 | `APP_DL_TICKET_TTL_MIN` |

票据过期后接口返回 `401 {"error":"app_read_ticket_expired"}`，页面**重新加载自己**即可：重新加载就是一次新的文档请求，会重新认人、重新签发。**不提供「凭旧票据续期」的接口**，否则票据可以无限延长，Odoo 侧注销就失去意义。注入的脚本里附一个可选的小工具 `WM_APP_READ_RETRY()`：收到 401 且错误码是 `app_read_ticket_expired` 时，弹出提示并 `location.reload()`。

### 2.5 吊销

| 要吊销什么 | 怎么做 | 多快生效 |
|---|---|---|
| 某人对某台的读权 | `POST /api/apps/:slug/read-grants/revoke {subject}` | 下一次请求就生效（每次都查 `gid`） |
| 某台「全员可看」 | `PUT /api/apps/:slug/read-policy {"policy":"grant"}` | 下一次请求 |
| 某台已经发出的全部票据 | `POST /api/apps/:slug/read-epoch`（`read_epoch + 1`） | 下一次请求 |
| 全站所有票据 | 轮换 `.wm-app-read.key`（管理 API 或本机命令行），然后重启 | 立即 |
| Odoo 注销、员工离职、管理员被降权 | Odoo 侧操作即可 | 最迟等到 `exp`（60 或 30 分钟）。下一次加载页面时就拒发 |

票据 TTL 就是 Odoo 侧变更生效的上限。如果要做到即时生效，就得在每次 API 请求时都向 Odoo 现查，而 sandbox 页面带不出 cookie，做不到；只能靠缩短 TTL 来折中。

---

## 3. 直接下载附件的安全边界

### 3.1 问题

在 sandbox 页面里写 `<a href="/api/apps/<slug>/files/<id>">` 或 `<img src=…>`，这类请求带不了 `X-App-Token` 头；从不透明源发出的子资源请求也带不出 Lax cookie。所以必须有一个「放进 URL 也安全」的凭据。

### 3.2 下载票据

```
wmd1.<payload>.<sig>   payload = {"t":"dl","s":"<slug>","f":<file id>,"sub":…,"via":…,"gid":…,"ep":…,"exp":…}
```

- **绑定到单个文件 id**：只对 `GET/HEAD /api/apps/<s>/files/<f>` 有效。放到列表、数据接口或其他文件 id 上一律 403。读票据也不能当下载票据用，反过来同样不行（`t` 字段区分）。
- **从哪里拿**：
  1. 用读票据、cookie 或管理员调用 `GET /api/apps/:slug/files` 时，响应里每一项的 `url` 直接写成 `/api/apps/<s>/files/<id>?dl=<wmd1…>`。现有页面只要用的是 `item.url`，就不用改。
  2. 页面自己拼 URL 的，改为调 `POST /api/apps/:slug/files/:id/dl-ticket`（读票据在头里）拿票，或者改用带头 `fetch` → Blob 下载（与 `downloadAuthed` 同样的写法）。
- **为什么不做一次性票据**：浏览器下载会断点续传、重试，`<img>` 也会重复请求，一次性票据会误伤这些行为。改用「单文件绑定 + 10 分钟 + 签发依据实时校验」来控制风险。如果属主要求一次性，第 3 阶段可以加一张消费表。
- **URL 里放票据的风险与缓解**：查询串会出现在浏览器历史、`Referer` 和日志里。缓解措施：响应加 `Referrer-Policy: no-referrer`；`endpoint-stats` 已经剥掉查询串（`endpoint-stats.ts:53`），实施时还要确认没有别的访问日志记录了完整 URL；票据只对一个文件有效，10 分钟就过期。

### 3.3 下载响应头（不管凭什么放行都一样）

| 头 | 值 | 说明 |
|---|---|---|
| `Content-Disposition` | 沿用现有逻辑：白名单 MIME 用 `inline`，二进制容器扩展名强制 `attachment`；文件名一律 `filename*=UTF-8''…` | 不改，避免回归 #215 |
| `X-Content-Type-Options` | `nosniff` | 已有 |
| `Content-Security-Policy` | `sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'` | **新增**。即使 inline 打开，也没法执行脚本或读同源内容。这是对 #309 已测「attachment+nosniff 不触发 XSS」的纵深补充 |
| `Cache-Control` | `private, no-store` | **新增** |
| `Referrer-Policy` | `no-referrer` | **新增** |
| `Vary` | `Cookie, X-Admin-Token, X-App-Token` | **新增** |

### 3.4 次序与存在性

`appReadGate` 必须排在 `getApp`、查库、`existsSync`、读文件流**之前**：

1. 没有任何凭据：返回 `401 app_read_auth_required`，不论 slug 或文件 id 存不存在，响应体都一样。
2. 有凭据但没有本台读权，或者票据是别的台的：返回 `403 app_read_denied`，响应体同样固定。
3. 通过之后，才可能出现 `404`（台不存在、文件属于别的台、已软删、磁盘上缺失），响应体统一为 `not_found`，不返回 `storage_path`。

拒绝响应不带文件名、大小、`ETag`、`Last-Modified` 或 `Content-Range`。`HEAD` 与 `GET` 走同一道门。条件请求和 Range 请求也必须先过门（现在用的是 `createReadStream().pipe()`，没有 304 或 206 短路；要是以后改用 `sendFile`，就必须保证门在它前面）。

---

## 4. 止血方案（第 1 阶段，可以先上）

### 4.1 规则

三条读路由加上 `HEAD`，统一挂 `appReadGate`。放行顺序如下，命中任意一条即放行：

1. 本机命令行（`rawLoopback && !browserMarked`）
2. `adminHeaderOk`。注意要先对这几条读路径调 `markOdooAdmin`，把它们加进 `ADMIN_IDENTITY_PATHS`
3. 有效的读票据（`wmr1`），且票据里的 slug 等于路由里的 slug
4. 有效的下载票据（`wmd1`），只用于单文件路由，且 slug 和文件 id 都匹配
5. **过渡兜底**：`APP_READ_INTERNAL_FALLBACK=1` 时，新鲜的 Odoo 内部会话（cookie）可以读**所有**台。见 §4.2 的裁定点

除此之外一律按 §3.4 返回 401 或 403。旧 HMAC 不再给读权，只继续让写请求拿到 CORS 头。MCP 两个工具第 1 阶段不动（入口已经要求网关 Bearer），在第 3 阶段收口。

开关 `APP_READ_GATE=enforce|report|off`，缺省 `enforce`：
- `report`：照旧放行，但对「本来会被拒」的请求在 `endpoint-stats` 里按 `slug × 拒绝原因` 计数，并加响应头 `X-WM-Read-Gate: would-deny`。只用于上线前的摸底，**建议不超过 48 小时**。
- `off`：只用于紧急回退，需要属主批准。

### 4.2 1-A 和 1-B 两个变体（要裁）

| | 1-A 严格 | 1-B 加内部员工兜底（推荐） |
|---|---|---|
| 匿名、任何能连上端口的人 | 拒 | 拒 |
| 管理员、Odoo 管理员、本机命令行 | 放行 | 放行 |
| 已登录 Odoo 的普通内部员工 | **拒**，等第 2 阶段授权上线 | 放行，可以读所有台 |
| Odoo 门户账号 | 拒 | 拒 |
| 影响面 | 所有非管理员读数据的页面立即坏掉 | 只有匿名读者受影响 |

推荐 **1-B**：P0 的缺口是「匿名可读」，1-B 用最小的破坏堵住它。「内部员工能看所有台」是一个已知的放宽，带**落日期限**：第 2 阶段上线后，兜底开关缺省关闭；需要全员可看的台，由管理员显式设成 `internal`。如果属主认为在内部员工之间做逐台隔离同样是 P0，就选 1-A，并把第 2 阶段并进同一个维护窗口。

### 4.3 会打断什么，怎么过渡

| 受影响的入口或用法 | 1-A | 1-B | 怎么过渡 |
|---|---|---|---|
| sandbox 台页面读自己的数据或文件（看板、文件列表），由**未登录 Odoo** 的人打开 | 坏 | 坏 | 页面显示「需要登录」。注入的 `WM_APP_READ=false` 可以让模板给出友好提示（私有台仓库同步改模板）；`report` 期按 slug 统计受影响的台，逐个通知 |
| 同上，由已登录 Odoo 的普通员工打开 | 坏 | 正常 | 1-A 要等第 2 阶段授权 |
| 页面里 `<a href=item.url>` 下载、`<img src=item.url>` | 用户有读权时正常（列表返回带 `dl` 的 URL） | 同左 | 自己拼 URL 的页面会坏，改用 `item.url` 或 Blob 下载 |
| 市场页「数据」抽屉（`AppDataDrawer`） | 只用口令的管理员会坏（普通 `fetch` 不带口令头），所以第 1 阶段一起改成带头请求；普通员工坏 | 普通员工正常 | 第 1 阶段 web 端改一处 |
| 聊天、邮件里贴的 `/api/apps/<s>/files/<id>` 裸链接 | 管理员也打不开（顶层导航不带口令头）；Odoo 管理员可以 | 已登录员工可以（顶层导航带 cookie） | 旧链接改由台页面或抽屉进入；拒绝时返回固定的说明，不跳转 |
| 远程脚本或 agent 通过 HTTP 匿名 `GET` | 坏 | 坏 | 改走 MCP（Bearer）、本机命令行或管理员口令；`report` 期先统计出这些调用方 |
| MCP `app_data_list` / `app_files_list` | 不变 | 不变 | 第 3 阶段收口 |
| 写请求（`POST data/files`）与旧页面的 CORS | 不变 | 不变 | 测试 W1、W2 钉住 |
| 仓库里的冒烟脚本（`scripts/appdata-smoke.mjs`、`appfiles-smoke.mjs`、`app-token-198-smoke.mjs` 等，约 10 个） | 匿名 GET 断言要改 | 同左 | 在第 1 阶段 PR 里改成本机命令行或带票据，并补上拒绝断言 |
| `skills/*`、`README.md` 里的「读开放」描述 | 过时 | 过时 | 第 1 阶段一起改文档 |

上线顺序：合并 → 测试机 `report` 运行 24 到 48 小时，统计按 slug 的 would-deny → 通知受影响的台、改模板 → 切 `enforce` → 灰度 → 生产。每一步都由属主另行批准。

**残余（第 1 阶段不解决）**：已经被匿名读走或缓存下来的数据收不回来；页面 HTML 里**直接写死**的业务数据仍然公开（第 3 阶段的 `html_requires_login` 处理）；§1.3 的同源残余。

---

## 5. 测试矩阵

完整矩阵见 `app-read-scope-266.matrix.json`。每一例都写明入口、身份、阶段和预期，全部为 `NOT_RUN`。测试环境：隔离的临时 `DATA_DIR`，两个合成 slug（A、B），合成记录和文件（包括软删的、磁盘上缺失的、属于 B 的 id），桩 Odoo（`WM_ODOO_URL` 指向本地夹具，返回内部、门户、管理员三种会话），随机回环端口，**不接触任何真实数据或密钥**。

入口（E）× 身份（I）的总表，「→」后面是第 2 阶段之后的结果：

| 身份 \ 入口 | E1 `GET data` | E2 `GET files` | E3 `GET/HEAD files/:id` | E5 `/apps/A/` HTML 注入 | E8 MCP 读 |
|---|---|---|---|---|---|
| I0 匿名（无 Origin、`Origin: null`、伪造 Origin、curl） | 401 | 401 | 401 | 旧 HMAC，`READ=false` | 不变 → 网关 401 |
| I1 旧 HMAC(A) | 401 | 401 | 401 | — | — |
| I2 读票据 A | 200（A） | 200，`url` 带 `dl` | 403（读票据不能当下载票据） | — | — |
| I3 读票据 A 打 B 的路由 | 403 | 403 | 403 | — | — |
| I4 读票据 A 已过期 | 401 expired | 401 expired | — | — | — |
| I5 读票据 A，`gid` 已撤销或 `read_epoch` 已变 | 403 | 403 | — | — | — |
| I6 下载票据 A/f1 | 403 | 403 | f1：200；f2：403；B/f1：403 | — | — |
| I7 Odoo 内部员工，无授权 | 1-B：200 → 403 | 同左 | 同左 | 1-B：读票据 → 旧 HMAC | — |
| I8 Odoo 内部员工，有 A 的授权 | 1-B：200 → 200（A），B：403 | 同左 | 同左 | 读票据（`via=grant`） | — |
| I9 Odoo 门户账号 | 403 | 403 | 403 | 旧 HMAC | — |
| I10 Odoo 管理员 | 200 | 200 | 200 | 读票据（`via=admin`） | — |
| I11 管理员口令，同站 | 200 | 200 | 200 | 不签发（文档请求带不上头） | — |
| I12 管理员口令 + 跨站 Origin | 403 | 403 | 403 | — | — |
| I13 本机命令行 | 200 | 200 | 200 | — | — |
| I14 回环 + `X-Forwarded-For` | 按远程处理：401 | 401 | 401 | — | — |
| I15 MCP 会话，无台授权 | — | — | — | — | 不变 → 403 |
| I16 MCP 会话，有 A 的授权 | — | — | — | — | 不变 → A 可读，B 拒 |

必测的专项：匿名「取 HTML → 取令牌 → 读数据」整条攻击链（S1）；存在与不存在的 slug、文件 id 拒绝响应完全相同（S2）；`HEAD`、Range、条件请求先过门（S3）；同名 `X-App-Token` 头出现多个、查询串里带读票据（S4）；`OPTIONS` 不返回数据、不构成授权（S5）；带票据的 HTML 加 `no-store` 和 `Vary`（S6）；下载响应头完整（S7）；日志和 endpoint-stats 里没有票据值（S8）；冷回读和 SPA 回落不注入（S9）；`/go/<id>` 和 `/sop/` 子页与 `/apps/` 行为一致（S10）；`report` 模式只计数、照旧放行（S11）；写请求和写请求的 CORS 不回归（W1、W2）；Odoo 不可达时 fail closed 返回 503，不降级为放行（S12）。

---

## 6. 分阶段 PR 与验收

| PR | 范围 | 验收判据 |
|---|---|---|
| **PR-0**（本 PR） | 只有文档：本设计和测试矩阵 | 属主或总工裁定 §9；评审席核对代码事实 |
| **PR-1 止血** | `server/`：`appReadGate`（E1–E3 + HEAD）、读票据和下载票据的签发与校验、`serveApp`、`/go`、SOP 子页按身份注入、列表 `url` 带 `dl`、§3.3 响应头、`APP_READ_GATE` 和 `APP_READ_INTERNAL_FALLBACK` 两个开关；`web/`：`AppDataDrawer` 改成带头请求，下载改用 `downloadAuthed`；冒烟脚本、skills、README 同步更新 | 矩阵里 `phase ≤ 1` 的用例全绿；S1 攻击链先红后绿（在旧 main 上红，在 PR 上绿，同一套夹具）；W1、W2 不回归；全量冒烟通过；`report` 模式能按 slug 计数 |
| **PR-2 逐台授权** | `app_read_grants`、`app_read_settings` 两张表（迁移只建表，**不自动播种**）；管理 API（列出、授权、撤销、策略、epoch）；市场页的授权管理界面；`APP_READ_INTERNAL_FALLBACK` 缺省改为 0 | 矩阵里 `phase = 2` 的用例全绿（I7、I8、I5 撤销即时生效，epoch 生效）；不存在通配主体；授权必须带到期时间；只有管理员能授权；上线前由属主按真实名单在维护窗口播种（不在公开仓库里出现名单） |
| **PR-3 收尾** | MCP `app_data_list` / `app_files_list` 按 `mcp:<会话>` 查授权；票据密钥轮换命令；可选的台级 `html_requires_login`（页面 HTML 本身要求登录，用于在 HTML 里写死数据的台）；可选的一次性下载票据 | I15、I16 绿；轮换后所有旧票据 401；`html_requires_login` 的台匿名打开只看到说明页 |
| **私有台仓库**（不在本仓库） | 模板处理 `WM_APP_READ=false`、`app_read_ticket_expired` 重新加载、下载改用 `item.url` 或 Blob | 由开发席在私有仓库内验收，公开仓库只引用 PR-1 的契约 |

每个 PR 都只开不合，属于高档（身份和授权），合并和部署需要属主分别批准。

---

## 7. 不做的事

不做全量 IAM 或 SSO（#221 另有安排）；不改写面授权（`POST data/files` 继续开放，另开议题）；不改 #309 的 run 读授权；不做同源隔离（#291）；不处理 `/go` 外站代理里的内容；不撤回已经泄露的数据；不轮换旧的 `.wm-app-token.key`（它只剩写 CORS 这一个用途，第 3 阶段再评估是否下线）。

## 8. 与先前材料的对应

- 第一章「无可信授权真源就 STOP」：真源现在是 `resolveOdooViewer` + 管理员维护的逐对象授权表，与 #309 第二阶段、#324 已合入的口径相同。**这仍然需要属主确认它可以作为自产台读面的真源**（§9 的 Q1）。
- 第一章「admin 不默认全台」：本稿改为管理员和本机命令行可读全部台，与 #309（`adminOk` 等价授权）、#324（管理员全量）以及 #359 属主口径保持一致。如果属主坚持「admin 不默认全台」，PR-1 就要去掉第 2 条放行规则，改为管理员也必须有授权行（Q3）。
- 第一章「禁止 loopback 豁免」：本稿保留本机命令行免口令，这是属主的既定口径。判定用的是 `rawLoopback && !browserMarked`，带反代头的请求按远程处理（I14），浏览器即使在服务器本机上打开也不算命令行。
- 第一章的「Blob 下载」与「另审一次性能力」：本稿默认采用「单文件绑定的短期下载票据」，Blob 作为页面自己拼 URL 时的替代方案。一次性票据留作 PR-3 的可选项（Q4）。

## 9. 待裁

1. **Q1 授权真源**：是否认可「新鲜 Odoo 内部会话 + 管理员维护的 `app_read_grants`」作为自产台读面的授权真源？
2. **Q2 止血变体**：选 1-A 还是 1-B（推荐 1-B，并带落日期限）？
3. **Q3 管理员范围**：管理员和 Odoo 管理员能否读全部台（推荐：能，并记审计）？
4. **Q4 下载**：接受「单文件绑定的短期下载票据（可以放进 URL）」吗？还是要求一次性票据，或者只允许 Blob 下载？
5. **Q5 TTL**：读票据 60 分钟、下载票据 10 分钟是否合适？
6. **Q6 上线**：是否先在测试机跑 `report` 模式 24 到 48 小时，还是直接 `enforce`？
