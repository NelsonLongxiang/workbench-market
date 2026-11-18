# 领域 · 第 1 步实施规格

> 只写规格，不写代码。设计见 [15 · 两层组织](productization/15-two-layer-org.md) 第六节「实现顺序」的第 1 步；和 [14](productization/14-team-and-assignment.md) 冲突的地方以 15 为准。
> 第 1 步要等 Odoo 下线和登录持久化合进 main 才写代码（人和授予要先落在站内账号上）。代码开工前，以那时的 main 重核第四节列的文件和函数。
> 第 1 步是身份与权限类改动，按 CONTRIBUTING 红线先验后合，附对抗组、先红后绿，加启动自检。
>
> **2026-11-18 按属主更正改过：**「有团队就一定会有负责人。」负责人不删，迁成领域负责人（新角色 `area-lead`）。改动在第一节第 4 条、「不做」、第二节第 3 小节第 2 条、第三节的角色表和放行、第六节的旧对象表；见 [15](productization/15-two-layer-org.md) 开头第 3 条。

## 一、这一步做什么、不做什么

**做：**

1. 领域表；领域规范，版本化（版本不可改，另有一个生效指针）。
2. 授予范围支持「域:<领域>」，库里写成 `area:<领域标识>`（见第二节第 2 条为什么不叫 `domain:`）。
3. 三个动作分开登记：触发、验收、定规范。定规范单独授予，只有属主能放行。
4. 迁移：现有部门转成领域，部门负责人转成该领域**负责人**（`area-lead`）的授予草稿，属主放行后生效。旧数据只读保留、不删。
5. 按部门判权的两处（数据视图的台、经验库）改成按领域判，过渡期新旧范围都认。

**不做（后面几步）：**

- 任务带领域、按领域规范判断归属（第 2 步）；
- 领域对应 a2a-net 团队、名册带领域标识（第 3 步）；
- 按领域展示的页面（第 4 步）；
- 删除部门这个旧对象（第 5 步）。负责人不删，迁成领域负责人（属主 11-18）；成员分配给员工删不删，待属主确认。

## 二、数据

### 1. 表

三张新表，写法照 [13 · 数据库](productization/13-database-plan.md) 的「两边都认」的子集，要能原样搬到 PostgreSQL：

- 时间一律是毫秒整数，由代码给，不在 SQL 里取（不用 `datetime('now')`、`unixepoch()`）；
- 不用 `GLOB`、`AUTOINCREMENT`、`INSERT OR REPLACE`；
- 主键用自然键或复合键；
- 「不能改、不能删」的规则两边各写一个触发器，成对登记、成对测试。

**`areas`（领域）**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT 主键 | 领域标识，`^[a-z][a-z0-9-]{0,47}$`（和部门标识同一套写法，迁移时原样沿用） |
| `name` | TEXT 非空 | 给人看的名字 |
| `status` | TEXT | `active` / `retired`；撤了的只读，不删 |
| `spec_version` | INTEGER，可空 | 生效指针：现在生效的规范版本号；没有规范时为空 |
| `team_host`、`team` | TEXT，缺省空串 | 对应的 a2a-net 团队，第 3 步才写，第 1 步建出来都是空 |
| `source` | TEXT | `manual` / `department`（从部门迁来的） |
| `created_at`、`created_by`、`updated_at`、`updated_by` | | 毫秒；做的人记主体标识 |

约束：`spec_version` 非空时要有对应的规范版本。这条由服务判；两种库都加外键 `(id, spec_version) → area_specs (area_id, version)`。

**`area_specs`（领域规范的版本）**

| 列 | 类型 | 说明 |
|---|---|---|
| `area_id`、`version` | 复合主键 | 版本号从 1 起，每个领域各自连续 |
| `body` | TEXT 非空 | 规范正文（Markdown）。上限 64 KB，超了拒 |
| `sha256` | TEXT | 正文的摘要，写入时算，核对用 |
| `note` | TEXT | 这一版改了什么，一句话 |
| `created_at`、`created_by`、`created_by_principal` | | |

规则：**版本建好就不能改、不能删**。库里两边各一个触发器拒 UPDATE、拒 DELETE；接口上也没有改旧版本的路由。改规范 = 新加一版；回退 = 把生效指针移回旧版本，不新增版本。

**`area_events`（领域的留痕）**

只增不改。每次建、撤、新加规范版本、移生效指针、迁移，各一行：

```
seq（自增）, area_id, kind ∈ {create, retire, spec-add, spec-activate, migrate}, version, actor, actor_principal, at, detail
```

自增编号用数据访问服务的「取新行编号」，不写 `AUTOINCREMENT`。

「节点确认后生效」（15 第二节）是第 3 步的事：那时生效指针多一个状态，变成「已定、待节点确认 → 已生效」。第 1 步只有市场一侧，定了就生效。

### 2. 授予范围 `area:<领域标识>`

- `roles.ts` 的 `SCOPE_RE` 加一种：`area:[a-z][a-z0-9-]{0,47}`。
- **为什么不用 `domain:`：** `domain:<名>` 已经被占用，指的是动作名的域（`skill.list` 的 `skill`，见 `roles.ts` 文件头注释）。那是「这类操作」，不是业务领域。给两样东西用同一个前缀，读授予时分不清，所以新起 `area:`。界面和文档里照旧叫「域:<领域>」。
- 起草授予时，`area:` 后面的领域要在 `areas` 里、并且 `status = active`（照现在 `dept:` 核部门表的办法，`services/grant.ts` 的 `issueCheck`）。
- 授予范围给人看的名字：`DepartmentService.scopeName` 旁边加一个领域的版本，`area:<x>` 回领域名。

### 3. 迁移：部门 → 领域

一次迁移，幂等（跑几次结果一样）：

1. 每个部门建一个同标识、同名字的领域，`source = department`，记一行 `area_events(kind = migrate, detail = 部门标识)`。已有同标识领域的跳过。
2. 部门负责人：部门有生效的负责人授予时（`dept_lead_grants` 里有，`leadGrantActive` 为真），给这个人起草一条 `area-lead`（领域负责人）授予，范围是 `area:<同标识>`，理由写「由部门负责人迁移」，状态停在待核，等属主放行（第三节第 3 条：这一档只有属主能放行）。
   - 不起草 `area-spec`（定规范）：定规范单独授予，迁移不替属主做决定。
   - 负责人停用了的、只有字段没有授予的（`dept-lead-pending`），不起草。
3. 部门成员（`department_members`）不迁：15 说系统里没有人的组织，领域里没有「成员」这层。成员表只读保留。
4. 旧数据一律不删：`departments`、`department_members`、`dept_lead_grants`、`dept:` 范围的授予原样留着。删除是第 5 步的事，按「旧断言 → 新守护」核对后再删。

**入口：** 属主一个人调 `POST /api/areas/migrate`，回这次建了哪些领域、起草了哪些授予。授予放行走现有的授予放行接口，或者照设置向导的「一批放行」。

**同时调两次也只成一份：** 每个部门的「建领域 + 起草授予」放在同一个事务里。
- 领域按标识去重：主键冲突就跳过。
- 授予按「被授予人 + 角色 `area-lead` + 范围 `area:<x>` + 理由『由部门负责人迁移』」去重：事务里先查有没有这样一条非撤销的授予，有就跳过。
- 两次调用交错时，后进事务的那一次看得到前一次已经提交的行，所以只成一份。PG 上同样做：事务隔离级别用可串行化，或者对 `areas` 那一行加锁后再查。

**搬到 PostgreSQL：** 三张新表都在中立写法里登记。迁移只用「插入（存在就跳过）」，这个写法由数据访问服务给两种库各一份，所以 PG 上跑同一段代码。

## 三、授权

### 1. 动作

新登记的动作，域都是 `area`，归业务域（`roles.ts` 的 `BUSINESS_DOMAINS`；规范决定 AI 在这个领域怎么干活，是业务内容，系统管理员缺省看不到）：

| 动作 | 类别 | 挂在哪 | 谁能做 |
|---|---|---|---|
| `area.list` | read | `GET /api/areas` | 对任一领域有授予的人：只列有授予的；管理层和属主看全部 |
| `area.read` | read | `GET /api/areas/:id` | 对这个领域有授予的人 |
| `area.create` | decide | `POST /api/areas` | 只有属主（收窄：`narrowed` 只认属主） |
| `area.retire` | decide | `POST /api/areas/:id/retire` | 只有属主；领域上还有生效授予时 409（照删部门） |
| `area.spec-list`、`area.spec-read` | read | `GET /api/areas/:id/specs`、`GET /api/areas/:id/specs/:version` | 对这个领域有授予的人 |
| `area.spec-set` | decide | `POST /api/areas/:id/specs`（新加一版）、`POST /api/areas/:id/specs/activate`（移生效指针） | 持本领域 `area-spec` 授予的人（定规范）；属主 |
| `area.migrate` | decide | `POST /api/areas/migrate` | 只有属主 |
| `area.trigger` | write | 第 2 步接到「建事项」上 | 对这个领域有触发授予的人 |
| `area.accept` | decide | 第 2 步接到「验收事项」上 | 对这个领域有验收授予的人 |

**触发、验收、定规范是三个动作。** 前两个第 1 步只登记名字和类别，还不接到事项上。
- **问题：** 第 1 步路由上没有它们。角色声明引用了不存在的动作，启动校验不让过。
- **我的做法：** 在 `POST /api/work-items`、`POST /api/work-items/:id/decision` 上各登记一条 `refine`（细分动作），`when` 在第 1 步恒为假，第 2 步改成「请求带了领域」。动作因此进了动作清单和快照，角色能引用。判定行为在第 1 步不变，回放零差异。
- **已定**（第七节第 1 条）：第 1 步就这样登记，角色一次给全。

**判定怎么接：**

- `judgment.ts` 的 `scopedVerdict` 现在只认 `dept:`（`DEPT_SCOPE`）。改成也认 `area:`；`ASKED` 表里的 `dept` 一列改名 `scoped`，含义不变（「按范围问时用的类别」）。
- **`area.spec-set` 是一条硬规则，不走「角色覆盖就放行」：** 判定（`judgeBuiltin` 和 `scopedVerdict` 两处）遇到这个动作，只认两种人：
  - 属主（见第 3 小节）；
  - 持有本领域 `area-spec` 角色、范围正好是 `area:<x>` 的生效授予的人。
  别的角色哪怕权限覆盖了这个动作也不算。比如管理层拿着范围 `*` 的授予，`area` 是业务域、管理层的权限覆盖全部业务域的决定类；又比如一个自定义角色列了 `area.spec-set`。规则写进 `narrowed`（收窄），和建领域、撤领域同一种机制。
- **过渡期 `dept:<x>` 等同 `area:<x>`，只限 `ASKED` 表里原有的那几项动作：** 也就是数据视图台的 `bench-store.*` 和经验库的 `knowledge.read`，按第 1 步开工时 `ASKED` 里的清单写死成一个集合。
  - 新的 `area.*` 动作一律不认 `dept:`。只持 `dept:<x>` 的人在领域 `<x>` 上不能触发、验收、定规范，要等属主放行 `area-member`。
  - 第 5 步收掉 `dept:` 时连这个集合一起删。

### 2. 角色

在 `roles.ts` 的内置预设里加三个，都要带范围（加进 `SCOPED_PRESETS`）：

| 角色 | 权限 | 说明 |
|---|---|---|
| `area-member`（领域成员） | `area.list`、`area.read`、`area.spec-list`、`area.spec-read`、`area.trigger`、`area.accept`；以及过渡期按部门问的那些动作（数据视图的台、经验库的看），类别照 `ASKED` 表 | 15 第五节「对某领域有授予的人：触发、答提问、验收」 |
| `area-spec`（定规范） | `area.spec-list`、`area.spec-read`、`area.spec-set` | 15「已确认」：定规范单独授予，不随触发、验收一起给 |
| `area-lead`（领域负责人） | 包含 `area-member` 的全部；另加负责人专有的动作：过目放行、改派、批本领域的接入申请（[16](productization/16-progressive-capability-access.md)）。动作名留给评审定（建议 `area.release`、`area.reassign`、`area.access-approve`），第 1 步照第七节第 1 条用恒为假的 `refine` 先登记，免得以后加动作时让已放行的授予悄悄变宽。**不含** `area.spec-set`：定规范仍然单独授予 | 15 第五节「领域负责人」（属主 11-18：有团队就有负责人；负责人由属主指定，能批什么由属主限定） |

`dept-lead`（部门负责人）这个预设第 1 步不删，停止起草（第六节）。

### 3. 谁能放行

- 照 `roles.ts` 的 `approvalOf` 三档，三个新角色都带决定类权限，属于「带业务拍板」一档，只有属主能放行。`area-lead` 尤其如此：负责人由属主指定（属主 11-18）。
- **属主指谁**：照 `services/grant.ts` 文件头现有的定义——本机命令行（授予面上本机命令行算属主），或者持有生效的 `owner` 授予（范围 `*`）的主体。管理口令对不到人，不算属主。
- **定规范只有属主能授**：按「角色的权限展开后是否覆盖 `area.spec-set`」来判，不按角色名。`area-spec`、列了这个动作的自定义角色、以后任何覆盖它的角色，起草和放行都只有属主。规则写在 `services/grant.ts` 的 `issueCheck`（起草）和 `approvability`（放行）。
- **只有一位属主时也走得通**：现有规则里「起草的人不能自己放行」只管第二、三档，属主这一档不受它限制。所以属主给另一个人起草 `area-spec`，可以自己放行；本机命令行也可以放行。属主不能给自己授予（库里约束），但属主本来就能定规范，不需要这条授予。
- 起草人、放行人都不能是被授予的人（库里现有的约束）。
- 不是人的主体不能持有带决定类的授予（judge 第 3 步现有规则），所以 AI 席位拿不到 `area-spec`、`area-member`、`area-lead`。
- 系统管理员照旧两人制：可以起草 `area-member`、不能放行，看不到规范正文（业务域）。`area-lead` 只有属主起草和放行。

## 四、受影响的现有代码（以 main f1b0bac9 为准，开工时重核）

| 文件 | 函数 / 位置 | 第 1 步怎么改 |
|---|---|---|
| `server/src/roles.ts` | `SCOPE_RE`、`SCOPED_PRESETS`、内置预设、`BUSINESS_DOMAINS`、`BLOCKS`（角色矩阵分块）、`scopeOk` | 加 `area:` 范围；加两个预设；`area` 进业务域和矩阵的业务块 |
| `server/src/judgment.ts` | `scopedVerdict`、`grantWithin`、`DEPT_SCOPE` | 认 `area:`；过渡期 `dept:` 同标识也算；规则名加 `grant-area` |
| `server/src/judgment-builtins.ts` | `ASKED`（`dept` 列）、`deptKind`、`narrowed`、匿名和本机命令行清单 | `dept` 列改名 `scoped`；`area.create`、`area.retire`、`area.migrate` 收窄到属主；本机命令行加 `area.list`、`area.read` |
| `server/src/services/grant.ts` | `issueCheck`（范围核对）、`approvability`、`decidesBusinessIn` | `area:` 的领域要存在、未撤；`area-spec` 只有属主起草、放行；停止起草 `dept:` 范围 |
| `server/src/routes/bench-views.ts` | `inDept`（按部门问 `scopedVerdict`） | 问 `area:<台绑定的标识>`；台绑定的字段第 1 步不改名（部门标识和领域标识相同），第 2 步改名 |
| `server/src/services/bench-registry.ts` | 绑定核对（`department` 要在部门表里） | 改成在领域表里、并且未撤 |
| `server/src/services/knowledge.ts` | `visibility`（`dept:` 条目问 `scopedVerdict`）、`SCOPE_RE`、范围名字 | 条目里的 `dept:<x>` 按 `area:<x>` 问；ygl-trees 给的写法不变（外部格式），只在判定处换 |
| `server/src/knowledge-remember.ts` | `defaultVisibility`、`rememberAnswer`（写 `dept:<部门>`） | 写成 `area:<领域>`；ygl-trees 那边要先认 `area:`（问 ygl-trees 会话），没认之前照写 `dept:` |
| `server/src/routes/knowledge.ts`、`knowledge_project_depts` | 「项目 → 部门」对照 | 对照的目标改成领域（同标识）；表第 1 步不改名、只读旧行、新写进新列，第 5 步并表 |
| `server/src/routes/departments.ts`、`services/department.ts`、`services/dept-lead-grant.ts` | 增、改、删部门，成员增删，`setDepartmentLead`、`removeDepartment` | 写接口停写（第六节）；读接口照旧 |
| `server/src/services/relation-proposal.ts` | `dept-lead`、`team-claim` 两种提议 | 不再收新的 `dept-lead` 提议；`team-claim` 第 3 步改成认领到领域 |
| `server/src/services/setup-wizard.ts` | `targets`（`dept_leads` 生成 `dept-lead`/`dept:`） | 不再收 `dept_leads`；第 1 步不加 `area_members`（第七节第 4 条） |
| `server/src/attention-names.ts` | `nameResolver`（同部门互相看得到名字） | 第 1 步不改：它只管能不能看到别人的名字，不带权。第 5 步改成「对同一个领域有授予」 |
| `server/src/team-relation.ts`、`work-item-access.ts`、`task-center.ts`、`services/team.ts` | `relationOf`、`teamVisibleTo`、`itemRoles`、`arrangeTask` | 第 1 步不改：这些是团队、负责人、分配那一套，第 2～4 步随事项带领域一起换 |
| `server/src/red-lines.ts` | `dept-lead-field-no-power` | 加一条：`area-spec` 只有属主能授 |
| `server/src/db.ts` | 新三张表和触发器 | 按第二节 |
| `server/src/startup-security-self-probe.ts` | 自检行 | 加一行：远程匿名 `POST /api/areas` 必须 401/403，`POST /api/areas/:id/specs` 同 |
| 新文件 `server/src/routes/areas.ts`、`services/area.ts` | | 路由、服务（SQL 只在服务里） |

## 五、回放、快照和对抗用例

### 1. 快照预期的变化

- **`surfaces/routes.json`、`actions.json`**：多出第三节的 8 条路由；`work-items` 两条路由多两个 `refine`；`builtins` 里收窄和本机命令行清单多几项；`asked` 的 `dept` 列改名 `scoped`。
- **`surfaces/schema.json`**：多三张表、两对触发器。
- **MCP 工具**：不变（第 1 步不加工具）。

### 2. 回放预期的变化（PR 里逐条列，重录）

- 新域 `areas`：搬之前没有这些路由，所以先写请求集。按「三类请求」录：没授予的 401/403、参数不对的 4xx、正常的 2xx。要包括第 3 小节的对抗场景。
- `departments.json`：改、删部门，成员增删，这些写请求从现在的应答变成 410（停写）。读请求零差异。
- `relations.json`：新的 `dept-lead` 提议变成 400；`team-claim` 零差异。
- `access.json`：设置向导带 `dept_leads` 的变成 400。
- `grants.json`：起草 `dept:` 范围的授予变成 400；`GET /api/roles` 多两个预设；角色矩阵多 `area` 块。
- `bench-views.json`、`knowledge.json`：判定从 `dept:` 换成 `area:` + 过渡认 `dept:`，应答预期零差异。不是零差异的逐条说明。
- 其余域预期零差异。全量回放是验收判据之一。

### 3. 对抗用例清单（先红后绿）

| # | 场景 | 预期 |
|---|---|---|
| 1 | 系统管理员、管理层、领域成员建领域、撤领域、跑迁移 | 403；只有属主 2xx |
| 2 | 持 `area-member`（本领域）的人新加规范版本、移生效指针 | 403：定规范要单独授予 |
| 3 | 持别的领域的 `area-spec` 的人改这个领域的规范 | 403 |
| 4 | 持本领域 `area-spec` 的人新加一版、再回退到旧版 | 2xx；回退只移指针，版本数不变 |
| 5 | 直接在库里改、删一个规范版本（SQLite、PG 各一次） | 触发器拒 |
| 6 | 生效指针指向不存在的版本 | 400；库里外键也拒 |
| 7 | 管理层、系统管理员起草或放行 `area-spec` | 拒：只有属主起草、放行 |
| 8 | 只有一位属主：属主给另一个人起草 `area-spec`，再由属主本人放行；另一条由本机命令行放行 | 都能成；被授予的人随后能新加规范版本 |
| 9 | 给 AI 席位起草 `area-member` 或 `area-spec` | 拒（决定类不给非人主体） |
| 10 | 范围 `area:甲` 的授予去访问领域乙的台、规范 | 403 |
| 11 | 范围写成 `area:` 后面跟大写、超长、已撤的领域、不存在的领域 | 400 |
| 12 | 过渡期：只持 `dept:<x>` 旧授予的人访问绑在 `<x>` 的台；同一个人对领域 `<x>` 新加规范版本、触发、验收 | 台照旧放行（回放零差异）；规范、触发、验收都 403；新起草 `dept:` 范围被拒 |
| 13 | 迁移跑两次 | 第二次不新建领域、不重复起草；旧部门表、成员表、负责人授予原样 |
| 14 | 迁移遇到负责人停用、只有字段没授予的部门 | 建领域，不起草授予 |
| 15 | 撤领域时还有生效授予 | 409 |
| 16 | 规范正文超 64 KB、sha256 和正文对不上 | 400 / 库里拒 |
| 17 | 停写的旧接口（改部门、加成员、`dept-lead` 提议、向导 `dept_leads`） | 410，库里没有变化 |
| 18 | 远程匿名访问领域的写接口 | 401（启动自检那一行同） |
| 19 | 持管理层授予（范围 `*`）的人，对任一领域新加规范版本、移生效指针 | 403（定规范是硬规则，角色覆盖不算） |
| 20 | 自定义角色的权限列了 `area.spec-set`，由管理层或系统管理员起草、放行 | 都拒：覆盖 `area.spec-set` 的授予只有属主能起草、放行 |
| 21 | 迁移接口同时调两次（并发） | 只成一份：领域一个、授予草稿一条 |
| 22 | 持 `area:<x>` 授予的人读经验库里写着 `dept:<x>` 的条目 | 看得到（经验库照写 `dept:`，判定处按领域问） |
| 23 | 系统管理员或管理层起草、放行 `area-lead` | 都拒：领域负责人只有属主起草、放行 |
| 24 | 持 `area-lead` 的人在第 1 步调负责人专有的动作（放行、改派、批接入） | 拒：第 1 步这些动作用恒为假的 `refine` 登记 |
| 25 | 持 `area-lead`（领域 x）的人新加领域 x 的规范版本 | 403：负责人不含定规范，定规范单独授予 |
| 26 | 迁移遇到有生效负责人授予的部门 | 起草的是 `area-lead`，不是 `area-member` |

**变异核对：**
- 拿掉「覆盖 `area.spec-set` 的授予只有属主起草、放行」，7、20 应红；
- 拿掉 `area.spec-set` 的硬规则（改回按角色覆盖放行），19 应红；
- 拿掉版本触发器，5 应红；
- 让 `area:` 匹配前缀而不是整串，10 应红；
- 拿掉过渡期认 `dept:`，12 的台那一半应红；过渡期认 `dept:` 扩到 `area.*`，12 的规范、触发、验收那一半应红；
- 迁移不放在一个事务里、或者不按授予去重，21 应红；
- 把 `area.trigger`、`area.accept` 那两条 `refine` 的 `when` 改成恒真，事项那几份回放应有差异。

## 六、和 14 的旧对象怎么收

| 旧对象 | 第 1 步 | 第 2～4 步 | 第 5 步 |
|---|---|---|---|
| 部门（`departments`）的增、改、删 | **停写**：接口回 410，提示改用领域；读照旧 | — | 删表（历史只读导出一份）；删路由 |
| 部门成员（`department_members`） | **停写**：接口回 410；读照旧（`nameResolver` 还在用） | — | `nameResolver` 改成按领域授予后删 |
| 部门负责人（字段、`dept_lead_grants`、`dept-lead` 预设、`dept-lead` 提议） | **停写**：不再收提议、不再起草 `dept-lead` / `dept:`；已生效的 `dept:` 授予过渡期照旧算 | — | 撤销剩下的 `dept:` 授予（留痕写「领域迁移收尾」），删预设、删 `DEPT_SCOPE` |
| 设置向导的 `dept_leads` | **停写**：不再收 | — | 删字段 |
| 「项目 → 部门」对照（`knowledge_project_depts`） | 新写落到领域；旧行只读 | — | 并表 |
| 数据视图台的部门绑定（`bench_views.department_id`） | 字段不改，含义换成领域标识（同标识），绑定时核领域表 | 第 2 步改列名 | — |
| 团队登记、认领到部门（`teams.department_id`、`team-claim`） | 照旧 | 第 3 步：团队对应领域（`areas.team_host/team`），认领改成认领到领域，停写旧列 | 删旧列 |
| 团队负责人（`team_leads`） | 照旧 | 第 2 步：事项按领域流转、过目改由领域负责人（`area-lead`）放行；现有的团队负责人起草成对应领域的 `area-lead` 授予、属主放行后，旧表停写 | **不删**，只读保留（属主 11-18：有团队就有负责人） |
| 成员分配给员工（`seat_assignments`、指名派工里的「成员的主人」） | 照旧 | 待属主确认（15 末尾）；确认不要以后：第 2 步停写，任务进领域、领域内谁接由领域自己定（15 第三节第 2 条） | 待属主确认；确认不要以后删表 |
| 团队事件（`team_events`） | 照旧 | 停写跟着上面几项 | 只读保留，不删（留痕） |

**删除前（第 5 步）：** 按「旧断言 → 新守护」逐条核对。每张要删的表、每个要删的接口，原来哪些测试守着，现在由哪条领域的测试守，列成表；没人守的先补测试再删。

## 七、评审已定（阶段四验收，#828）

1. `area.trigger`、`area.accept` **第 1 步就用恒为假的 `refine` 登记**，角色这一步就完整：
   - 理由：第 2 步再往 `area-member` 里加动作，会让属主已经放行的授予在没人重新放行的情况下变宽。
   - 配的变异写在第五节。
2. 库里的范围前缀用 **`area:`**。
3. 经验库照写 `dept:`，等 ygl-trees 认了 `area:` 再换；判定处按领域问。对抗清单第 22 条守着。
4. 设置向导**第 1 步不加** `area_members`：迁移已经覆盖现有的人，新领域的授予逐条起草。
