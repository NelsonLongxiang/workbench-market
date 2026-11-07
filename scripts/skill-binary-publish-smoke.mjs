#!/usr/bin/env node
/** 技能发布按字节：JSON 发布面收 encoding:'base64' 的二进制文件，快照/回滚/导出/钉装校验都不改坏字节；
 *  MCP 一次只传一个文件：skill_file_put → skill_publish 按 sha256 成版，skill_download 签发 10 分钟票据，包内清单 + 校验脚本真装一遍（备份至多 3 个）。合成数据 + 全新 DATA_DIR + 随机回环端口。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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
  ok('下载响应带 Referrer-Policy: no-referrer', pkgRes.headers.get('referrer-policy') === 'no-referrer', String(pkgRes.headers.get('referrer-policy')));
  ok('凭票下载 .tar.gz，带期望指纹头', pkgRes.status === 200 && pkgRes.headers.get('content-type') === 'application/gzip' && pkgRes.headers.get('x-expected-digest') === dl.out.tree_digest, `${pkgRes.status} ${pkgRes.headers.get('content-type')}`);
  const tar2 = untar(gunzipSync(pkgBuf));
  const meta = JSON.parse(tar2.get('bin.probe/.wm-skill.json')?.toString('utf8') ?? '{}');
  ok('包内有清单与校验脚本，二进制逐字节一致', meta.slug === slug && meta.version === 2 && meta.tree_digest === dl.out.tree_digest && tar2.has('bin.probe/.wm-skill-verify.mjs') && tar2.get('bin.probe/assets/logo.png')?.equals(png2) === true, [...tar2.keys()].join(','));
  ok('清单逐文件 sha256 与 tree_digest 自洽（不含清单与脚本本身）', digest(meta.files.map((f) => ({ path: f.path, bytes: tar2.get('bin.probe/' + f.path) }))) === meta.tree_digest && meta.files.every((f) => f.sha256 === createHash('sha256').update(tar2.get('bin.probe/' + f.path)).digest('hex')));
  ok('校验脚本是市场模板原样', tar2.get('bin.probe/.wm-skill-verify.mjs')?.equals(readFileSync('server/src/skill-verify.mjs')) === true);
  const bad = await fetch(`${B}/api/skills/dl/${'0'.repeat(64)}`);
  ok('伪造票号 404，也带 no-referrer', bad.status === 404 && bad.headers.get('referrer-policy') === 'no-referrer');
  {
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(join(DATA, 'workbench-market.db'));
    const ticket = dl.out.download_url.split('/').pop();
    const key = createHash('sha256').update(ticket).digest('hex');
    ok('票据表里查不到明文票号（只存 sha256）', !sdb.prepare('SELECT 1 FROM skill_download_tickets WHERE id = ?').get(ticket) && !sdb.prepare('SELECT 1 FROM skill_download_tickets WHERE instr(id, ?) > 0 OR instr(issued_to, ?) > 0').get(ticket, ticket));
    const row = sdb.prepare('SELECT issued_to, downloads, denied FROM skill_download_tickets WHERE id = ?').get(key);
    ok('票据按哈希记签发会话与下载次数', row?.issued_to === 'anonymous' && row?.downloads === 1 && row?.denied === 0, JSON.stringify(row));
    // 单票次数上限：再下 4 次到 5 次都成功，第 6 次 404，拒绝计数可见
    const more = [];
    for (let i = 0; i < 4; i++) more.push((await fetch(dl.out.download_url)).status);
    const over = await fetch(dl.out.download_url);
    const row2 = sdb.prepare('SELECT downloads, denied FROM skill_download_tickets WHERE id = ?').get(key);
    ok('单票最多下载 5 次，第 6 次 404，拒绝计数可见', more.every((s) => s === 200) && over.status === 404 && row2?.downloads === 5 && row2?.denied === 1, `${more} ${over.status} ${JSON.stringify(row2)}`);
    sdb.prepare('UPDATE skill_download_tickets SET expires_at = ?, downloads = 0 WHERE id = ?').run(Date.now() - 1, key);
    sdb.close();
  }
  ok('过期票据 404（与伪造同一应答）', (await fetch(dl.out.download_url)).status === 404);
  ok('保留名不能当技能文件发布', (await post(`/api/skills/${S}/versions`, { files: [{ path: '.wm-skill.json', content: '{}' }] })).status === 400);

  // 9) 原样执行应答里的 install_command（HOME 指到临时目录，不碰真实家目录）
  ok('应答带校验脚本哈希，install_command 先核对脚本再带 --expect 安装', dl.out?.verify_script_sha256 === createHash('sha256').update(readFileSync('server/src/skill-verify.mjs')).digest('hex') && dl.out.install_command.includes(dl.out.verify_script_sha256) && dl.out.install_command.includes(`--install --expect ${dl.out.tree_digest}`), dl.out?.install_command);
  const HOME = join(TMP, 'home');
  const ROOT = join(HOME, '.workbench-market', 'skills');
  mkdirSync(HOME, { recursive: true });
  const sh = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, HOME } });
  const lastJson = (out) => { try { return JSON.parse(String(out).trim().split('\n').pop()); } catch { return {}; } };
  const installOnce = async (version) => {
    const d = await call('skill_download', version ? { slug, version } : { slug });
    const r = sh(d.out.install_command);
    return { rc: r.status, out: lastJson(r.stdout), err: r.stderr, d: d.out };
  };
  const verifyLocal = (expect) => { const r = spawnSync(process.execPath, [join(ROOT, 'bin.probe', '.wm-skill-verify.mjs'), ...(expect ? ['--expect', expect] : [])], { encoding: 'utf8' }); return { rc: r.status, out: lastJson(r.stdout) }; };
  let ins = await installOnce();
  ok('首次安装：rc=0，装到 ~/.workbench-market/skills/bin.probe，无备份', ins.rc === 0 && ins.out.installed_to === join(ROOT, 'bin.probe') && ins.out.backup === null && readFileSync(join(ROOT, 'bin.probe/assets/logo.png')).equals(png2), JSON.stringify(ins.out) + ins.err);
  let vr = verifyLocal(ins.d.tree_digest);
  ok('装好后 verify_command 一致 rc=0', vr.rc === 0 && vr.out.ok === true, JSON.stringify(vr.out));
  ins = await installOnce();
  ok('同版本未改动：不重装', ins.rc === 0 && ins.out.unchanged === true, JSON.stringify(ins.out));
  writeFileSync(join(ROOT, 'bin.probe/SKILL.md'), 'local edit');
  writeFileSync(join(ROOT, 'bin.probe/extra.txt'), 'x');
  symlinkSync('/etc/hosts', join(ROOT, 'bin.probe/link-out'));
  vr = verifyLocal();
  ok('本地改动被列出：modified/added（含符号链接），rc=1', vr.rc === 1 && vr.out.modified.includes('SKILL.md') && vr.out.added.includes('extra.txt') && vr.out.added.includes('link-out'), JSON.stringify(vr.out));
  ins = await installOnce(1);
  ok('装 v1 覆盖：旧目录（含本地改动）进备份，previous 点名改动', ins.rc === 0 && ins.out.version === 1 && ins.out.previous?.intact === false && ins.out.previous?.modified.includes('SKILL.md') && existsSync(join(ins.out.backup, 'extra.txt')) && readFileSync(join(ROOT, 'bin.probe/assets/logo.png')).equals(png), JSON.stringify(ins.out));
  for (const v of [2, 1, 2, 1]) await installOnce(v);
  const backs = readdirSync(join(ROOT, '.backups', 'bin.probe'));
  ok('来回装 6 次后备份只留 3 个', backs.length === 3, backs.join(','));
  ok('根目录下没有残留的临时目录', readdirSync(ROOT).filter((n) => n.includes('.incoming-')).length === 0, readdirSync(ROOT).join(','));

  // 9b) 篡改。第一道：命令内联逻辑核对整包 sha256，包被换了一个字节都到不了解压和执行
  const d9 = (await call('skill_download', { slug })).out;
  const raw9a = Buffer.from(await (await fetch(d9.download_url)).arrayBuffer());
  // 两次签发/下载隔开 1 秒以上：打包若混进当前时间（秒级 mtime），这里才会露出来
  await new Promise((x) => setTimeout(x, 1100));
  const again9 = (await call('skill_download', { slug })).out;
  const raw9 = Buffer.from(await (await fetch(again9.download_url)).arrayBuffer());
  ok('同一版本隔 1 秒再打包仍逐字节相同，= 应答 package_sha256', d9.package_sha256 === again9.package_sha256 && raw9a.equals(raw9) && createHash('sha256').update(raw9).digest('hex') === d9.package_sha256, `${d9.package_sha256} ${again9.package_sha256}`);
  ok('install_command 先核对整包哈希再解压，核对脚本哈希再执行', /pkg\.tgz" [0-9a-f]{64} && tar -xzf/.test(d9.install_command) && d9.install_command.indexOf(d9.package_sha256) < d9.install_command.indexOf('tar -xzf') && d9.install_command.indexOf(d9.verify_script_sha256) < d9.install_command.indexOf('--install'));
  const fresh = async (tag) => {
    const work = join(TMP, 'tamper-' + tag);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'pkg.tgz'), Buffer.from(await (await fetch((await call('skill_download', { slug })).out.download_url)).arrayBuffer()));
    execFileSync('tar', ['-xzf', join(work, 'pkg.tgz'), '-C', work]);
    return work;
  };
  const repack = (work) => { execFileSync('tar', ['-czf', join(work, 'evil.tgz'), '-C', work, 'bin.probe']); return join(work, 'evil.tgz'); };
  const runCmdWith = (tgz) => sh(d9.install_command.replace(/curl -fsSL '[^']+' -o "\$d\/pkg\.tgz"/, `cp '${tgz}' "$d/pkg.tgz"`));
  const before = readFileSync(join(ROOT, 'bin.probe/SKILL.md'));
  {
    // 换掉包里的校验脚本（让它一运行就留下记号）并重新打包：整包哈希先不符，脚本不会被执行
    const work = await fresh('script');
    const marker = join(TMP, 'evil-ran');
    writeFileSync(join(work, 'bin.probe/.wm-skill-verify.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`);
    const r = runCmdWith(repack(work));
    ok('包被替换：整包 sha256 不符即停，包内代码没被执行，已装版本不动', r.status === 2 && !existsSync(marker) && /sha256 不符/.test(r.stderr) && /pkg\.tgz/.test(r.stderr) && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), `${r.status} ${r.stderr}`);
  }
  {
    // 包没换、但解出来后脚本被换（模拟整包核对之后的替换）：第二道脚本哈希核对拦下
    const marker = join(TMP, 'evil-ran-2');
    const evil = join(TMP, 'evil-script.mjs');
    writeFileSync(evil, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`);
    // 对照：这个脚本真被执行就会留下记号（否则下面「没被执行」的断言是空的）
    const probe = join(TMP, 'evil-ran-probe');
    writeFileSync(join(TMP, 'evil-probe.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(probe)}, 'x');`);
    spawnSync(process.execPath, [join(TMP, 'evil-probe.mjs')]);
    ok('对照：替换脚本直接运行确实会留下记号', existsSync(probe));
    // 用 cp 换文件，不在 shell 里拼脚本内容（Linux 的 dash 与 macOS 的 bash 引号规则不同）
    const cmd = d9.install_command.replace('&& tar -xzf "$d/pkg.tgz" -C "$d" &&', `&& tar -xzf "$d/pkg.tgz" -C "$d" && cp '${evil}' "$d/bin.probe/.wm-skill-verify.mjs" &&`);
    const r = sh(cmd);
    ok('解压后脚本被换：脚本哈希不符即停，没被执行', r.status === 2 && !existsSync(marker) && /wm-skill-verify/.test(r.stderr), `${r.status} ${r.stderr}`);
  }
  // 第二道：包内脚本自己的检查（绕过整包核对、直接对改过的目录跑 --install --expect）
  const runScript = (work, expect = d9.tree_digest) => spawnSync(process.execPath, [join(work, 'bin.probe', '.wm-skill-verify.mjs'), '--install', '--root', ROOT, ...(expect ? ['--expect', expect] : [])], { encoding: 'utf8' });
  const rewriteMeta = (dir, mutate) => {
    const m = JSON.parse(readFileSync(join(dir, '.wm-skill.json'), 'utf8'));
    mutate(m);
    m.tree_digest = digest(m.files.filter((f) => existsSync(join(dir, f.path))).map((f) => ({ path: f.path, bytes: readFileSync(join(dir, f.path)) })));
    writeFileSync(join(dir, '.wm-skill.json'), JSON.stringify(m));
    return m;
  };
  {
    const work = await fresh('file');
    writeFileSync(join(work, 'bin.probe/SKILL.md'), 'tampered');
    const r = runScript(work);
    ok('改文件不改清单：rc=2，已装版本不动', r.status === 2 && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), r.stdout);
  }
  {
    const work = await fresh('meta');
    const dir = join(work, 'bin.probe');
    writeFileSync(join(dir, 'SKILL.md'), 'tampered');
    rewriteMeta(dir, (m) => { m.files = m.files.map((f) => ({ ...f, sha256: createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex') })); });
    const self = spawnSync(process.execPath, [join(dir, '.wm-skill-verify.mjs')], { encoding: 'utf8' });
    ok('（前提）连清单一起篡改后包本身自洽', self.status === 0, self.stdout);
    const r = runScript(work);
    ok('连清单一起篡改：清单指纹与 --expect 不符 rc=2，已装版本不动', r.status === 2 && /与市场应答不符/.test(r.stdout) && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), r.stdout);
    const noExpect = runScript(work, null);
    ok('不带 --expect 的 --install 一律拒绝', noExpect.status === 2 && /必须带 --expect/.test(noExpect.stdout), noExpect.stdout);
  }
  {
    const work = await fresh('link');
    symlinkSync('/etc/hosts', join(work, 'bin.probe/hosts-link'));
    const r = runScript(work);
    ok('包里有符号链接：整包拒绝 rc=2，点名 symlink', r.status === 2 && /"reason":"symlink"/.test(r.stdout) && !existsSync(join(ROOT, 'bin.probe/hosts-link')), r.stdout);
  }
  {
    // 硬链接：把清单里的文件换成指向包外文件的硬链接，内容与清单一致也要拒
    const work = await fresh('hard');
    const dir = join(work, 'bin.probe');
    const outside = join(work, 'outside.md');
    writeFileSync(outside, readFileSync(join(dir, 'SKILL.md')));
    rmSync(join(dir, 'SKILL.md'));
    linkSync(outside, join(dir, 'SKILL.md'));
    const r = runScript(work);
    ok('包里有硬链接（内容与清单一致）：整包拒绝 rc=2，点名 hardlink', r.status === 2 && /"reason":"hardlink"/.test(r.stdout), r.stdout);
  }
  {
    // R3：只改清单 dir（文件与指纹都不动），--expect 照样对得上，但不许装到别的目录
    const work = await fresh('dir');
    const dir = join(work, 'bin.probe');
    const m = JSON.parse(readFileSync(join(dir, '.wm-skill.json'), 'utf8'));
    m.dir = 'other.skill';
    writeFileSync(join(dir, '.wm-skill.json'), JSON.stringify(m));
    const r = runScript(work);
    ok('只改清单 dir：rc=2，不装到 other.skill，原安装不动', r.status === 2 && /目录名/.test(r.stdout) && !existsSync(join(ROOT, 'other.skill')) && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), r.stdout);
  }
  for (const [tag, bad] of [['dotdot', '../escape.md'], ['abs', '/tmp/escape.md']]) {
    const work = await fresh(tag);
    const dir = join(work, 'bin.probe');
    const m = rewriteMeta(dir, (mm) => { mm.files.push({ path: bad, sha256: 'a'.repeat(64), size: 1 }); });
    const r = runScript(work, m.tree_digest);
    ok(`清单里有 ${tag === 'abs' ? '绝对路径' : '.. 路径'}：整包拒绝 rc=2，点名 manifest-path`, r.status === 2 && /"reason":"manifest-path"/.test(r.stdout) && readFileSync(join(ROOT, 'bin.probe/SKILL.md')).equals(before), r.stdout);
  }
  {
    // N1：Host 头带引号时不签发（没设 MARKET_PUBLIC_URL）
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_download', arguments: { slug } } });
    const res = await new Promise((done) => {
      const rq = httpRequest({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/mcp', headers: { host: "x';touch /tmp/p;'", 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (rs) => { let t = ''; rs.on('data', (c) => (t += c)); rs.on('end', () => done(t)); });
      rq.on('error', (e) => done(String(e)));
      rq.end(body);
    });
    ok('请求主机不规范时不签发下载链接（提示设 MARKET_PUBLIC_URL）', /MARKET_PUBLIC_URL/.test(res) && !/install_command/.test(res), res.slice(0, 200));
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
