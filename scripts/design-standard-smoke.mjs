#!/usr/bin/env node
/** MCP design_standard 冒烟：模块级（读真文件、缺文件/坏 front matter 503、参数校验）+ 独立实例（tools/list 含该工具、
 *  tools/call 返回与仓库文件 sha256 一致、section 过滤、坏参数 isError、网关开时未授权同"不存在"应答）。合成数据目录、随机端口。 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sha = (p) => createHash('sha256').update(readFileSync(p, 'utf8'), 'utf8').digest('hex');
const want = { 'DESIGN.md': sha('DESIGN.md'), 'design-system/workbench-market/PATTERNS.md': sha('design-system/workbench-market/PATTERNS.md') };

// ── 模块级 ──
const { designStandard } = await import('../server/src/design-standard.ts');
const all = designStandard({});
ok('模块：version 来自 DESIGN.md front matter', typeof all.version === 'string' && all.version.length > 0, String(all.version));
ok('模块：tokens 含 colors/typography/spacing', !!(all.tokens?.colors?.primary && all.tokens?.typography?.body && all.tokens?.spacing));
ok('模块：sources sha256 与仓库文件一致', all.sources.every((s) => want[s.path] === s.sha256), JSON.stringify(all.sources));
ok('模块：sections 同时含 design 与 patterns', all.sections.some((s) => s.doc === 'design') && all.sections.some((s) => s.doc === 'patterns'));
const tok = designStandard({ part: 'tokens' });
ok('模块：part=tokens 不带 sections', tok.tokens && tok.sections === undefined);
const pat = designStandard({ part: 'patterns' });
ok('模块：part=patterns 只给 patterns 章节且不带 tokens', pat.tokens === undefined && pat.sections.length > 0 && pat.sections.every((s) => s.doc === 'patterns'));
const sec = designStandard({ section: '数据看板' });
ok('模块：section 过滤只返回命中章节', sec.sections.length >= 1 && sec.sections.every((s) => s.heading.includes('数据看板')));
const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };
ok('模块：坏 part → 400', err(() => designStandard({ part: 'colors' }))?.status === 400);
ok('模块：空 section → 400', err(() => designStandard({ section: '  ' }))?.status === 400);
ok('模块：无命中 section → 404', err(() => designStandard({ section: '不存在的章节xyz' }))?.status === 404);
const tmpRoot = 'tmp/design-standard-fixture';
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(join(tmpRoot, 'design-system/workbench-market'), { recursive: true });
ok('模块：缺文件 → 503 且点名路径', /DESIGN\.md/.test(err(() => designStandard({}, tmpRoot))?.message ?? '') && err(() => designStandard({}, tmpRoot))?.status === 503);
writeFileSync(join(tmpRoot, 'DESIGN.md'), '# 无 front matter\n');
writeFileSync(join(tmpRoot, 'design-system/workbench-market/PATTERNS.md'), '## x\ny\n');
ok('模块：缺 front matter → 503', err(() => designStandard({}, tmpRoot))?.status === 503);
writeFileSync(join(tmpRoot, 'DESIGN.md'), '---\ncolors: [unclosed\n---\n');
ok('模块：front matter 解析失败 → 503', err(() => designStandard({}, tmpRoot))?.status === 503);
rmSync(tmpRoot, { recursive: true, force: true });

// ── 实例级 ──
function start(gateway, tag, admin) {
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const DATA = `tmp/e2e-dstd-${tag}`;
  rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: `../${DATA}`, ADMIN_TOKEN: admin ?? '', MCP_GATEWAY: gateway };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', env, stdio: ['ignore', 'ignore', 'pipe'] });
  let e = ''; child.stderr.on('data', (c) => (e += c));
  return { base: `http://127.0.0.1:${PORT}`, child, DATA, stderr: () => e };
}
async function ready(i) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { try { if ((await fetch(i.base + '/api/health')).status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
async function stop(i) { if (i.child.exitCode === null) { const ex = new Promise((r) => i.child.once('exit', r)); i.child.kill(); await ex; } rmSync(i.DATA, { recursive: true, force: true }); }
const rpc = async (base, method, params, token) => {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(base + '/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

{
  const i = start('off', 'off');
  try {
    ok('实例(off)：就绪', await ready(i), i.stderr().slice(-300));
    const l = await rpc(i.base, 'tools/list', {});
    ok('实例(off)：tools/list 含 design_standard', (l.body?.result?.tools ?? []).some((t) => t.name === 'design_standard'));
    const c = await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: { part: 'tokens' } });
    let j = null; try { j = JSON.parse(c.body?.result?.content?.[0]?.text ?? ''); } catch {}
    ok('实例(off)：tools/call 返回 tokens 且 sha256 与仓库一致', !!j?.tokens?.colors && j.sources.every((s) => want[s.path] === s.sha256), c.body ? JSON.stringify(c.body).slice(0, 200) : '');
    const s = await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: { section: 'SOP 交付空间' } });
    let sj = null; try { sj = JSON.parse(s.body?.result?.content?.[0]?.text ?? ''); } catch {}
    ok('实例(off)：section 过滤生效', sj?.sections?.length >= 1 && sj.sections.every((x) => x.heading.includes('SOP 交付空间')));
    const b = await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: { part: 'nope' } });
    ok('实例(off)：坏 part → isError', b.body?.result?.isError === true, JSON.stringify(b.body).slice(0, 200));
  } finally { await stop(i); }
}
{
  const ADMIN = 'dstd-admin-tok';
  const i = start('on', 'on', ADMIN);
  try {
    ok('实例(on)：就绪', await ready(i), i.stderr().slice(-300));
    const AT = { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN };
    const mk = async (name, grants) => {
      const r = await fetch(i.base + '/api/mcp/sessions', { method: 'POST', headers: AT, body: JSON.stringify({ name }) });
      const j = await r.json().catch(() => null);
      if (grants) await fetch(`${i.base}/api/mcp/sessions/${j?.id}/grants`, { method: 'PUT', headers: AT, body: JSON.stringify({ grants }) });
      return j?.token;
    };
    const tNo = await mk('dstd-nogrant', ['workbench_list']);
    const tYes = await mk('dstd-grant', ['design_standard']);
    ok('实例(on)：会话创建成功', typeof tNo === 'string' && typeof tYes === 'string');
    ok('实例(on)：匿名调用 401', (await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: {} })).status === 401);
    const no = await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: {} }, tNo);
    ok('实例(on)：未授权会话 → 与不存在同应答（-32601）', no.body?.error?.code === -32601, JSON.stringify(no.body).slice(0, 200));
    const yes = await rpc(i.base, 'tools/call', { name: 'design_standard', arguments: { part: 'tokens' } }, tYes);
    ok('实例(on)：已授权会话可读', !yes.body?.result?.isError && /"tokens"/.test(yes.body?.result?.content?.[0]?.text ?? ''), JSON.stringify(yes.body).slice(0, 200));
  } finally { await stop(i); }
}

console.log(`design-standard-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
