#!/usr/bin/env node
/** #94 ③ P3 agent 工作区冒烟（草稿三分支·L8 冲突·判据先红后绿）。
 *  ①app_draft_open——从台当前头开草稿 → {draft}
 *  ②app_draft_edit——old_text/new_text 编辑落草稿
 *  ③app_draft_submit——合并回发布线→新版本生成+激活+物化内容=编辑后
 *  ④L8 并行冲突：两草稿同路径——先提者成·后提者 409 Conflict（isError 含 Conflict）·激活版仍先者
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = 9960;
const DATA = 'tmp/e2e-p3-' + Date.now().toString(36);
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p3-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mcp = async (id, name, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
  try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
};
// 替身 v1（publish/drafts/apply/merge/commits files）
const TOKEN = 'p3-tok2';
const nid = (s) => 'c' + createHash('sha256').update(s + Math.random()).digest('hex').slice(0, 12);
const projs = new Map();
const drafts = new Map(); // draftId → { project, branch, files }
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
  const raw = req.url ?? '';
  const getB = (proj, br) => { const m = projs.get(proj) ?? new Map(); projs.set(proj, m); const st = m.get(br) ?? { commits: [], head: null, files: [] }; m.set(br, st); return st; };
  const pb = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(raw);
  if (req.method === 'POST' && pb) {
    const st = getB(decodeURIComponent(pb[1]), decodeURIComponent(pb[2]));
    const b = JSON.parse(body || '{}');
    const id = nid('pub'); st.commits.push(id); st.head = id; st.files = b.files ?? [];
    return json(200, { commit_id: id, changed: true });
  }
  const dr = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/drafts$/.exec(raw);
  if (req.method === 'POST' && dr) {
    const st = getB(decodeURIComponent(dr[1]), decodeURIComponent(dr[2]));
    const d = 'd' + nid('dr'); drafts.set(d, { project: decodeURIComponent(dr[1]), branch: decodeURIComponent(dr[2]), files: JSON.parse(JSON.stringify(st.files)), from: st.head, applied: false });
    return json(200, { draft: d, from: st.head });
  }
  const ap = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/drafts\/([^/]+)\/apply$/.exec(raw);
  if (req.method === 'POST' && ap) {
    const d = drafts.get(ap[3]);
    if (!d) return json(404, { error: 'no draft' });
    const b = JSON.parse(body || '{}');
    for (const ch of b.changes ?? []) {
      if (ch.op === 'edit') { for (const f of d.files) if (f.path === ch.path) f.content = String(f.content).split(ch.old_text).join(ch.new_text); }
    }
    d.applied = true;
    return json(200, { commit_id: nid('ap') });
  }
  const mg = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/drafts\/([^/]+)\/merge$/.exec(raw);
  if (req.method === 'POST' && mg) {
    const d = drafts.get(mg[3]); if (!d) return json(404, {});
    const into = JSON.parse(body || '{}').into ?? 'release';
    const st = getB(d.project, into);
    const dPaths = new Set(d.files.map((f) => f.path));
    const overlap = d.files.filter((f) => (st.files ?? []).some((g) => g.path === f.path));
    if (st.files.length > 0 && d.applied && overlap.length > 0 && st.head !== d.from) return json(409, { kind: 'Conflict', conflicts: overlap.map((f) => f.path) });
    const id = nid('mg'); st.commits.push(id); st.head = id; st.files = d.files;
    return json(200, { commit_id: id });
  }
  const cf = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(raw);
  if (req.method === 'GET' && cf) {
    const st = getB(decodeURIComponent(cf[1]), decodeURIComponent(cf[2]));
    return st ? json(200, { files: st.files ?? [] }) : json(404, {});
  }
  return json(404, { error: 'nf' });
});
const LP = await new Promise((r) => lfs.listen(0, '127.0.0.1', () => r(lfs.address().port)));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p3-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN }, stdio: 'ignore',
});
try {
  await waitReady(`http://127.0.0.1:${PORT}/api/health`);
  // 基座台
  await fetch(`http://127.0.0.1:${PORT}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug: 'p3-draft', title: 'p3', files: [{ path: 'index.html', content: '<h1>base</h1><p>OLD</p>' }] }) });
  await new Promise((r) => setTimeout(r, 800)); // 影子落地
  // ① open
  const o1 = await mcp(1, 'app_draft_open', { slug: 'p3-draft' });
  const t1 = String(o1?.result?.content?.[0]?.text ?? '');
  const draft1 = /"draft":\s*"([^"]+)"/.exec(t1)?.[1];
  ok('① draft_open → draft id', !!draft1, t1.slice(0, 80));
  // ② edit
  const e1 = await mcp(2, 'app_draft_edit', { slug: 'p3-draft', draft: draft1, path: 'index.html', old_text: 'OLD', new_text: 'NEW-EDITED' });
  ok('② draft_edit（old→new）', !/isError|失败/.test(String(e1?.result?.content?.[0]?.text ?? '')), String(e1?.result?.content?.[0]?.text ?? '').slice(0, 80));
  // ③ submit
  const s1 = await mcp(3, 'app_draft_submit', { slug: 'p3-draft', draft: draft1, changelog: 'p3 draft merge' });
  const s1t = String(s1?.result?.content?.[0]?.text ?? '');
  ok('③a draft_submit 成', !/isError|失败/.test(s1t), s1t.slice(0, 90));
  const page = await (await fetch(`http://127.0.0.1:${PORT}/apps/p3-draft/`)).text();
  ok('③b 新版激活含编辑内容（NEW-EDITED）', page.includes('NEW-EDITED'), page.slice(0, 60));
  // ④ L8 并行冲突
  const o2 = await mcp(4, 'app_draft_open', { slug: 'p3-draft' });
  const o3 = await mcp(5, 'app_draft_open', { slug: 'p3-draft' });
  const d2 = /"draft":\s*"([^"]+)"/.exec(String(o2?.result?.content?.[0]?.text ?? ''))?.[1];
  const d3 = /"draft":\s*"([^"]+)"/.exec(String(o3?.result?.content?.[0]?.text ?? ''))?.[1];
  await mcp(6, 'app_draft_edit', { slug: 'p3-draft', draft: d2, path: 'index.html', old_text: 'base', new_text: 'FIRST' });
  await mcp(7, 'app_draft_edit', { slug: 'p3-draft', draft: d3, path: 'index.html', old_text: 'base', new_text: 'SECOND' });
  const sm2 = await mcp(8, 'app_draft_submit', { slug: 'p3-draft', draft: d2, changelog: 'first' });
  ok('④a 先提者成', !/isError/.test(String(sm2?.result?.content?.[0]?.text ?? '')));
  const sm3 = await mcp(9, 'app_draft_submit', { slug: 'p3-draft', draft: d3, changelog: 'second' });
  const sm3t = String(sm3?.result?.content?.[0]?.text ?? '');
  ok('④b 后提者 409 Conflict（L8）', /Conflict|409/.test(sm3t), sm3t.slice(0, 80));
  const page2 = await (await fetch(`http://127.0.0.1:${PORT}/apps/p3-draft/`)).text();
  ok('④c 激活版仍先者（FIRST 在·SECOND 不在）', page2.includes('FIRST') && !page2.includes('SECOND'), page2.slice(0, 60));
} finally { child.kill(); lfs.close(); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== ③ P3 草稿工作区冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
