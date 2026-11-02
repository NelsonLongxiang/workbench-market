// 显式目标活性巡检：默认仅报告；任务点火须显式production+确认+任务名。
import fs from "node:fs";
import {scriptOptions,explicitApi,explicitPath,validatePathParents} from '../explicit-data-target.mjs';
const targetOptions=scriptOptions();
const API=explicitApi(targetOptions.api,targetOptions);
const logPath=explicitPath(targetOptions['log-file'],targetOptions);
validatePathParents(logPath,targetOptions);
if(targetOptions['restart-task']&&(!/^[A-Za-z0-9_.-]+$/.test(targetOptions['restart-task'])||targetOptions['target-mode']!=='production'))throw Error('explicit_restart_task_invalid_or_not_production');
const stamp = new Date().toISOString();
const log = (s) => console.log(s);
const alive = async () => {
  try { const r = await fetch(API + "/api/health", { redirect: "error", signal: AbortSignal.timeout(5000) }); return r.ok ? r.status : 0; }
  catch { return 0; }
};
if (await alive()) { log(`[live] ${stamp} ${API} OK`); process.exit(0); }
// 死亡勘验
const { execSync } = await import("node:child_process");
let ns = "(no listener)", tail = "";
try { ns = execSync("netstat -ano | findstr :"+new URL(API).port+" | findstr LISTENING", { encoding: "utf8" }).trim() || "(no listener)"; } catch {}
try { tail = fs.readFileSync(logPath, "utf8").slice(-300); } catch {}
log(`[DEAD] ${stamp} listener=${ns} log-tail=${JSON.stringify(tail)}`);
// 自愈：schtasks 点火（任务存在时）；不存在则只报告
let healed = false;
try {
  if (!targetOptions['restart-task']) throw Error('explicit_restart_task_not_requested');
  const {execFileSync}=await import('node:child_process');
  execFileSync('schtasks',['/Run','/TN',targetOptions['restart-task']],{encoding:'utf8',timeout:15000,stdio:'pipe'});
  for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 1000)); if (await alive()) { healed = true; break; } }
} catch (e) { log("[heal] schtasks /Run 不可用: " + String(e.stderr || e.message).slice(0, 120)); }
log(healed ? `[REVIVED] ${stamp} ${API} 已自愈` : `[STILL-DEAD] ${stamp} 自愈未成功——需人工按 AGENTS.md 跨会话存活形态拉起`);
process.exit(healed ? 0 : 1);
