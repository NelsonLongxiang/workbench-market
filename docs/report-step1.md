# 报告 · 第 1 步实施规格

> 依据：[19 · 报告：人机协同的协议](productization/19-report-protocol.md)，以及其中第八节属主 2026-11-21 定的五条（维度由领域负责人和属主定、单独授予；AI 能回应但标明；验收不强制报告、由维度的模板声明；报告是产出物；判据类模板版本默认经作者以外的人复核）。第十一次上线加入 #1057 的限定豁免，见下文「生效按判据内容判」。
> 依据的代码事实见第 19 篇附录（main `903e840d`）。开工时重核。
>
> **状态：第 1 步已实施，已进入 `main` 和 `release/10`。** A [#926](https://github.com/NelsonLongxiang/workbench-market/pull/926)、B [#930](https://github.com/NelsonLongxiang/workbench-market/pull/930)、C [#932](https://github.com/NelsonLongxiang/workbench-market/pull/932)、D [#937](https://github.com/NelsonLongxiang/workbench-market/pull/937) 及验收跟进 [#944](https://github.com/NelsonLongxiang/workbench-market/pull/944) 已合入。E 随 B 完成，[三条拒收测试](https://github.com/NelsonLongxiang/workbench-market/blob/a85d21402325a86c13ce94f90d256d27b8638d4b/scripts/report-template-p0-test.mjs#L31-L33) 分别核对 `duplicate_row_key`、`repeat_limit`、`invalid_asset`。F [#996](https://github.com/NelsonLongxiang/workbench-market/pull/996) 先合入 `release/9`，连同测试补强 [#997](https://github.com/NelsonLongxiang/workbench-market/pull/997) 经 [#998](https://github.com/NelsonLongxiang/workbench-market/pull/998) 收敛入 `main`。

## 一、这一步做什么、不做什么

做：

- 维度和模板：领域负责人（或属主）定义维度、给维度发模板版本；模板版本建好就不改不删。
- 台上的绑定：台把模板的数据槽接到自己的视图块上。
- 生成并冻结报告：**在服务端**按模板版本和台的绑定取数、校验、冻结；数据来源的版本、哈希、行数由服务端填，不信调用方。
- 论断：随报告冻结，有编号。
- 回应：对一条论断认可、反驳或补充，必须写理由；只追加；标明回应者是人还是 AI。
- 读：报告页逐条看论断和回应；同一事物下几个维度的报告列在一起。

不做（排在后面，见第 19 篇第七节）：

- 写进公共区（等公共区落地，领域第 1 步 PR5）。
- 验收门：模板可以声明「有未处理的反驳时不能验收」，这一步只存这个声明、在报告上算出状态，**不接到事项的验收上**（接的时候改的是验收标准，单独一个 PR）。
- 跨台报告、定时生成、可视化编辑器、正式 PDF 服务。
- 按回应统计、修订提案。

## 二、数据放哪

| 东西 | 放哪 | 理由 |
|---|---|---|
| 维度、模板版本 | 主库 | 维度属于领域，一个模板给多个台用；和领域规范（`area_specs`）同一种东西 |
| 台对模板的绑定 | 台库 | 绑定指向本台的视图块，跟着台走；删台随台删 |
| 报告、论断、回应 | 台库 | 数据从台来；备份、搬走、删除一个台就是处理这一份（[data-views](data-views.md) 第十三节第 2 条） |

这一处和第 19 篇第七节第 2 步原来的说法「模板和报告存进台库」不同：模板改放主库。理由见上表第一行，第 19 篇随本规格一起改。

写法照 [13 · 数据库](productization/13-database-plan.md) 的「两边都认」的子集（和 [领域第 1 步](domains-step1.md) 第二节同一套约束）：时间是毫秒整数，由代码给；不用 SQLite 特有的写法；「不能改、不能删」两边各一个触发器，成对登记、成对测试。

### 1. 主库

**`report_dimensions`（维度）**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT 主键 | `^[a-z][a-z0-9-]{0,47}$` |
| `area_id` | TEXT，可空 | 属于哪个领域；空表示跨领域的维度 |
| `title` | TEXT 非空 | 给人看的名字 |
| `status` | TEXT | `active` / `retired` |
| `active_version` | INTEGER，可空 | 生效的模板版本；没有模板时为空 |
| `created_at`、`created_by`、`updated_at`、`updated_by` | | |

**`report_templates`（模板版本）**

| 列 | 类型 | 说明 |
|---|---|---|
| `dimension_id`、`version` | 复合主键 | 版本号每个维度各自从 1 连续 |
| `body` | TEXT 非空 | 模板 JSON，形状见第三节。上限 200 KB（同视图描述） |
| `sha256` | TEXT | 正文摘要 |
| `criteria_sha256` | TEXT | 判据部分的摘要（`claims`、`responses`、`gate`、`slots`、`parameters` 按键排序的规范写法取 sha256），由服务端算。#926 独立验收后加 |
| `kind` | TEXT | `layout`：判据和这个维度某个**复核过的**版本一样（只动版式、措辞、组件）；`criteria`：否则（第一版没有可比的，也是 `criteria`）。由服务端算，不由提交方声明。是发版那一刻的说法，生效不看它（见下） |
| `note` | TEXT | 这一版改了什么 |
| `created_at`、`created_by`、`created_by_principal` | | 作者的留痕写法和主体（本机命令行、只带管理口令的主体为空） |

规则：版本建好就不能改、不能删（触发器拒 UPDATE、DELETE），**不按条数修剪**：报告引用着它。撤维度只改 `status`，模板留着。

**`report_template_reviews`（复核记录）**：实现时从 `report_templates` 的 `reviewed_by`、`reviewed_at` 两列改成单独一张表（PR A 评审对齐）。模板正文建好就不能改，复核是后来的事，放在同一行就得改那一行；单独一张表也是只增不改。

| 列 | 类型 | 说明 |
|---|---|---|
| `dimension_id`、`version` | 复合主键 | 一版只复核一次 |
| `reviewed_by`、`reviewed_by_principal`、`reviewed_at`、`note` | | 复核人的留痕写法、主体、时间、说明 |

复核人的口径（属主 2026-11-21 定「必须有作者以外的复核人」；怎么算「作者以外」由统筹 2026-11-21 按严格口径裁定，见 PR A 的评审）：

- 复核人必须**认得出是谁**：主体不为空、主体是人、启用着。本机命令行、只带管理口令的主体为空，**不能复核**（403）。
- 复核人不能是作者：主体相同就算本人，换个留痕写法（比如带管理口令）也算；留痕写法相同也算（403）。
- 复核按判据内容生效，所以「作者」也按判据内容认：这个维度里判据和被复核那一版一样的**任何一版**的作者，都算本人（403）。不然自己写的判据可以借别人只改标题的那一版、自己复核后生效（#926 独立验收 E1）。
  - 实际用的时候：**要复核的人，复核前别在那份还没复核的判据上再发版本**（哪怕只改标题）。发了就也算作者，复核不了；只有两个人持定报告维度授予的领域，两个人都发过同一份草稿，就要找第三个人（比如属主），或者其中一人把判据改一点重发，这一版只有他是作者。被拒时的说法会点明是第几版让你算作者。
- 作者认不出是谁，就判不了谁是本人，所以**本机命令行、只带管理口令的不能发 `criteria` 版本**（第一版也算 `criteria`），403；`layout` 版本照常能发。
- 跨领域的维度只有属主能定，属主自己发的 `criteria` 版本要**另一位**持属主授予的人复核。
  - 现在只有一位属主（属主 2026-11-21 裁定：规则不放宽，先接受这个限制）：跨领域维度的 `criteria` 版本发得了、生效不了。第 1 步用的是各领域的维度，用不到。真要用时两条路：给一位信得过的人加属主授予（不改代码）；或者另行设计「跨领域维度由指定的人复核」，再评审。领域维度、`layout` 版本不受影响。
- 库这一层也守着：复核人主体为空、作者本人复核、`criteria` 版本作者主体为空，触发器都拒。

生效按判据内容判，不按 `kind` 判（#926 独立验收）。[#1057](https://github.com/NelsonLongxiang/workbench-market/pull/1057) 自第十一次上线起加了一项窄例外：当前可识别、启用且持有生效属主授予的本人发布并激活目标版本，且同维度同判据摘要下各版的整个作者集合（包括发版人和有记录的起草责任人）都只有该属主本人时，可免独立复核。每次激活都重新核对当前属主身份和完整作者集合。服务在激活事务里按维度、版本、判据摘要和属主主体追加豁免，再移生效指针。豁免记录只增不改，既不是复核，也不会因判据相同传给其他版本。其余情形按原复核规则。上面的单属主阻塞记录是豁免前口径。

**第十二次候选（未上线）**：[#1059](https://github.com/NelsonLongxiang/workbench-market/pull/1059) 增加 `schema_version: 3`，正文用 json-render 的 `root/elements` 平铺结构。`$format`、`$count`、`$join`、`$concat`、`$math` 只用于正文和标题，由服务端冻结报告时校验并求值。台库值只作数据，冻结结果和既有 v2 读取、判据摘要、打印契约沿用。

原判据规则：

- 起初 `kind` 是和**上一版**比出来的，上一版可能没复核过。在没复核的判据类版本上再发一版只改标题的，它会被记成 `layout`，没复核的判据就跟着它生效了；把已生效的判据偷换掉也是同一条路。
- 常规路径：移生效指针时，目标版本的 `criteria_sha256` 要等于同一维度**某个复核过的版本**的摘要；没有复核或上面的本版本豁免则返回 409。服务和触发器一并约束。
- 复核认的是判据内容：两版判据一样，复核了其中一版，另一版也能生效。只改版式、措辞的版本不用另外复核。
- 库这一层还守着：记成 `layout` 的版本，判据要和某个复核过的版本一样，否则触发器拒。
- 摘要和正文对不对得上，库这一层核不了（SQLite 里没有 sha256）。服务发版时算，移指针时按正文重算一遍再比，对不上 409。直接改库移指针的人绕得过这一步，和直接改库能写复核记录一样，不在这一层的防线里。

### 2. 台库（附加的表，开库不建、不升台库版本，第一次用到才建；和 `bs_vars`、`bs_app_data` 同一种做法）

**`bs_report_bindings`**：`dimension_id`、`template_version`、`slots`（JSON：每个数据槽对应本台哪份视图的哪个块、列怎么对应）、`version`（这个台对这个维度的绑定的版本）、`created_at`、`created_by`。绑定改了就加一版，旧版留着（报告引用）。

**`bs_reports`**

| 列 | 说明 |
|---|---|
| `id` | 整数主键，服务端分配 |
| `dimension_id`、`template_version`、`template_sha256`、`binding_version` | 用的是哪一版模板、哪一版绑定 |
| `subject` | 事物的引用，文字，`<种类>:<标识>`，例如 `item:123`、`card:45@2026-11`、`obj:<领域定的标识>`。市场只做相等比较 |
| `inputs` | 参数和文字字段（JSON） |
| `body` | 冻结的成品（JSON，P0 的 `FrozenReport` 形状） |
| `sources` | 每个数据槽：视图版本、视图描述的 sha256、块、行数、是否完整（服务端填） |
| `content_sha256` | `body` 的摘要 |
| `producer`、`producer_kind` | 主体标识；`human` / `ai`，由服务端定：**只有主体表里登记为人（kind 为 `person`）的记 `human`**，席位、应用、节点、系统主体、内置身份、MCP 会话、查不到的一律记 `ai`——宁可把人算成非人，不把非人算成人（#930 统筹验收） |
| `supersedes` | 更正的是哪份报告（同维度、同事物）；更正链不分叉，只能接链头（和 #919 的更正链同一条规矩） |
| `created_at` | |
| `claim_count` | 这份报告有几条论断，写报告时记下，建好不改（#930 统筹验收：冻结论断用） |

**`bs_report_claims`**：`report_id`、`claim_key`（模板里声明的类别加序号，例如 `risk-2`）、`kind`、`text`、`basis`（JSON：指向数据槽和行键，或上游产出物的 `_row`，或 ygl claim 的 id）。随报告一起写、一起冻结：触发器拒绝把论断挂到不存在的报告上，也拒绝报告写下以后再补论断（条数到了 `claim_count` 就不能再插）。

**`bs_report_responses`**

| 列 | 说明 |
|---|---|
| `id` | 整数主键 |
| `report_id`、`claim_key` | 回应哪一条论断；`claim_key` 为空表示对整份报告 |
| `stance` | `agree` / `dispute` / `supplement` |
| `reason` | 必填，1～4000 字 |
| `responder`、`responder_kind` | 主体标识；`human` / `ai`，服务端按主体种类定，不收请求里的 |
| `position` | 回应时的位置：服务端按回应者当时生效的授予记，**只记管得到这个台的**：范围是全公司（`*`），或正好是这个台绑的部门、领域（例如 `area-lead@area:sales`）；别处的授予不记，免得读报告的人借此看到回应者的全部授予（属主 2026-11-21 定：收窄）。不收请求里的 |
| `supersedes` | 同一回应者对同一条论断改主意时，指向自己的上一条；只能接自己的链头 |
| `created_at` | |

报告、论断、回应三张表都**不能改、不能删**（触发器）。删台随台库一起删（走删卡片那道门，规模里多报告份数）。

### 3. 「未处理的反驳」怎么算

一条论断上，取每个**人**的回应链的最新一条；其中有 `dispute`，且这份报告还是链头（没被更正），这条论断就有未处理的反驳。AI 的回应不计入。报告的状态由此算出，不存。

## 三、模板的形状

生产模板使用 `schema_version` 2 或 3。两版都包含 `title`、`parameters`、`fields`、`slots`、`body`、`claims`、`responses`、`gate`。v2 正文沿用节点数组。v3 正文采用 json-render 的平铺结构，由服务端在生成报告时解析。

```json
{
  "schema_version": 3,
  "title": "经营报告",
  "parameters": {},
  "fields": { "summary": { "required": true, "max_length": 500 } },
  "slots": {},
  "body": {
    "root": "main",
    "elements": {
      "main": { "type": "document", "props": {}, "children": ["summary"] },
      "summary": { "type": "text", "props": { "content": { "ref": { "scope": "field", "name": "summary" } } } }
    }
  },
  "claims": [
    { "kind": "conclusion", "label": "结论", "min": 1, "max": 3 },
    { "kind": "risk", "label": "风险", "min": 0, "max": 10 }
  ],
  "responses": { "stances": ["agree", "dispute", "supplement"], "reason_required": true },
  "gate": { "open_dispute_blocks_acceptance": false }
}
```

- `claims`：这个维度要给哪几类论断，各几条。生成时数目不在范围内就拒。
- `responses`：这个维度允许哪几种回应。`reason_required` 只能是 `true`（属主：认可、反驳要有理由）；写成别的拒。
- `gate`：属主定的「验收不强制报告、由维度的模板声明」。这一步只存、只算状态，不接验收。
- 论断的正文从哪来：生成请求里给，按 `claims` 校验。论断的 `basis` 指向的数据槽和行键必须在这份报告里，指不到的拒。

v3 元素的 ID 由 `elements` 的键给出，`children` 按顺序列 ID。每个元素只能从根到达一次。根可用 `document` 包多块，其他元素仍用封面、章节、文字、网格、重复、数据视图、分页和图片节点。节点参数写在 `props`，章节、网格和重复的子项写在 `children`。服务端拒绝不可达元素、环、未知类型、未知字段和事件。

v3 的 `title` 和 `content` 支持以下指令，可按需嵌套。其他 props 保留原节点契约。

| 指令 | 形状与含义 |
| --- | --- |
| `$format` | `{"$format":"percent","value":0.12,"locale":"zh-CN"}`。接受 `date`、`number`、`percent`、`currency`。日期用 UTC，接受 ISO 日期、带时区时间或毫秒时间戳。缺省地区 `zh-CN`，货币可用 `currency` 指定三字母代码，缺省 CNY。 |
| `$count` | `{"$count":{"ref":{"scope":"slot","name":"orders"}}}`，取数组项数或文字长度。 |
| `$join` | `{"$join":["甲","乙"],"separator":"、"}`，用分隔符合并数组。 |
| `$concat` | `{"$concat":["共 ",{"$count":[1,2]}," 项"]}`，顺序拼接值。 |
| `$math` | `{"$math":"divide","a":2,"b":4}`。二元操作为 `add`、`subtract`、`multiply`、`divide`、`mod`、`min`、`max`。单元操作 `round`、`floor`、`ceil`、`abs` 只收 `a`。操作数和结果须为有限数字。 |

引用可读参数、文字字段、重复的当前行或这份报告已校验的数据槽。加 `column` 取得该槽的一列。不指定列的槽引用用于计数。引用值只当数据处理。服务端拒绝缺失引用、越界表达式和不合规的值，指令结果随报告冻结成普通正文，已存正文保持原格式。

`kind` 的判法：`claims`、`responses`、`gate`、`slots`（列和类型）、`parameters` 这几块和这个维度某个**复核过的**版本完全一样，就是 `layout`；否则是 `criteria`。不和上一版比（第二节第 1 小节，#926 独立验收）。

## 四、授权

### 1. 动作

| 动作 | 类别 | 路由 | 谁 |
|---|---|---|---|
| `report.dimension-list` | read | `GET /api/report-dimensions`（清单） | 同下。实现时从 `report.dimension-read` 里分出来（PR A 评审对齐）：清单和单条各报一个动作，判法相同；`area-report` 预设两个都带，权限没有扩大 |
| `report.dimension-read` | read | `GET /api/report-dimensions/:id`、`…/templates/:version` | 登录的人（模板是协议，不是业务数据）。评审定 |
| `report.dimension-set` | decide | `POST /api/report-dimensions`（建）、`POST …/:id/templates`（发一版）、`POST …/:id/templates/:version/review`（复核）、`POST …/:id/activate`（移生效指针）、`POST …/:id/retire` | **硬规则，不走角色覆盖**（和 `area.spec-set` 同一种机制）：领域维度认属主、本机命令行和持本领域 `area-report` 授予的人；跨领域维度只认属主和本机命令行 |
| `bench-store.report-bind` | write | `PUT /api/bench-views/:bench/reports/:dimension/binding` | 和 `bench-store.view-put` 同一档：管理层；台所在领域有写授予的人 |
| `bench-store.report-generate` | write | `POST /api/bench-views/:bench/reports` | 同上 |
| `bench-store.report-read` | read | `GET /api/bench-views/:bench/reports`、`…/reports/:id`、`…/reports/:dimension/binding`；`GET /api/report-subjects/:subject`（同一事物在各台上的报告，按读者能读的台裁剪；第七节 F） | 和 `bench-store.render` 同一档 |
| `bench-store.report-respond` | write | `POST /api/bench-views/:bench/reports/:id/responses` | 能读这份报告的人。评审定：是否把 `bench-store.report-respond` 加进已含 `bench-store.render` 的预设，还是单独授予 |

### 2. 角色

- 新预设 `area-report`（定义本领域的维度）：只含 `report.dimension-list`、`report.dimension-read`、`report.dimension-set`，范围必须正好是 `area:<领域>`。和 `area-spec` 一样单独授予，不随领域负责人一起给（属主 2026-11-21：单独授予）。
- `report.dimension-set` 写进判定的收窄规则（`narrowed`），和 `area.spec-set` 一样：管理层范围 `*`、自定义角色列了这个动作，都不算。

### 3. MCP

照「必须限定到台」的形状加四个工具：`report_generate`（写）、`report_list`、`report_get`（读）、`report_respond`（写）。维度和模板只走 REST（[16](productization/16-progressive-capability-access.md)：领域能力以 REST 声明）。

## 五、对抗用例清单（先红后绿）

1. 管理层（范围 `*`）、系统管理员、管理口令、列了 `report.dimension-set` 的自定义角色：建维度、发模板都 403。
2. 持 A 领域 `area-report` 的人：给 B 领域、给跨领域维度发模板 403；给 A 领域发成。
3. 改、删一个已有的模板版本：接口没有入口；直接对库 UPDATE、DELETE 被触发器拒（两种库各一条）。
4. 模板 `reason_required` 写成 `false`、`claims` 的 `min` 大于 `max`、未知键：400。
5. 发模板时请求里写 `kind`：拒（由服务端算）；论断要求变了而服务端判成 `layout`：用例守住判法。在没复核的判据类版本上只改标题，仍判成 `criteria`、不能生效；已生效的判据不能借「先发判据类、再发只改标题的」偷换（#926 独立验收）。
5a. `criteria` 版本没有复核就移成生效：409；作者自己复核：403（换个留痕写法、主体相同也算）；复核人没有这个维度的 `report.dimension-set`：403；本机命令行、只带管理口令的复核：403；本机命令行发 `criteria` 版本：403；`layout` 版本不要复核也能生效。
6. 生成请求里带来源版本、哈希、行数、`producer_kind`：拒（未知键），不被采纳。
7. 数据槽取到的数据被截断、行数超上限、列类型和模板不合：拒，不出半份报告（P0 的拒收照搬到服务端）。
8. 论断数目不在模板范围内、`basis` 指向报告里没有的行：400。
9. 生成之后台里的数据变了、视图改了版：已冻结的报告逐字不变；再生成一份能看出来源版本不同。
10. 报告、论断、回应：接口没有改删入口；对库 UPDATE、DELETE 被触发器拒。
11. 回应没写理由、理由超长、`stance` 不在模板允许的范围：400。
12. 回应请求里写 `responder_kind`、`position`：拒；席位令牌回应的落成 `ai`，人落成 `human`。
13. 回应者改主意：只能接自己的链头；接别人的、接已被接过的：409。
14. 没有读权限的人回应：和读不到一样（404），不泄露报告是否存在。实现：能回应、读不了这个台上报告的人，回应存在和不存在的报告应答一字不差；MCP 会话回应要在这个台上同时有 `report_respond` 和 `report_get` 的授予（#932 独立验收）。
15. 「未处理的反驳」：只有 AI 的 `dispute` 不算；人的最新一条是 `agree` 不算；报告被更正之后旧报告上的不算。实现：一个人对一条论断（或整份报告）只有一条链，已经回应过的不带 `supersedes` 再发 409，所以「最新一条」就是链头；对整份报告的反驳也算一处（#932 独立验收）。
16. 同一事物的列表按读者能读的台裁剪：读不到的台上的报告不出现，数目也不出现。（跨台的列表接口见第七节 F：`GET /api/report-subjects/:subject` 对每个台照单台清单同一个判法，读不了的台连台库都不打开；一个台都读不了回 200、空清单。D 的报告页只列一个台里的报告，靠这个台的读权限挡住。）
17. 删卡片：台库里有报告时走删卡片那道门，409 的规模里有报告份数、没有正文。

## 六、待定

| 问题 | 谁定 | 推荐 |
|---|---|---|
| `report.dimension-read` 是否对所有登录的人开放 | 评审 | 开放 |
| `bench-store.report-respond` 是否随含取数的预设一起给 | 评审 | 一起给：能看报告的人能表态，是第 19 篇的出发点 |

## 七、拆成五个 PR

都以 main 为 base（有集成分支时以集成分支为 base），一次开一个。前两个是身份与权限类，先验后合。

| PR | 内容 | 对应用例 |
|---|---|---|
| A | 主库两张表和触发器、维度服务、`report.dimension-*` 路由、`area-report` 预设和收窄规则 | 1～5 |
| B | 台库的绑定表、`bench-store.report-bind`；P0 的校验搬进服务端的领域服务（纯函数，前端照旧可用）；`bench-store.report-generate`：服务端取数、冻结、填来源；**读报告 `bench-store.report-read` 也在 B 做**（实现时从 C 挪过来，统筹 11-21 裁定保留在 B） | 6～9、17 |
| C | 回应的表、触发器、`bench-store.report-respond`、「未处理的反驳」的算法；MCP 四个工具（论断的表随 B 一起建） | 10～15 |
| D | 报告页：连续阅读、逐条论断和回应、同一事物的几个维度并排（只在**一个台**里：清单走 `GET /api/bench-views/:bench/reports`，进得了这个台、能读报告的人才看得到） | 浏览器用例另列 |
| F（后续，未排期） | **跨台的同一事物列表**：`GET /api/report-subjects/:subject`，按读者能读的台裁剪（用例 16）。由报告这条线的作者做，开工前在 issue 上认领；要有反例：读不到的台上的报告不出现、数目也不出现（#932 统筹验收：第 1 步的 A～D 都没做这一条，在这里落账） | 16 |
| E | 第 19 篇第七节第 0 步剩下的三条测试改成核错误码（可以随 B 一起） | — |
