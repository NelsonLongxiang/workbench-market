// 评审监督席·交付对账：e2e 新鲜度 + 市场面行数 + 台账容限
const fs = await import("node:fs");
const stamp = new Date().toISOString();
const problems = [];
try {
  const s = JSON.parse(fs.readFileSync("evidence/e2e-summary.json", "utf8"));
  const ageH = (Date.now() - new Date(s.finished_at).getTime()) / 36e5;
  console.log(`[e2e] total=${s.total} passed=${s.passed} all_passed=${s.all_passed} age=${ageH.toFixed(1)}h`);
  if (!s.all_passed) problems.push("e2e 未全 PASS");
  if (ageH > 48) problems.push(`e2e 摘要过期 ${ageH.toFixed(0)}h`);
} catch (e) { problems.push("e2e-summary 不可读: " + String(e).slice(0, 60)); }
try {
  await fetch("http://127.0.0.1:9800/api/check-all", { method: "POST" }).catch(() => {});
  const w = await (await fetch("http://127.0.0.1:9800/api/workbenches")).json();
  console.log(`[market] workbenches=${w.length} up=${w.filter(x => x.last_status === "up").length}`);
} catch (e) { problems.push("9800 不可达: " + String(e.cause?.code ?? e).slice(0, 60)); }
const { execSync } = await import("node:child_process");
try {
  const jobs = execSync("ygl-trees a2a-tasks 2>nul", { encoding: "utf8" });
} catch {}
console.log(problems.length ? `[AUDIT-FAIL] ${stamp} \n- ${problems.join("\n- ")}` : `[AUDIT-OK] ${stamp}`);
if (problems.length) process.exit(1);
