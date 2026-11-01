#!/usr/bin/env node
/** #178 skill_search 冒烟（替身 Gateway·EVAL_GATEWAY_URL）：协议形状 + 阈值/上限/排序/空态/错误面 + frontmatter 吸收。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const GW = PORT + 1;
const DATA = 'tmp/e2e-ss-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ss' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
// 替身 Gateway：按 qid 返回给定 probability；校验五头/题型/qid 对应/批≤15
let lastReq = null, reqCount = 0, mode = 'ok';
const probs = new Map();
const gw = createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    reqCount++;
    let j = {}; try { j = JSON.parse(b); } catch {}
    lastReq = { headers: req.headers, body: j };
    if (mode === '429') { res.writeHead(429); return res.end('rate'); }
    if (mode === '400') { res.writeHead(400); return res.end('bad'); }
    const answers = {};
    for (const qid of Object.keys(j?.state?.skills ?? {})) {
      const nm = String(j.state.skills[qid]?.name ?? '');
      answers[qid] = { probability: probs.has(nm) ? probs.get(nm) : 0.1 };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers }));
  });
});
await new Promise((r) => gw.listen(GW, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ss', EVAL_GATEWAY_URL: `http://127.0.0.1:${GW}/v4/ai/evaluation-model`, AI_GATEWAY_API_KEY: 'vck_test' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
const mcp = async (name, args) => { const r = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(20000) }); const j = await r.json().catch(() => ({})); let payload = {}; try { payload = JSON.parse(j.result?.content?.[0]?.text ?? '{}'); } catch {} return { j, payload }; };
const pub = (slug, name, desc) => fetch(`${B}/api/skills/${encodeURIComponent(slug)}/versions`, { method: 'POST', headers: H, body: JSON.stringify({ changelog: 'ss', files: [{ path: 'SKILL.md', content: '---\nname: ' + name + '\ndescription: ' + desc + '\nargument-hint: [x]\n---\nbody\n' }] }) });
try {
  await waitReady(`${B}/api/health`);
  // 造 5 个技能（4 个 >0.7·含 0.70 边界）
  await pub('agents:ss-a', 'ss-a-搜索', '采购差异核对与对账');
  await pub('agents:ss-b', 'ss-b-验收', '验收台账与六判据');
  await pub('agents:ss-c', 'ss-c-边界', '边界测试技能');
  await pub('agents:ss-d', 'ss-d-第四', '第四个高分技能');
  // S14：frontmatter 吸收
  const list = await (await fetch(`${B}/api/skills`)).json();
  const ssA = list.find((x) => x.slug === 'agents:ss-a');
  ok('S14 frontmatter 吸收（description 非空）', String(ssA?.description ?? '').includes('采购'), String(ssA?.description).slice(0, 40));
  probs.set('ss-a-搜索', 0.95); probs.set('ss-b-验收', 0.9); probs.set('ss-c-边界', 0.70); probs.set('ss-d-第四', 0.85);
  // S1/S10：工具在注册表 + 协议形状
  const tl = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const tlJ = await tl.json();
  ok('S1 skill_search 在 tools/list', (tlJ.result?.tools ?? []).some((t) => t.name === 'skill_search'), '');
  const r = await mcp('skill_search', { need: 'ss-a-搜索 ss-b-验收 ss-c-边界 ss-d-第四 采购对账差异核对' });
  ok('S2 恰返回最高 3 个（4 个 >0.7）', (r.payload.items ?? []).length === 3, JSON.stringify((r.payload.items ?? []).map((x) => x.slug)));
  ok('S3 0.70 严格不出现', !(r.payload.items ?? []).some((x) => x.name === 'ss-c-边界'), '');
  ok('S4 降序', (r.payload.items ?? []).every((x, i, a) => i === 0 || a[i - 1].confidence >= x.confidence), '');
  ok('S5 confidence=模型 probability', (r.payload.items ?? [])[0]?.confidence === 0.95, String((r.payload.items ?? [])[0]?.confidence));
  ok('S10 五头齐+boolean+批≤15', (() => { const h = lastReq?.headers ?? {}; return ['authorization', 'ai-model-id', 'ai-evaluation-model-specification-version', 'ai-gateway-protocol-version', 'ai-gateway-auth-method'].every((k) => !!h[k]) && String(h['ai-model-id']).includes('jev') && lastReq?.body?.questions && Object.values(lastReq.body.questions).every((q) => q.type === 'boolean') && Object.keys(lastReq.body.state.skills).length <= 15 && !("model" in (lastReq?.body ?? {})); })(), '');
  // S6 全部 ≤0.7 → 空+note
  probs.set('ss-a-搜索', 0.5); probs.set('ss-b-验收', 0.6); probs.set('ss-d-第四', 0.65);
  const r6 = await mcp('skill_search', { need: '低分场景' });
  ok('S6 全≤0.7 → 空数组+note', (r6.payload.items ?? []).length === 0 && !!r6.payload.note, JSON.stringify(r6.payload));
  // S7 400 不重试
  mode = '400'; const before = reqCount;
  const r7 = await mcp('skill_search', { need: '错误场景' });
  const txt7 = JSON.stringify(r7.j);
  ok('S7 400 不重试（请求数+1）', reqCount - before === 1 && /400/.test(txt7), 'delta=' + (reqCount - before));
  // S7b 429 一次后成功（请求数比无错时 +1）
  mode = '429'; const before429 = reqCount;
  setTimeout(() => { mode = 'ok'; }, 300);
  const r429 = await mcp('skill_search', { need: 'ss-a-搜索 采购' });
  ok('S7b 429 退避后成功（请求数+2）', reqCount - before429 >= 2 && Array.isArray(r429.payload.items), 'delta=' + (reqCount - before429));
  mode = 'ok';
  await new Promise((x) => setTimeout(x, 400));
  // S11 需求与描述相同 → 在候选里
  lastReq = null;
  const r11 = await mcp('skill_search', { need: '验收台账与六判据' });
  for (const k of probs.keys()) probs.set(k, 0.1);
  probs.set('ss-b-验收', 0.99);
  const r11b = await mcp('skill_search', { need: '验收台账与六判据' });
  const _top = (r11b.payload.items ?? [])[0];
  ok('S11 需求同描述 → 该技能居首（0.99）', _top?.slug === 'agents:ss-b', JSON.stringify(_top?.slug ?? r11b.payload).slice(0, 80));
  for (const k of probs.keys()) probs.set(k, 0.1);
  probs.set('ss-a-搜索', 0.95); probs.set('ss-b-验收', 0.9); probs.set('ss-c-边界', 0.70); probs.set('ss-d-第四', 0.85);
  // S8 无 key → 报错（独立微件·不降级）
  const { execSync } = await import('node:child_process');
  let s8out = '';
  try { s8out = String(execSync(process.execPath + ' tmp/s8-nokey.mjs', { encoding: 'utf8' })).trim(); } catch (e) { s8out = String(e.stdout ?? '') + String(e.message ?? ''); }
  ok('S8 无 key 报错不降级（AI_GATEWAY_API_KEY 未配置）', s8out.includes('ERR:') && s8out.includes('AI_GATEWAY_API_KEY'), s8out.slice(0, 80));
} finally { child.kill(); await new Promise((r) => gw.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== skill_search 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
