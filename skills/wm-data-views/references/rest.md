# REST 入口

页面和脚本用的入口，都在 `/api/bench-views` 下面。部署方设了 `WM_BENCH_VIEWS=on` 才开；关着的时候每一条都回 404（`bench_views_off`）。

## 谁进得来

| 来的是谁 | 结果 |
|---|---|
| 有管理层授予（范围「全部」）的登录账号 | 读、写都行 |
| 普通员工的授予（范围「全部」）的登录账号 | 只能读 |
| 登录了但没有授予，或者授予的范围不是「全部」 | 403（看不出台存不存在） |
| 没登录 | 401 |
| 管理口令 | 403：台里是业务数据，管理口令看不了、也改不了 |
| 带跨站标记的请求 | 403 |

按部门、按团队放行（「这个部门的人和席位能改自己部门的台」）等身份线的部门表落地之后接上；在那之前就是上面这张表。

## 地址

`<台>` 是台的标识，`<集>` 是数据集的名字。请求体和工具的参数同名；应答就是工具的结果。

| 做什么 | 方法和地址 | 对应的工具 |
|---|---|---|
| 列出台 | `GET /api/bench-views` | — |
| 登记一个台 | `POST /api/bench-views`，`{ slug, title }` | — |
| 列出数据集 | `GET /api/bench-views/<台>/datasets` | `dataset_list` |
| 建、改数据集 | `PUT /api/bench-views/<台>/datasets/<集>`，请求体是定义（不用再写 `name`） | `dataset_define` |
| 写行 | `POST /api/bench-views/<台>/datasets/<集>/rows?op=replace`（或 `upsert`、`append`、`delete`），**请求体就是行的数组**（`delete` 时是主键的数组） | `dataset_replace` 等四个 |
| 查询 | `POST /api/bench-views/<台>/query`，`{ query, params }` | `dataset_query` |
| 列出快照 | `GET /api/bench-views/<台>/datasets/<集>/snapshots` | `dataset_snapshots` |
| 手工留快照 | `POST /api/bench-views/<台>/datasets/<集>/snapshots`，`{ note }` | `dataset_snapshot` |
| 退回快照 | `POST /api/bench-views/<台>/restore`，`{ snapshot_id, note }` | `dataset_restore` |
| 读视图描述 | `GET /api/bench-views/<台>/view`（`?version=<n>` 读指定的一版） | `view_get` |
| 存视图描述 | `PUT /api/bench-views/<台>/view`，`{ doc, base, note }` | `view_put` |
| 版本清单 | `GET /api/bench-views/<台>/view/versions` | `view_versions` |
| 两版的差异 | `GET /api/bench-views/<台>/view/diff?a=<n>&b=<n>` | `view_diff` |
| 回退 | `POST /api/bench-views/<台>/view/rollback`，`{ to, base, note }` | `view_rollback` |
| 取数（页面用） | `GET /api/bench-views/<台>/render?view=<键>&p.<筛选项>=<值>` | — |
| 提交表单（页面用） | `POST /api/bench-views/<台>/form`，`{ view, block, version, values }` | — |
| 留痕 | `GET /api/bench-views/<台>/log` | — |

几条规矩：

- **幂等键走请求头** `Idempotency-Key`（写行、提交表单）。
- **编号要写成数字**：请求体里的 `snapshot_id`、`base`、`to`、`block`、`version` 写成文字（`"1"`）会被拒；查询串里的 `version`、`a`、`b` 写错了也会被拒，不会当成没写。
- **大的写入**：写行的那一条不经市场的 JSON 解析，请求体原样递给台库，最大到数据集的上限（见 `limits.md`）。别的地址的请求体是普通 JSON，不要往里塞大数据。
- 出错的应答是 `{ error, message, details }`，`error` 就是 SKILL.md「出错了怎么办」那张表里的代号；另有 `bench_not_found`（台没登记）、`bench_views_forbidden`、`bench_views_admin_token_denied`、`bench_views_cross_origin_denied`、`login_required`。
