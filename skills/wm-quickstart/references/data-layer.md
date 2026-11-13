# 台页面的数据层规范

**严禁把可视化数据写死在台页面里。** 页面只放渲染代码，看板上显示的每一个数都要在运行时从本台的工作台空间读。读的位置有下面三种：

| 数据 | 放哪 | 读法 |
|---|---|---|
| 看板值：KPI、状态、阈值、口径说明、最近一次刷新的时间、小型索引 | 工作台**变量**（`kind: var`） | `GET /api/workbenches/${WM_WORKBENCH_ID}/vars/<key>` |
| 定下来就不再改的值：冻结的历史清单、版本号、口径定义 | 工作台**常量**（`kind: const`，写入后不能改、不能删） | 同上；列举用 `GET …/vars?prefix=<前缀>` |
| 明细记录：台账、事件、表单提交 | 本台**数据面** | `GET /api/apps/<slug>/data`（按 `before_id` 翻页读全） |
| 文件：截图、面单、报表、证据包 | 本台**文件面** | `GET /api/apps/<slug>/files`；下载走返回的 `url` |

每个台的具体键名、记录类型和写入规矩写在本台常量 `AGENTS.md` 里，见 [workbench-agents.md](workbench-agents.md)。

所有请求都带本台的 `X-App-Token`（平台注入的 `<meta name="wm-app-token">` 或 `window.WM_APP_TOKEN`）。

## 不允许的写法

- 在页面脚本里写 `const DATA = [...]`、`const STATIC = {...}` 这类数据字面量。
- 用 `<script type="application/json">` 内嵌快照、payload。
- 把数据放在台目录里的静态 `.json` 文件里，再 `fetch('./x.json')`。台页面是沙箱不透明源，生产环境同目录的静态文件取不到，而本地预览能取到，所以这个问题在本地发现不了。
- 写死卡片编号、slug，或者别的台的地址。卡片编号用 `window.WM_WORKBENCH_ID`，slug 用 `window.WM_APP_SLUG`。

页面里**可以**有的：枚举的中文名、字段说明、渲染规则这类属于代码的东西，以及读不到数据时的空态文案。

## 判断一样东西放哪

1. 会随业务变的数，放变量或数据面，不放页面。
2. 单个值不超过 64KB，每台不超过 512 个键。超过的拆成多个键，或者放进数据面、文件面。
3. 会一条条追加的（事件、记录），放数据面，只追加。
4. 定稿后不应再改的，放常量。谁写的谁维护：要改，由写它的会话（作者）带 `override` 与 `reason` 修订，修订会留审计；作者缺失时由部署机本机命令行兜底。
5. 二进制和大文件放文件面，在变量或记录里只引用 `file:<id>`。
6. 刷得很勤的变量（进度、心跳、计数，几秒一写），键名用 `hot.` 开头，比如 `hot.progress`。**起名 hot. 就表示接受最多丢 30 秒**：部署开了 Redis 时，这类变量先写 Redis，30 秒落一次盘，Redis 整个丢了会丢最近一个周期的写入。不能丢的值不要用 `hot.` 开头；`hot.` 开头的键也不能是常量（会被拒）。

## 写入方

- 页面凭本台令牌可以读写本台的变量和常量，也可以读写本台的数据面和文件面。
- agent 用 MCP：`workbench_vars_get`、`workbench_vars_set`（MCP 不能修订常量）、`app_data_submit`、`app_files_upload`。
- 改已存在的变量要带期望的 `revision`（`If-Match` 或 `revision` 参数），不符返回 409。拿到 409 后重读再写，不要硬覆盖。
- 往数据面提交（`POST /api/apps/<slug>/data` 或 `app_data_submit`）带幂等键时，**每次新提交生成一个随机的键**（比如 `crypto.randomUUID()`），只在重试同一次提交时复用它。不要用业务字段、日期或内容拼键：键只在同一个提交方之间算重复：台页面的提交（不管是谁）是一方，每个 MCP 会话各是一方。页面上两次不同的提交撞了键，后一次会被当成重复或拒绝（409）。

## 读不到时

页面要明说「没读到」，不能显示成「没有数据」或者 0：

```js
const id = window.WM_WORKBENCH_ID, h = { 'X-App-Token': window.WM_APP_TOKEN };
if (id == null) return showWarn('本台还没登记卡片，读不到工作台变量');
const r = await fetch(`/api/workbenches/${id}/vars/summary`, { headers: h });
if (r.status === 404) return showEmpty('还没写入 summary');
if (!r.ok) return showWarn(`读取失败 HTTP ${r.status}，下面不是「没有数据」`);
const { value, updated_at } = await r.json();   // 同时显示读取时点
```

`hot.` 开头的变量在缓存暂时不通时会回 503（`code: vars_hot_unavailable`，`retryable: true`）：这时不是没有数据，过几秒重读，不要显示成 0 或空。

## 已有台的迁移

1. 把页面里的数据原样写进变量或常量（大块数据进数据面、文件面），记下键名。
2. 页面改成运行时读取，删掉字面量。
3. 用无头浏览器、在沙箱 CSP 下核对迁移前后显示的数一致，再发布。

报告类页面（定稿归档的报告，内容本身就是交付物）不在此列。是否属于报告由台的属主认定。
