# 报告治理五项作为领域能力接入（第 16 篇 · 方案 A）· 设计稿

> 依据：
> - 属主 2026-11-18（[第 16 篇](productization/16-progressive-capability-access.md)开头）：「我们是尽量的避免暴露更多的 MCP 工具，只暴露常用的，其他的通过渐进式披露来完成。」
> - 属主 2026-11-24，回答「先做报告治理五项走 MCP」：「是的。但是要注意，我们不能让 MCP 的工具越来越多，这一块我在前面也提到过，要渐进式披露」。同日属主选**方案 A**：先由身份线做第 16 篇第 2、3 步，再做第 4 步，报告治理作为第一个真正接入的领域。
> - 已冻结的设计 [#1016](https://github.com/NelsonLongxiang/workbench-market/issues/1016)（MCP 报告五项治理，正文 SHA-256 `6ab668fb…`，冻结评论 7137094554）：五项都走「受控提案 + 有权的人在站内确认」，提案默认有效 7 天，治理审计默认保留 90 天，实现前置 N1–N6。
>
> 代码事实核于 release/10 `138d89d4`。
>
> **状态：设计稿，只写文档，不写代码。** 本篇只回答「五项怎么按渐进式披露进来」；提案与确认的语义以 #1016 为准，这里引用、不重写。

## 一、这篇定什么、不定什么

**定**：
1. 五项在目录里长什么样（几行、叫什么），详情给什么，调用走哪两条路；
2. 每一项的入参、按人判还是按台判、确认时再核什么；
3. 复核只收活跃的人，在披露链上怎么落实；
4. 和 #1016、第 16 篇各步的衔接，以及实现顺序和验收。

**不定**：
- #1016 已冻结的提案状态机、幂等、两库并发、作者回避细则（N1–N6），照 #1016 执行；
- 第 16 篇第 2 步（负责人批接入）、第 3 步（会话归属到人）本身，属身份线；
- 第 16 篇第 4 步的通用机制（能力声明、目录与详情分层、REST 与通用「调用」的转调），这里只写报告治理作为它的第一个领域要声明什么；
- 维度撤销（retire）、批量绑定、组合自动执行：#1016 不接，这里也不接。

## 二、现状

| 项 | REST（现在就有） | 动作 · 类别 | 现在谁能做 | 请求体 |
|---|---|---|---|---|
| 登记维度 | `POST /api/report-dimensions` | `report.dimension-set` · decide | 属主；持本领域 `area-report`（范围正好是 `area:<领域>`）的人。跨领域只有属主 | `{ id, title, area? }` |
| 发版 | `POST /api/report-dimensions/:id/templates` | 同上 | 同上，按维度所属领域判 | `{ body, note, sha256? }` |
| 复核 | `POST …/:id/templates/:version/review` | 同上 | 同上；服务另要求**启用的人**、且不是同判据任一版的作者 | `{ note }` |
| 激活 | `POST …/:id/activate` | 同上 | 同上；目标判据须已复核 | `{ version }` |
| 台绑定 | `PUT /api/bench-views/:bench/reports/:dimension/binding` | `bench-store.report-bind` · write | 管理层；台所在领域有写授予的人 | `{ base, slots }` |

出处：[认人](../server/src/routes/report-dimensions.ts#L79-L97)、[四项路由](../server/src/routes/report-dimensions.ts#L136-L189)、[只认启用的人](../server/src/services/report-dimension.ts#L147)、[复核](../server/src/services/report-dimension.ts#L251)、[激活](../server/src/services/report-dimension.ts#L289)、[台绑定路由](../server/src/routes/bench-views.ts#L326-L327)与[入参](../server/src/services/bench-report.ts#L93-L107)、[动作表](report-step1.md#L159-L176)。

和渐进披露相关的现状：

- 报告的 MCP 只有按台的四个：`report_list`、`report_get`、`report_generate`、`report_respond`（[bench-mcp-tools.ts](../server/src/bench-mcp-tools.ts#L157-L167)）。五项治理没有 MCP 入口。
- `access_info` 的目录只列 MCP 工具（[index.ts](../server/src/index.ts#L3591)），还不能列领域能力；常驻集里没有通用「调用」（[index.ts](../server/src/index.ts#L3429)）。
- `mcp_sessions` 没有归属的人（[db.ts](../server/src/db.ts#L551-L559)）：会话没法和「这个人在这个领域的授予」取交集。五项都按人判，所以**在第 16 篇第 3 步之前，任何会话都不应拿到五项的提案能力**（fail-closed）。

## 三、怎么披露：目录两行，工具零个

### 1. 目录（`access_info` 默认应答）

报告治理在目录里**只占两行**，不论将来提案种类加多少：

| 能力名 | 一行说明 | 领域 |
|---|---|---|
| `report.governance-propose` | 提一项报告治理请求（登记维度、发版、请人复核、激活、台绑定），由有权的人在站内确认后才生效 | 按请求的维度或台 |
| `report.governance-result` | 查自己会话提过的治理请求现在怎样了 | 同上 |

每行照第 16 篇第三节带「本会话批没批」。不带参数表。

### 2. 详情（按名字取）

`access_info` 按能力名取一项时，给：
- `op` 的取值和每个 `op` 的入参表（第四节）；
- 出错码和「被拒时怎么办」；
- 能力说明所在的技能名：内置技能 `wm-report-governance`（随本仓 `skills/` 发，经技能市场按需读，[第 16 篇第七节之一](productization/16-progressive-capability-access.md#L145)）。现有的 `wm-capability-access` 只加一句指向它，不展开。

报告治理是市场本体的能力，不是私域，所以说明进本仓；仍按第 16 篇第六节当数据处理、限长、去控制字符。

### 3. 调用（两条路，同一套规矩）

| 路 | 写法 | 渠道标记 |
|---|---|---|
| REST（能写脚本的 agent） | `POST /api/report-governance/proposals`，体 `{ op, args, idempotency_key }`；`GET /api/report-governance/proposals/:id` | `rest` |
| 通用「调用」（纯聊天客户端） | 常驻的那一个通用「调用」，目标 `report.governance-propose` 或 `report.governance-result`，参数同上 | `mcp-invoke` |

两条路命中同一条会话授予、同一次判定、同一张审计表；判定和审计都记成被调的能力（`report.governance-propose`）和其中的 `op`，不记成「调用」工具本身。

**工具数**：本篇不新增任何专用 MCP 工具。`tools/list` 只会因第 16 篇第 4 步多出那一个通用「调用」，且它是所有领域共用的，加一次就不再随领域增长。五项将来加 `op`、加字段，也只改详情和技能正文，不动 `tools/list` 和目录行数。

### 4. 通用「调用」对本领域的界限

照第 16 篇第三节三条，落到本领域：
- 只认上面两个能力名；不能借它调 `report.dimension-set` 的 REST、`bench-store.report-bind`、四个报告 MCP 工具或任何内部路由；
- `op` 是固定枚举，`args` 按 `op` 的入参表严格核（多键即拒），禁止携带路由、SQL、回调地址、身份、授予（#1016「建议入口与授权模型」）；
- 决定类一律只产生提案：调用成功的结果只有「提案编号 + 状态 pending」，业务表、生效指针、台绑定都不动，直到有权的人确认。

## 四、五个 op：入参、判权、确认

提案的公共字段（服务端填，请求里写了就拒）：提案编号、规范化摘要、提案会话、会话的归属人、作用域、期望的前置版本、过期时间（默认 7 天）。

| op | 入参（`args`） | 提案时按什么判 | 谁确认、确认时再核什么 |
|---|---|---|---|
| `dimension-create` | `area`（必填，领域标识）、`id`、`title` | 会话的提案授予覆盖「dimension-create × `area:<领域>`」，且归属人此刻在该领域能做 `report.dimension-set`。**跨领域（不写 area）首版不开**（#1016 推荐，属主照旧走人工入口） | 该领域持 `area-report` 的人或属主，在站内确认；再核领域仍启用、标识未被用过或退休保留 |
| `template-publish` | `dimension`、`body`（完整模板）、`body_sha256`、`expected_latest_version`、`note` | 授予覆盖「template-publish × 该维度」，且归属人对该维度能做 `report.dimension-set` | 对该维度有权的人确认。服务端重算正文摘要和 criteria/layout 分类，任一与提案不符即要重提；新版本作者记确认人，**起草会话的归属人记为共同作者**（#1016 N3）；生效指针不动 |
| `review-invite` | `dimension`、`version`、`body_sha256`、`criteria_sha256`、`invitees`（可选，1～5 个人的主体标识） | 授予覆盖「review-invite × 该维度」 | **没有确认这一步，也不写复核。** 它只通知被邀请人（或该维度所有有权的人），对方打开精确版本，在站内用自己的身份提交复核。见第五节 |
| `dimension-activate` | `dimension`、`version`、`expected_active_version`、`criteria_sha256` | 授予覆盖「dimension-activate × 该维度」，且归属人对该维度有权 | 对该维度有权的人确认。重算目标判据摘要；须有同维度同判据、作者以外的人的有效复核；当前指针仍是 `expected_active_version`。回退同此 |
| `bench-bind` | `bench`（已登记台）、`dimension`、`template_version`、`template_sha256`、`base`、`view_version`、`slots` | 授予覆盖「bench-bind × 单台 × 单维度」，且归属人对这张台能做 `bench-store.report-bind`。**先判权再核台存在**：无权时不打开台库、不透露台在不在（#1016 N2） | 对这张台有 `bench-store.report-bind` 的人确认；维度仍适用这张台；模板版本和摘要、绑定 `base`、视图版本与每个槽的来源都未漂移，否则冲突、不自动换成最新 |

几条共同规矩：
- **按人判和按台判不互相代替**：领域的维度治理权不能推出台绑定权，台的管理层和 `report_generate` 授予也推不出维度治理权；`bench_mcp_grants`（L18，会话 × 台 × 工具）和这里的领域提案授予是两种判据（第 16 篇第四节第 8 条）。
- **提案权是严格交集**：会话的提案授予 ∩ 归属人当下对目标动作的权限。归属关系核不出来、归属人停用、授予被撤，提案即拒，已有待审提案在确认时也拒。
- **确认身份**只认站内同源登录的启用的人：管理口令、只是系统管理员、本机命令行、未登录的本机页面、任何会话都不能确认（#1016 N2）。命令行属主的例外只属于现有人工 REST 入口。
- `report.governance-result` 只回本会话提过的提案：状态、冲突原因、确认后的结果编号（模板版本、绑定版本）；不回其他台元数据、业务行或别人的提案；重复读也重新判权。

## 五、复核只收活跃的人

第 16 篇第三节说决定类「只能生成待人确认的提议」；复核比这更紧，**连提议都不生成**：

1. 能力里没有「提交复核」这个 `op`。agent 能做的只有 `review-invite`，它不产生任何可被「确认」成复核的记录，所以不存在「人点一下确认，就替 agent 完成了复核」的路径。
2. 复核意见只经现有人工入口提交（`POST …/templates/:version/review` 或之后的站内页面），提交者必须是启用的人（[report-dimension.ts](../server/src/services/report-dimension.ts#L147)）、对该维度有权、不是同维度同判据任一版的作者。
3. 作者集合按 #1016 N3 在领域服务里统一算，新增两类：起草提案的会话的归属人；共同作者。换会话、换标题、只改版式都洗不掉作者身份；作者认不出就拒绝复核。这条同时作用在现有人工 REST 上，防止绕过。
4. 跨领域维度只有一位属主时，发版后只能等另一位有权的人复核，当下不可激活（#1016 已定）。

## 六、实现顺序（方案 A）

| 步 | 做什么 | 归谁 | 前置 | 合入 |
|---|---|---|---|---|
| 0 | 本稿 | UI/UX 席执笔 | 无 | 纯文档，非作者复核 |
| 1 | 第 16 篇第 2 步：负责人批接入、属主上限、审批回避 | 身份线 | 第 15 篇第 1 步 | 身份类，先验后合，属主卡 |
| 2 | 第 16 篇第 3 步：`mcp_sessions` 加归属主体、会话权限 = 会话授予 ∩ 账户授予 | 身份线 | 第 1 步 | 同上 |
| 3 | 第 16 篇第 4 步：领域能力声明、目录与详情分层、REST 与通用「调用」转调；**报告治理作为首个声明的领域**，带 #1016 N1 的提案记录与站内审批页 | 待派 | 第 2 步 | 同上 |
| 4 | `bench-bind`：先开一项（#1016 推荐先小范围验台绑定），带 N4、N5 的两库与退役围栏 | 待派 | 第 3 步、#1015 对齐 | 同上 |
| 5 | `dimension-create`、`template-publish`、`review-invite`、`dimension-activate`，带 N3 的作者集合改造 | 待派 | 第 4 步 | 同上 |

第 1、2 步同一时间只开一条（第 16 篇第七节）。每一步新加的安全行为补一行启动自检。第 3 步之前，目录里不出现这两行能力，也不发 `wm-report-governance`，以免 agent 看见却调不通。

## 七、验收（在 #1016 权限矩阵之上补的披露部分）

| 场景 | 应看到的结果 |
|---|---|
| 接入前后各取一次 `tools/list` | 只多出第 16 篇第 4 步那一个通用「调用」；本篇五项不带来任何专用工具 |
| 默认 `access_info` | 报告治理只占两行，不含参数表；按名字取详情才有 `op` 与入参表 |
| 没批的会话 | 能看目录和详情（标「未批」），调用被拒；拒绝不透露目标维度或台是否存在 |
| 同一提案分别走 REST 和通用「调用」 | 同一判定结果、同一张审计表，渠道分别为 `rest`、`mcp-invoke`；记的是被调能力与 `op`，不是「调用」工具 |
| 借通用「调用」调 `report.dimension-set` REST、`bench-store.report-bind`、报告 MCP 工具、内部路由，或在 `args` 里带路由、身份、授予 | 一律拒，无业务写入 |
| 没有归属人的会话、归属人停用、归属人领域授予被撤 | 提案被拒；已有待审提案确认时被拒 |
| 任何方式想由 agent 完成复核（找不存在的 `op`、拿邀请去「确认」、代传会话身份） | 全部拒，复核表不变；被邀请的有权非作者本人在站内提交才成功 |
| 起草会话的归属人想复核这份模板（经提案链或经现有人工 REST） | 拒 |
| 管理口令、命令行、未登录本机页面、另一个会话去确认提案 | 拒 |
| 现有四项人工 REST、台绑定 REST、四个报告 MCP 工具 | 照旧可用；动作清单、路由快照、回放不放宽 |

## 八、待评审定

| 事 | 推荐 | 其他做法 |
|---|---|---|
| 目录里一行还是两行 | 两行（提和查分开），与 #1016「提出请求」「查询结果」两个入口一致 | 一行 `report.governance`，用 `op: result` 查；目录更省，但「查」也要受提案授予约束，读写分不开 |
| 能力名与 REST 路径 | `report.governance-propose` / `-result`，`/api/report-governance/proposals` | 随第 16 篇第 4 步的统一命名改 |
| `review-invite` 的被邀请人 | 可选，最多 5 人；不写就通知该维度所有有权的人 | 必填，防止广播；代价是 agent 要先知道谁有权，可能借此探人 |
| 首版是否开跨领域维度的提案 | 不开（#1016 推荐） | 开给属主名下会话；属主是唯一有权人时复核仍卡住，收益有限 |

## 附：本篇不改的东西

- 现有五项人工 REST 的判权和行为不变；
- 四个报告 MCP 工具不变，不扩展、不改名；
- `report_respond` 仍是对冻结报告和论断表态，与模板复核无关。
