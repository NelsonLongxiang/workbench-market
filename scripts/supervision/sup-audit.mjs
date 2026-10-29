// 评审监督席·只读对账：e2e 48h 新鲜度 + 市场列表；A2A 台账未核
import { readFileSync } from "node:fs";
const summaryPath = new URL("../../evidence/e2e-summary.json", import.meta.url);
const stamp = new Date().toISOString();
const problems = [];
try {
  const s = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (!s || typeof s.finished_at !== "string" || !s.finished_at.trim()) throw new Error("finished_at 缺失或类型错误");
  const finished = Date.parse(s.finished_at);
  if (!Number.isFinite(finished)) throw new Error("finished_at 日期非法");
  const ageH = (Date.now() - finished) / 36e5;
  if (ageH < 0) throw new Error("finished_at 晚于当前时间");
  if (!Number.isInteger(s.total) || s.total <= 0 || !Number.isInteger(s.passed) || s.passed < 0 || s.passed > s.total ||
      !Number.isInteger(s.failed) || s.failed < 0 || s.passed + s.failed !== s.total ||
      ![0, 1, false, true].includes(s.all_passed) || Boolean(s.all_passed) !== (s.failed === 0)) {
    throw new Error("e2e 摘要计数或 all_passed 非法/矛盾");
  }
  console.log(`[e2e] total=${s.total} passed=${s.passed} all_passed=${s.all_passed} age=${ageH.toFixed(1)}h`);
  if (!s.all_passed) problems.push("e2e 未全 PASS");
  if (ageH > 48) problems.push(`e2e 摘要过期 ${ageH.toFixed(0)}h`);
} catch (e) { problems.push("e2e-summary 不可读: " + String(e).slice(0, 60)); }
try {
  const response = await fetch("http://127.0.0.1:9800/api/workbenches", { method: "GET", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const w = await response.json();
  if (!Array.isArray(w)) throw new Error("workbenches 响应不是数组");
  console.log(`[market] workbenches=${w.length} up=${w.filter(x => x.last_status === "up").length}`);
} catch (e) { problems.push("9800 不可达: " + String(e.cause?.code ?? e).slice(0, 60)); }
console.log("[ledger] NOT_CHECKED（未核 A2A 台账；本报告仅覆盖 e2e 摘要与市场只读列表）");
console.log(problems.length ? `[AUDIT-FAIL] ${stamp} \n- ${problems.join("\n- ")}` : `[AUDIT-OK] ${stamp} scope=e2e-summary,market-list ledger=NOT_CHECKED`);
if (problems.length) process.exit(1);
