#!/usr/bin/env node
/** 技能发布按字节：JSON 发布面收 encoding:'base64' 的二进制文件，快照/回滚/导出/钉装校验都不改坏字节；
 *  MCP 一次只传一个文件：skill_file_put → skill_publish 按 sha256 成版，skill_manifest → skill_file_get 逐个取回。合成数据 + 全新 DATA_DIR + 随机回环端口。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/skill-binary-publish-smoke-' + Date.now().toString(36));
const DATA = join(TMP, 'data');
mkdirSync(DATA, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'bin-smoke' };
for (const k of ['REDIS_URL', 'LAYERFS_SERVICE_URL', 'LAYERFS_SERVICE_TOKEN', 'LAYERFS_SERVICE_TOKEN_FILE', 'WM_EXTENSIONS_DIR']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));

const B = `http://127.0.0.1:${PORT}`;
const AT = { 'Content-Type': 'application/json', 'X-Admin-Token': 'bin-smoke' };
const post = async (u, body, h = AT) => { const r = await fetch(B + u, { method: 'POST', headers: h, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const get = async (u) => { const r = await fetch(B + u); return r.json(); };
const rpc = async (method, params) => (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
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

// 合成二进制：PNG 头 + 全部 256 个字节值（含 0x00、0x80–0xFF 这类非 UTF-8 序列）
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
const skillMd = '---\nname: bin-probe\ndescription: 二进制往返探针\n---\nbody';
const slug = 'bin:probe';
const S = encodeURIComponent(slug);

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch {} await new Promise((x) => setTimeout(x, 250)); }

  // 1) REST 发布：文本 + base64 二进制
  const v1Files = [{ path: 'SKILL.md', content: skillMd }, { path: 'assets/logo.png', content: png.toString('base64'), encoding: 'base64' }];
  const v1Expect = digest([{ path: 'SKILL.md', bytes: Buffer.from(skillMd) }, { path: 'assets/logo.png', bytes: png }]);
  let r = await post(`/api/skills/${S}/versions`, { files: v1Files, changelog: 'v1', reviewed_by: 'smoke' });
  ok('带 base64 二进制的首版发布 201 → v1', r.status === 201 && r.body?.version === 1, JSON.stringify(r.body));
  ok('指纹按原始字节算（与本地重算一致）', r.body?.tree_digest === v1Expect, `${r.body?.tree_digest} vs ${v1Expect}`);
  ok('total_bytes 按字节计', r.body?.total_bytes === Buffer.byteLength(skillMd) + png.length, String(r.body?.total_bytes));
  ok('快照里的二进制文件逐字节一致', readFileSync(join(DATA, r.body?.snapshot_path ?? '-', 'assets/logo.png')).equals(png));

  // 2) 等价写法：文本用 base64 给，与 utf8 给是同一内容 → 409
  r = await post(`/api/skills/${S}/versions`, { files: [{ path: 'SKILL.md', content: Buffer.from(skillMd).toString('base64'), encoding: 'base64' }, v1Files[1]], reviewed_by: 'smoke' });
  ok('文本改用 base64 给出：同内容同指纹 409', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);

  // 3) 坏输入
  r = await post(`/api/skills/${S}/versions`, { files: [{ path: 'a.bin', content: 'not base64!', encoding: 'base64' }] });
  ok('非法 base64 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await post(`/api/skills/${S}/versions`, { files: [{ path: 'a.bin', content: 'QUJD', encoding: 'hex' }] });
  ok('未知 encoding → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await post(`/api/skills/${S}/versions`, { files: [{ path: '../x.bin', content: 'QUJD', encoding: 'base64' }] });
  ok('base64 文件同样走路径校验（.. 段 400）', r.status === 400, `${r.status}`);

  // 4) LayerFS 影子：含二进制的版本记 skipped，不推
  const vs = await get(`/api/skills/${S}/versions`);
  const v1 = vs.versions?.find((v) => v.version === 1);
  ok('含二进制版本的影子记 skipped 并点名文件', v1?.shadow_status === 'skipped' && /assets\/logo\.png/.test(v1?.shadow_error ?? ''), JSON.stringify(v1));

  // 5) 导出 tar 里的二进制逐字节一致
  const tarRes = await fetch(`${B}/api/skills/${S}/export?version=1`);
  const tar = untar(Buffer.from(await tarRes.arrayBuffer()));
  ok('导出 tar 中二进制逐字节一致', tar.get('probe/assets/logo.png')?.equals(png) === true, [...tar.keys()].join(','));
  ok('导出 tar 中文本一致', tar.get('probe/SKILL.md')?.toString('utf8') === skillMd);

  // 6) 钉装后校验：按字节重算 = 期望指纹
  r = await post(`/api/skills/${S}/install`, { version: 1, installed_by: 'smoke' });
  ok('钉装 v1', r.status === 201, `${r.status}`);
  const ver = await get(`/api/skills/${S}/verify`);
  ok('钉装校验 ok（二进制不被误判篡改）', ver.ok === true && ver.expected === v1Expect, JSON.stringify(ver));

  // 7) MCP 上传：一次一个文件 skill_file_put → skill_publish 按 sha256 引用成版
  const tl = await rpc('tools/list', {});
  const names = (tl.result?.tools ?? []).map((t) => t.name);
  ok('MCP 技能传输四工具在 tools/list', ['skill_file_put', 'skill_publish', 'skill_manifest', 'skill_file_get'].every((n) => names.includes(n)), names.join(','));
  const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); let out = null; try { out = JSON.parse(m.result?.content?.[0]?.text ?? 'null'); } catch {} return { m, out, err: m.result?.isError === true || !!m.error }; };
  const png2 = Buffer.concat([png, Buffer.from([0xff, 0xfe])]);
  const p1 = await call('skill_file_put', { content: skillMd });
  const p2 = await call('skill_file_put', { content: png2.toString('base64'), encoding: 'base64' });
  ok('skill_file_put 返回内容 sha256', p1.out?.sha256 === createHash('sha256').update(skillMd).digest('hex') && p2.out?.sha256 === createHash('sha256').update(png2).digest('hex') && p2.out?.size === png2.length, JSON.stringify([p1.out, p2.out]));
  const again = await call('skill_file_put', { content: png2.toString('base64'), encoding: 'base64' });
  ok('同内容重复上传幂等（同 sha256）', again.out?.sha256 === p2.out?.sha256);
  ok('skill_file_put 非法 base64 被拒', (await call('skill_file_put', { content: '@@', encoding: 'base64' })).err);
  let r7 = await call('skill_publish', { slug, files: [{ path: 'SKILL.md', content: skillMd }] });
  ok('skill_publish 不收内联 content（只收 sha256 引用）', r7.err, JSON.stringify(r7.m).slice(0, 200));
  r7 = await call('skill_publish', { slug, files: [{ path: 'SKILL.md', sha256: p1.out.sha256 }, { path: 'missing.txt', sha256: 'a'.repeat(64) }] });
  ok('引用了未上传的文件：拒绝并点名路径', r7.err && /missing\.txt/.test(JSON.stringify(r7.m)), JSON.stringify(r7.m).slice(0, 200));
  r7 = await call('skill_publish', { slug, files: [{ path: 'SKILL.md', sha256: p1.out.sha256 }, { path: 'assets/logo.png', sha256: p2.out.sha256 }], changelog: 'v2 经 MCP' });
  ok('MCP 发新版本 → v2', !r7.err && r7.out?.version === 2, JSON.stringify(r7.m).slice(0, 300));
  ok('MCP 发布的二进制快照逐字节一致', readFileSync(join(DATA, r7.out?.snapshot_path ?? '-', 'assets/logo.png')).equals(png2));
  const v2row = (await get(`/api/skills/${S}/versions`)).versions?.find((v) => v.version === 2);
  ok('MCP 发布的 reviewed_by 记调用会话、changelog 在案', v2row?.reviewed_by === 'anonymous' && v2row?.changelog === 'v2 经 MCP', JSON.stringify(v2row));
  r7 = await call('skill_publish', { slug, files: [{ path: 'SKILL.md', sha256: p1.out.sha256 }, { path: 'assets/logo.png', sha256: p2.out.sha256 }] });
  ok('MCP 同内容重发被拒（409 语义）', r7.err, JSON.stringify(r7.m).slice(0, 200));
  const newMd = '---\nname: mcp-new\ndescription: 从 MCP 首次上传\n---\n';
  const p3 = await call('skill_file_put', { content: newMd });
  r7 = await call('skill_publish', { slug: 'mcp:new-skill', files: [{ path: 'SKILL.md', sha256: p3.out?.sha256 }] });
  ok('MCP 首次上传新技能 → v1，SKILL.md 描述同步', r7.out?.version === 1 && (await get('/api/skills')).some((s) => s.slug === 'mcp:new-skill' && s.description === '从 MCP 首次上传'), JSON.stringify(r7.m).slice(0, 200));

  // 8) MCP 获取：清单 → 逐个取文件，按 sha256 自校验，重算整版指纹
  const man = await call('skill_manifest', { slug });
  ok('skill_manifest 缺省最新版（v2）列出 path/sha256/size', man.out?.version === 2 && man.out?.files?.length === 2 && man.out.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.size)), JSON.stringify(man.out));
  const got = [];
  for (const f of man.out?.files ?? []) {
    const g = await call('skill_file_get', { slug, path: f.path });
    got.push({ path: f.path, bytes: Buffer.from(g.out?.content ?? '', g.out?.encoding === 'base64' ? 'base64' : 'utf8'), enc: g.out?.encoding, sha: g.out?.sha256 });
  }
  ok('逐个取回的文件与清单 sha256 一致', got.length === 2 && got.every((g, i) => createHash('sha256').update(g.bytes).digest('hex') === man.out.files[i].sha256 && g.sha === man.out.files[i].sha256));
  ok('二进制给 base64、文本给 utf8', got.find((g) => g.path === 'assets/logo.png')?.enc === 'base64' && got.find((g) => g.path === 'SKILL.md')?.enc === 'utf8');
  ok('取回文件重算整版指纹 = tree_digest', digest(got) === man.out?.tree_digest);
  const g1 = await call('skill_file_get', { slug, version: 1, path: 'assets/logo.png' });
  ok('指定版本取文件（v1 的旧 logo）', Buffer.from(g1.out?.content ?? '', 'base64').equals(png));
  ok('清单外的路径（含 ..）取不到', (await call('skill_file_get', { slug, path: '../../bin%3Aprobe/v1/SKILL.md' })).err && (await call('skill_file_get', { slug, path: 'nope.md' })).err);

} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`skill-binary-publish-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
