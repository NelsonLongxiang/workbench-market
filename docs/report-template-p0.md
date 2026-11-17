# 报告模板框架 P0 · 技术试验

状态：**实验原型，未接生产入口**。它验证数据视图之上的“模板→数据槽绑定→冻结文档→连续阅读/打印”是否可行，不是已交付模板管理系统。

## 范围

- 通用模板节点：封面、章节、正文、受控网格、重复段、指标、柱图、完整表格、合成图片、显式分页。
- 两个合成报告族：经营概览（308 行完整明细）、产品线（50 个重复详情）。
- 一个模板换两周期/两份兼容来源；冻结输入与后续来源变更分离。
- 既有组件的数值格式、图表系列/配置和设计 token 继续复用；报告表格没有看板分页、省略与滚动容器。
- P0 选择 SVG 图表输出，使用现有 ECharts 包已有的 renderer，不新增包、不改默认看板 canvas。

不在范围：模板编辑器、MCP/HTTP 操作、权限/受众发布、业务生成记录/资产管理、生产数据绑定、定时出报、正式 PDF 服务。源 identity/version/hash 与 expected_rows 在这里是调用方提供的**夹具证据**，不是客户端可自证的生产权限。

## 代码入口

| 文件 | 职责 |
|---|---|
| [p0.ts](../web/src/report-template/p0.ts) | 有界编排、槽/列/参数/键检查、JSON 值复制与深度冻结，无 IO |
| [P0Report.tsx](../web/src/report-template/P0Report.tsx) | 只读报告呈现，复用数据视图的格式/图表配置函数 |
| [p0.css](../web/src/report-template/p0.css) | 连续流、A4、完整表头/行、段首与图文保持 |
| [p0-entry.tsx](../web/src/report-template/p0-entry.tsx) | 仅测试 Vite 入口，未导入 App/生产路由 |
| [合成夹具](../scripts/fixtures/report-template-p0.mjs) | 完整 rows/columns、模板/绑定、生成合成 PNG |
| [纯函数测试](../scripts/report-template-p0-test.mjs) | 编排/冻结/边界正反例 |
| [台库接缝测试](../scripts/report-template-p0-store-test.mjs) | 真台库默认 200 行截断拒绝、500 上限完整 308 行、实时变更不改冻结值 |
| [浏览器跑器](../scripts/report-template-p0-browser.mjs) / [Playwright](../scripts/report-template-p0-browser.py) | 隔离 Vite 构建、随机回环 listener、浏览器及 print-to-PDF |
| [可选 PDF 核对](../scripts/report-template-p0-pdf.py) | 用本机已有 PyMuPDF 核内容/顺序/表头/边距，非新增运行依赖 |

## 复跑

~~~sh
node scripts/report-template-p0-test.mjs
node scripts/report-template-p0-store-test.mjs
node scripts/report-template-p0-browser.mjs
# 可选：本机已经装有 PyMuPDF 时，连 PDF 内容/边界一起核；不自动安装
node scripts/report-template-p0-browser.mjs --inspect-pdf
pnpm check
~~~

解释器由现有 python-bin.mjs 选择；构建用本项目已安装的 Vite/React/ECharts，不安装排版引擎。

浏览器跑器只在 127.0.0.1 的随机空闲端口服务合成文档；结束时关闭自身 listener 和子进程。产物保留在项目 tmp/report-template-p0，正式库、生产浏览器会话与任何远端服务都不参与。运行目录与生产端点不可自行替换。

CI：browser-security 跑基础浏览器/打印，tsc-and-syntax 跑纯函数＋真实台库接缝。完整 PDF 文字/几何检验为可选本机步骤，CI 没有偷偷安装 PyMuPDF；P0 尚不承诺 CI 已核 PDF 内全部内容。

## P0 实测结果

本地环境：Node 24.12.0、Python 3.12、已安装 Playwright 1.62.0 / Chromium 151.0.7922.34、PyMuPDF 1.26.7。CI 的浏览器版本仍按仓库既有配置，不能把本机结果冒充 CI。

| 验证 | 本地结果 |
|---|---|
| 编排及反例 | 27 组通过：缺列、错型、未知键、重复 id/行键、超限 repeat、错误槽/参数、源签名不符、截断、未实现布局均拒绝 |
| 真台库接缝 | 4 组通过；默认确实只回 200/308 且 truncated，原型拒绝；显式 limit=500 得到 308；追加后 live=309，原冻结成品仍 308 |
| 浏览器 | 三份输出通过；全量行/产品、图表 ready、图片加载、HTML样式文本不执行、无外部取数 |
| 经营概览 | 21 页 A4；308 行顺序精确；行页重复表头；末尾 END308 可核 |
| 产品详情 | 22 页 A4；50 个详情顺序精确、50 张图片；每个编号与对应图片保持同页 |
| 第二周期/来源 | 同一模板形状，2026-11/另一合成源；21 页 A4，308 行 |
| 页面文字边界 | 三份 PDF 的全部文字在 20mm 内容区容差内 |
| 超高行 | 浏览器试验注入 1400px 行后 preflight 报 layout_overflow；未输出伪成功 PDF |
| 类型/语法 | pnpm check 通过（web typecheck＋221 服务器文件语法核） |

发现并修正：最初产品编号可能在页尾、图片在下一页；把标题/编号/首图作为不可拆分的段首后重新打印，PDF 检查逐编号确认对应图片同页。它不是把整个产品详情硬塞一页；长正文仍允许自然续页。

## 结论与下一步

**已证明**：有限的语义文档流＋局部网格可复用现有数据视图语义，满足这两组真实规模的合成长报告；完整性检查必须在打印前进行，冻结内容与实时预览应分离。

**尚未证明**：跨台一致性、生成期间撤权/资源改绑、资产授权、旧定义淘汰后执行、编辑器自定义能力、可发布报告持久化、页眉页脚/自动页码/目录、任意宽表与超高元素通用分页。P0 不等于 P1。

建议 P1 分开实施：同源契约/报告领域模型 → 经既有判定的来源适配与生成记录 → 最小结构化编辑 → 正式导出及完整性门。涉及权限的部分按仓库规则做独立验收，再合并；不因本 P0 测试通过自动上线。
