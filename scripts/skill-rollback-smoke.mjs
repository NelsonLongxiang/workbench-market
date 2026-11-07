#!/usr/bin/env node
/** 技能回滚=移「当前版本」指针：发 v1/v2 后回滚到 v1 不再撞 (skill_id, tree_digest) 唯一索引（旧实现复制出同指纹 N+1 → 500）；
 *  回滚后缺省取装/导出/下载/安装计划/校验都拿 v1 的内容，含 base64 二进制的版本逐字节一致；经 MCP 变更申请批准的同一执行体可前移回 v2；
 *  发布新版恢复跟随最新；预置的孤儿 v{N+1}/（旧实现回滚失败留下的）发布时先挪进 .orphans/，不混进新版本。合成数据 + 全新 DATA_DIR + 随机回环端口。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const TMP = resolve('tmp/skill-rollback-smoke-' + Date.now().toString(36));
const DATA = join(TMP, 'data');
mkdirSync(DATA, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const PORT = 20000 + Math.floor(Math.random() * 12000);
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'rb-smoke' };
for (const k of ['REDIS_URL', 'LAYERFS_SERVICE_URL', 'LAYERFS_SERVICE_TOKEN', 'LAYERFS_SERVICE_TOKEN_FILE', 'WM_EXTENSIONS_DIR']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));

const B = `http://127.0.0.1:${PORT}`;
const AT = { 'Content-Type': 'application/json', 'X-Admin-Token': 'rb-smoke' };
const post = async (u, body, h = AT) => { const r = await fetch(B + u, { method: 'POST', headers: h, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const get = async (u) => { const r = await fetch(B + u, { headers: AT }); return r.json(); };
const rpc = async (name, args) => {
  const j = await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json();
  try { return JSON.parse(j.result?.content?.[0]?.text ?? 'null'); } catch { return j; }
};
const digest = (files) => {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) { h.update(f.path); h.update('\0'); h.update(createHash('sha256').update(f.bytes).digest('hex')); h.update('\0'); }
  return h.digest('hex');
};
/** 解 ustar：只取普通文件 name → bytes */
const untar = (buf) => {
  const out = new Map();
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.subarray(o, o + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(o + 124, o + 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
    out.set(name, Buffer.from(buf.subarray(o + 512, o + 512 + size)));
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};
/** MCP skill_download 不带版本 → 取票据下载 .tar.gz 包 */
const downloadPkg = async () => {
  const dl = await rpc('skill_download', { slug });
  const r = await fetch(dl?.download_url ?? `${B}/-`);
  return { dl, digest: r.headers.get('x-expected-digest'), files: r.ok ? untar(gunzipSync(Buffer.from(await r.arrayBuffer()))) : new Map() };
};
const exportTar = async (q = '') => { const r = await fetch(`${B}/api/skills/${S}/export${q}`); return { digest: r.headers.get('x-expected-digest'), files: untar(Buffer.from(await r.arrayBuffer())) }; };

// 合成二进制：PNG 头 + 全部 256 个字节值（含 0x00、0x80–0xFF 这类非 UTF-8 序列）；v2 换掉尾部字节
const png1 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
const png2 = Buffer.concat([png1, Buffer.from([0xff, 0xfe, 0x00])]);
const md1 = '---\nname: rb-probe\ndescription: 回滚探针 v1\n---\nv1 body';
const md2 = '---\nname: rb-probe\ndescription: 回滚探针 v2\n---\nv2 body';
const md3 = '---\nname: rb-probe\ndescription: 回滚探针 v3\n---\nv3 body';
const slug = 'rb:probe';
const S = encodeURIComponent(slug);
const filesOf = (md, png) => [{ path: 'SKILL.md', content: md }, { path: 'assets/logo.png', content: png.toString('base64'), encoding: 'base64' }];
const d1 = digest([{ path: 'SKILL.md', bytes: Buffer.from(md1) }, { path: 'assets/logo.png', bytes: png1 }]);
const d2 = digest([{ path: 'SKILL.md', bytes: Buffer.from(md2) }, { path: 'assets/logo.png', bytes: png2 }]);

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch {} await new Promise((x) => setTimeout(x, 250)); }

  // 1) 发 v1、v2（都含二进制）
  let r = await post(`/api/skills/${S}/versions`, { files: filesOf(md1, png1), changelog: 'v1', reviewed_by: 'smoke' });
  ok('发 v1', r.status === 201 && r.body?.version === 1 && r.body?.tree_digest === d1, JSON.stringify(r.body));
  r = await post(`/api/skills/${S}/versions`, { files: filesOf(md2, png2), changelog: 'v2', reviewed_by: 'smoke' });
  ok('发 v2', r.status === 201 && r.body?.version === 2 && r.body?.tree_digest === d2, JSON.stringify(r.body));
  ok('未回滚时当前版本=最新 v2', (await get('/api/skills')).find((s) => s.slug === slug)?.active_version === 2);

  // 2) 回滚到 v1：成功、不新增版本
  r = await post(`/api/skills/${S}/activate`, { version: 1, reviewed_by: 'smoke' });
  ok('回滚到 v1 → 200（不再撞唯一索引 500）', r.status === 200 && r.body?.active_version === 1 && r.body?.previous_version === 2 && r.body?.tree_digest === d1, `${r.status} ${JSON.stringify(r.body)}`);
  let vs = await get(`/api/skills/${S}/versions`);
  ok('版本链不变（仍 2 个版本，只增不减）', vs.versions?.length === 2 && vs.versions.map((v) => v.version).join() === '2,1', JSON.stringify(vs.versions?.map((v) => v.version)));
  ok('版本列表标出当前版本 v1', vs.active_version === 1 && vs.versions.find((v) => v.active)?.version === 1, JSON.stringify(vs.versions?.map((v) => [v.version, v.active])));
  const listed = (await get('/api/skills')).find((s) => s.slug === slug);
  ok('技能列表 active_version=1', listed?.active_version === 1, JSON.stringify(listed));
  const mList = await rpc('skills_list', {});
  ok('MCP skills_list active_version=1', (Array.isArray(mList) ? mList : mList?.items ?? []).find((s) => s.slug === slug)?.active_version === 1, JSON.stringify(mList).slice(0, 300));
  const mVers = await rpc('skill_versions', { slug });
  ok('MCP skill_versions 标出当前 v1', Array.isArray(mVers) && mVers.find((v) => v.active)?.version === 1, JSON.stringify(mVers).slice(0, 300));

  // 3) 回滚后缺省取装/导出/安装计划/校验都是 v1
  let tar = await exportTar();
  ok('缺省导出=v1：摘要头', tar.digest === d1, String(tar.digest));
  ok('缺省导出=v1：文本', tar.files.get('probe/SKILL.md')?.toString('utf8') === md1);
  ok('缺省导出=v1：二进制逐字节一致', tar.files.get('probe/assets/logo.png')?.equals(png1) === true);
  let pkg = await downloadPkg();
  ok('回滚后不带版本下载=v1（签发版本与摘要头）', pkg.dl?.version === 1 && pkg.dl?.tree_digest === d1 && pkg.digest === d1, JSON.stringify(pkg.dl).slice(0, 300));
  ok('回滚后下载包内二进制与 v1 逐字节一致', pkg.files.get('rb.probe/assets/logo.png')?.equals(png1) === true && pkg.files.get('rb.probe/SKILL.md')?.toString('utf8') === md1, [...pkg.files.keys()].join(','));
  const plan = await rpc('skill_install_plan', { slug });
  ok('MCP 安装计划缺省=v1', plan?.version === 1 && plan?.expected_sha256 === d1 && /version=1$/.test(plan?.export_url ?? ''), JSON.stringify(plan));
  r = await post(`/api/skills/${S}/install`, { installed_by: 'smoke' });
  ok('缺省取装=v1', r.status === 201 && r.body?.version === 1 && r.body?.expected_digest === d1, `${r.status} ${JSON.stringify(r.body)}`);
  let ver = await get(`/api/skills/${S}/verify`);
  ok('钉装校验 ok（按字节重算=v1 指纹）', ver.ok === true && ver.expected === d1 && ver.actual === d1, JSON.stringify(ver));
  const listed2 = (await get('/api/skills')).find((s) => s.slug === slug);
  ok('钉装记录 current_version=1', listed2?.current_version === 1 && listed2?.is_installed === true, JSON.stringify(listed2));
  tar = await exportTar('?version=2');
  ok('显式 version=2 仍可导出 v2（快照未动）', tar.digest === d2 && tar.files.get('probe/assets/logo.png')?.equals(png2) === true);

  // 4) 坏输入：不存在的版本 404、缺 reviewed_by 400，当前版本不动
  r = await post(`/api/skills/${S}/activate`, { version: 9, reviewed_by: 'smoke' });
  ok('回滚到不存在的 v9 → 404', r.status === 404, `${r.status}`);
  r = await post(`/api/skills/${S}/activate`, { version: 2 });
  ok('缺 reviewed_by → 400', r.status === 400, `${r.status}`);
  r = await post(`/api/skills/${S}/activate`, { version: 2, reviewed_by: 'smoke' }, { 'Content-Type': 'application/json' });
  ok('无口令 → 401/403', r.status === 401 || r.status === 403, `${r.status}`);
  ok('失败请求后当前版本仍 v1', (await get(`/api/skills/${S}/versions`)).active_version === 1);

  // 5) MCP 变更申请 → 批准（同一执行体）：前移回 v2
  const cr = await rpc('change_request_create', { kind: 'skill', op: 'rollback', slug, target_version: 2, reason: 'smoke 前移' });
  ok('MCP 建技能回滚申请', typeof cr?.id === 'number' && cr?.status === 'pending', JSON.stringify(cr));
  ok('批准前当前版本不变', (await get(`/api/skills/${S}/versions`)).active_version === 1);
  r = await post(`/api/change-requests/${cr?.id}/approve`, { reviewed_by: 'smoke-reviewer' });
  ok('批准执行 → 200', r.status === 200 && r.body?.executed === 'skill/rollback', `${r.status} ${JSON.stringify(r.body)}`);
  tar = await exportTar();
  ok('批准后缺省导出=v2（二进制逐字节一致）', tar.digest === d2 && tar.files.get('probe/assets/logo.png')?.equals(png2) === true);
  pkg = await downloadPkg();
  ok('批准后不带版本下载=v2', pkg.dl?.version === 2 && pkg.files.get('rb.probe/assets/logo.png')?.equals(png2) === true, JSON.stringify(pkg.dl).slice(0, 200));

  // 6) 再回 v1（反复回滚不撞）；同内容重发仍 409（不可变锚照旧）
  r = await post(`/api/skills/${S}/activate`, { version: 1, reviewed_by: 'smoke' });
  ok('再次回滚到 v1 → 200', r.status === 200 && r.body?.active_version === 1 && r.body?.previous_version === 2, `${r.status} ${JSON.stringify(r.body)}`);
  r = await post(`/api/skills/${S}/versions`, { files: filesOf(md1, png1), reviewed_by: 'smoke' });
  ok('重发 v1 同内容仍 409（同技能同指纹唯一不变）', r.status === 409, `${r.status}`);

  // 7) 预置孤儿 v3/（旧实现回滚撞索引前已写好的目录：带 v1 的多余文件）；发布新版恢复跟随最新
  const slugDir = join(DATA, 'skill-snapshots', encodeURIComponent(slug));
  mkdirSync(join(slugDir, 'v3', 'docs'), { recursive: true });
  writeFileSync(join(slugDir, 'v3', 'extra.md'), 'orphan extra');
  writeFileSync(join(slugDir, 'v3', 'SKILL.md'), md1);
  writeFileSync(join(slugDir, 'v3', 'docs', 'old.md'), 'orphan nested');
  r = await post(`/api/skills/${S}/versions`, { files: filesOf(md3, png1), changelog: 'v3', reviewed_by: 'smoke' });
  ok('回滚后发 v3 → 201', r.status === 201 && r.body?.version === 3, `${r.status} ${JSON.stringify(r.body)}`);
  vs = await get(`/api/skills/${S}/versions`);
  ok('发布后当前版本=v3', vs.active_version === 3 && vs.versions.find((v) => v.active)?.version === 3, JSON.stringify(vs.versions?.map((v) => [v.version, v.active])));
  const d3 = digest([{ path: 'SKILL.md', bytes: Buffer.from(md3) }, { path: 'assets/logo.png', bytes: png1 }]);
  ok('v3 指纹只按本次发布的文件算', r.body?.tree_digest === d3, String(r.body?.tree_digest));
  const walk = (d, rel = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), rel + e.name + '/') : [rel + e.name]).sort();
  ok('v3 快照目录只含本次发布的文件（孤儿内容没混进来）', walk(join(slugDir, 'v3')).join() === 'SKILL.md,assets/logo.png', walk(join(slugDir, 'v3')).join());
  const orphans = existsSync(join(slugDir, '.orphans')) ? readdirSync(join(slugDir, '.orphans')) : [];
  ok('孤儿目录整体挪进 .orphans/', orphans.length === 1 && /^v3-/.test(orphans[0]) && walk(join(slugDir, '.orphans', orphans[0])).join() === 'SKILL.md,docs/old.md,extra.md', orphans.join());
  ok('没留下临时目录', readdirSync(slugDir).filter((n) => n.includes('.tmp-')).length === 0, readdirSync(slugDir).join());
  tar = await exportTar();
  ok('缺省导出=v3 且只含本次文件', tar.digest === d3 && tar.files.get('probe/SKILL.md')?.toString('utf8') === md3 && [...tar.files.keys()].sort().join() === 'probe/SKILL.md,probe/assets/logo.png', [...tar.files.keys()].join());
  pkg = await downloadPkg();
  const pkgFiles = [...pkg.files.keys()].filter((k) => !/\/\.wm-skill/.test(k)).sort().join();
  ok('不带版本下载=v3，包里不含孤儿文件', pkg.dl?.version === 3 && pkg.dl?.tree_digest === d3 && pkgFiles === 'rb.probe/SKILL.md,rb.probe/assets/logo.png', pkgFiles);
  r = await post(`/api/skills/${S}/install`, { installed_by: 'smoke' });
  ok('缺省取装=v3', r.status === 201 && r.body?.version === 3, `${r.status} ${JSON.stringify(r.body)}`);
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`skill-rollback-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
