// 评审监督席·9800 活性巡检 v2（死亡留勘验 + schtasks 自愈分支）
import fs from "node:fs";
const stamp = new Date().toISOString();
const log = (s) => console.log(s);
const alive = async () => {
  try { const r = await fetch("http://127.0.0.1:9800/api/health", { signal: AbortSignal.timeout(5000) }); return r.ok ? r.status : 0; }
  catch { return 0; }
};
if (await alive()) { log(`[live] ${stamp} 9800 OK`); process.exit(0); }
// 死亡勘验
const { execSync } = await import("node:child_process");
let ns = "(no listener)", tail = "";
try { ns = execSync("netstat -ano | findstr :9800 | findstr LISTENING", { encoding: "utf8" }).trim() || "(no listener)"; } catch {}
try { tail = fs.readFileSync("tmp/server.log", "utf8").slice(-300); } catch {}
log(`[DEAD] ${stamp} listener=${ns} log-tail=${JSON.stringify(tail)}`);
// 自愈：schtasks 点火（任务存在时）；不存在则只报告
let healed = false;
try {
  execSync("schtasks /Run /TN workbench-market-9800", { encoding: "utf8", timeout: 15000, stdio: "pipe" });
  for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 1000)); if (await alive()) { healed = true; break; } }
} catch (e) { log("[heal] schtasks /Run 不可用: " + String(e.stderr || e.message).slice(0, 120)); }
log(healed ? `[REVIVED] ${stamp} 9800 已自愈` : `[STILL-DEAD] ${stamp} 自愈未成功——需人工按 AGENTS.md 跨会话存活形态拉起`);
process.exit(healed ? 0 : 1);
