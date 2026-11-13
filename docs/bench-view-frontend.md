# 数据视图：给前端开发者的说明

写视图台页面、驾驶舱里的视图面板、或者别的要画数据视图的页面时看这一份。设计和规矩在 [data-views.md](data-views.md)；给 agent 的用法在技能 `skills/wm-data-views`。

分工：接口和组件 `web/src/bench-blocks/` 归数据视图支线；页面（`web/src/pages/UseEntry.tsx`、驾驶舱的 `components/cockpit/BenchView*.tsx`）归前端。页面要让组件做它现在做不到的事，找数据视图支线改组件，不在页面里另写一份。

## 一、打开一张卡片（`/use/<卡片编号>`）

1. **先问入口**：`GET /api/bench-views/<卡片编号>/entry`，前端用 `web/src/api.ts` 的 `getBenchEntry(cardId)`。
2. **200**：这张卡片是视图台，并且这个人读得到，进视图台页面。应答形状：

   ```json
   { "bench": { "slug": "wb-12", "title": "设备台", "workbench_id": 12 },
     "version": 3, "title": "视图描述里的标题", "default_view": "board",
     "views": [{ "key": "board", "title": "看板" }, { "key": "detail", "title": "明细" }] }
   ```

   - 顶栏菜单用 `views`，按顺序排，显示 `title`；默认打开 `default_view`（就是第一份）。
   - 页面标题用顶层的 `title`，台名是 `bench.title`。
3. **404 `{"error":"bench_not_found"}`**：照原来的方式打开卡片（卡片的 url）。读不到的、不存在的、卡片没开台库的、台还没有视图描述的，都是同一个 404，应答逐字一样，页面不要去区分。这样「打开」不会绕过原来的判定，也看不出某张卡片背后有没有台。
4. **401**：没登录，走登录。**403**：只带了管理口令（台里是业务数据，管理口令看不到），或者跨站。
5. **5xx、断网**：显示「这会儿打不开，稍后再试」，带「再试一次」，**不要退回原来的打开方式**（台库忙或者坏了时，退回去会把故障藏起来）。能走到 5xx 的只有本来就读得到这个台的人，所以 404 和 5xx 的差别不露任何信息。

## 二、视图台页面上要调的接口

路径里的台都可以写卡片编号，也可以写 `bench.slug`；页面统一用卡片编号。

| 要做的 | 接口 | 说明 |
|---|---|---|
| 取一份视图的数据 | `GET /api/bench-views/<卡片编号>/render?view=<键>&p.<字段>=<值>` | `getBenchView`。不给 `view` 就是第一份。筛选栏的值经 `p.<字段>` 给，只收文本 |
| 表单提交 | `POST /api/bench-views/<卡片编号>/form`，请求体 `{ view, block, version, values }` | `submitBenchForm`。`version` 是页面拿到的版本（入口里的 `version`）；版本变了会拒，提示刷新 |
| 视图描述全文（一般用不到） | `GET /api/bench-views/<卡片编号>/view` | `getBenchViewDoc`。`render` 已经按块给好了 |

`render` 应答里：

- `blocks` 和视图描述里的块一一对应，每块多了 `data`（`columns`、`rows`、`truncated`）或者 `error`（`code`、`message`）。
- **表格块的列 `label` 可能是空串**：视图描述没给说明名的旧版本才会这样（新存的视图保存时就要求每列都有说明名）。组件写「第 N 列」，不拿列名（键名）当表头。
- **表单块带 `can_submit`**：`false` 时那一块的按钮不可点，旁边写「你的账号不能在这个台上填表。要填的话，请管理层为你开通这个台的权限。」（`FORM_DENIED`）。
- `filters`：这份视图认哪些筛选项（名字、类型、显示名）。驾驶舱顶上那一排的值按名字传进来，认的就生效。

入口只给菜单要的最少信息，不给块和查询。卡片清单（`/api/workbenches`）**没有**「是不是视图台」的字段：加了就会让读不到的人看出哪张卡片背后有台。所以打开时先问入口，404 就照原来打开。

## 三、组件（`web/src/bench-blocks/`）

只依赖设计 token，不依赖外壳；视图台页面和驾驶舱共用。导出见 `index.ts`。

### 整份视图：`BenchView`

拿一次 `render` 的应答画整份视图。

| 属性 | 说明 |
|---|---|
| `result` | `render` 的应答（`ViewResult`），没取到时 `null` |
| `loading` | 正在取 |
| `onParams(params)` | 筛选栏的值变了：用新的值重新取 `render` |
| `onSubmit(blockIndex, values)` | 表单提交：调 `submitBenchForm`，失败就抛 `{ code, message }` |
| `formDisabledReason` | 给了，所有表单都不可点（比如驾驶舱里一律不能交）；没给时按块的 `can_submit` |
| `frame` | `card`（缺省，单独成页）/ `none`（拼进驾驶舱面板，块不带外框） |
| `dense` | 表格用紧凑的行高（拼进面板里用） |
| `hideFilters` | 不画视图自己的筛选栏（筛选由外面管，值照样经 `render` 传进来） |

块的宽度：视图描述里写了 `span` 的照写的（12 栏网格里占 3、4、6、12 栏）；没写的按类型取，一行里只剩它一个就撑满这一行（`layoutSpans`）。

### 单个块

每个块都接 `BlockFrameProps`：`title`、`span`、`extra`（右上角的操作）、`asOf` / `staleAfterMs`（数据截至）、`loading`、`error` / `errorMessage`、`empty`（空的时候说什么，说清为什么空、下一步能做什么）、`data`、`frame`。四态（加载、空、出错、超限）由外框统一画，块自己只画有数据的样子。

| 块 | 自己的属性 |
|---|---|
| `StatBlock` 统计卡 | `value`（取哪一列，第一行）、`unit`、`delta`（环比）、`toneRules`（按值着色）、`onClick` |
| `ProgressBlock` 进度 | `value`、`total`（一列，或者写死的正数）、`unit` |
| `TableBlock` 表格 | `columns`（显示哪些列、什么次序）、`pageSize`、`statusText`（取值 → 说法和颜色）、`rowActions`、`onRowClick`、`dense`。表头只用列的 `label`，没有就写「第 N 列」（`tableHead`） |
| `BarBlock` / `LineBlock` 柱、线 | `x`、`y`（一个或几个数值列）、`series`；柱多 `stacked`、`horizontal`、`toneRules`；线多 `area` |
| `PieBlock` 饼 | `label`、`value`、`donut`、`onSelect` |
| `FilterBar` 筛选栏 | `fields`、`value`、`onChange` |
| `FormBlock` 表单 | `fields`、`submitLabel`、`onSubmit`（失败抛 `{ code, message }`）、`disabledReason` |

纯函数（数字的写法、格子按什么画、图表的系列、宽度、表头）在 `blocks-view.ts` 和 `chart-option.ts`，单测在 `scripts/bench-blocks-ui-unit.mjs`；改了它们先跑这个。

## 四、规矩

- **人和席位**照 `web/src/people.ts` 的规则显示，不直接显示主体标识。
- **状态代号不直接给人看**：表格的 `value_labels` 把取值换成说法；没配说法的取值显示成灰色小字的原文（一眼看得出「这个还没配」）。
- **读不到不是没有数据**：出错、没权限、超限都要说清是哪一种，不显示成 0 或空表。
- **只看桌面宽屏**：验收按 1440×900；不做手机视角。
- 页面上的真实表头、空态、出错态由前端的浏览器回归核（`bench-page-browser`）。
