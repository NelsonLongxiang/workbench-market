#!/usr/bin/env node
/** 技能发布按字节：JSON 发布面收 encoding:'base64' 的二进制文件，快照/回滚/导出/钉装校验都不改坏字节；
 *  MCP 一次只传一个文件：skill_file_put → skill_publish 按 sha256 成版，skill_download 签发 10 分钟票据，包内清单 + 校验脚本真装一遍（备份至多 3 个）。合成数据 + 全新 DATA_DIR + 随机回环端口。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/skill-binary-publish-smoke-' + Date.now().toString(36));
const DATA = join(TMP, 'data');
mkdirSync(DATA, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'bin-smoke' };
for (const k of ['MARKET_PUBLIC_URL', 'REDIS_URL', 'LAYERFS_SERVICE_URL', 'LAYERFS_SERVICE_TOKEN', 'LAYERFS_SERVICE_TOKEN_FILE', 'WM_EXTENSIONS_DIR']) delete env[k];
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
  ok('MCP 技能传输三工具在 tools/list，旧的 manifest/file_get 已移除', ['skill_file_put', 'skill_publish', 'skill_download'].every((n) => names.includes(n)) && !names.includes('skill_manifest') && !names.includes('skill_file_get'), names.join(','));
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

  // 8) MCP 获取：skill_download 只给 10 分钟下载票据，包里带清单与校验脚本
  const dl = await call('skill_download', { slug });
  ok('skill_download 缺省最新版（v2），给下载链接、过期时间、安装命令', dl.out?.version === 2 && /\/api\/skills\/dl\/[0-9a-f]{64}$/.test(dl.out?.download_url ?? '') && Date.parse(dl.out?.expires_at) - Date.now() <= 10 * 60_000 && Date.parse(dl.out?.expires_at) > Date.now() && dl.out?.package_dir === 'bin.probe' && dl.out?.install_dir === '~/.workbench-market/skills/bin.probe' && /--install/.test(dl.out?.install_command ?? ''), JSON.stringify(dl.out));
  ok('下载链接不带会话令牌之类的查询参数', !(dl.out?.download_url ?? '').includes('?'));
  const pkgRes = await fetch(dl.out.download_url);
  const pkgBuf = Buffer.from(await pkgRes.arrayBuffer());
  ok('凭票下载 .tar.gz，带期望指纹头', pkgRes.status === 200 && pkgRes.headers.get('content-type') === 'application/gzip' && pkgRes.headers.get('x-expected-digest') === dl.out.tree_digest, `${pkgRes.status} ${pkgRes.headers.get('content-type')}`);
  const tar2 = untar(gunzipSync(pkgBuf));
  const meta = JSON.parse(tar2.get('bin.probe/.wm-skill.json')?.toString('utf8') ?? '{}');
  ok('包内有清单与校验脚本，二进制逐字节一致', meta.slug === slug && meta.version === 2 && meta.tree_digest === dl.out.tree_digest && tar2.has('bin.probe/.wm-skill-verify.mjs') && tar2.get('bin.probe/assets/logo.png')?.equals(png2) === true, [...tar2.keys()].join(','));
  ok('清单逐文件 sha256 与 tree_digest 自洽（不含清单与脚本本身）', digest(meta.files.map((f) => ({ path: f.path, bytes: tar2.get('bin.probe/' + f.path) }))) === meta.tree_digest && meta.files.every((f) => f.sha256 === createHash('sha256').update(tar2.get('bin.probe/' + f.path)).digest('hex')));
  ok('校验脚本是市场模板原样', tar2.get('bin.probe/.wm-skill-verify.mjs')?.equals(readFileSync('server/src/skill-verify.mjs')) === true);
  const bad = await fetch(`${B}/api/skills/dl/${'0'.repeat(64)}`);
  ok('伪造票号 404', bad.status === 404);
  {
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(join(DATA, 'workbench-market.db'));
    const row = sdb.prepare('SELECT issued_to, downloads FROM skill_download_tickets WHERE id = ?').get(dl.out.download_url.split('/').pop());
    ok('票据记签发会话与下载次数', row?.issued_to === 'anonymous' && row?.downloads === 1, JSON.stringify(row));
    sdb.prepare('UPDATE skill_download_tickets SET expires_at = ? WHERE id = ?').run(Date.now() - 1, dl.out.download_url.split('/').pop());
    sdb.close();
  }
  ok('过期票据 404（与伪造同一应答）', (await fetch(dl.out.download_url)).status === 404);
  ok('保留名不能当技能文件发布', (await post(`/api/skills/${S}/versions`, { files: [{ path: '.wm-skill.json', content: '{}' }] })).status === 400);

  // 9) 按安装命令的步骤真装：解压 → 包内脚本 --install（root 指到临时目录，不碰真实家目录）
  const ROOT = join(TMP, 'skills-root');
  const installOnce = async (version) => {
    const d = await call('skill_download', version ? { slug, version } : { slug });
    const buf = Buffer.from(await (await fetch(d.out.download_url)).arrayBuffer());
    const work = join(TMP, 'work-' + Math.random().toString(36).slice(2));
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'pkg.tgz'), buf);
    execFileSync('tar', ['-xzf', join(work, 'pkg.tgz'), '-C', work]);
    const r = spawnSync(process.execPath, [join(work, 'bin.probe', '.wm-skill-verify.mjs'), '--install', '--root', ROOT], { encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
    return { rc: r.status, out: JSON.parse(r.stdout || '{}') };
  };
  const verifyLocal = () => { const r = spawnSync(process.execPath, [join(ROOT, 'bin.probe', '.wm-skill-verify.mjs')], { encoding: 'utf8' }); return { rc: r.status, out: JSON.parse(r.stdout || '{}') }; };
  let ins = await installOnce();
  ok('首次安装：rc=0，装到 <root>/bin.probe，无备份', ins.rc === 0 && ins.out.installed_to === join(ROOT, 'bin.probe') && ins.out.backup === null && readFileSync(join(ROOT, 'bin.probe/assets/logo.png')).equals(png2), JSON.stringify(ins.out));
  let vr = verifyLocal();
  ok('装好后校验一致 rc=0', vr.rc === 0 && vr.out.ok === true, JSON.stringify(vr.out));
  ins = await installOnce();
  ok('同版本未改动：不重装', ins.rc === 0 && ins.out.unchanged === true, JSON.stringify(ins.out));
  writeFileSync(join(ROOT, 'bin.probe/SKILL.md'), 'local edit');
  writeFileSync(join(ROOT, 'bin.probe/extra.txt'), 'x');
  vr = verifyLocal();
  ok('本地改动被列出：modified/added，rc=1', vr.rc === 1 && vr.out.modified.includes('SKILL.md') && vr.out.added.includes('extra.txt'), JSON.stringify(vr.out));
  ins = await installOnce(1);
  ok('装 v1 覆盖：旧目录（含本地改动）进备份，previous 点名改动', ins.rc === 0 && ins.out.version === 1 && ins.out.previous?.intact === false && ins.out.previous?.modified.includes('SKILL.md') && existsSync(join(ins.out.backup, 'extra.txt')) && readFileSync(join(ROOT, 'bin.probe/assets/logo.png')).equals(png), JSON.stringify(ins.out));
  for (const v of [2, 1, 2, 1]) await installOnce(v);
  const backs = readdirSync(join(ROOT, '.backups', 'bin.probe'));
  ok('来回装 6 次后备份只留 3 个', backs.length === 3, backs.join(','));
  ok('根目录下没有残留的临时目录', readdirSync(ROOT).filter((n) => n.includes('.incoming-')).length === 0, readdirSync(ROOT).join(','));
  {
    // 包被篡改：--install 拒绝，什么都不动
    const d = await call('skill_download', { slug });
    const work = join(TMP, 'work-tamper');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'pkg.tgz'), Buffer.from(await (await fetch(d.out.download_url)).arrayBuffer()));
    execFileSync('tar', ['-xzf', join(work, 'pkg.tgz'), '-C', work]);
    writeFileSync(join(work, 'bin.probe/SKILL.md'), 'tampered');
    const before = readFileSync(join(ROOT, 'bin.probe/SKILL.md'));
    const r = spawnSync(process.execPath, [join(work, 'bin.probe', '.wm-skill-verify.mjs'), '--install', '--root', ROOT], { encoding: 'utf8' });
    ok('被篡改的包 --install rc=2，已装版本不动', r.status === 2 && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), r.stdout);
  }

  // 10) 长路径（>100 字节）走 ustar prefix 字段，系统 tar 解出来路径完整
  {
    const longPath = 'docs/' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/readme.md';
    const lp = await call('skill_file_put', { content: 'long' });
    await call('skill_publish', { slug: 'bin:long-path', files: [{ path: 'SKILL.md', sha256: p1.out.sha256 }, { path: longPath, sha256: lp.out.sha256 }] });
    const d = await call('skill_download', { slug: 'bin:long-path' });
    const work = join(TMP, 'work-long');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'pkg.tgz'), Buffer.from(await (await fetch(d.out.download_url)).arrayBuffer()));
    execFileSync('tar', ['-xzf', join(work, 'pkg.tgz'), '-C', work]);
    const r = spawnSync(process.execPath, [join(work, 'bin.long-path', '.wm-skill-verify.mjs')], { encoding: 'utf8' });
    ok('长路径文件完整解出，包校验一致', readFileSync(join(work, 'bin.long-path', longPath), 'utf8') === 'long' && r.status === 0, r.stdout);
  }

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
