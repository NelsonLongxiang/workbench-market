# 贡献约定

给在本仓干活的人和 agent 会话看的常驻约定：这个仓是什么、红线、新东西该写在哪、提交前跑什么。功能说明看 README。

## 这个仓是什么

工作台市场：组织的人用入口。只做四件事——呈现（驾驶舱、门户、自产台、SOP 执行页）、判定（谁能做什么）、留痕、索引。席位怎么运行、消息怎么投递、证据怎么存、业务规则是什么，不在这里实现，只消费别的部件的接口。

地基是 Cordis。新东西用它的构件来表达：插件、服务、依赖注入、事件、可撤销的注册、Config。不另造插件机制。

## 红线

- 这是公开仓：不写业务内容，不写内网地址、端口、主机名、凭证。部署方的私有功能放在仓库外，经扩展目录挂进来。
- 安全面的改动（鉴权、CORS、SSRF、注入、令牌、会话）附对抗组，先红后绿，见 PR 模板。
- 新的安全行为要加一行启动自检。
- 身份与权限的改动先验后合。范围：影响谁能登录、谁是谁、谁能做什么的改动都算，拿不准就当这一类。按文件名大致是 `server/src/` 下名字里含 identity、login、local-account、signup、principal、grant、role、judgment、admin-token、access、auth、session、person、seat-token、custom-role、dept-lead、setup-wizard、mcp、peer、portal、surfaces、attention-answers、startup-security-self-probe 的文件，以及 `server/src/login-providers/` 整个目录。规则：
  - 合进集成分支（见下一节）之前，要有作者以外的会话或人在 PR 当前的头提交上做一次独立验收：复现对抗组（先红后绿）、跑变异，把结论（PASS，或有条件 PASS 且条件已满足）贴在 PR 上，写明对应的头提交。
  - 头提交变了（包括把集成分支合进 PR）就复核增量，验收结论要对应新的头提交。
  - 作者不合自己的这类 PR。合并的人要先确认 PR 上有对应当前头提交的验收结论，没有就不合。

## 集成分支与版本评测（属主 2026-11-18）

属主原话：「如果每项任务都做 CI，那根本没办法做任务了，必须要收敛到一个可评估和评测的版本再去做」「特别是连改了一份文档都要做 CI，这个没必要啊」。

- 每次上线一个集成分支：`release/<次数>`，从 main 切出。这次上线的任务 PR 都以它为 base。
- CI 只在 PR 指向 main 时跑。任务 PR 合进集成分支不跑 CI、不等 CI。条件是：
  - 作者在本机跑过相关测试和 `node scripts/tech-route-check.mjs --strict`；
  - PR 上有作者以外的评审结论；身份与权限类按上面的红线做独立验收，只是不等 CI；
  - 作者不合自己的 PR，由合并方 squash 合入。
- 只改文档（`docs/`、`*.md`）的 PR：有一条评审或确认评论就能合，不跑 CI，也不做变异。指向 main 的纯文档 PR 同样不等 CI。
- 集成分支要一直能构建、路线体检能过。冲突由后合进来的一方解。
- 改了 `.github/` 下文件的任务 PR：合并方合进集成分支之前，要用 YAML 解析器把所有 workflow 解析一遍，解析不过就不合。任务 PR 不跑 CI，这一步没有别人替我们挡（步骤名里的「: 」会让整个工作流解析失败，检查一项都不出现）。
- 收敛：这次上线的范围都进了集成分支以后，开一个「集成分支 → main」的 PR，这就是可评测的版本。在它上面跑一次完整 CI，加一轮整体独立验收：全量回放、探针、变异、跨功能回归。有问题就在集成分支上修，修完再跑一遍，全过才合进 main，然后上线。

## 东西该写在哪

| 新增的东西 | 写在哪 | 不要 |
|---|---|---|
| 路由 | `server/src/routes/<域>.ts`，自带注册函数，经 HTTP 服务（`http`）注册，报上动作名和类别（`{ action: '<域>.<动词>', kind }`） | 写进 `server/src/index.ts`；直接挂在 Express 上 |
| 登录方式 | `server/src/login-providers/` 下的一个插件，登记进那里的清单 | 改核心 |
| SQL | `server/src/services/` 里对应域的服务 | 写在路由处理函数或别的模块里 |
| 表、列 | `server/src/db.ts`（幂等迁移） | 在别的文件里建表、改表 |
| SQL 里要用的当前时间 | 代码生成（`new Date().toISOString()` 或毫秒数），作为参数传进 SQL | 在 SQL 里写 `datetime('now')`、`CURRENT_TIMESTAMP` 这类取时间的写法 |
| SQL 写法 | 两种库（SQLite、PostgreSQL）都认的写法：`ON CONFLICT … DO UPDATE / DO NOTHING`、`RETURNING id`、`COALESCE` | 新增 SQLite 特有的写法（`INSERT OR REPLACE / IGNORE`、`lastInsertRowid`、`rowid`、`json_*` 函数等，清单见 `tech-route.json` 里 `sql-dialect` 的说明） |
| 环境变量 | 所属模块自己的 Config（`server/src/config.ts` 的 `defineConfig`；服务类插件写成 `static Config`），启动时取一次并校验，同时写进 README | 在用到的地方直接读 `process.env` |
| 周期任务 | 能随所属模块一起停掉的定时器 | 裸的 `setInterval` |
| 会往外发的周期任务或发送 | 发之前先问 `outboundOff()`（`server/src/outbound-gate.ts`），关着就整轮跳过、不记失败，并在 `scripts/outbound-off-test.mjs` 里加一个触发点 | 只靠底层的闸：发送会被当成失败，按退避重试、最后判死 |
| 认人 | 经身份服务：`server/src/identity.ts` 的 `identity()`、`loginRelay()` | 引用 `server/src/login-providers/` 里面的文件 |
| 缓存认人的结果 | 用 `identity().cachedResolver()`：缓存的只有登录提供方的回答，主体停没停用每次现查 | 自己把 `resolveViewer()` 的结果存起来（停用和恢复就不是立即生效了） |
| 测试脚本 | 接进 CI；确实进不了的，在 `tech-route.json` 的 `tests` 里写明理由 | 写了不跑 |
| 测试里起隔离实例 | `NODE_ENV=test`，起不来时用 `scripts/lib/self-probe-env.mjs` 的 `instanceStartError` 打标、`startWithEnvironmentRetry` 有限次重试环境问题；并行起实例要限并发 | 把自检超时当成被测行为失败；开满核数并行起实例 |
| 测试脚本读写库 | 经统一入口（还没有：暂时照旧直接开库，但新脚本尽量经接口造数据、核对结果，确需开库的在 PR 里说明） | 不说明就新增直接开库的脚本 |
| 运行时依赖 | 先登记进 `tech-route.json` 的 `deps` | 顺手加 |

存量里有不少不符合上表的地方。那是欠账，只减不增：改到哪个域，顺手把那个域收一点。

## 提交前

```bash
node scripts/tech-route-check.mjs    # 路线体检：把末尾「本次变化」一行贴进 PR
pnpm check                           # web 类型检查 + server 语法检查
```

体检分三档，每项现在是哪一档以 `tech-route.json` 为准（属主 2026-11-10 裁定）：

- **红线**，高于目标就失败：不可擦除的语法、领域服务引用 express、没登记的运行时依赖、环境变量没写进 README、改动里有隐私命中、对外的面和快照不一致、没报动作的路由数和动作快照对不上。
- **预算**，比基线多就失败：`index.ts` 里的路由、没报动作的路由、`services/` 之外的 SQL、`db.ts` 之外的建表改表、没登记的测试脚本、类型错误、README 没提到的文件和已失效的路径、核心直接引用身份的具体实现。
- **计数**，只报告：其余各项。其中两项的落点还没建好（配置、定时器），建好之后转预算。数据库的三项（SQL 里取当前时间、SQLite 特有写法、直接开库的测试脚本）为换库止住新增，先计数，什么时候转预算写在各自的 note 里；计数期间评审照「本次变化」一行拦新增。

被拦住的时候：

- 先把东西放到上表说的地方。
- 改了路由、动作、MCP 工具或表结构：跑 `node scripts/surface-snapshot.mjs --write`，把 `surfaces/` 和代码一起提交。
- 把路由从 `index.ts` 搬进 `server/src/routes/`：纯移动。搬之前先写好这个域的请求集并录下应答（`node scripts/route-replay-test.mjs --record <域>`，单独提交），搬完之后路由快照和录制回放都必须零差异。
- 有意改了已搬走的路由的行为：跑 `node scripts/route-replay-test.mjs --record`，把 `surfaces/replay/` 和代码一起提交。
- 类型错误超了：体检表下面贴着 tsc 的原始报错行，照着改。量法是带空值检查、其余宽松。
- 带着存量搬家：预算按文件记，把 `index.ts` 里的 SQL 原样挪到新文件会被当成新增。先把 SQL 收进 `services/`，或者走豁免。
- 确实要破例：在 `tech-route.json` 的 `waivers` 里加一条，五项都要写：规则、哪一项、理由、谁批的、到哪天（`YYYY-MM-DD`）。缺一项体检直接报错；过期不算。确实要把预算档、红线档的基线调大，在那条规则上写 `loosen_reason`（见下面「体检的限度」里讲清单被放宽的那一条），否则 CI 失败。
- 数字变小了：合并之后跑 `node scripts/tech-route-check.mjs --tighten`，把基线收紧。不收紧的话，空出来的额度会被别的 PR 用回去。预算档和红线档只减不增；计数档按实际重记，代码挪进的新文件也记进去，总数不会低于实际。

体检的限度，心里要有数：

- 它是正则计数，不解析语法。注释和字符串里的命中也算：注释里写到 `db.prepare(` 算一处 SQL；README 里用反引号写一个全大写的名字，会被当成环境变量。
- 反过来，换个写法就能绕开计数。绕开量法不等于符合约定，评审照约定看。
- 清单被放宽（档位调低、基线调大、预算档和红线档里某个文件的额度变大或多出新文件、加豁免、已有豁免延期或改了理由和批准人）不会悄悄过去：体检表末尾的「清单变化」一行会列出来。其中预算档、红线档的放宽（基线或某个文件、条目的额度调大，红线目标放宽，档位调低）在 `--strict`（CI）下直接失败，除非那条规则上写了 `loosen_reason`：一句话说明为什么放宽、带 PR 号（光写 PR 号不算，去掉 PR 号、标点符号和零宽字符之类，至少还要四个字），比如 `"loosen_reason": "合并 A、B 两个模块时搬进来的存量 SQL（#123）"`。写了就放行，原因显示在「清单变化」里。原因只管引入它的那一次：main 上已经有的原因不算这一次的，`--tighten` 重写清单时会清掉。计数档按实际重记、加豁免、登记不进 CI 的测试照旧只列出来，不拦。
- 体检只在 PR 上跑。两个各自通过的 PR 先后合并，合起来可能超，要到下一个 PR 才会红。
