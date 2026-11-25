# 20 · 数据视图与报告模板借用 json-render

> 属主 2026-11-25 说了两句：「关于数据视图和报告模板，可以借用项目：https://github.com/vercel-labs/json-render.git」，随后又问「有没有可能直接使用这个项目嵌入？」。
> 本篇回答三件事：能不能直接嵌进来，嵌在哪里，先后怎么排。
> [数据视图](../data-views.md) 开头说过「开源项目只作参考，自己做」，这条对 json-render 改为可以直接用。
> 核对依据：json-render main（2026-11-25 读）、npm 0.23.2；我们这边是 main `3bf571c6`。

## 一、它是什么

json-render 自称「生成式界面框架」，Apache-2.0。AI 按提示输出 JSON，前端把 JSON 渲染成界面，AI 只能用登记过的组件。和我们的对照：

| 它的 | 做什么 | 我们这边对应的 |
|---|---|---|
| 目录（catalog）：组件名 → zod 定义的 props + 说明；动作名 → 说明 | 一份来源同时管校验和给 AI 的提示（`catalog.prompt()`） | `VIEW_DOC_CONTRACT` → `view-doc-schema.json`（#763）。校验已经是一份来源；技能里的「组件一览」还是手写的 |
| 注册表（registry）：组件名 → 真正的 React 组件 | 同一份目录可以换不同的画法 | 十二种块的 React 组件 |
| 平铺描述 `{ root, elements: { id: { type, props, children } } }` | 每个元素有稳定 id，可以流式生成、按 id 局部改 | 视图是 `views[].blocks[]` 排在 12 栏网格里；报告 `body` 是节点数组，节点带 `id` |
| 指令：`$format`、`$math`、`$concat`、`$count`、`$join` 等 | 在 props 里写取值和格式化，可以嵌套 | 报告正文是 `(string \| { ref })[]`，只能把值原样插进去 |
| 出口：React、PDF（`react-pdf`）、邮件、图片、MCP Apps 等 | 同一份描述出多种成品 | 网页一种；P0 的 PDF 用浏览器打印 |
| `experimental_composeSpec`：从候选组件里挑选、排布，由选择题模型判（示例用 jev） | AI 只决定挑哪些、怎么摆，props 不由它编 | 没有；ygl 的 eval 门槛同样用 jev |

## 二、能不能直接嵌进来：能

实际核了三处，都没有挡路的：

- **React 版本。** `@json-render/react` 声明要 React `^19.2.3`，我们是 18.3。我读了它 `packages/react/src` 的全部源码：用到的只有 `createContext`、`useContext`、`useState`、`useCallback`、`useRef`、`useEffect`、`useSyncExternalStore`，这些 React 18 都有；19 独有的 `use()`、`useActionState`、`useOptimistic`、ref 当 prop 一个也没用。所以 React 不用升，在 pnpm 里把这个 peer 放宽到 18 就行。能不能跑，以试嵌的浏览器回归为准。
- **新增依赖。**
  - `@json-render/core`（解包约 1.2 MB）和 `@json-render/react`（约 0.57 MB）；
  - zod 4：它是 core 的依赖，web 现在没有 zod；
  - 打进包里实际增加多少，试嵌时量。
- **接我们自己的组件。** registry 就是「名字 → 组件」，十二种块直接登记进去，不用它的 shadcn 组件。块里已有的治理都留着：提交幂等、按台读权限、任务图的 500 上限和起止核对、5 秒刷新。json-render 只负责「读描述、按名字找组件、把 props 交过去」。

风险有两处：

- **版本还在 0.x。** 带 `experimental_` 的接口随时会变。要钉死精确版本，升级当成一次单独的改动来做。
- **校验分两层。** 服务端的校验仍是权威，它不用 zod。web 端用 zod 做的目录校验，只用来生成给 AI 的提示、在开发时报错。两边由 `bench-view-contract-test.mjs` 核一致。

## 三、嵌在哪里

**报告模板直接用 json-render 的描述做正文。** 报告 P1 还没开写，现在定格式成本最低，好处也最多：

- 平铺描述加稳定 id，正好给「最小结构化编辑」用（第 19 篇第七节）。
- 指令让正文能写成「本月 308 单，比上月多 12%」，不再只能把原始值插进去。
- 同一份描述可以走 `react-pdf` 出正式 PDF，以后要出邮件、图片也是同一份。

治理照旧：

- 判据摘要只算 `claims`、`responses`、`gate`、`slots`、`parameters`。正文换格式不算改判据，所以不用重新复核。
- 作者以外复核、属主本人发版免复核（#1057）、模板版本只增不改、报告冻结，这些都在 json-render 之外。
- 冻结时由服务端把指令算成文字。读回来的报告和冻结那一刻逐字一样，不依赖读的人那边的环境。

**数据视图先套一层壳，不重写。**

- 十二种块已经跑在生产上。嵌进来的做法是加一个转换：视图描述 → json-render 描述，转出来交给 `<Renderer>`，注册表里放的就是现有组件。页面上看到的不变。
- 加壳之后多出三样东西：`catalog.prompt()` 给 AI 写视图用；devtools 用来排查；以后接 MCP Apps，把视图直接画在对话里（第 16 篇）。
- 视图描述的存储格式和 `view_put` 不动。这样已有的台、技能和回放都不受影响。

**不用的部分。**

- shadcn 组件库：我们用 antd 和自己的块。
- `$bindState` 和按状态显示：视图台的交互只有筛选栏和表单。多一套本地状态，就多一处「页面上看到的和库里存的不一样」。
- Next.js、Vue 等别的出口。

## 四、顺序

1. **试嵌（这一步不合入，产物放在 `tmp/<工单号>/`）。**
   - 在 web 加上 core 和 react，钉 0.23.2，把 peer 放宽到 React 18。
   - 十二种块登记成目录和注册表。
   - 拿技能里的两个例子（订单台、督导台）转成 json-render 描述画出来，和现在的页面逐块截图对照。
   - 跑 `browser-security` 里数据视图那几条，量包体增量。
   - 再用 `react-pdf` 把 P0 的经营概览出一份 PDF，和浏览器打印比页数、重复表头、段首保持。
2. **试嵌通过后，按以下三件开 PR，排进第十二次上线：**
   1. 报告模板 `schema_version` 3：正文改成 json-render 描述，指令白名单只收 `$format`、`$count`、`$join`、`$concat`、`$math`，冻结时由服务端求值；`docs/report-step1.md` 第三节同步改写。
   2. 数据视图加转换壳，页面改由 `<Renderer>` 画；验收时前后截图要逐块一致。
   3. 目录说明随契约一起生成，技能「组件一览」改为脚本产出，`--check` 核对。
3. **试嵌没通过：** 退回「只借设计」——指令和目录生成自己写，不带依赖。没通过的原因写回本篇。

上面每个 PR 都照常走非作者评审。

## 五、试嵌结果（2026-11-25）

第四节第 1 步做完了，结果：

| 问题 | 结果 |
|---|---|
| 两个例子经 `<Renderer>` 画出来和现在一样吗 | 一样。7 个视图、20 个块，位置、尺寸全部一致；19 块逐像素一致，甘特那一块有 11 个像素差 1/255，肉眼看不出；两边都没有控制台报错 |
| `browser-security` 里数据视图那几条 | 本机没装 Playwright，没跑（NOT_RUN）。改成数据视图转换壳那个 PR 的合入门槛，由 CI 跑 |
| web 包体增加多少 | gzip 后 +38 KB（+3.6%） |
| `react-pdf` 和浏览器打印比 | 两边都能重复表头、保持段首。`react-pdf` 还要另配中文字体、把 ECharts 截成图、重写样式，所以 P0 继续用浏览器打印，`react-pdf` 另外评估 |

定：通过，按第四节第 2 步开三个 PR，排第十二次上线；报告模板 `schema_version` 3 先开。

试嵌里摸出来、开 PR 时要照着做的几点：
- 取数结果不放进描述，描述里只写块序号，注册表按序号把结果交给原来的块组件。
- 目录只在脚本里生成，不打进浏览器的包。
- 给 AI 的提示我们自己写，不直接用 `catalog.prompt()` 的原文。
- json-render 不校验 props，服务端校验仍是唯一权威。
