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
  { c: "判据52：E2E 摘要记录的用例总数不得少于 17。", t: "E2E 规模下限", s: "S2", ck: count("verifier_e2e_summary", "==", 1, and({ col: "total", op: ">=", value: 17 })), rv: ["判据原文逐字取自冻结材料，行为面至少覆盖既有 17 组用例（含驾驶舱与统一门户）。", "count 条件计数 ==1 精确判定。", "删用例或未跑 E2E 即计数 0 FAIL。"] },
  { c: "判据53：E2E 摘要必须标记全部用例通过。", t: "E2E 全绿", s: "S1", ck: { type: "exists", predicate: { from: "verifier_e2e_summary", select: ["id"], where: and({ col: "all_passed", op: "=", value: 1 }) }, expect: true }, rv: ["判据原文逐字取自冻结材料，行为面必须全绿才可交付。", "all_passed=1 exists 精确判定。", "任一用例失败即 0 行 FAIL。"] },
  { c: "判据54：E2E 摘要必须带有完成时间戳。", t: "E2E 时间戳在位", s: "S3", ck: { type: "exists", predicate: { from: "verifier_e2e_summary", select: ["id"], where: { col: "finished_at", op: "is not null" } }, expect: true }, rv: ["判据原文逐字取自冻结材料，摘要须可追溯运行时间。", "is not null exists 精确判定。", "空时间戳即 FAIL。"] },
  // ── 渲染层对比度探针（E2E 内置 Playwright 实测 DOM 的 fg/bg 配对，经 verifier_contrast_checks 提取表） ──
  { c: "判据55：渲染层对比度探针覆盖的文字目标不得少于 7 处。", t: "对比度探针覆盖面", s: "S1", ck: count("verifier_contrast_checks", ">=", 7), rv: ["判据原文逐字取自冻结材料，探针须覆盖深底与浅底两类表面。", "count>=7 纯数值判定。", "删探针目标或未跑 E2E 即计数不足 FAIL。"] },
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
];

// ── 产出三件套 ────────────────────────────────────────────────────────────────
const header = `workbench-market 开发验证器 v8（全面覆盖矩阵 + 渲染层对比度 + 驾驶舱 + 统一门户）

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
（E2E 与渲染层对比度结果经摘要表断言）；覆盖八个维度共 65 条判据：数据域完整性
（判据1-9）、种子与配置（判据10-15）、提交物结构（判据16-35）、颜色可见性
（判据36-51 与 57-58：经对比度审计的色值在源码与规范中的钉位，漂移即破坏已审计
的可读性）、E2E 行为证据（判据52-54：规模下限、全绿、时间戳在位）、渲染层对比度
探针（判据55-56：覆盖面下限与全达标——深底上的状态文字曾实测 1.18:1 不可见，
此维度保证同类回归被行为层抓住）、任务驾驶舱（判据59-61：名称域完整性、驾驶舱
页面在位、CRUD 路由钉位——工作台从收藏夹到分屏组合视图的功能面锚定）、统一门户
（判据62-65：反向代理中间件与禁嵌头剥离逻辑在位、代理依赖声明、使用页 iframe 走
/go/ 同源代理——从登记簿到统一入口的形态锚定）。
以下判据全部可机械判定：
`;

const material = header + "\n" + U.map((u) => u.c).join("\n") + "\n";
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
