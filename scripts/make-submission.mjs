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

// 1) 快照（活库由 server 持有 WAL，VACUUM INTO 得到一致副本）
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
snapDb.close();
console.log(`✓ verifier_text_facts: ${hit}/${TEXT_FACTS.length} 色值在源码中钉位`);
console.log(`✓ snapshot: tmp/verify-snap.sqlite`);
console.log(`✓ submission: tmp/submission (${files.length} root files + ${dirs.length} dirs + ${pngs.length} png)`);
