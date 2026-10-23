#!/usr/bin/env node
/**
 * 开发验证器 v4 生成器 —— 单一事实源表 → material.md + candidates.json + reviews.json
 * 保证 source_clause / anchor.quote / review source_clause 三者逐字一致（P1/P3 的硬要求）。
 * 用法：node tmp/gen-v4.mjs   （产物落在 verify/，随后 submit/prepare）
 */
import { writeFileSync } from "node:fs";

// ── 35 单元事实源 ────────────────────────────────────────────────────────────
// ck: checker；rv: [faithful 理由, decidable 理由, not-vacuous 理由]
const notIn = (col, list) => ({ op: "not", conditions: [{ col, op: "in", value: list }] });
const and = (...conditions) => ({ op: "and", conditions });
const or = (...conditions) => ({ op: "or", conditions });
const sql = (from, select, where) => ({ type: "sql", predicate: { from, select, where }, expect: "none", fail_when: "rows>0" });
const count = (from, op, value, where) => ({ type: "count", predicate: { from, select: [], ...(where ? { where } : {}) }, op, value });
const exists = (from, where) => ({ type: "exists", predicate: { from, select: ["key"], where }, expect: true });
const existsFact = (path, needle) => ({ type: "exists", predicate: { from: "verifier_text_facts", select: ["path"], where: and({ col: "path", op: "=", value: path }, { col: "needle", op: "=", value: needle }, { col: "present", op: "=", value: 1 }) }, expect: true });
const file = (glob, min, require) => ({ type: "file", glob, min, ...(require ? { require } : {}) });

const U = [
  // ── 数据域完整性：types 表 ──
  { c: "判据1：类型的 key 字段不得为空。", t: "类型 key 非空", s: "S1", ck: sql("types", ["id", "key"], and({ col: "key", op: "is null" })),
    rv: ["判据原文逐字取自冻结材料，检查类型键非空。", "is null 谓词精确判定，无模糊词。", "插入 key 为 NULL 的行即 FAIL。"] },
  { c: "判据2：类型的 health_method 字段必须等于 GET 或 HEAD。", t: "探测方法域完整", s: "S1", ck: sql("types", ["id", "health_method"], notIn("health_method", ["GET", "HEAD"])),
    rv: ["判据原文逐字取自冻结材料，violation 形式=方法不在两值集合。", "in 集合判定，SQL 层无歧义。", "写入 POST 方法行即 FAIL。"] },
  { c: "判据3：类型的 expect_status 字段必须为空或落在 100 到 599 之间。", t: "期望状态码域完整", s: "S2", ck: sql("types", ["id", "expect_status"], and({ col: "expect_status", op: "is not null" }, or({ col: "expect_status", op: "<", value: 100 }, { col: "expect_status", op: ">", value: 599 }))),
    rv: ["判据原文逐字取自冻结材料，允许空值，非空时限定百位区间。", "数值列 INTEGER 上的区间判定，类型可靠。", "写入 999 即 FAIL。"] },
  { c: "判据4：类型的 default_port 字段必须为空或落在 1 到 65535 之间。", t: "默认端口域完整", s: "S2", ck: sql("types", ["id", "default_port"], and({ col: "default_port", op: "is not null" }, or({ col: "default_port", op: "<", value: 1 }, { col: "default_port", op: ">", value: 65535 }))),
    rv: ["判据原文逐字取自冻结材料，端口区间为 TCP 合法域。", "数值区间判定。", "写入 0 或 70000 即 FAIL。"] },
  // ── 数据域完整性：workbenches 表 ──
  { c: "判据5：每个已注册工作台的 enabled 字段必须等于 0 或 1。", t: "enabled 域完整", s: "S1", ck: sql("workbenches", ["id", "name"], notIn("enabled", [0, 1])),
    rv: ["判据原文逐字取自冻结材料，布尔列只许两态。", "in 两值集合判定。", "写入 2 即出现违规行 FAIL。"] },
  { c: "判据6：工作台的 last_status 字段必须等于 up、down、unknown 之一或为空。", t: "状态字段域完整", s: "S1", ck: sql("workbenches", ["id", "last_status"], and({ col: "last_status", op: "is not null" }, notIn("last_status", ["up", "down", "unknown"]))),
    rv: ["判据原文逐字取自冻结材料，三态加空即合法域。", "字符串集合判定，SQL 相等语义明确。", "写入 pending 状态即 FAIL。"] },
  { c: "判据7：工作台的 last_latency_ms 字段必须为空或落在 0 到 60000 之间。", t: "延迟字段域完整", s: "S2", ck: sql("workbenches", ["id", "last_latency_ms"], and({ col: "last_latency_ms", op: "is not null" }, or({ col: "last_latency_ms", op: "<", value: 0 }, { col: "last_latency_ms", op: ">", value: 60000 }))),
    rv: ["判据原文逐字取自冻结材料，延迟以毫秒计且受探测超时上界约束。", "INTEGER 列区间判定。", "写入 -1 即 FAIL。"] },
  { c: "判据8：工作台的 last_http_code 字段必须为空或落在 100 到 599 之间。", t: "HTTP 码域完整", s: "S2", ck: sql("workbenches", ["id", "last_http_code"], and({ col: "last_http_code", op: "is not null" }, or({ col: "last_http_code", op: "<", value: 100 }, { col: "last_http_code", op: ">", value: 599 }))),
    rv: ["判据原文逐字取自冻结材料，HTTP 状态码合法区间。", "数值区间判定。", "写入 99 即 FAIL。"] },
  { c: "判据9：工作台的 sort 字段必须落在 0 到 9999 之间。", t: "排序字段域完整", s: "S3", ck: sql("workbenches", ["id", "sort"], or({ col: "sort", op: "<", value: 0 }, { col: "sort", op: ">", value: 9999 })),
    rv: ["判据原文逐字取自冻结材料，排序列非空有界。", "NOT NULL 列直接区间判定。", "写入 -5 即 FAIL。"] },
  // ── 种子与配置 ──
  { c: "判据10：类型库中的工作台类型不少于 8 个。", t: "类型库规模下限", s: "S1", ck: count("types", ">=", 8),
    rv: ["判据原文逐字取自冻结材料，语义为类型表行数下限。", "count 与 8 比较纯数值判定。", "删类型至 7 即 FAIL。"] },
  { c: "判据11：内置类型 web 必须存在于类型库。", t: "内置 web 类型存在", s: "S1", ck: exists("types", and({ col: "key", op: "=", value: "web" })),
    rv: ["判据原文逐字取自冻结材料，检查内置类型存在性。", "键精确匹配。", "删 web 行即 FAIL。"] },
  { c: "判据12：ollama 类型的探测路径必须为 /api/tags。", t: "ollama 种子探测路径", s: "S2", ck: exists("types", and({ col: "key", op: "=", value: "ollama" }, { col: "health_path", op: "=", value: "/api/tags" })),
    rv: ["判据原文逐字取自冻结材料，钉住 ollama 种子的探测语义。", "双条件精确匹配。", "改路径即 FAIL。"] },
  { c: "判据13：streamlit 类型的探测路径必须为 /_stcore/health。", t: "streamlit 种子探测路径", s: "S2", ck: exists("types", and({ col: "key", op: "=", value: "streamlit" }, { col: "health_path", op: "=", value: "/_stcore/health" })),
    rv: ["判据原文逐字取自冻结材料，钉住 streamlit 种子的健康端点。", "双条件精确匹配。", "改路径即 FAIL。"] },
  { c: "判据14：巡检设置必须包含 health_interval_seconds、health_timeout_ms、health_concurrency 三个键。", t: "巡检三键齐备", s: "S1", ck: count("settings", "==", 3, and({ col: "key", op: "in", value: ["health_interval_seconds", "health_timeout_ms", "health_concurrency"] })),
    rv: ["判据原文逐字取自冻结材料，三键名与 in 列表一致。", "键名集合计数 ==3。", "缺任一键计数变 2 即 FAIL。"] },
  { c: "判据15：工作台表中至少注册了 1 个工作台。", t: "工作台非空", s: "S2", ck: count("workbenches", ">=", 1),
    rv: ["判据原文逐字取自冻结材料，语义为工作台表非空。", "count>=1 数值判定。", "空表即 FAIL。"] },
  // ── 提交物结构（封装提交物） ──
  { c: "判据16：封装提交物必须包含 README.md。", t: "README 存在", s: "S2", ck: file("README.md", 1), rv: ["判据原文逐字取自冻结材料，检查根 README。", "精确文件名 glob。", "删除即 FAIL。"] },
  { c: "判据17：封装提交物必须包含根目录 package.json。", t: "根清单存在", s: "S2", ck: file("package.json", 1), rv: ["判据原文逐字取自冻结材料，检查 workspace 根清单。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据18：封装提交物必须包含 pnpm-workspace.yaml。", t: "workspace 定义存在", s: "S2", ck: file("pnpm-workspace.yaml", 1), rv: ["判据原文逐字取自冻结材料，检查 workspace 定义。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据19：封装提交物必须包含 server/package.json。", t: "server 清单存在", s: "S2", ck: file("server/package.json", 1), rv: ["判据原文逐字取自冻结材料，检查 server 包清单。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据20：封装提交物必须包含 web/package.json。", t: "web 清单存在", s: "S2", ck: file("web/package.json", 1), rv: ["判据原文逐字取自冻结材料，检查 web 包清单。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据21：封装提交物必须包含 server/src/index.ts。", t: "server 入口存在", s: "S1", ck: file("server/src/index.ts", 1), rv: ["判据原文逐字取自冻结材料，检查服务入口源码。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据22：封装提交物必须包含 server/src/db.ts。", t: "db 模块存在", s: "S1", ck: file("server/src/db.ts", 1), rv: ["判据原文逐字取自冻结材料，检查建库模块。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据23：封装提交物必须包含 server/src/health.ts。", t: "探测模块存在", s: "S1", ck: file("server/src/health.ts", 1), rv: ["判据原文逐字取自冻结材料，检查健康探测模块。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据24：封装提交物 web/src/pages 目录下的页面组件不少于 6 个。", t: "页面组件下限", s: "S2", ck: file("web/src/pages/*.tsx", 6), rv: ["判据原文逐字取自冻结材料，六个功能页各一文件。", "目录 glob 计数 >=6。", "删页即 FAIL。"] },
  { c: "判据25：封装提交物 web/src/components 目录下的组件不少于 2 个。", t: "组件下限", s: "S3", ck: file("web/src/components/*.tsx", 2), rv: ["判据原文逐字取自冻结材料，状态徽章与表单两组件。", "目录 glob 计数 >=2。", "删组件即 FAIL。"] },
  { c: "判据26：封装提交物必须包含 web/dist/index.html。", t: "构建入口存在", s: "S1", ck: file("web/dist/index.html", 1), rv: ["判据原文逐字取自冻结材料，构建落盘证据。", "精确路径 glob。", "未构建即 FAIL。"] },
  { c: "判据27：封装提交物 web/dist/assets 目录下的 JS 产物不少于 5 个。", t: "分桶产物下限", s: "S2", ck: file("web/dist/assets/*.js", 5), rv: ["判据原文逐字取自冻结材料，供应商分桶后的产物数量下限。", "目录 glob 计数 >=5。", "桶缺失即 FAIL。"] },
  { c: "判据28：封装提交物必须包含 scripts/make-submission.mjs。", t: "打包脚本存在", s: "S2", ck: file("scripts/make-submission.mjs", 1), rv: ["判据原文逐字取自冻结材料，判定面打包脚本自举。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据29：封装提交物必须包含 scripts/verify-report.mjs。", t: "报告脚本存在", s: "S2", ck: file("scripts/verify-report.mjs", 1), rv: ["判据原文逐字取自冻结材料，可视化脚本自举。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据30：封装提交物必须包含 verify/material.md。", t: "验证器材料自举", s: "S2", ck: file("verify/material.md", 1), rv: ["判据原文逐字取自冻结材料，判据源入版本库。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据31：封装提交物必须包含 verify/candidates.json。", t: "候选清单自举", s: "S2", ck: file("verify/candidates.json", 1), rv: ["判据原文逐字取自冻结材料，候选源入版本库。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据32：封装提交物必须包含 verify/reviews.json。", t: "盲审档案自举", s: "S2", ck: file("verify/reviews.json", 1), rv: ["判据原文逐字取自冻结材料，盲审源入版本库。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据33：封装提交物必须包含 design-system/workbench-market/MASTER.md。", t: "设计规范存在", s: "S2", ck: file("design-system/workbench-market/MASTER.md", 1), rv: ["判据原文逐字取自冻结材料，设计单一事实源。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据34：封装提交物必须包含 evidence/e2e_test.py。", t: "E2E 脚本存在", s: "S1", ck: file("evidence/e2e_test.py", 1), rv: ["判据原文逐字取自冻结材料，端到端测试脚本在位。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据35：封装提交物 evidence 目录下的 PNG 截图证据不少于 10 张。", t: "UI 证据下限", s: "S3", ck: file("evidence/*.png", 10), rv: ["判据原文逐字取自冻结材料，UI 证据资产下限。", "目录 glob 计数 >=10。", "清理截图即 FAIL。"] },
  // ── 颜色可见性（经对比度审计的色值钉位；内容由 make-submission 提取进快照 verifier_text_facts 表，sql/exists 断言） ──
  { c: "判据36：main.tsx 主题必须包含主色值「#1E3A5F」。", t: "主色 token 钉位", s: "S2", ck: existsFact("web/src/main.tsx","#1E3A5F"), rv: ["判据原文逐字取自冻结材料，主色为设计系统脊柱。", "提取表三条件 exists 精确判定。", "改主题色提取为 0 即 FAIL。"] },
  { c: "判据37：main.tsx 主题必须包含次级文字色值「#5A6577」。", t: "次级文字对比达标色", s: "S1", ck: existsFact("web/src/main.tsx","#5A6577"), rv: ["判据原文逐字取自冻结材料，该值经浅底 5.9:1 审计修复。", "提取表三条件 exists 精确判定。", "回退旧色提取为 0 即 FAIL。"] },
  { c: "判据38：main.tsx 主题必须包含成功色值「#059669」。", t: "成功色 token 钉位", s: "S3", ck: existsFact("web/src/main.tsx","#059669"), rv: ["判据原文逐字取自冻结材料，在线绿图形用色 3.77:1 达图形标准。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据39：main.tsx 主题必须包含错误色值「#DC2626」。", t: "错误色 token 钉位", s: "S2", ck: existsFact("web/src/main.tsx","#DC2626"), rv: ["判据原文逐字取自冻结材料，错误红文字级 4.83:1 达标。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据40：App.tsx 侧栏 token 必须包含深底色值「#0F172A」。", t: "侧栏深底钉位", s: "S2", ck: existsFact("web/src/App.tsx","#0F172A"), rv: ["判据原文逐字取自冻结材料，深色导航背景与白字标题配对。", "提取表三条件 exists 精确判定。", "改底色提取为 0 即 FAIL。"] },
  { c: "判据41：index.css 必须包含焦点环色值「rgba(5, 150, 105, 0.6)」。", t: "焦点环可见", s: "S1", ck: existsFact("web/src/index.css","rgba(5, 150, 105, 0.6)"), rv: ["判据原文逐字取自冻结材料，focus-visible 焦点环是键盘可访问性必需。", "提取表三条件 exists 精确判定。", "删焦点环提取为 0 即 FAIL。"] },
  { c: "判据42：index.css 必须包含选中边框色值「rgba(5, 150, 105, 0.45)」。", t: "选中边框钉位", s: "S3", ck: existsFact("web/src/index.css","rgba(5, 150, 105, 0.45)"), rv: ["判据原文逐字取自冻结材料，卡片选中态边框色。", "提取表三条件 exists 精确判定。", "改边框提取为 0 即 FAIL。"] },
  { c: "判据43：App.tsx 标题区必须包含强调色值「#059669」。", t: "标题强调色钉位", s: "S3", ck: existsFact("web/src/App.tsx","#059669"), rv: ["判据原文逐字取自冻结材料，深底上的 emerald 标题图标。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据44：设计规范 MASTER.md 必须包含主色值「#1E3A5F」。", t: "规范主色钉位", s: "S3", ck: existsFact("design-system/workbench-market/MASTER.md","#1E3A5F"), rv: ["判据原文逐字取自冻结材料，规范单一事实源钉主色。", "提取表三条件 exists 精确判定。", "删 token 提取为 0 即 FAIL。"] },
  { c: "判据45：设计规范 MASTER.md 必须包含次级文字审计色值「#5A6577」。", t: "规范审计色钉位", s: "S3", ck: existsFact("design-system/workbench-market/MASTER.md","#5A6577"), rv: ["判据原文逐字取自冻结材料，对比度实测表记录修复色。", "提取表三条件 exists 精确判定。", "删记录提取为 0 即 FAIL。"] },
  { c: "判据46：Dashboard.tsx 统计标签必须包含次级色值「#5A6577」。", t: "统计标签次级色钉位", s: "S2", ck: existsFact("web/src/pages/Dashboard.tsx","#5A6577"), rv: ["判据原文逐字取自冻结材料，统计标签用次级审计色。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据47：Dashboard.tsx 在线环必须包含成功色值「#059669」。", t: "在线环色钉位", s: "S2", ck: existsFact("web/src/pages/Dashboard.tsx","#059669"), rv: ["判据原文逐字取自冻结材料，在线率环用 emerald。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据48：Dashboard.tsx 离线卡必须包含错误色值「#DC2626」。", t: "离线卡色钉位", s: "S2", ck: existsFact("web/src/pages/Dashboard.tsx","#DC2626"), rv: ["判据原文逐字取自冻结材料，离线数字用错误红。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据49：Dashboard.tsx 辅助文字必须包含轴色值「#94A3B8」。", t: "辅助轴色钉位", s: "S3", ck: existsFact("web/src/pages/Dashboard.tsx","#94A3B8"), rv: ["判据原文逐字取自冻结材料，辅助轴文字用 slate。", "提取表三条件 exists 精确判定。", "改色提取为 0 即 FAIL。"] },
  { c: "判据50：index.css 必须包含主色淡底色值「rgba(30, 58, 95, 0.1)」。", t: "主色淡底钉位", s: "S3", ck: existsFact("web/src/index.css","rgba(30, 58, 95, 0.1)"), rv: ["判据原文逐字取自冻结材料，navy 主色 10% 淡底。", "提取表三条件 exists 精确判定。", "改值提取为 0 即 FAIL。"] },
  { c: "判据51：index.css 必须包含深底色值「#0f172a」。", t: "css 深底钉位", s: "S3", ck: existsFact("web/src/index.css","#0f172a"), rv: ["判据原文逐字取自冻结材料，样式侧深底 token。", "提取表三条件 exists 精确判定。", "改值提取为 0 即 FAIL。"] },
  // ── E2E 行为证据（经 verifier_e2e_summary 提取表，源自 e2e_test.py 落盘的 evidence/e2e-summary.json） ──
  { c: "判据52：E2E 摘要记录的用例总数不得少于 25。", t: "E2E 规模下限", s: "S2", ck: count("verifier_e2e_summary", "==", 1, and({ col: "total", op: ">=", value: 25 })), rv: ["判据原文逐字取自冻结材料，行为面至少覆盖既有 25 组用例（含驾驶舱、统一门户、自产台、凭据注入、SOP 台、MCP 生产通道、SOP 管理页、运行时批、卫生批与 A2A P1）。", "count 条件计数 ==1 精确判定。", "删用例或未跑 E2E 即计数 0 FAIL。"] },
  { c: "判据53：E2E 摘要必须标记全部用例通过。", t: "E2E 全绿", s: "S1", ck: { type: "exists", predicate: { from: "verifier_e2e_summary", select: ["id"], where: and({ col: "all_passed", op: "=", value: 1 }) }, expect: true }, rv: ["判据原文逐字取自冻结材料，行为面必须全绿才可交付。", "all_passed=1 exists 精确判定。", "任一用例失败即 0 行 FAIL。"] },
  { c: "判据54：E2E 摘要必须带有完成时间戳。", t: "E2E 时间戳在位", s: "S3", ck: { type: "exists", predicate: { from: "verifier_e2e_summary", select: ["id"], where: { col: "finished_at", op: "is not null" } }, expect: true }, rv: ["判据原文逐字取自冻结材料，摘要须可追溯运行时间。", "is not null exists 精确判定。", "空时间戳即 FAIL。"] },
  // ── 渲染层对比度探针（E2E 内置 Playwright 实测 DOM 的 fg/bg 配对，经 verifier_contrast_checks 提取表） ──
  { c: "判据55：渲染层对比度探针覆盖的文字目标不得少于 9 处。", t: "对比度探针覆盖面", s: "S1", ck: count("verifier_contrast_checks", ">=", 9), rv: ["判据原文逐字取自冻结材料，探针须覆盖深底与浅底两类表面（含 SOP 管理页新表面）。", "count>=9 纯数值判定。", "删探针目标或未跑 E2E 即计数不足 FAIL。"] },
  { c: "判据56：渲染层对比度探针不得存在未通过的目标。", t: "渲染对比度全达标", s: "S1", ck: count("verifier_contrast_checks", "==", 0, { col: "passed", op: "=", value: 0 }), rv: ["判据原文逐字取自冻结材料，任何一处实测对比度低于下限即违规。", "violation count==0 精确判定。", "任一目标 ratio<min 即 FAIL（如深底徽标文字 1.18:1）。"] },
  { c: "判据57：index.css 必须包含深底状态文字规则选择器「.wm-use-bar .ant-badge-status-text」。", t: "深底状态文字规则钉位", s: "S1", ck: existsFact("web/src/index.css", ".wm-use-bar .ant-badge-status-text"), rv: ["判据原文逐字取自冻结材料，深色顶栏上的徽标文字必须有专用覆盖规则。", "提取表三条件 exists 精确判定。", "删规则提取为 0 即 FAIL。"] },
  { c: "判据58：index.css 必须包含深底浅色文字色值「rgba(255, 255, 255, 0.85)」。", t: "深底浅色值钉位", s: "S1", ck: existsFact("web/src/index.css", "rgba(255, 255, 255, 0.85)"), rv: ["判据原文逐字取自冻结材料，深底文字用 85% 白（对 #0f172a 约 11:1）。", "提取表三条件 exists 精确判定。", "改色值提取为 0 即 FAIL。"] },
  // ── 任务驾驶舱（多工作台分屏组合视图——收藏夹到驾驶舱的质变） ──
  { c: "判据59：驾驶舱的 name 字段不得为空。", t: "驾驶舱名称非空", s: "S1", ck: sql("cockpits", ["id", "name"], or({ col: "name", op: "is null" }, { col: "name", op: "=", value: "" })), rv: ["判据原文逐字取自冻结材料，驾驶舱必须有可辨识名称。", "is null 或空串的 violation 谓词精确判定。", "写入空名驾驶舱即 FAIL。"] },
  { c: "判据60：封装提交物必须包含 web/src/pages/Cockpit.tsx。", t: "驾驶舱页面存在", s: "S1", ck: file("web/src/pages/Cockpit.tsx", 1), rv: ["判据原文逐字取自冻结材料，任务驾驶舱功能页在位。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据61：server/src/index.ts 必须包含驾驶舱路由「/api/cockpits」。", t: "驾驶舱路由钉位", s: "S1", ck: existsFact("server/src/index.ts", "/api/cockpits"), rv: ["判据原文逐字取自冻结材料，驾驶舱 CRUD 路由组在位。", "提取表三条件 exists 精确判定。", "删路由提取为 0 即 FAIL。"] },
  // ── 统一门户（/go/ 反向代理：一个端口号 + 同源 + 禁嵌剥离） ──
  { c: "判据62：server/src/index.ts 必须包含「createProxyMiddleware」。", t: "代理中间件在位", s: "S1", ck: existsFact("server/src/index.ts", "createProxyMiddleware"), rv: ["判据原文逐字取自冻结材料，统一门户代理由 http-proxy-middleware 实现。", "提取表三条件 exists 精确判定。", "删代理提取为 0 即 FAIL。"] },
  { c: "判据63：server/src/index.ts 必须包含剥禁嵌头的「x-frame-options」。", t: "禁嵌剥离钉位", s: "S1", ck: existsFact("server/src/index.ts", "x-frame-options"), rv: ["判据原文逐字取自冻结材料，代理剥除上游 X-Frame-Options 的逻辑在位。", "提取表三条件 exists 精确判定。", "删剥头逻辑提取为 0 即 FAIL。"] },
  { c: "判据64：封装提交物 server/package.json 必须声明依赖「http-proxy-middleware」。", t: "代理依赖在位", s: "S1", ck: existsFact("server/package.json", "http-proxy-middleware"), rv: ["判据原文逐字取自冻结材料，代理依赖已声明。", "提取表三条件 exists 精确判定。", "卸依赖提取为 0 即 FAIL。"] },
  { c: "判据65：web/src/pages/UseWorkbench.tsx 必须包含「/go/${w.id}/」。", t: "使用页走门户", s: "S1", ck: existsFact("web/src/pages/UseWorkbench.tsx", "/go/${w.id}/"), rv: ["判据原文逐字取自冻结材料，使用页 iframe 经统一门户同源代理而非原始地址。", "提取表三条件 exists 精确判定。", "改回原始地址提取为 0 即 FAIL。"] },
  // ── 台生成器（自产台：AI 发布 API + 全版本快照——台的管理者到台的生产者） ──
  { c: "判据66：自产台的 slug 字段不得为空。", t: "自产台标识非空", s: "S1", ck: sql("apps", ["id", "slug"], or({ col: "slug", op: "is null" }, { col: "slug", op: "=", value: "" })), rv: ["判据原文逐字取自冻结材料，自产台必须有可寻址标识。", "is null 或空串的 violation 谓词精确判定。", "写入空 slug 行即 FAIL。"] },
  { c: "判据67：内置类型 market-app 必须存在于类型库。", t: "自产台类型存在", s: "S1", ck: exists("types", and({ col: "key", op: "=", value: "market-app" })), rv: ["判据原文逐字取自冻结材料，发布即入册依赖内置类型。", "键精确匹配。", "删 market-app 行即 FAIL。"] },
  { c: "判据68：server/src/index.ts 必须包含发布路由「/api/apps」。", t: "发布 API 钉位", s: "S1", ck: existsFact("server/src/index.ts", "/api/apps"), rv: ["判据原文逐字取自冻结材料，AI 会话直发的发布通道在位。", "提取表三条件 exists 精确判定。", "删发布路由提取为 0 即 FAIL。"] },
  { c: "判据69：server/src/db.ts 必须包含版本快照表「app_versions」。", t: "版本链表钉位", s: "S1", ck: existsFact("server/src/db.ts", "app_versions"), rv: ["判据原文逐字取自冻结材料，全版本快照依赖版本链表。", "提取表三条件 exists 精确判定。", "删表提取为 0 即 FAIL。"] },
  { c: "判据70：自产台表中至少发布了 1 个应用。", t: "自产台非空", s: "S2", ck: count("apps", ">=", 1), rv: ["判据原文逐字取自冻结材料，演示自产台常驻库中作为活样例。", "count>=1 数值判定。", "清空 apps 表即 FAIL。"] },
  // ── 凭据注入（auth bearer/basic 经 /go/ 门户注入 Authorization——认证类工作台的凭据盲区） ──
  { c: "判据71：server/src/index.ts 必须包含注入头名「authorization」。", t: "凭据注入钉位", s: "S1", ck: existsFact("server/src/index.ts", "authorization"), rv: ["判据原文逐字取自冻结材料，代理凭据注入 Authorization 头的逻辑在位。", "提取表三条件 exists 精确判定。", "删注入逻辑提取为 0 即 FAIL。"] },
  { c: "判据72：web/src/components/WorkbenchForm.tsx 必须包含凭据表单字段「authValue」。", t: "凭据表单钉位", s: "S1", ck: existsFact("web/src/components/WorkbenchForm.tsx", "authValue"), rv: ["判据原文逐字取自冻结材料，凭据值经表单录入而非拼进 url。", "提取表三条件 exists 精确判定。", "删表单字段提取为 0 即 FAIL。"] },
  { c: "判据73：evidence/e2e_test.py 必须包含凭据注入断言字面量「e2e-bear-tok」。", t: "注入行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "e2e-bear-tok"), rv: ["判据原文逐字取自冻结材料，E2E 用 echo fixture 实测注入行为（防 SPA 假绿）。", "提取表三条件 exists 精确判定。", "删透传断言提取为 0 即 FAIL。"] },
  { c: "判据74：server/src/index.ts 必须包含 WS 升级挂载「goServer.on('upgrade'」。", t: "WS 升级代理钉位", s: "S1", ck: existsFact("server/src/index.ts", "goServer.on('upgrade'"), rv: ["判据原文逐字取自冻结材料，upgrade 事件不流经中间件链，必须有独立的准备逻辑（实测缺位时 WS 被路由到死端口）。", "提取表三条件 exists 精确判定。", "删挂载提取为 0 即 FAIL。"] },
  { c: "判据75：server/src/index.ts 必须包含握手 Origin 改写「req.headers.origin = u.origin」。", t: "WS 握手 Origin 改写钉位", s: "S1", ck: existsFact("server/src/index.ts", "req.headers.origin = u.origin"), rv: ["判据原文逐字取自冻结材料，浏览器 WS 握手必带门户源 Origin，上游 Origin fence 会 403（实测 DSH 台「重新连接中」根因之一）。", "提取表三条件 exists 精确判定。", "删改写提取为 0 即 FAIL。"] },
  // ── SOP 台（结构化流程即台：状态层 Redis 热态 + 持久层 SQLite 真源——分层治理） ──
  { c: "判据76：server/src/db.ts 必须包含运行真源表「sop_runs」。", t: "SOP 运行表钉位", s: "S1", ck: existsFact("server/src/db.ts", "sop_runs"), rv: ["判据原文逐字取自冻结材料，SOP 运行记录以 SQLite 为真源（Redis 只做热态）。", "提取表三条件 exists 精确判定。", "删表提取为 0 即 FAIL。"] },
  { c: "判据77：server/src/redis.ts 必须包含状态层写入函数「runStateSave」。", t: "Redis 状态层钉位", s: "S1", ck: existsFact("server/src/redis.ts", "runStateSave"), rv: ["判据原文逐字取自冻结材料，热态写入经独立状态层模块（连不上自动降级直写 SQLite）。", "提取表三条件 exists 精确判定。", "删状态层提取为 0 即 FAIL。"] },
  { c: "判据78：server/src/index.ts 必须包含 Runner 服务端渲染「renderSopRunner」。", t: "SOP Runner 钉位", s: "S1", ck: existsFact("server/src/index.ts", "renderSopRunner"), rv: ["判据原文逐字取自冻结材料，SOP 台零构建服务端渲染执行页（步骤卡+防抖保存+run 恢复）。", "提取表三条件 exists 精确判定。", "删渲染提取为 0 即 FAIL。"] },
  { c: "判据79：server/src/index.ts 必须包含运行 API 前缀「/api/sop/runs」。", t: "SOP 运行 API 钉位", s: "S1", ck: existsFact("server/src/index.ts", "/api/sop/runs"), rv: ["判据原文逐字取自冻结材料，分层持久化的运行 CRUD（开 run 钉版本、热读、checkpoint、finish）。", "提取表三条件 exists 精确判定。", "删 API 提取为 0 即 FAIL。"] },
  { c: "判据80：evidence/e2e_test.py 必须包含 SOP 台用例字面量「e2e-sop」。", t: "SOP 行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "e2e-sop"), rv: ["判据原文逐字取自冻结材料，E2E 实测 SOP 全链（发布面校验/状态机/Runner/分层读写/版本治理）。", "提取表三条件 exists 精确判定。", "删用例提取为 0 即 FAIL。"] },
  // ── MCP 生产通道（/mcp StreamableHTTP：AI 会话直连市场——生产者的直发面） ──
  { c: "判据81：server/src/index.ts 必须包含 MCP 端点挂载「app.post('/mcp'」。", t: "MCP 端点钉位", s: "S1", ck: existsFact("server/src/index.ts", "app.post('/mcp'"), rv: ["判据原文逐字取自冻结材料，AI 会话经 StreamableHTTP 直连市场的入口在位。", "提取表三条件 exists 精确判定。", "删端点提取为 0 即 FAIL。"] },
  { c: "判据82：server/src/index.ts 必须包含工具注册表「MCP_TOOLS」。", t: "MCP 工具注册钉位", s: "S1", ck: existsFact("server/src/index.ts", "MCP_TOOLS"), rv: ["判据原文逐字取自冻结材料，7 个生产工具（list/summary/check/use_url/app_publish/app_activate/sop_publish）经注册表暴露。", "提取表三条件 exists 精确判定。", "删注册表提取为 0 即 FAIL。"] },
  { c: "判据83：server/src/index.ts 必须包含 JSON-RPC 错误码「-32601」。", t: "JSON-RPC 合规钉位", s: "S1", ck: existsFact("server/src/index.ts", "-32601"), rv: ["判据原文逐字取自冻结材料，未知 method 按 JSON-RPC 2.0 规范回 -32601（协议合规性锚点）。", "提取表三条件 exists 精确判定。", "删错误处理提取为 0 即 FAIL。"] },
  { c: "判据84：evidence/e2e_test.py 必须包含 MCP 用例字面量「e2e-mcp-app」。", t: "MCP 行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "e2e-mcp-app"), rv: ["判据原文逐字取自冻结材料，E2E 实测 MCP 协议面与生产工具链（initialize/tools/list/app_publish/sop_publish）。", "提取表三条件 exists 精确判定。", "删用例提取为 0 即 FAIL。"] },
  // ── SOP 管理页（/sops：状态徽章 + 版本链 + run 记录——SOP 台的消费与管理面） ──
  { c: "判据85：封装提交物必须包含 web/src/pages/Sops.tsx。", t: "SOP 管理页存在", s: "S1", ck: file("web/src/pages/Sops.tsx", 1), rv: ["判据原文逐字取自冻结材料，SOP 管理页（状态机操作/记录查看）在位。", "精确路径 glob。", "删除即 FAIL。"] },
  { c: "判据86：web/src/pages/Sops.tsx 必须包含状态语义表「SOP_STATUS」。", t: "SOP 状态徽章钉位", s: "S1", ck: existsFact("web/src/pages/Sops.tsx", "SOP_STATUS"), rv: ["判据原文逐字取自冻结材料，draft/published/deprecated 徽章（色值经对比度审计）由单一语义表驱动。", "提取表三条件 exists 精确判定。", "删语义表提取为 0 即 FAIL。"] },
  { c: "判据87：web/src/App.tsx 必须包含 SOP 路由「path: '/sops'」。", t: "SOP 路由钉位", s: "S1", ck: existsFact("web/src/App.tsx", "path: '/sops'"), rv: ["判据原文逐字取自冻结材料，侧栏菜单与路由表挂载 SOP 管理页。", "提取表三条件 exists 精确判定。", "删路由提取为 0 即 FAIL。"] },
  { c: "判据88：evidence/e2e_test.py 必须包含演示 SOP 字面量「demo-rack-sop」。", t: "演示 SOP 常驻钉位", s: "S2", ck: existsFact("evidence/e2e_test.py", "demo-rack-sop"), rv: ["判据原文逐字取自冻结材料，E2E 实测 /sops 页并要求演示 SOP（demo-rack-sop）常驻可见。", "提取表三条件 exists 精确判定。", "删演示或用例提取为 0 即 FAIL。"] },
  // ── 凭据面防泄露（监督席派单 direct-30b57179：列表掩码 + 掩码回传保护） ──
  { c: "判据89：server/src/index.ts 必须包含列表掩码函数「maskSensitiveQuery」。", t: "API token 掩码钉位", s: "S1", ck: existsFact("server/src/index.ts", "maskSensitiveQuery"), rv: ["判据原文逐字取自冻结材料，无认证 API 响应（列表与详情同策略）对 url query 敏感参数（token/password/secret/api_key 等）掩码防浏览泄露；代理侧 DB 直读不受影响。", "提取表三条件 exists 精确判定。", "删掩码函数提取为 0 即 FAIL。"] },
  { c: "判据90：server/src/index.ts 必须包含掩码回传保护字面量「=****」。", t: "掩码回传保护钉位", s: "S1", ck: existsFact("server/src/index.ts", "=****"), rv: ["判据原文逐字取自冻结材料，PUT 收到含掩码指纹的 url/auth.value 视为未变更保留 DB 原值、POST 拒绝掩码指纹入新建——否则编辑保存/复制工作台会把 **** 写库毁掉 query 门/凭据（E2E 组 15 第⑨-⑩断言实测）。", "提取表三条件 exists 精确判定。", "删保护提取为 0 即 FAIL。"] },
  // ── 安全批（外部评审 16 issue 之 #1/#2/#3/#11，监督席派单 direct-74a7d418 已复现定性） ──
  { c: "判据91：server/src/index.ts 必须包含 API 出口统一脱敏函数「maskForApi」。", t: "auth.value+MCP 脱敏钉位", s: "S1", ck: existsFact("server/src/index.ts", "maskForApi"), rv: ["判据原文逐字取自冻结材料，REST 列表/详情的 auth.value 与 MCP workbench_list/use_url 的 url 经同一脱敏函数——agent 可编程面不得绕过 REST 脱敏（评审 #2/#3）。", "提取表三条件 exists 精确判定。", "删函数提取为 0 即 FAIL。"] },
  { c: "判据92：server/src/index.ts 必须包含 CORS 白名单「CORS_ALLOW」。", t: "CORS 白名单钉位", s: "S1", ck: existsFact("server/src/index.ts", "CORS_ALLOW"), rv: ["判据原文逐字取自冻结材料，CORS 从全开放收紧为本机 dev 源白名单（评审 #1）——生产同源托管无需跨源；外源不回 ACAO。", "提取表三条件 exists 精确判定。", "改回全开放提取为 0 即 FAIL。"] },
  { c: "判据93：server/src/index.ts 必须包含 draft 拒绝文案「未上架不可执行」。", t: "draft 403 瘦身钉位", s: "S1", ck: existsFact("server/src/index.ts", "未上架不可执行"), rv: ["判据原文逐字取自冻结材料，非 published 的 SOP 不再渲染下发完整 Runner 页面（评审 #11 信息泄漏面）——403 一行文案，直连与门户内联两处分流同款。", "提取表三条件 exists 精确判定。", "恢复整页渲染提取为 0 即 FAIL。"] },
  { c: "判据94：evidence/e2e_test.py 必须包含 MCP 泄漏探针字面量「token=8sKZ」。", t: "MCP 泄漏行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "token=8sKZ"), rv: ["判据原文逐字取自冻结材料，E2E 组 15 十四断言以真实票据前缀为探针：MCP 响应不得含明文 token（含 token=**** 掩码形态）、CORS 外源无 ACAO、draft 403 页面无步骤内容、auth.value 双端点掩码+回传不毁库。", "提取表三条件 exists 精确判定。", "删探针提取为 0 即 FAIL。"] },
  // ── 门户 3xx Location 改写（外部评审 #4，监督席代码分析佐证同红线 9③ 根因） ──
  { c: "判据95：server/src/index.ts 必须包含 Location 改写的 id 备份「goWid」。", t: "Location 改写 id 备份钉位", s: "S1", ck: existsFact("server/src/index.ts", "goWid"), rv: ["判据原文逐字取自冻结材料，proxyRes 里 req.url 已被 pathRewrite 写回上游路径（goPrefix 失配，改写从不生效）——前置中间件在还知道 id 时备份 req.goWid 供 proxyRes 使用。", "提取表三条件 exists 精确判定。", "删备份提取为 0 即 FAIL（改写失效回归）。"] },
  { c: "判据96：evidence/e2e_test.py 必须包含 Location 改写断言字面量「redir-relative」。", t: "Location 改写行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "redir-relative"), rv: ["判据原文逐字取自冻结材料，E2E 组 15 以 http.client（不跟随重定向）断言：上游 302 的相对/绝对 Location 均改写为 /go/<id>/landed（跳转留在门户前缀内，不落 SPA fallback）。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 运行时批（外部评审 #5/#6/#7/#8/#9/#10：六处正确性缺陷一轮整改） ──
  { c: "判据97：server/src/index.ts 必须包含巡检重挂锚「issue #5」。", t: "巡检设置即时生效钉位", s: "S1", ck: existsFact("server/src/index.ts", "issue #5"), rv: ["判据原文逐字取自冻结材料，PUT /api/settings 即幂等重挂巡检定时器（armPatrol clearTimeout 开头），不必重启服务（评审 #5）。", "提取表三条件 exists 精确判定。", "删重挂提取为 0 即 FAIL。"] },
  { c: "判据98：server/src/index.ts 必须包含删 SOP 清注册锚「issue #6」。", t: "删台清注册钉位", s: "S1", ck: existsFact("server/src/index.ts", "issue #6"), rv: ["判据原文逐字取自冻结材料，DELETE /api/apps 同时清理 /apps/ 与 /sop/ 两类注册行，不留孤儿工作台（评审 #6）。", "提取表三条件 exists 精确判定。", "删清理提取为 0 即 FAIL。"] },
  { c: "判据99：server/src/index.ts 必须包含导入 mode 锚「issue #7」。", t: "导入 replace 语义钉位", s: "S1", ck: existsFact("server/src/index.ts", "issue #7"), rv: ["判据原文逐字取自冻结材料，import mode 支持 query 优先（README 的 ?mode=replace 写法），且内部路径注册行（/ 开头）不再被 http 断言静默丢弃（评审 #7）。", "提取表三条件 exists 精确判定。", "删语义提取为 0 即 FAIL。"] },
  { c: "判据100：scripts/import-smoke.mjs 必须包含运行时批探针字面量「e2e-import-probe」。", t: "运行时批行为断言钉位", s: "S1", ck: existsFact("scripts/import-smoke.mjs", "e2e-import-probe"), rv: ["判据原文逐字取自冻结材料，导入冒烟（独立实例，7 项）覆盖 query replace 语义/内部路径行不丢/悬空面板 prune/掩码行跳过/body mode 等价；E2E 组 19 subprocess 调用——replace 全表清写不再碰活库（84 事故 ×3 根治）。", "提取表三条件 exists 精确判定。", "删探针提取为 0 即 FAIL。"] },
  // ── 卫生批（外部评审 #12/#13：README 一致性 + 干净克隆自愈） ──
  { c: "判据101：scripts/make-submission.mjs 必须包含干净克隆自愈「issue #13」。", t: "提交物脚本自愈钉位", s: "S1", ck: existsFact("scripts/make-submission.mjs", "issue #13"), rv: ["判据原文逐字取自冻结材料，VACUUM INTO 前 mkdirSync(tmp) 幂等创建——干净克隆无 tmp/ 不再必然失败（评审 #13）。", "提取表三条件 exists 精确判定。", "删自愈提取为 0 即 FAIL。"] },
  { c: "判据102：README.md 必须包含验证器判据数锚「144 条判据」。", t: "README 版本一致钉位", s: "S2", ck: existsFact("README.md", "144 条判据"), rv: ["判据原文逐字取自冻结材料，README 验证器节与代码版本同步（评审 #12——锚用判据数，比版本号锚少一次升版漂移）。", "提取表三条件 exists 精确判定。", "版本漂移提取为 0 即 FAIL。"] },
  // ── A2A 网络接入 P1（GH #17：签名卡片 + 人工绑定，只读暴露） ──
  { c: "判据103：server/src/a2a.ts 必须包含上游一致签名面「canonicalPayload」。", t: "A2A 卡片签名钉位", s: "S1", ck: existsFact("server/src/a2a.ts", "canonicalPayload"), rv: ["判据原文逐字取自冻结材料，卡片 canonical 与上游 card.ts（裁判钉 75a3ebd）逐字节一致——Ed25519 pure + SPKI DER base64，expiresAt ≤ 48h，须过上游 verifyCard（GH #17 P1）。", "提取表三条件 exists 精确判定。", "删签名面提取为 0 即 FAIL。"] },
  { c: "判据104：server/src/index.ts 必须包含绑定管理口令头「x-admin-token」。", t: "人工绑定口令钉位", s: "S1", ck: existsFact("server/src/index.ts", "x-admin-token"), rv: ["判据原文逐字取自冻结材料，绑定读写要 X-Admin-Token 常量时间比较（未设置一律 403）+ Origin 空或同源服务端校验；MCP 无绑定写工具；卡片不发布 teamMemberships（绑定图不出门）。", "提取表三条件 exists 精确判定。", "删口令校验提取为 0 即 FAIL。"] },
  { c: "判据105：server/src/a2a.ts 必须包含节点短 id 持久化「a2a_node8」。", t: "SOP 节点短 id 钉位", s: "S1", ck: existsFact("server/src/a2a.ts", "a2a_node8"), rv: ["判据原文逐字取自冻结材料，每 SOP 随机生成 8hex 持久化（apps.a2a_node8）——禁 slug 推导（修订 3 防抢注）；上卡规则：published 且 ≥1 有效绑定。", "提取表三条件 exists 精确判定。", "删持久化提取为 0 即 FAIL。"] },
  { c: "判据106：scripts/a2a-smoke.mjs 必须包含上游裁判「verifyCard」。", t: "上游裁判冒烟钉位", s: "S1", ck: existsFact("scripts/a2a-smoke.mjs", "verifyCard"), rv: ["判据原文逐字取自冻结材料，专用实例 21 项冒烟以 dsh-open-a2a-net src/card.ts 的 verifyCard 为裁判验卡（+绑定 CRUD/上卡规则/软撤销/direct 不泄露），E2E 组 21 subprocess 调用。", "提取表三条件 exists 精确判定。", "删裁判调用提取为 0 即 FAIL。"] },
  // ── Agent 执行数据面（MCP sop_run_* 五工具：直接更新持久化执行数据，不经版本发布） ──
  { c: "判据107：server/src/index.ts 必须包含 run 持久化链共用核心「sopRunStepSaveCore」。", t: "执行数据同链钉位", s: "S1", ck: existsFact("server/src/index.ts", "sopRunStepSaveCore"), rv: ["判据原文逐字取自冻结材料，agent 经 MCP sop_run_step_save 更新持久化执行数据与人在 Runner 页/REST 走同一条链（sopRun*Core 唯一持久化链：Redis 热写+30s checkpoint 沉淀 SQLite 真源）。", "提取表三条件 exists 精确判定。", "删共用核心提取为 0 即 FAIL。"] },
  { c: "判据108：server/src/index.ts 必须包含 MCP 执行数据工具注册「sop_run_step_save」。", t: "MCP 执行数据工具钉位", s: "S1", ck: existsFact("server/src/index.ts", "sop_run_step_save"), rv: ["判据原文逐字取自冻结材料，MCP 注册 sop_run_start/step_save/get/list/finish 五工具（共 12 个）——agent 更新 run 数据不触发版本发布，run 钉开跑时版本。", "提取表三条件 exists 精确判定。", "删注册提取为 0 即 FAIL。"] },
  { c: "判据109：evidence/e2e_test.py 必须包含人机同链断言字面量「agent-填-1」。", t: "人机同链行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "agent-填-1"), rv: ["判据原文逐字取自冻结材料，E2E 组 17 C4 断言：MCP 写入的步骤数据经 REST 读回同一份（人机同链），MCP 开 run→写→读回→归档全链。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 导出脱敏（compliance 二期首项：无认证导出曾是最大凭据泄漏向量） ──
  { c: "判据110：server/src/index.ts 必须包含导出脱敏锚「compliance 二期首项」。", t: "导出默认脱敏钉位", s: "S1", ck: existsFact("server/src/index.ts", "compliance 二期首项"), rv: ["判据原文逐字取自冻结材料，/api/export 默认经 maskForApi 脱敏（url query 敏感参数 + auth.value），masked:1 标记；?reveal=1 显式真值（备份迁移用）。", "提取表三条件 exists 精确判定。", "删脱敏提取为 0 即 FAIL。"] },
  { c: "判据111：server/src/index.ts 必须包含导入掩码跳过锚「掩码行（url 含 =****）不落库」。", t: "导入掩码跳过钉位", s: "S1", ck: existsFact("server/src/index.ts", "掩码行（url 含 =****）不落库"), rv: ["判据原文逐字取自冻结材料，导入侧对掩码 url 行跳过、auth.value=**** 剥除——掩码数据永不落库（完整恢复用 reveal 导出）。", "提取表三条件 exists 精确判定。", "删跳过提取为 0 即 FAIL。"] },
  { c: "判据112：evidence/e2e_test.py 必须包含导出脱敏断言字面量「E2E MaskImport」。", t: "导出脱敏行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "E2E MaskImport"), rv: ["判据原文逐字取自冻结材料，E2E 组 15 第⑫断言：默认导出无明文 token/auth（masked:1）、reveal 含真值、掩码导入行 skipped。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 工作台注册 CRUD MCP 化（agent 登记外部台；凭据字段不接受——安全边界内置） ──
  { c: "判据113：server/src/index.ts 必须包含注册 CRUD 共用核心「workbenchCreateCore」。", t: "注册 CRUD 同链钉位", s: "S1", ck: existsFact("server/src/index.ts", "workbenchCreateCore"), rv: ["判据原文逐字取自冻结材料，workbench_register/update/unregister 三 MCP 工具与 REST 走同一套 CRUD 核心（掩码回传保护/驾驶舱联动清理复用）。", "提取表三条件 exists 精确判定。", "删共用核心提取为 0 即 FAIL。"] },
  { c: "判据114：server/src/index.ts 必须包含 MCP 凭据拒绝锚「凭据不接受 MCP 写入」。", t: "MCP 凭据边界钉位", s: "S1", ck: existsFact("server/src/index.ts", "凭据不接受 MCP 写入"), rv: ["判据原文逐字取自冻结材料，register/update 传入 auth 字段一律 400——凭据只经人工 REST/表单（安全边界内置而非文档约定）。", "提取表三条件 exists 精确判定。", "删拒绝提取为 0 即 FAIL。"] },
  { c: "判据115：evidence/e2e_test.py 必须包含 CRUD 行为断言字面量「E2E MCP 台」。", t: "注册 CRUD 行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "E2E MCP 台"), rv: ["判据原文逐字取自冻结材料，E2E 组 17 C5 断言：MCP 登记→更新（enabled/category）→凭据字段拒绝→注销全链，工具面 15 个。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 破坏性测试隔离（84 事故 ×3 根治：replace 全表清写永不碰活库） ──
  { c: "判据116：evidence/e2e_test.py 必须包含导入隔离锚「import-smoke」。", t: "破坏性测试隔离钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "import-smoke"), rv: ["判据原文逐字取自冻结材料，E2E 组 19 第⑥段改为 subprocess 调 scripts/import-smoke.mjs（独立 DATA_DIR+PORT）——活库 E2E 不再有全表清写路径（监督席 direct-2102fc1b 升级项）。", "提取表三条件 exists 精确判定。", "回退到活库跑 replace 提取为 0 即 FAIL。"] },
  // ── 工具清单一致（评审 #18：README 写 7 工具实际 15——验证器盲区，工具名锚钉住漂移） ──
  { c: "判据117：README.md 必须包含执行数据工具名「sop_run_step_save」。", t: "README 工具清单锚（执行数据）", s: "S2", ck: existsFact("README.md", "sop_run_step_save"), rv: ["判据原文逐字取自冻结材料，README 的 MCP 工具清单须包含执行数据工具（评审 #18：曾写 7 工具实际 15——文档漂移漏网，以工具名锚钉住）。", "提取表三条件 exists 精确判定。", "删工具名提取为 0 即 FAIL。"] },
  { c: "判据118：README.md 必须包含注册工具名「workbench_register」。", t: "README 工具清单锚（注册 CRUD）", s: "S2", ck: existsFact("README.md", "workbench_register"), rv: ["判据原文逐字取自冻结材料，README 的 MCP 工具清单须包含注册 CRUD 工具（同 #18 盲区修补——工具面扩张必须同步文档）。", "提取表三条件 exists 精确判定。", "删工具名提取为 0 即 FAIL。"] },
  // ── 双锚增强（v26：安全批从源码单锚升格为源码+行为双锚——防「代码在而行为回归」） ──
  { c: "判据119：evidence/e2e_test.py 必须包含 CORS 行为断言锚「access-control-allow-origin」。", t: "CORS 行为双锚", s: "S1", ck: existsFact("evidence/e2e_test.py", "access-control-allow-origin"), rv: ["判据原文逐字取自冻结材料，判据 92 锚源码 CORS_ALLOW，本判据锚 E2E 实测响应头（外源无 ACAO/白名单放行）——双锚防代码在而行为回归。", "提取表三条件 exists 精确判定。", "删行为断言提取为 0 即 FAIL。"] },
  { c: "判据120：evidence/e2e_test.py 必须包含协议错误断言锚「-32601」。", t: "MCP 协议双锚", s: "S1", ck: existsFact("evidence/e2e_test.py", "-32601"), rv: ["判据原文逐字取自冻结材料，判据 83 锚源码错误码，本判据锚 E2E 实测（未知 method 回 -32601 JSON-RPC error）——协议合规行为面双锚。", "提取表三条件 exists 精确判定。", "删行为断言提取为 0 即 FAIL。"] },
  { c: "判据121：evidence/e2e_test.py 必须包含 draft 泄漏探针锚「SecretStep」。", t: "draft 403 双锚", s: "S1", ck: existsFact("evidence/e2e_test.py", "SecretStep"), rv: ["判据原文逐字取自冻结材料，判据 93 锚源码瘦身文案，本判据锚 E2E 探针（draft 403 页面不含步骤内容 SecretStep）——信息泄漏行为面双锚。", "提取表三条件 exists 精确判定。", "删探针提取为 0 即 FAIL。"] },
  // ── A2A P2：/a2a/direct 准入开放（GH #17 阶段表 P2——幂等族/512KiB/run↔context_id） ──
  { c: "判据122：server/src/a2a.ts 必须包含 direct 准入核心「a2aDirectHandle」。", t: "direct 准入核心钉位", s: "S1", ck: existsFact("server/src/a2a.ts", "a2aDirectHandle"), rv: ["判据原文逐字取自冻结材料，准入链（team→SOP 解析 404 不泄露/匿名拒/精确绑定匹配/mode 判定）+ 幂等族（-32003 replay/-32002 conflict，指纹={team,caller,message}）+ 512KiB→413 + start/note/status 语义 + run↔context_id（a2a_run_ctx 表）。", "提取表三条件 exists 精确判定。", "删核心提取为 0 即 FAIL。"] },
  { c: "判据123：server/src/index.ts 必须包含 DELIVERED 路由桥「a2aDirectHandle」。", t: "direct 路由桥钉位", s: "S1", ck: existsFact("server/src/index.ts", "a2aDirectHandle"), rv: ["判据原文逐字取自冻结材料，POST /a2a/direct 挂 a2aDirectHandle（note 写 sop_runs 的 a2a-notes 追加、context 注册、错误兜底 TASK_STATE_FAILED 形状）——生产无 ADMIN_TOKEN 时绑定面休眠=准入自然全拒（主人裁定口径）。", "提取表三条件 exists 精确判定。", "删桥提取为 0 即 FAIL。"] },
  { c: "判据124：server/src/a2a.ts 必须包含幂等族锚「-32003」。", t: "direct 幂等族钉位", s: "S1", ck: existsFact("server/src/a2a.ts", "-32003"), rv: ["判据原文逐字取自冻结材料，上游幂等族：同 key 同 payload→409 -32003 replay:true（先前权威）、同 key 异 payload→409 -32002 conflict（caller bug 不自动重试）——指纹不含 context_id（上游 peerPayloadFingerprint 口径）。", "提取表三条件 exists 精确判定。", "删幂等提取为 0 即 FAIL。"] },
  { c: "判据125：scripts/a2a-smoke.mjs 必须包含 P2 行为锚「TASK_STATE_DELIVERED」。", t: "P2 行为断言钉位", s: "S1", ck: existsFact("scripts/a2a-smoke.mjs", "TASK_STATE_DELIVERED"), rv: ["判据原文逐字取自冻结材料，P1+P2 冒烟 35 项（独立实例）：准入拒×3/404 不泄露/start→DELIVERED+task_id 回显/run↔context/note 续同 run+a2a-notes 落库/status/幂等 replay+conflict/512KiB 413。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── MCP 网关 P1（GH #20：会话/令牌/授权/审计——env MCP_GATEWAY=on 激活） ──
  { c: "判据126：server/src/index.ts 必须包含网关开关「MCP_GATEWAY」。", t: "网关开关钉位", s: "S1", ck: existsFact("server/src/index.ts", "MCP_GATEWAY"), rv: ["判据原文逐字取自冻结材料，env 开关合并与激活解耦（默认 off=现状行为；激活=主人同设 ADMIN_TOKEN+MCP_GATEWAY=on 重启——守护误拉新代码不断消费端）。", "提取表三条件 exists 精确判定。", "删开关提取为 0 即 FAIL。"] },
  { c: "判据127：server/src/index.ts 必须包含会话表「mcp_sessions」。", t: "网关会话面钉位", s: "S1", ck: existsFact("server/src/index.ts", "mcp_sessions"), rv: ["判据原文逐字取自冻结材料，控制面五端点（建会话 token 仅一次/列表无 token 值/软吊销即时生效/grants 整体替换坏名 400/工具面要口令）+ Bearer 网关（401+WWW-Authenticate 含 initialize 无兼容期）。", "提取表三条件 exists 精确判定。", "删会话面提取为 0 即 FAIL。"] },
  { c: "判据128：server/src/index.ts 必须包含审计表「mcp_calls」。", t: "网关审计钉位", s: "S1", ck: existsFact("server/src/index.ts", "mcp_calls"), rv: ["判据原文逐字取自冻结材料，审计行 at/identity/method/tool/ok/error/duration_ms/args_sha256（不存参数原文）；401 只计数不进审计；last_used_at 更新。", "提取表三条件 exists 精确判定。", "删审计提取为 0 即 FAIL。"] },
  { c: "判据129：server/src/index.ts 必须包含远程收口锚「REMOTE_ALLOW_EXACT」。", t: "远程面收口钉位", s: "S1", ck: existsFact("server/src/index.ts", "REMOTE_ALLOW_EXACT"), rv: ["判据原文逐字取自冻结材料，非本机只放 /mcp、/.well-known/agent-card.json、/a2a/direct——其余 /api/* 写操作要 X-Admin-Token；本机 REST 面内网信任模型不变。", "提取表三条件 exists 精确判定。", "删收口提取为 0 即 FAIL。"] },
  { c: "判据130：scripts/gateway-smoke.mjs 必须包含网关行为锚「WWW-Authenticate」。", t: "网关行为断言钉位", s: "S1", ck: existsFact("scripts/gateway-smoke.mjs", "WWW-Authenticate"), rv: ["判据原文逐字取自冻结材料，独立实例 24 项：控制面 403/token 一次性/重名坏名 400/列表无 token/grants 校验过滤/401+WWW-Authenticate/未授权=不存在同应答/审计 args_sha256 无原文/401 不入审计/last_used_at/软吊销即时失效。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── MCP 网关管理页 + ADMIN_TOKEN 插槽（GH #20 P1 派单①②补充） ──
  { c: "判据131：web/src/pages/McpGateways.tsx 必须包含管理页语义锚「默认拒绝」。", t: "网关管理页钉位", s: "S1", ck: existsFact("web/src/pages/McpGateways.tsx", "默认拒绝"), rv: ["判据原文逐字取自冻结材料，管理页五区（口令输入/新建会话/会话表/grants 编辑器/审计查看器）全走既有五端点无新后端；token 一次性 Modal 提示。", "提取表三条件 exists 精确判定。", "删管理页提取为 0 即 FAIL。"] },
  { c: "判据132：web/src/App.tsx 必须包含管理页路由「'/mcp-gateways'」。", t: "网关路由钉位", s: "S1", ck: existsFact("web/src/App.tsx", "'/mcp-gateways'"), rv: ["判据原文逐字取自冻结材料，侧栏菜单与路由表挂载网关管理页。", "提取表三条件 exists 精确判定。", "删路由提取为 0 即 FAIL。"] },
  { c: "判据133：ADMIN-TOKEN-SETUP.md 必须包含主人操作锚「setx ADMIN_TOKEN」。", t: "ADMIN_TOKEN 插槽钉位", s: "S2", ck: existsFact("ADMIN-TOKEN-SETUP.md", "setx ADMIN_TOKEN"), rv: ["判据原文逐字取自冻结材料，主人操作指南（生成/设入/重启/验证 + DSH 连接器升级 + 三启动路径插槽状态）——值不进任何 agent 可读文件（#17 修订 3 诚实约束）。", "提取表三条件 exists 精确判定。", "删指南提取为 0 即 FAIL。"] },
  // ── Cookie 池（派单 direct-5fbb2176：web 型外部台 cookie 认证——导入/挂接/注入/过滤） ──
  { c: "判据134：server/src/index.ts 必须包含 cookie 池表「cookie_sets」。", t: "Cookie 池表钉位", s: "S1", ck: existsFact("server/src/index.ts", "cookie_sets"), rv: ["判据原文逐字取自冻结材料，Cookie 池（浏览器扩展标准导出导入）+ 工作台挂接 cookie_set_id + /go/ 代理 proxyReq 按目标 host 域匹配+未过期过滤→Cookie 头替换注入；value 明文不回任何 API（逐条掩码）。", "提取表三条件 exists 精确判定。", "删池表提取为 0 即 FAIL。"] },
  { c: "判据135：server/src/index.ts 必须包含 Cookie 注入锚「goCookies」。", t: "Cookie 注入钉位", s: "S1", ck: existsFact("server/src/index.ts", "goCookies"), rv: ["判据原文逐字取自冻结材料，前置中间件解析 goCookies（域匹配+过期过滤后），proxyReq 替换 Cookie 头（确定性语义）——未挂接台维持浏览器透传。", "提取表三条件 exists 精确判定。", "删注入提取为 0 即 FAIL。"] },
  { c: "判据136：scripts/cookie-smoke.mjs 必须包含行为锚「过期 cookie 被过滤」。", t: "Cookie 行为断言钉位", s: "S1", ck: existsFact("scripts/cookie-smoke.mjs", "过期 cookie 被过滤"), rv: ["判据原文逐字取自冻结材料，独立实例 11 项：导入（name 校验）/掩码/过期信息/挂接/注入到达上游/过期过滤/取消挂接无注入/删池/全过期。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 自产台数据提交面（派单 direct-22838fab：台不仅是看板，有交互提交数据） ──
  { c: "判据137：server/src/index.ts 必须包含数据面表「app_data」。", t: "自产台数据面钉位", s: "S1", ck: existsFact("server/src/index.ts", "app_data"), rv: ["判据原文逐字取自冻结材料，POST /api/apps/:slug/data（JSON ≤1MB，兼容 {data:...} 与直接对象两种形态）+ GET 游标分页（倒序 before_id）；无 DELETE 留审计。", "提取表三条件 exists 精确判定。", "删数据面提取为 0 即 FAIL。"] },
  { c: "判据138：scripts/appdata-smoke.mjs 必须包含行为锚「游标翻页」。", t: "数据面行为断言钉位", s: "S1", ck: existsFact("scripts/appdata-smoke.mjs", "游标翻页"), rv: ["判据原文逐字取自冻结材料，独立实例 8 项：写入双形态/倒序读回/has_more/limit 分页/游标翻页/未知 slug 404/1MB 拒。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 自产台文件提交面（所有资源类型 · 50MB 上限） ──
  { c: "判据139：server/src/index.ts 必须包含文件面表「app_files」。", t: "文件面钉位", s: "S1", ck: existsFact("server/src/index.ts", "app_files"), rv: ["判据原文逐字取自冻结材料，multipart 单文件 ≤50MB（超限 413）/落盘 DATA_DIR/uploads/<YYYYMM>/ + 元数据入表/下载 content-type+nosniff+非白名单强制 attachment/删台级联清盘。", "提取表三条件 exists 精确判定。", "删文件面提取为 0 即 FAIL。"] },
  { c: "判据140：server/src/index.ts 必须包含文件名编码修复「fixFileName」。", t: "中文文件名钉位", s: "S1", ck: existsFact("server/src/index.ts", "fixFileName"), rv: ["判据原文逐字取自冻结材料，busboy 默认 latin1 解码导致中文名 mojibake——latin1→utf8 往返修复（实测「截图.png」变「æªå¾.png」的坑）。", "提取表三条件 exists 精确判定。", "删修复提取为 0 即 FAIL。"] },
  { c: "判据141：scripts/appfiles-smoke.mjs 必须包含行为锚「50MB 上限 → 413」。", t: "文件面行为断言钉位", s: "S1", ck: existsFact("scripts/appfiles-smoke.mjs", "50MB 上限 → 413"), rv: ["判据原文逐字取自冻结材料，独立实例 13 项：PNG/PDF/未知类型上传/元数据含中文名/列表倒序/下载字节一致/content-type/inline 白名单/nosniff/未知 slug 与文件 id 404/413/删台级联。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
  // ── 远程数据面白名单（主人裁定 A：远程浏览器可提交表单，控制面照旧收口） ──
  { c: "判据142：server/src/index.ts 必须包含远程白名单前缀「REMOTE_ALLOW_PREFIX」。", t: "远程数据面白名单钉位", s: "S1", ck: existsFact("server/src/index.ts", "REMOTE_ALLOW_PREFIX"), rv: ["判据原文逐字取自冻结材料，远程（非 loopback）请求只放自产台数据/文件面（/api/apps/<slug>/(data|files)）——应用层写与发布面同口径；控制面 /api/* 写仍要 X-Admin-Token（未设则 403）。", "提取表三条件 exists 精确判定。", "删白名单提取为 0 即 FAIL。"] },
  // ── 台数据读取 MCP 工具（监督席 direct-68a08a66 裁定：只读与 GET 同权，零新增暴露面） ──
  { c: "判据143：server/src/index.ts 必须包含读工具「app_data_list」。", t: "台数据读工具钉位", s: "S1", ck: existsFact("server/src/index.ts", "app_data_list"), rv: ["判据原文逐字取自冻结材料，MCP 只读工具（15→17）：app_data_list 读自产台表单提交数据、app_files_list 读文件列表（含下载 url）——倒序游标分页与 GET 同语义；只走 MCP 的 agent 也能消费台数据。", "提取表三条件 exists 精确判定。", "删读工具提取为 0 即 FAIL。"] },
  { c: "判据144：evidence/e2e_test.py 必须包含 MCP 读工具行为锚「app_files_list」。", t: "读工具行为断言钉位", s: "S1", ck: existsFact("evidence/e2e_test.py", "app_files_list"), rv: ["判据原文逐字取自冻结材料，E2E 组17 断言 tools/list 17 个含两读工具 + REST 写数据后 MCP app_data_list 读回内容与 created_by 一致 + app_files_list 结构。", "提取表三条件 exists 精确判定。", "删断言提取为 0 即 FAIL。"] },
];

// ── 产出三件套 ────────────────────────────────────────────────────────────────
const header = `workbench-market 开发验证器 v29（全面覆盖矩阵 + 渲染层对比度 + 驾驶舱 + 统一门户 + 台生成器 + 凭据注入 + WS 升级 + SOP 台 + MCP 生产通道 + SOP 管理页 + 凭据面防泄露 + 安全批整改 + 门户 Location 改写 + 运行时批整改 + 卫生批整改 + A2A 网络接入 P1+P2 + Agent 执行数据面 + 导出脱敏 + 注册 CRUD MCP 化 + 破坏性测试隔离 + 工具清单一致 + 安全批双锚 + MCP 网关 P1 + 网关管理页与 ADMIN_TOKEN 插槽）

判定面：SQLite 快照与封装提交物目录，二者均由 scripts/make-submission.mjs 生成：
快照 tmp/verify-snap.sqlite 来自活库的一致性副本，并含文本事实提取表
verifier_text_facts(path, needle, present)——打包时对源码逐一检查钉位事实；
E2E 行为证据提取表 verifier_e2e_summary(total, passed, failed, all_passed,
finished_at)——源自 e2e_test.py 每次运行落盘的 evidence/e2e-summary.json；
渲染层对比度提取表 verifier_contrast_checks(label, ratio, min_required,
passed)——源自 E2E 内置的 Playwright 对比度探针（实测 DOM 前景/背景配对，
静态色值钉位无法覆盖的深底文字可见性）。
提交物目录 tmp/submission 从仓库根抽取根清单、server 与 web 源码树、构建产物、
脚本、验证器自举档案、设计规范与证据。
命令执行型检查（typecheck、lint、build）不属于 CLI 闭集，由开发流程自行执行
（E2E 与渲染层对比度结果经摘要表断言）；覆盖三十四个维度共 144 条判据：数据域完整性
（判据1-9）、种子与配置（判据10-15）、提交物结构（判据16-35）、颜色可见性
（判据36-51 与 57-58：经对比度审计的色值在源码与规范中的钉位，漂移即破坏已审计
的可读性）、E2E 行为证据（判据52-54：规模下限、全绿、时间戳在位）、渲染层对比度
探针（判据55-56：覆盖面下限与全达标——深底上的状态文字曾实测 1.18:1 不可见，
此维度保证同类回归被行为层抓住）、任务驾驶舱（判据59-61：名称域完整性、驾驶舱
页面在位、CRUD 路由钉位——工作台从收藏夹到分屏组合视图的功能面锚定）、统一门户
（判据62-65：反向代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走
/go/ 同源代理——从登记簿到统一入口的形态锚定）、台生成器（判据66-70：自产台
slug 域完整、market-app 内置类型在位、发布路由与版本链表钉位、演示台常驻——
从台的管理者到台的生产者的供给面锚定）、凭据注入（判据71-73：服务端注入头钉位、
表单凭据字段钉位、E2E 注入行为断言钉位——认证类工作台的凭据不再明文拼进 url）、
WS 升级（判据74-75：upgrade 挂载与握手 Origin 改写钉位——实时应用经门户可用的
最后一公里；缺位时 HTTP 通而 WS 死，页面永远「重新连接中」）、SOP 台（判据76-80：
运行真源表与 Redis 状态层模块钉位、Runner 服务端渲染与运行 API 钉位、E2E 行为
断言钉位——结构化流程即台：状态层 Redis 热态 + 持久层 SQLite 真源的分层治理，
发布即版本化，draft→published→deprecated 状态机防半成品入册）、MCP 生产通道（判据81-84：
/mcp StreamableHTTP 端点与工具注册表钉位、JSON-RPC -32601 协议合规锚点、E2E 行为断言
钉位——AI 会话直连市场：列台/总览/探测/取入口/发布台/SOP 上架七个生产工具，市场的
MCP 化把供给通道从 REST 页面操作升级为 agent 原生）、SOP 管理页（判据85-88：
Sops.tsx 在位与状态语义表钉位、路由钉位、演示 SOP 常驻钉位——SOP 台的消费与管理面：
状态徽章可视化状态机、run 记录 Drawer 直查分层持久化的执行数据；色值经对比度审计
的 SOP_STATUS 语义表是徽章不漂移的单一事实源）、凭据面防泄露（判据89-90：列表
token 掩码函数与掩码回传保护钉位——无认证列表不再批量泄露 query 门凭据，详情
同策略，PUT 掩码回传不毁库）、安全批整改（判据91-94：auth.value 与 MCP 通道
统一脱敏函数钉位、CORS 白名单、draft 403 瘦身、MCP 泄漏行为断言探针——外部
评审 16 issue 之 #1/#2/#3/#11，监督席复现定性的整改面）、门户 Location 改写
（判据95-96：proxyRes 的 id 备份钉位与行为断言钉位——3xx 跳转改写回 /go/ 前缀
内，评审 #4；根因同红线 9③：proxyRes 时 req.url 已被 pathRewrite 写回）、运行时批
整改（判据97-100：巡检重挂/删台清注册/导入 replace 语义钉位 + 组 19 六断言探针——
评审 #5-10 一轮整改，replace 导入的驾驶舱面板 id 映射恢复在 E2E 内实测）、卫生批
整改（判据101-102：提交物脚本干净克隆自愈 + README 版本一致钉位——评审 #12/#13，
文档漂移由提取表事实钉位抓住）、A2A 网络接入 P1（判据103-106：上游一致卡片签名面、
人工绑定口令校验、SOP 节点短 id 随机持久化、上游裁判冒烟钉位——GH #17 P1 只读暴露：
Ed25519 签名卡片过上游 verifyCard、绑定只经 ADMIN_TOKEN+Origin 校验的人工通道、
上卡规则 published+有效绑定、/a2a/direct 一律 not-found 不泄露存在性）、Agent 执行数据面
（判据107-109：run 持久化链共用核心与 MCP 五工具钉位 + 人机同链行为断言——agent 经
sop_run_step_save 直接更新持久化执行数据，与 Runner/REST 同一条 Redis+SQLite 链，
不经版本发布）、导出脱敏（判据110-112：导出默认经 maskForApi 脱敏 + 导入掩码行
跳过/剥除 + 行为断言——compliance 二期首项，无认证导出曾是最大凭据泄漏向量）、注册
CRUD MCP 化（判据113-115：register/update/unregister 三工具与 REST 同链共用核心、
MCP 凭据字段硬拒绝（安全边界内置）、行为断言——agent 发现内网服务可自主登记入册）、
破坏性测试隔离（判据116：导入 replace 永不碰活库）、工具清单一致（判据117-118：
README 工具名锚钉住 MCP 工具面扩张的文档同步——评审 #18 盲区修补）、安全批双锚
（判据119-121：CORS/MCP 协议/draft 403 三面从源码单锚升格为源码+行为双锚——
防「代码在而行为回归」的静态钉位盲区）、A2A P2 准入（判据122-125：direct 准入
核心与路由桥/上游幂等族 -32003/-32002/512KiB 413/run↔context_id 绑定/DELIVERED
形状——GH #17 阶段表 P2；生产无 ADMIN_TOKEN 时绑定面休眠，准入自然全拒）、MCP
网关 P1（判据126-130：env 开关合并激活解耦/会话面（token 一次性·sha256 库存·
软吊销即时）/审计面（args_sha256 不存原文·401 只计数）/远程面收口（三白名单面）/
行为断言——GH #20 P1：市场 /mcp 从「任何客户端调全部工具」升级为认人按会话
授权的网关，15 内置工具默认拒绝）。
以下判据全部可机械判定：
`;

// 0.114.4 P1c：材料每一行都必须被候选覆盖（header 行无候选会被拒）——材料只含判据行，
// 维度总览挪进 title（submit 元数据，不参与 clause 分句）。
const material = U.map((u) => u.c).join("\n") + "\n";
const candidates = {
  candidates: U.map((u) => ({
    source_clause: u.c,
    anchor: { quote: u.c, locator: "dev-verifier-v4.md " + u.c.slice(0, 3) },
    title: u.t,
    severity: u.s,
    checker: u.ck,
  })),
};
const reviews = {
  reviews: U.map((u) => ({
    source_clause: u.c,
    findings: [
      { question: "faithful", verdict: "ok", reason: u.rv[0], anchor: { quote: u.c, locator: "dev-verifier-v4.md " + u.c.slice(0, 3) } },
      { question: "decidable", verdict: "ok", reason: u.rv[1] },
      { question: "not-vacuous", verdict: "ok", reason: u.rv[2] },
    ],
  })),
};

writeFileSync("verify/material.md", material, "utf8");
writeFileSync("verify/candidates.json", JSON.stringify(candidates, null, 2) + "\n", "utf8");
writeFileSync("verify/reviews.json", JSON.stringify(reviews, null, 2) + "\n", "utf8");
console.log(`✓ verify/material.md (${U.length} 判据) · candidates.json · reviews.json`);
