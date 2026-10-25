#!/usr/bin/env node
/**
 * workbench-market 开发验证器 —— 判定面打包脚本
 *
 * 产出两个判定面（幂等，可重复执行）：
 *   1. tmp/verify-snap.sqlite   —— 活库一致性快照（VACUUM INTO，WAL 安全）
 *   2. tmp/submission/          —— 封装提交物目录，从仓库根抽取：
 *        README.md · package.json · pnpm-workspace.yaml
 *        server/package.json · server/src/
 *        web/package.json · web/src/ · web/dist/
 *        scripts/ · verify/ · design-system/
 *        evidence/e2e_test.py · evidence/*.png
 *
 * 用法：node scripts/make-submission.mjs
 * 之后：ygl-trees verify run <spec-id> --db tmp/verify-snap.sqlite --submission tmp/submission
 */
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snap = join(root, "tmp", "verify-snap.sqlite");
const sub = join(root, "tmp", "submission");

// issue #13：干净克隆没有 tmp/——VACUUM INTO 前先把目录建好（recursive 幂等）
mkdirSync(join(root, "tmp"), { recursive: true });

// 1) 快照（活库由 server 持有 WAL，VACUUM INTO 得到一致副本）
// 摘要门（#44/#46 两犯机械化）：残次 e2e-summary 物理进不了提交物——passed!==total 即中止
{
  const sum = JSON.parse(readFileSync(join(root, "evidence", "e2e-summary.json"), "utf8"));
  if (sum.total > 0 && sum.passed !== sum.total) {
    console.error(`[summary-gate] e2e-summary 残次（${sum.passed}/${sum.total}）——先归真再提交`);
    process.exit(2);
  }
}

rmSync(snap, { force: true });
const db = new DatabaseSync(join(root, "server", "data", "workbench-market.db"), { readOnly: true });
db.exec(`VACUUM INTO '${snap.replaceAll("\\", "/")}'`);
db.close();

// 2) 封装提交物（file 型判据的 glob 目标全集）
rmSync(sub, { recursive: true, force: true });
mkdirSync(sub, { recursive: true });
const files = ["README.md", "package.json", "pnpm-workspace.yaml"];
for (const f of files) cpSync(join(root, f), join(sub, f));
const dirs = ["server/src", "web/src", "web/dist", "scripts", "verify", "design-system"];
for (const d of dirs) cpSync(join(root, d), join(sub, d), { recursive: true });

mkdirSync(join(sub, "evidence"), { recursive: true });
cpSync(join(root, "evidence", "e2e_test.py"), join(sub, "evidence", "e2e_test.py"));
cpSync(join(root, "server", "package.json"), join(sub, "server", "package.json"));
cpSync(join(root, "web", "package.json"), join(sub, "web", "package.json"));
const pngs = readdirSync(join(root, "evidence")).filter((f) => f.endsWith(".png"));
for (const f of pngs) cpSync(join(root, "evidence", f), join(sub, "evidence", f));
try { cpSync(join(root, "evidence", "e2e-summary.json"), join(sub, "evidence", "e2e-summary.json")); } catch {}

// 3) 打包清单（审计面：提交物内容一目了然）
const manifest = {
  generated_at: new Date().toISOString(),
  snapshot: "tmp/verify-snap.sqlite",
  submission_dir: "tmp/submission",
  files,
  dirs,
  extra: ["server/package.json", "web/package.json", "evidence/e2e_test.py", `evidence/*.png ×${pngs.length}`],
};
writeFileSync(join(sub, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

// 4) 文本事实提取表（颜色可见性判据的判定面）：
//    对钉位事实逐一检查源文件内容，把结果写进快照 verifier_text_facts，
//    验证器用 sql/exists 谓词断言 —— 内容子串在 CLI 闭集中不可直接判定，
//    经此单一入口桥接（提取器随版本库可审计，每次打包从当前源码重新提取）。
const TEXT_FACTS = [
  ["web/src/main.tsx", "#1E3A5F"],
  ["web/src/main.tsx", "#5A6577"],
  ["web/src/main.tsx", "#059669"],
  ["web/src/main.tsx", "#DC2626"],
  ["web/src/App.tsx", "#0F172A"],
  ["web/src/index.css", "rgba(5, 150, 105, 0.6)"],
  ["web/src/index.css", "rgba(5, 150, 105, 0.45)"],
  ["web/src/App.tsx", "#059669"],
  ["design-system/workbench-market/MASTER.md", "#1E3A5F"],
  ["design-system/workbench-market/MASTER.md", "#5A6577"],
  ["web/src/pages/Dashboard.tsx", "#5A6577"],
  ["web/src/pages/Dashboard.tsx", "#059669"],
  ["web/src/pages/Dashboard.tsx", "#DC2626"],
  ["web/src/pages/Dashboard.tsx", "#94A3B8"],
  ["web/src/index.css", "rgba(30, 58, 95, 0.1)"],
  ["web/src/index.css", "#0f172a"],
  ["web/src/index.css", ".wm-use-bar .ant-badge-status-text"],
  ["web/src/index.css", "rgba(255, 255, 255, 0.85)"],
  ["server/src/index.ts", "/api/cockpits"],
  ["server/src/index.ts", "createProxyMiddleware"],
  ["server/src/portal.ts", "x-frame-options"],
  ["server/package.json", "http-proxy-middleware"],
  ["web/src/pages/UseWorkbench.tsx", "/go/${w.id}/"],
  ["server/src/index.ts", "/api/apps"],
  ["server/src/db.ts", "app_versions"],
  ["server/src/index.ts", "authorization"],
  ["web/src/components/WorkbenchForm.tsx", "authValue"],
  ["evidence/e2e_test.py", "e2e-bear-tok"],
  ["server/src/index.ts", "goServer.on('upgrade'"],
  ["server/src/index.ts", "req.headers.origin = u.origin"],
  ["server/src/db.ts", "sop_runs"],
  ["server/src/redis.ts", "runStateSave"],
  ["server/src/index.ts", "renderSopRunner"],
  ["server/src/index.ts", "/api/sop/runs"],
  ["evidence/e2e_test.py", "e2e-sop"],
  ["server/src/index.ts", "app.post('/mcp'"],
  ["server/src/index.ts", "MCP_TOOLS"],
  ["server/src/index.ts", "-32601"],
  ["evidence/e2e_test.py", "e2e-mcp-app"],
  ["web/src/pages/Sops.tsx", "SOP_STATUS"],
  ["web/src/App.tsx", "path: '/sops'"],
  ["evidence/e2e_test.py", "demo-rack-sop"],
  ["server/src/index.ts", "maskSensitiveQuery"],
  ["server/src/index.ts", "=****"],
  ["server/src/index.ts", "maskForApi"],
  ["server/src/index.ts", "CORS_ALLOW"],
  ["server/src/index.ts", "未上架不可执行"],
  ["evidence/e2e_test.py", "token=8sKZ"],
  ["server/src/portal.ts", "goWid"],
  ["evidence/e2e_test.py", "redir-relative"],
  ["server/src/index.ts", "issue #5"],
  ["server/src/index.ts", "issue #6"],
  ["server/src/index.ts", "issue #7"],
  ["scripts/import-smoke.mjs", "e2e-import-probe"],
  ["scripts/make-submission.mjs", "issue #13"],
  ["README.md", "174 条判据"],
  ["server/src/a2a.ts", "@nelsonlongxiang/dsh-open-a2a-net/card"],
  ["server/src/index.ts", "x-admin-token"],
  ["server/src/a2a.ts", "a2a_node8"],
  ["scripts/a2a-smoke.mjs", "verifyCard"],
  ["server/src/index.ts", "sopRunStepSaveCore"],
  ["server/src/index.ts", "sop_run_step_save"],
  ["evidence/e2e_test.py", "agent-填-1"],
  ["server/src/index.ts", "compliance 二期首项"],
  ["server/src/index.ts", "掩码行（url 含 =****）不落库"],
  ["evidence/e2e_test.py", "E2E MaskImport"],
  ["server/src/index.ts", "workbenchCreateCore"],
  ["server/src/index.ts", "凭据不接受 MCP 写入"],
  ["evidence/e2e_test.py", "E2E MCP 台"],
  ["scripts/import-smoke.mjs", "e2e-import-probe"],
  ["evidence/e2e_test.py", "import-smoke"],
  ["README.md", "sop_run_step_save"],
  ["README.md", "workbench_register"],
  ["evidence/e2e_test.py", "access-control-allow-origin"],
  ["evidence/e2e_test.py", "-32601"],
  ["evidence/e2e_test.py", "SecretStep"],
  ["server/src/a2a.ts", "a2aDirectHandle"],
  ["server/src/index.ts", "a2aDirectHandle"],
  ["server/src/a2a.ts", "-32003"],
  ["scripts/a2a-smoke.mjs", "TASK_STATE_DELIVERED"],
  ["server/src/index.ts", "MCP_GATEWAY"],
  ["server/src/services/mcp.ts", "mcp_sessions"],
  ["server/src/services/mcp.ts", "mcp_calls"],
  ["server/src/index.ts", "REMOTE_ALLOW_EXACT"],
  ["scripts/gateway-smoke.mjs", "WWW-Authenticate"],
  ["web/src/pages/McpGateways.tsx", "默认拒绝"],
  ["web/src/App.tsx", "'/mcp-gateways'"],
  ["ADMIN-TOKEN-SETUP.md", "setx ADMIN_TOKEN"],
  ["server/src/services/cookie.ts", "cookie_sets"],
  ["server/src/portal.ts", "goCookies"],
  ["scripts/cookie-smoke.mjs", "过期 cookie 被过滤"],
  ["server/src/index.ts", "app_data"],
  ["scripts/appdata-smoke.mjs", "游标翻页"],
  ["server/src/index.ts", "app_files"],
  ["server/src/index.ts", "fixFileName"],
  ["scripts/appfiles-smoke.mjs", "50MB 上限 → 413"],
  ["server/src/index.ts", "REMOTE_ALLOW_PREFIX"],
  ["server/src/index.ts", "app_data_list"],
  ["evidence/e2e_test.py", "app_files_list"],
  ["server/src/index.ts", "pageLimit"],
  ["server/src/index.ts", "mcpAggregatedTools"],
  ["scripts/upstream-smoke.mjs", "taste__rules 转发成功"],
  ["server/src/index.ts", "X-Market-Client"],
  ["web/src/components/AppDataDrawer.tsx", "提交数据"],
  ["scripts/a2a-smoke.mjs", "waitReady"],
  ["server/src/index.ts", "admin_token_sha256"],
  ["web/src/pages/Settings.tsx", "/api/admin-token"],
  ["server/src/index.ts", "maskUpstreamsSetting"],
  ["scripts/appfiles-smoke.mjs", "404 不落盘"],
  ["server/src/index.ts", "hashAdminToken"],
  ["scripts/token-smoke.mjs", "无 admin_token_sha256"],
  ["server/src/a2a.ts", "a2aSendOutbound"],
  ["server/src/index.ts", "/api/a2a/send"],
  ["server/src/db.ts", "a2a_outbox"],
  ["scripts/receipt-smoke.mjs", "E1 上游 parseReceipt 可解析"],
  ["server/src/db.ts", "sop_run_files"],
  ["server/src/sop-runner.ts", "agent-extras"],
  ["web/src/pages/Sops.tsx", "待验收任务"],
  ["server/src/index.ts", "/api/sop/runs/:id/assign"],
  ["web/src/pages/Tasks.tsx", "发布任务"],
  ["server/src/db.ts", "CREATE TABLE IF NOT EXISTS skills"],
  ["scripts/skill-smoke.mjs", "digest 身份锚"],
  ["server/src/context.ts", "SkillService"],
  ["scripts/skill-import.mjs", "外源 version 不进身份"],
  ["scripts/skill-smoke.mjs", "生产种子在库"],
  ["scripts/skill-publish-smoke.mjs", "digest 锚（同内容拒 409）"],
  ["server/src/mcp-tools.ts", "skill_install_plan"],
  ["web/src/pages/Skills.tsx", "技能市场"],
  ["scripts/skill-install-smoke.mjs", "篡改后校验红"],
];
import { readFileSync } from "node:fs";
const snapDb = new DatabaseSync(snap);
snapDb.exec(`CREATE TABLE verifier_text_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  needle TEXT NOT NULL,
  present INTEGER NOT NULL
)`);
const ins = snapDb.prepare("INSERT INTO verifier_text_facts (path, needle, present) VALUES (?, ?, ?)");
let hit = 0;
for (const [p, needle] of TEXT_FACTS) {
  const src = readFileSync(join(root, p), "utf8");
  const present = src.includes(needle) ? 1 : 0;
  hit += present;
  ins.run(p, needle, present);
}
// 5) E2E 行为证据提取表：读 evidence/e2e-summary.json（e2e_test.py 每次运行落盘）；
//    无文件则不插入——E2E 判据 fail-closed（count==1 与 exists 均失败），诚实暴露 E2E 未跑
snapDb.exec(`CREATE TABLE verifier_e2e_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  all_passed INTEGER NOT NULL,
  finished_at TEXT NOT NULL
)`);
let e2eRow = null;
try {
  e2eRow = JSON.parse(readFileSync(join(root, "evidence", "e2e-summary.json"), "utf8"));
} catch {
  console.log("⚠ evidence/e2e-summary.json 缺失 —— E2E 判据将 fail-closed");
}
if (e2eRow && Number.isFinite(e2eRow.total)) {
  snapDb
    .prepare("INSERT INTO verifier_e2e_summary (total, passed, failed, all_passed, finished_at) VALUES (?, ?, ?, ?, ?)")
    .run(e2eRow.total, e2eRow.passed, e2eRow.failed, e2eRow.all_passed ? 1 : 0, e2eRow.finished_at ?? "");
  console.log(`✓ verifier_e2e_summary: ${e2eRow.passed}/${e2eRow.total} (${e2eRow.finished_at})`);
}
// 6) 渲染层对比度提取表：e2e-summary.json 的 contrast_checks 数组逐行入库；
//    未跑 E2E 或探针缺失则无行 —— 对比度判据 fail-closed
snapDb.exec(`CREATE TABLE verifier_contrast_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  ratio REAL NOT NULL,
  min_required REAL NOT NULL,
  passed INTEGER NOT NULL
)`);
if (e2eRow && Array.isArray(e2eRow.contrast_checks) && e2eRow.contrast_checks.length) {
  const insC = snapDb.prepare("INSERT INTO verifier_contrast_checks (label, ratio, min_required, passed) VALUES (?, ?, ?, ?)");
  for (const c of e2eRow.contrast_checks) insC.run(c.label, Number(c.ratio), Number(c.min), c.passed ? 1 : 0);
  const okN = e2eRow.contrast_checks.filter((c) => c.passed).length;
  console.log(`✓ verifier_contrast_checks: ${okN}/${e2eRow.contrast_checks.length} 处达标`);
} else {
  console.log("⚠ contrast_checks 缺失 —— 渲染层对比度判据将 fail-closed");
}
snapDb.close();
console.log(`✓ verifier_text_facts: ${hit}/${TEXT_FACTS.length} 色值在源码中钉位`);
console.log(`✓ snapshot: tmp/verify-snap.sqlite`);
console.log(`✓ submission: tmp/submission (${files.length} root files + ${dirs.length} dirs + ${pngs.length} png)`);
