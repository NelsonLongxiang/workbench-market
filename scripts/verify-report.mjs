#!/usr/bin/env node
/**
 * 验证器报告可视化 —— 从 verify run JSON 生成单文件 HTML（无依赖）。
 * 用法：node scripts/verify-report.mjs <run.json> [more.json ...] [-o evidence/verify-report.html]
 * 首个 run 作为主报告详展，其余进历史对照表。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("-o");
const out = outIdx >= 0 ? args[outIdx + 1] : "evidence/verify-report.html";
const runPaths = outIdx >= 0 ? args.slice(0, outIdx) : args;
const runs = runPaths.map((f) => JSON.parse(readFileSync(f, "utf8")));
if (!runs.length) { console.error("usage: node scripts/verify-report.mjs <run.json> [...] [-o out.html]"); process.exit(2); }
const [main, ...history] = runs;

// 判据标题在 spec 不在报告：从 run 文件旁的 ../specs/<spec_id>/spec.json 补全
const titleMap = new Map();
const specPath = join(dirname(runPaths[0]), "..", "specs", main.spec_id, "spec.json");
if (existsSync(specPath)) {
  for (const v of JSON.parse(readFileSync(specPath, "utf8")).vu ?? []) titleMap.set(v.id, v.title);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pill = (v) => `<span class="pill ${String(v).toLowerCase()}">${esc(v)}</span>`;
const bar = (matched, scanned, color) => {
  const pct = scanned > 0 ? Math.min(100, (matched / scanned) * 100) : 0;
  return `<div class="bar"><i style="width:${pct}%;background:${color}"></i></div><span class="mono">${matched}/${scanned}</span>`;
};
const VC = { PASS: "#059669", FAIL: "#DC2626", ERROR: "#D97706", "NEEDS-MATERIAL": "#64748B" };
const ts = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");

const unitRows = (main.vu ?? []).map((u) => {
  const w = u.witness ?? {};
  const vc = VC[u.verdict] ?? "#64748B";
  const witness = u.checker_type === "file" ? bar(w.rows_matched ?? 0, w.rows_scanned ?? 0, vc) : `<span class="mono">${w.rows_matched ?? 0}/${w.rows_scanned ?? 0}</span>`;
  return `<tr>
    <td class="mono">${esc(u.id)}</td>
    <td>${pill(u.verdict)} <span class="sev">${esc(u.severity ?? "")}</span></td>
    <td>${esc(titleMap.get(u.id) ?? u.id)}<div class="clause">${esc((u.source_clause ?? "").slice(0, 60))}</div></td>
    <td class="mono">${esc(u.checker_type ?? "")}</td>
    <td class="num">${witness}</td>
  </tr>`;
}).join("");

const histRows = runs.map((r) => `<tr>
  <td class="mono">${esc(r.run_id?.slice(0, 18))}</td>
  <td>${ts(r.started)}</td>
  <td>${pill(r.overall)}</td>
  <td class="mono">${esc(r.spec_id)}</td>
  <td class="num">${r.summary?.pass ?? "-"}<span class="dim">/${(r.summary?.pass ?? 0) + (r.summary?.fail ?? 0) + (r.summary?.error ?? 0) + (r.summary?.needs_material ?? 0)}</span></td>
</tr>`).join("");

const s = main.summary ?? {};
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>workbench-market · 验证报告 ${esc(main.run_id?.slice(4, 12))}</title>
<style>
  :root{--navy:#1E3A5F;--ok:#059669;--bad:#DC2626;--ink:#0F172A;--sub:#5A6577;--line:#E2E8F0;--bg:#F8FAFC}
  *{box-sizing:border-box;margin:0}
  body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);padding:32px}
  .wrap{max-width:960px;margin:0 auto}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  h1{font-size:20px;font-weight:600}
  .meta{color:var(--sub);font-size:12.5px}
  .overall{display:inline-block;padding:3px 14px;border-radius:999px;font-weight:700;font-size:15px;color:#fff;background:${VC[main.overall] ?? "#64748B"}}
  .chips{display:flex;gap:10px;margin:18px 0 22px;flex-wrap:wrap}
  .chip{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 18px;min-width:86px}
  .chip b{display:block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .chip span{font-size:12px;color:var(--sub)}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13.5px}
  th{text-align:left;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--sub);padding:9px 12px;border-bottom:2px solid var(--line);background:#fff}
  td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .clause{color:var(--sub);font-size:12px;margin-top:2px}
  .mono{font-family:"Cascadia Mono",Consolas,monospace;font-size:12.5px;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11.5px;font-weight:700;color:#fff;background:var(--sub)}
  .pill.pass{background:var(--ok)}.pill.fail{background:var(--bad)}.pill.error{background:#D97706}.pill.needs-material{background:#64748B}
  .sev{color:var(--sub);font-size:11px;margin-left:4px}
  .num{text-align:right;white-space:nowrap}
  .dim{color:var(--sub)}
  .bar{display:inline-block;width:64px;height:8px;border-radius:4px;background:#EDF2F7;vertical-align:middle;margin-right:6px;overflow:hidden}
  .bar i{display:block;height:100%}
  h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);margin:26px 0 10px}
  footer{margin-top:26px;color:var(--sub);font-size:12px;line-height:1.8}
</style></head><body><div class="wrap">
  <header><span class="overall">${esc(main.overall)}</span><h1>验证报告</h1>
    <span class="meta mono">${esc(main.spec_id)} v${esc(main.verifier?.spec_version ?? "?")} · run ${esc(main.run_id)} · ${ts(main.started)}（快照口径 as-of ${ts(main.as_of?.value)}）</span>
  </header>
  <div class="chips">
    <div class="chip"><b style="color:var(--ok)">${s.pass ?? 0}</b><span>通过</span></div>
    <div class="chip"><b style="color:var(--bad)">${s.fail ?? 0}</b><span>失败</span></div>
    <div class="chip"><b>${s.needs_material ?? 0}</b><span>缺材料</span></div>
    <div class="chip"><b>${s.error ?? 0}</b><span>错误</span></div>
    <div class="chip"><b>${(main.vu ?? []).length}</b><span>验证单元</span></div>
  </div>
  <table><thead><tr><th>单元</th><th>判定</th><th>判据</th><th>检查器</th><th style="text-align:right">命中/扫描</th></tr></thead>
  <tbody>${unitRows}</tbody></table>
  <h2>运行历史（${runs.length} 次）</h2>
  <table><thead><tr><th>Run</th><th>时间</th><th>Overall</th><th>Spec</th><th style="text-align:right">通过数</th></tr></thead>
  <tbody>${histRows}</tbody></table>
  <footer>
    判定面：SQLite 快照 + 封装提交物（node scripts/make-submission.mjs 生成）· 引擎 ${esc(main.verifier?.engine_version ?? "?")} · 模式 ${esc(main.verifier?.mode ?? "?")}
    <br>payload_sha256 <span class="mono">${esc(main.payload_sha256?.slice(0, 16))}…</span> · 本页由 scripts/verify-report.mjs 从报告 JSON 静态生成（无外部依赖）
  </footer>
</div></body></html>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log(`✓ ${out}  (${runs.length} run(s), overall=${main.overall})`);
