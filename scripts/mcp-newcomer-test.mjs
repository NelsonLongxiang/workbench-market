#!/usr/bin/env node
/**
 * 新来的 AI 席位第一次接 MCP（冷读暴露的四处，通用网关这一侧）的对抗组。独立实例：全新 DATA_DIR、合成的管理口令、MCP_GATEWAY=on、数据视图开。
 *  一、读技能不用申请：零授权会话 tools/list 就有 skill_search、skills_list、skill_read。
 *     目录分层（渐进开放第 1 步）：access_info 默认只给索引（名称、一行说明、类别、批没批），不带参数表；参数表按名字取（access_info {tool}），
 *     和 tools/list 里的 inputSchema 一样；老客户端带 full: true 照样拿全量。
 *     免授权 ≠ 免认证：匿名、无效令牌、已吊销的会话照样 401。放开的只有这三个读：skill_download、skill_versions、skill_file_put、skill_publish 照旧要授权。
 *  二、skill_read 只读技能快照里的普通文件：../、绝对路径、反斜杠、点段、快照外的符号链接都读不到，和没有这个文件同一句；二进制只给大小和摘要。
 *  三、skill_search 的空结果分两种：库里一个技能都没有（不调评估模型，直说还没有导入技能）；有技能但没有够格的（另一句）。
 *  四、申请：通用申请和台申请的编号带类别前缀（mcp-N、bench-N），不会撞；created_at、decided_at 统一成 ISO；应答写清批了之后怎么知道；
 *     access_info {ref} 只查得到自己的申请，别的会话的和不存在的同一句；台申请照旧不核台存不存在（没有授予的会话看不出台存不存在），应答说清写错了怎么办。
 * 测试数据都是合成的。
 */
import { freePort } from './lib/free-port.mjs';
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-newcomer-' + Date.now().toString(36);
const ADMIN = 'newcomer-synthetic-admin';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { PATH: process.env.PATH, HOME: join(DATA, 'home'), NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', WM_BENCH_VIEWS: 'on', REDIS_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const end = Date.now() + 60000;
let up = false;
while (!up && Date.now() < end && child.exitCode === null) {
  try { up = (await fetch(BASE + '/api/health')).status === 200; } catch { /* 还没起来 */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.log('  ✗ 实例没起来\n' + log.slice(-1500)); child.kill(); process.exit(1); }

const AT = { 'X-Admin-Token': ADMIN };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, body: j };
}
const rpc = (method, params, token) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token ? { Authorization: `Bearer ${token}` } : {});
async function tool(token, name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const text = r.body?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(r.body?.result?.isError ? text.split('\n').slice(1).join('\n') : text); } catch { /* 没有结构 */ }
  return { status: r.status, rpcError: r.body?.error ?? null, isError: !!r.body?.result?.isError, text, payload };
}
async function newSession(name, grants = []) {
  const r = await call('POST', '/api/mcp/sessions', { name }, AT);
  if (grants.length) await call('PUT', `/api/mcp/sessions/${r.body.id}/grants`, { grants }, AT);
  return { id: r.body.id, token: r.body.token };
}
const listNames = async (token) => ((await rpc('tools/list', {}, token)).body?.result?.tools ?? []).map((t) => t.name);
const SKILL_READS = ['skill_read', 'skill_search', 'skills_list'];

try {
  const bare = await newSession('newcomer-bare');
  const other = await newSession('newcomer-other');

  // ---------- 一、读技能不用申请 ----------
  const names = await listNames(bare.token);
  ok('零授权会话 tools/list 有两个权限自助工具、通用调用、分段读大结果和三个读技能的工具，别的没有', J([...names].sort()) === J(['access_info', 'access_request', 'invoke', 'result_read', ...SKILL_READS].sort()), J(names));
  const info = await tool(bare.token, 'access_info');
  // 工具结果是紧凑 JSON（不缩进）：同一份内容，换行和缩进不占上下文
  ok('tools/call 的结果是紧凑 JSON：没有换行和缩进，解析得开', info.text.length > 100 && !info.text.includes('\n') && info.payload && JSON.stringify(info.payload) === info.text, info.text.slice(0, 80));
  const cat = info.payload?.catalog ?? [];
  const listed = ((await rpc('tools/list', {}, bare.token)).body?.result?.tools ?? []);
  // 目录分层（渐进开放第 1 步）：默认只给索引，参数表按名字取
  const fullInfo = await tool(bare.token, 'access_info', { full: true });
  const fullCat = fullInfo.payload?.catalog ?? [];
  ok('access_info 默认只给索引：每项没有参数表，说明压成一行（不超过 80 字、没有换行和控制字符），目录项数和全量一样',
    cat.length > 30 && cat.length === fullCat.length && cat.every((t) => !('input_schema' in t) && typeof t.description === 'string' && t.description.length > 0 && [...t.description].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(t.description)),
    J(cat.filter((t) => 'input_schema' in t || [...(t.description ?? '')].length > 80).map((t) => t.name)));
  // #481 ratio ruling: all sizes are UTF-8 bytes; the old relative percentage is diagnostic only.
  const defaultBytes = Buffer.byteLength(info.text, 'utf8'), fullBytes = Buffer.byteLength(fullInfo.text, 'utf8');
  const schemaBytes = fullCat.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t.input_schema), 'utf8'), 0);
  const indexMetrics = { defaultBytes, fullBytes, schemaBytes, savedBytes: fullBytes - defaultBytes, catalogItems: cat.length, defaultBudgetBytes: 280 * cat.length };
  console.log('NEWCOMER_INDEX_METRICS ' + J(indexMetrics));
  console.log(`INFO 原25%比例只打印不判：字符 ${info.text.length}/${fullInfo.text.length}（${(100 * info.text.length / fullInfo.text.length).toFixed(2)}%），UTF-8字节 ${defaultBytes}/${fullBytes}（${(100 * defaultBytes / fullBytes).toFixed(2)}%）`);
  ok('G2 默认索引真实节省不少于全部 input_schema 的 JSON UTF-8 字节', fullBytes - defaultBytes >= schemaBytes, J(indexMetrics));
  ok('G3 默认完整应答 UTF-8 字节不超过每目录项 280B', defaultBytes <= 280 * cat.length, J(indexMetrics));
  ok('应答里写着怎么取参数表', typeof info.payload?.how_to_detail === 'string' && info.payload.how_to_detail.includes('access_info'));
  ok('老客户端带 full: true 照样拿全量：每项带参数表，说明是原文', fullCat.length > 30 && fullCat.every((t) => t.input_schema && t.input_schema.type === 'object') && fullCat.some((t) => [...t.description].length > 80));
  // 逐字节对照：scripts/fixtures/access-info-full-baseline.json 是加 result_read 之前（main 79f539a5，第 1 步和不缩进都已合入）
  // 同样配置下 access_info {full: true} 的原样应答（实例地址随端口变，两边都写成 {{origin}} 再比）。
  // 第 1 步那时的基准对的是第 1 步之前的 access_info {}，证明了 full 和老的整份目录逐字节相同；这一份接着那一份，往下传。
  // 只把以后各步已经明确的工具和字段变化加进期望，其余维持逐字节相同。
  // 工具目录以后再变（加了、删了工具），这一条会红：那时照这里的做法重抓基准，把那一次加的、删的写进期望
  {
    const { readFileSync } = await import('node:fs');
    // 有意新增的报告工具，按目录里的位置放回历史基准再比。
    const ADDED = ['invoke', 'result_read', 'report_list', 'report_get', 'report_generate', 'report_dimension_get', 'report_template_get', 'report_binding_get', 'report_respond'];
    // 有意改了参数表的工具：去掉这次加的那一处，应当和基准一字不差；放回基准时用现在的那一项
    // dataset_query：查询描述加了 current_only（公共区的数据集只取每条更正链最新那行）
    // view_put：从历史基准到当下已新增 records、dag、gantt 和 flow（若流程图已合入）。
    const CHANGED = {
      access_info: (t) => {
        const c = JSON.parse(J(t));
        delete c.input_schema.properties.capability;
        delete c.input_schema.properties.area;
        c.input_schema.properties.ref.description = c.input_schema.properties.ref.description.replace(/、area-1$/, '');
        return c;
      },
      access_request: (t) => {
        const c = JSON.parse(J(t));
        c.description = c.description.replace('领域接入改填 area 和 actions，须有可信责任人，由属主或本领域负责人审批。不会增加 tools/list 中的工具。', '');
        delete c.input_schema.properties.area;
        delete c.input_schema.properties.actions;
        delete c.input_schema.properties.report_scope;
        c.input_schema.required.unshift('tools');
        delete c.input_schema.oneOf;
        return c;
      },
      // app_files_list（#1055）：加了短时下载票——说明末尾一段和三个参数（ticket_for_id、max_uses、revoke_ticket）
      app_files_list: (t) => {
        const c = JSON.parse(J(t));
        c.description = c.description.slice(0, c.description.indexOf('下载票：交给'));
        for (const k of ['ticket_for_id', 'max_uses', 'revoke_ticket']) delete c.input_schema.properties[k];
        return c;
      },
      dataset_query: (t) => { const c = JSON.parse(J(t)); delete c.input_schema.properties.query.properties.current_only; return c; },
      view_put: (t) => {
        const c = JSON.parse(J(t));
        c.input_schema.properties.doc.description = c.input_schema.properties.doc.description
          .replace(' / records / ', ' / ').replace(' / dag / gantt / flow。', '。').replace(' / dag / gantt。', '。');
        return c;
      },
    };
    const before = JSON.parse(readFileSync(new URL('./fixtures/access-info-full-baseline.json', import.meta.url), 'utf8'));
    const nowText = fullInfo.text.split(BASE).join('{{origin}}');
    const nowFull = JSON.parse(nowText);
    const added = nowFull.catalog.map((t) => t.name).filter((n) => !before.catalog.some((t) => t.name === n));
    const removed = before.catalog.map((t) => t.name).filter((n) => !nowFull.catalog.some((t) => t.name === n));
    const changed = before.catalog.filter((t) => J(t) !== J(nowFull.catalog.find((x) => x.name === t.name))).map((t) => t.name);
    const declaredOk = Object.entries(CHANGED).every(([name, undo]) => { const now = nowFull.catalog.find((x) => x.name === name), old = before.catalog.find((x) => x.name === name); return now && old && J(undo(now)) === J(old); });
    const changedNow = new Map(nowFull.catalog.filter((t) => Object.hasOwn(CHANGED, t.name)).map((t) => [t.name, t]));
    // 把这次加的那几项按它们现在的位置放回基准里，再和现在的应答逐字节比
    const insertAt = (list, items, nameOf) => { const out = [...list]; for (const it of items) { const i = nowFull.catalog.findIndex((x) => x.name === nameOf(it)); out.splice(i, 0, it); } return out; };
    const newEntries = nowFull.catalog.filter((t) => ADDED.includes(t.name));
    const patched = { ...before, granted_tools: (() => { const out = [...before.granted_tools]; for (const name of ADDED) { const i = nowFull.granted_tools.indexOf(name); if (i >= 0) out.splice(i, 0, name); } return out; })(), catalog: insertAt(before.catalog.map((t) => changedNow.get(t.name) ?? t), newEntries, (t) => t.name) };
    const reportCaps = [
      { name: 'report.governance-propose', description: '提出报告治理请求，由站内有权的人确认', area: '按目标台和维度', kind: 'decide', granted: false },
      { name: 'report.governance-result', description: '查询本会话提出的报告治理请求', area: '按原目标台和维度', kind: 'read', granted: false },
    ];
    const expected = Object.fromEntries(Object.entries(patched).flatMap(([key, value]) => key === 'catalog' ? [[key, value], ['capabilities', reportCaps]] : [[key, value]]));
    ok('full: true 只含已列明的目录与字段变化，其余逐字节相同', J(added) === J(ADDED) && removed.length === 0 && J(changed) === J(Object.keys(CHANGED)) && declaredOk && JSON.stringify(expected) === nowText,
      J({ added, removed, changed, declaredOk, bytes: [Buffer.byteLength(nowText), Buffer.byteLength(JSON.stringify(expected))] }));
  }
  const details = await Promise.all(listed.map((t) => tool(bare.token, 'access_info', { tool: t.name })));
  ok('按名字取参数表（access_info {tool}）：和 tools/list 里的 inputSchema 一样，说明是原文（新人不用先申请才知道参数名）',
    details.every((d, i) => d.payload?.tool?.name === listed[i].name && J(d.payload.tool.input_schema) === J(listed[i].inputSchema) && d.payload.tool.description === listed[i].description),
    J(details.map((d) => d.text.slice(0, 60))));
  const notGranted = await tool(bare.token, 'access_info', { tool: 'workbench_vars_set' });
  ok('没批的工具也能取参数表，标 granted=false', notGranted.payload?.tool?.granted === false && notGranted.payload.tool.input_schema?.type === 'object', notGranted.text.slice(0, 120));
  const ss = await tool(bare.token, 'access_info', { tool: 'skill_search' });
  ok('skill_search 的参数表里写着 need（冷读里猜成 query 的那个）', J(ss.payload?.tool?.input_schema?.required) === J(['need']));
  // 一行说明的压法：上游聚合来的说明是别人写的，只当数据——去控制字符、只取第一句、限长
  const { catalogSummary } = await import('../server/src/mcp-tools.ts');
  const evil = catalogSummary('第一句\u0007话\n第二行；第二句。'), long = catalogSummary('长'.repeat(200));
  ok('一行说明：去掉控制字符和换行，只取第一句；超长截到 80 字加省略号', evil === '第一句 话 第二行；' && [...long].length === 80 && long.endsWith('…'), J([evil, long.length]));
  const fmt = catalogSummary('看\u202e反过来\u2066隔离\u2069零\u200b宽\u200d连\ufeff结。');
  ok('一行说明：方向控制符（U+202E、U+2066、U+2069）和零宽字符（U+200B、U+200D、U+FEFF）这类格式字符都去掉', fmt === '看反过来隔离零宽连结。' && !/\p{Cf}/u.test(fmt), J(fmt));
  const unknown = await tool(bare.token, 'access_info', { tool: 'no_such_tool' });
  ok('取不存在的工具：报错，不编一个出来', unknown.isError && /目录里没有/.test(unknown.text), unknown.text.slice(0, 120));
  const both = await tool(bare.token, 'access_info', { tool: 'skill_search', full: true });
  ok('tool、full、ref 一次只能给一个', both.isError, both.text.slice(0, 120));
  ok('读技能的三个工具在目录里标 always_allowed、granted；下载、版本链、上传、发布照旧 granted=false',
    SKILL_READS.every((n) => cat.find((t) => t.name === n)?.always_allowed === true && cat.find((t) => t.name === n)?.granted === true)
    && ['skill_download', 'skill_versions', 'skill_file_put', 'skill_publish'].every((n) => cat.find((t) => t.name === n)?.granted === false && !cat.find((t) => t.name === n)?.always_allowed));
  for (const n of ['skill_download', 'skill_versions', 'skill_file_put', 'skill_publish']) {
    const r = await tool(bare.token, n, n === 'skill_file_put' ? { content: 'x' } : { slug: 'newcomer-guide' });
    ok(`零授权调 ${n}：照旧按不存在应答（放开的只有三个读）`, r.rpcError?.code === -32601, J(r.rpcError ?? r.text.slice(0, 80)));
  }
  ok('匿名调 skill_read 401（免授权≠免认证）', (await rpc('tools/call', { name: 'skill_read', arguments: { slug: 'x' } })).status === 401);
  ok('无效令牌调 skills_list 401', (await rpc('tools/call', { name: 'skills_list', arguments: {} }, 'f'.repeat(64))).status === 401);

  // ---------- 三（前半）、空库 ----------
  let r = await tool(bare.token, 'skill_search', { need: '查一个工作台里的合成数据并按区域统计' });
  ok('空库：skill_search 不报错、不调评估模型，直说这个实例还没有导入技能', !r.isError && r.payload?.candidates_total === 0 && /还没有导入技能/.test(r.payload?.note ?? ''), r.text.slice(0, 200));
  r = await tool(bare.token, 'skills_list', {});
  ok('空库：skills_list 回空数组', !r.isError && J(r.payload) === '[]', r.text.slice(0, 120));

  // ---------- 二、skill_read ----------
  const pub = await newSession('newcomer-publisher', ['skill_file_put', 'skill_publish']);
  const SKILL_MD = '---\nname: newcomer-guide\ndescription: 合成的入门技能，给新来的席位看怎么申请工具\n---\n\n# 入门\n\n先调 access_info。\n';
  const REF = '# 参考\n\n合成的参考文件。\n';
  const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
  const put = async (content, encoding) => (await tool(pub.token, 'skill_file_put', { content, ...(encoding ? { encoding } : {}) })).payload?.sha256;
  const files = [
    { path: 'SKILL.md', sha256: await put(SKILL_MD) },
    { path: 'references/basics.md', sha256: await put(REF) },
    { path: 'assets/logo.png', sha256: await put(BIN.toString('base64'), 'base64') },
  ];
  r = await tool(pub.token, 'skill_publish', { slug: 'newcomer-guide', files, changelog: '合成' });
  ok('准备：发布一个合成技能（SKILL.md、一个参考文件、一个二进制）', !r.isError && r.payload?.version === 1, r.text.slice(0, 200));
  // 快照里放一个指到快照外的符号链接（模拟库被动过手脚）：不能被读出来，也不列
  const snap = join(DATA, 'skill-snapshots', encodeURIComponent('newcomer-guide'), 'v1');
  writeFileSync(join(DATA, 'outside-secret.txt'), 'synthetic-outside-secret\n');
  try { symlinkSync(join(process.cwd(), DATA, 'outside-secret.txt'), join(snap, 'references', 'leak.md')); } catch { /* 平台不支持符号链接就跳过这一条 */ }
  // 硬链接：和快照外的文件是同一份（lstat 看着是普通文件），一样不能读、不列
  try { linkSync(join(DATA, 'outside-secret.txt'), join(snap, 'references', 'hard.md')); } catch { /* 跨设备等建不了就跳过 */ }
  // 指向目录的符号链接、真的子目录名：都不是文件
  try { symlinkSync(join(process.cwd(), DATA), join(snap, 'references', 'dirlink')); } catch { /* 跳过 */ }

  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide' });
  ok('零授权 skill_read：缺省读 SKILL.md，原文、版本、sha256 都给', !r.isError && r.payload?.path === 'SKILL.md' && r.payload?.content === SKILL_MD && r.payload?.version === 1
    && r.payload?.sha256 === createHash('sha256').update(SKILL_MD).digest('hex'), r.text.slice(0, 200));
  ok('skill_read：列出这一版的文件（只有普通文件；快照外的符号链接不列）', J((r.payload?.files ?? []).map((f) => f.path)) === J(['SKILL.md', 'assets/logo.png', 'references/basics.md']), J(r.payload?.files));
  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide', path: 'references/basics.md' });
  ok('skill_read：按 path 读参考文件', !r.isError && r.payload?.content === REF, r.text.slice(0, 120));
  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide', path: 'assets/logo.png' });
  ok('skill_read：二进制不给内容，只给大小和摘要，并指向 skill_download', !r.isError && r.payload?.binary === true && r.payload?.content === undefined && r.payload?.size === BIN.length && /skill_download/.test(r.payload?.note ?? ''), r.text.slice(0, 160));
  const missing = (await tool(bare.token, 'skill_read', { slug: 'newcomer-guide', path: 'nope.md' })).text;
  for (const p of ['references/leak.md', 'references/hard.md', 'references/dirlink', 'references/dirlink/outside-secret.txt', 'references', '../v1/SKILL.md', 'references/../SKILL.md', './SKILL.md', '/etc/hosts', 'references\\basics.md', join(process.cwd(), DATA, 'outside-secret.txt'), '.wm-skill.json']) {
    const x = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide', path: p });
    ok(`skill_read 读不到快照外或不规范的路径（${p.length > 40 ? '绝对路径' : p}）：和没有这个文件同一句`, x.isError && x.text.replace(p, 'P') === missing.replace('nope.md', 'P') && !x.text.includes('synthetic-outside-secret'), x.text.slice(0, 160));
  }
  r = await tool(bare.token, 'skill_read', { slug: 'no-such-skill' });
  ok('skill_read 没有这个技能：说没有、并指向 skills_list', r.isError && /skill not found|没有这个技能/.test(r.text) && /skills_list/.test(r.text), r.text.slice(0, 160));
  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide', version: 9 });
  ok('skill_read 版本不存在：说版本不存在', r.isError && /version not found|版本/.test(r.text), r.text.slice(0, 120));

  // ---------- 五、技能名不带来源前缀 ----------
  // 技能正文里写的是短名字（wm-data-views 这样），库里是带来源前缀的完整名字（agents:…）：按去掉前缀的名字找，唯一就用它，多个同名就列出完整名字
  const pubDl = await newSession('newcomer-downloader', ['skill_download']);
  const one = async (slug, md) => (await tool(pub.token, 'skill_publish', { slug, files: [{ path: 'SKILL.md', sha256: await put(md) }], changelog: '合成' })).payload?.version;
  ok('准备：发布 agents:newcomer-short（只有一个来源）和两个来源都有的 dup-guide', await one('agents:newcomer-short', '# 短名字\n') === 1 && await one('agents:dup-guide', '# 甲\n') === 1 && await one('jf:dup-guide', '# 乙\n') === 1);
  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-short' });
  ok('skill_read 用短名字：只有一个来源，就读它，应答里给完整名字', !r.isError && r.payload?.slug === 'agents:newcomer-short' && r.payload?.content === '# 短名字\n', r.text.slice(0, 160));
  r = await tool(bare.token, 'skill_read', { slug: 'dup-guide' });
  ok('skill_read 用短名字、两个来源同名：说有几个同名技能、请用完整名字，并列出完整名字', r.isError && /2 个同名技能/.test(r.text) && r.text.includes('agents:dup-guide') && r.text.includes('jf:dup-guide'), r.text.slice(0, 200));
  r = await tool(bare.token, 'skill_read', { slug: 'jf:dup-guide' });
  ok('skill_read 用完整名字：照常读', !r.isError && r.payload?.content === '# 乙\n');
  r = await tool(bare.token, 'skill_read', { slug: 'newcomer-guide' });
  ok('不带前缀的完整名字（库里本来就没有前缀）：照常读，不当短名字去找', !r.isError && r.payload?.slug === 'newcomer-guide');
  r = await tool(pubDl.token, 'skill_download', { slug: 'newcomer-short' });
  ok('skill_download 用短名字：唯一就签发，应答里是完整名字', !r.isError && r.payload?.slug === 'agents:newcomer-short' && /^http/.test(r.payload?.download_url ?? ''), r.text.slice(0, 160));
  r = await tool(pubDl.token, 'skill_download', { slug: 'dup-guide' });
  ok('skill_download 用短名字、多个同名：一样列出完整名字，不签发', r.isError && r.text.includes('agents:dup-guide') && r.text.includes('jf:dup-guide') && !/download_url/.test(r.text), r.text.slice(0, 200));
  r = await tool(bare.token, 'skills_list', {});
  const byFull = Object.fromEntries((r.payload ?? []).map((x) => [x.slug, x.short_name]));
  ok('skills_list 每项同时给完整名字（slug）和短名字（short_name）', byFull['agents:newcomer-short'] === 'newcomer-short' && byFull['jf:dup-guide'] === 'dup-guide' && byFull['newcomer-guide'] === 'newcomer-guide', J(byFull));

  // ---------- 三（后半）、有技能但没有够格的 ----------
  r = await tool(bare.token, 'skill_search', { need: '查一个工作台里的合成数据并按区域统计' });
  ok('有技能时：skill_search 不再说「还没有导入技能」', !/还没有导入技能/.test(r.text), r.text.slice(0, 200));
  // 这个实例没配评估模型（没有 AI_GATEWAY_API_KEY）：退回关键词匹配（标题、描述、短名字），应答注明不是置信度
  r = await tool(bare.token, 'skill_search', { need: '新来的席位想知道怎么申请工具' });
  ok('没配评估模型：skill_search 退回关键词匹配，搜得到（描述里的词），应答注明是关键词匹配', !r.isError && r.payload?.match === 'keyword' && (r.payload?.items ?? []).some((x) => x.slug === 'newcomer-guide') && /关键词匹配/.test(r.payload?.note ?? ''), r.text.slice(0, 300));
  ok('关键词匹配的每项不带 confidence（不是模型打的分），带命中的词数和短名字', (r.payload?.items ?? []).every((x) => x.confidence === undefined && Number.isInteger(x.keyword_hits) && x.keyword_hits > 0 && typeof x.short_name === 'string'), J(r.payload?.items));
  r = await tool(bare.token, 'skill_search', { need: 'newcomer-short' });
  ok('关键词匹配：按短名字也搜得到', (r.payload?.items ?? []).some((x) => x.slug === 'agents:newcomer-short'), J(r.payload?.items));
  r = await tool(bare.token, 'skill_search', { need: '完全不相干的词语组合xyzzy' });
  ok('关键词匹配一个都没命中：空列表，说清是关键词没命中、可以用 skills_list 看全部', !r.isError && (r.payload?.items ?? []).length === 0 && /关键词/.test(r.payload?.note ?? '') && /skills_list/.test(r.payload?.note ?? ''), r.text.slice(0, 200));
  r = await tool(bare.token, 'skills_list', {});
  ok('有技能时：零授权 skills_list 列得出', !r.isError && (r.payload ?? []).some((s) => s.slug === 'newcomer-guide'), r.text.slice(0, 120));
  ok('skills_list 每项带一句描述（SKILL.md frontmatter 的 description）', (r.payload ?? []).find((s) => s.slug === 'newcomer-guide')?.description === '合成的入门技能，给新来的席位看怎么申请工具', J((r.payload ?? []).find((s) => s.slug === 'newcomer-guide')));

  // ---------- 四、申请 ----------
  const a1 = await tool(bare.token, 'access_request', { tools: ['workbench_summary'], reason: '合成：看总览' });
  const q1 = a1.payload?.request;
  ok('通用申请：编号带前缀 mcp-，created_at 是 ISO', /^mcp-\d+$/.test(q1?.ref ?? '') && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(q1?.created_at ?? ''), J(q1));
  ok('通用申请：应答写清批了之后怎么知道（回头调 access_info，用编号查这一条；批了 tools/list 就多出来）', /access_info/.test(a1.payload?.next ?? '') && (a1.payload?.next ?? '').includes(q1?.ref ?? '#') && /tools\/list/.test(a1.payload?.next ?? ''), a1.text.slice(0, 300));
  const b1 = await tool(bare.token, 'access_request', { tools: ['dataset_list@bench:newcomer-bench'], reason: '合成：看数据集' });
  const qb = b1.payload?.request;
  ok('台申请：编号带前缀 bench-，和通用申请不会撞（两套各自从 1 起）', /^bench-\d+$/.test(qb?.ref ?? '') && qb.ref !== q1?.ref && Number(qb.ref.slice(6)) === Number(q1?.ref?.slice(4)), J([q1?.ref, qb?.ref]));
  ok('台申请：created_at 也是 ISO（原来是毫秒数）', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(qb?.created_at ?? ''), J(qb));
  ok('台申请：照旧不核台存不存在；应答说清只核写法、写错了不会有人批、拿编号和标识去找给任务的人核对，以及批了怎么知道',
    !b1.isError && /只核写法/.test(b1.payload?.note ?? '') && (b1.payload?.note ?? '').includes(qb?.ref ?? '#') && /access_info/.test(b1.payload?.next ?? ''), b1.text.slice(0, 300));
  const b2 = await tool(other.token, 'access_request', { tools: ['dataset_list@bench:missing-bench-zz'], reason: '合成' });
  ok('台申请：不存在的台和存在的台应答一样（不泄露存在性）', !b2.isError && b2.payload?.note?.replace(b2.payload.request.ref, 'R').replace('missing-bench-zz', 'B') === b1.payload?.note?.replace(qb.ref, 'R').replace('newcomer-bench', 'B'), b2.text.slice(0, 200));

  // 按台限定的工具写成 工具@台的标识（slug）：服务端换成台号；换不到和数字台号不存在同一句；不支持按台的工具说清不支持，不说「不在目录」
  const wbs = (await call('GET', '/api/workbenches', null, AT)).body ?? [];
  const tc = wbs.find((w) => /\/(sop|apps)\/task-center\/$/.test(String(w.url)));
  const s1 = await tool(other.token, 'access_request', { tools: ['workbench_vars_get@task-center'], reason: '合成：读任务中心的变量' });
  ok('工具@台的标识：服务端换成台号记进申请（不再报「不在工具目录里」）', !!tc && !s1.isError && J(s1.payload?.request?.tools) === J([`workbench_vars_get@${tc.id}`]), J([tc, s1.text.slice(0, 200)]));
  const s2 = await tool(other.token, 'access_request', { tools: ['workbench_vars_get@no-such-bench-zz'], reason: '合成' });
  const s3 = await tool(other.token, 'access_request', { tools: ['workbench_vars_get@999999'], reason: '合成' });
  ok('工具@不存在的台的标识：和数字台号不存在同一句', s2.isError && s3.isError && s2.text.replace('no-such-bench-zz', 'X') === s3.text.replace('999999', 'X'), J([s2.text, s3.text]));
  const s4 = await tool(other.token, 'access_request', { tools: ['workbench_summary@task-center'], reason: '合成' });
  ok('不支持按台的工具写了 @台的标识：说这个工具暂不支持按台申请，不说不在目录', s4.isError && /暂不支持按台申请/.test(s4.text) && !/不在工具目录/.test(s4.text), s4.text.slice(0, 160));
  ok('access_info 的申请写法说清：数字台号，自产台、SOP 台也可以写台的标识', /数字台号/.test(info.payload?.how_to_request ?? '') && /台的标识/.test(info.payload?.how_to_request ?? ''), info.payload?.how_to_request);

  r = await tool(bare.token, 'access_info', { ref: q1.ref });
  ok('access_info {ref}：只回这一条（自己的通用申请）', J(r.payload?.request?.ref) === J(q1.ref) && r.payload?.request?.status === 'pending' && r.payload?.catalog === undefined, r.text.slice(0, 200));
  r = await tool(bare.token, 'access_info', { ref: qb.ref });
  ok('access_info {ref}：台申请也查得到', r.payload?.request?.ref === qb.ref && r.payload.request.bench === 'newcomer-bench', r.text.slice(0, 200));
  const notMine = await tool(other.token, 'access_info', { ref: q1.ref });
  const nowhere = await tool(other.token, 'access_info', { ref: 'mcp-99999' });
  ok('access_info {ref}：别的会话的申请和不存在的同一句', notMine.isError && nowhere.isError && notMine.text.replace(q1.ref, 'R') === nowhere.text.replace('mcp-99999', 'R'), J([notMine.text, nowhere.text]));
  const otherBench = await tool(other.token, 'access_info', { ref: qb.ref });
  ok('access_info {ref}：别的会话的台申请也一样', otherBench.isError && otherBench.text.replace(qb.ref, 'R') === nowhere.text.replace('mcp-99999', 'R'), otherBench.text);
  for (const bad of ['12', 'mcp-', 'mcp-0', 'MCP-1', 'mcp-1x', 'bench--1']) {
    const x = await tool(bare.token, 'access_info', { ref: bad });
    ok(`access_info {ref:${bad}}：写法不对说清怎么写`, x.isError && /mcp-<编号>|bench-<编号>/.test(x.text), x.text.slice(0, 120));
  }
  // 批了之后：decided_at 也是 ISO
  await call('POST', `/api/mcp/access-requests/${q1.ref.slice(4)}/approve`, { note: '合成' }, AT);
  r = await tool(bare.token, 'access_info', { ref: q1.ref });
  ok('批准之后：access_info {ref} 看得到 approved，decided_at 是 ISO', r.payload?.request?.status === 'approved' && /Z$/.test(r.payload.request.decided_at ?? ''), r.text.slice(0, 200));
  ok('批准之后：tools/list 多出所批的工具', (await listNames(bare.token)).includes('workbench_summary'));
  const full = await tool(bare.token, 'access_info');
  ok('access_info 的申请列表里两种都带 ref、时间都是 ISO', (full.payload?.requests ?? []).every((q) => /^mcp-\d+$/.test(q.ref) && /Z$/.test(q.created_at)) && (full.payload?.bench_requests ?? []).every((q) => /^bench-\d+$/.test(q.ref) && /Z$/.test(q.created_at)), J([full.payload?.requests, full.payload?.bench_requests]).slice(0, 300));

  // 吊销之后：读技能也 401
  await call('DELETE', `/api/mcp/sessions/${other.id}`, null, AT);
  ok('已吊销的会话调 skill_read 401', (await rpc('tools/call', { name: 'skill_read', arguments: { slug: 'newcomer-guide' } }, other.token)).status === 401);
  // REST 通道同样免授权
  const rest = await call('POST', '/api/mcp-rest/tools/skill_read', { slug: 'newcomer-guide' }, { Authorization: `Bearer ${bare.token}` });
  ok('REST 通道：零授权会话 skill_read 一样能读', rest.status === 200 && JSON.stringify(rest.body).includes('入门'), J(rest).slice(0, 160));
} catch (e) {
  fail++; console.log('  ✗ 没跑完：' + String(e?.stack ?? e).slice(0, 400));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nmcp-newcomer-test: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
