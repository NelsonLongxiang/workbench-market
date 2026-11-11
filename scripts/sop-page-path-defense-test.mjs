#!/usr/bin/env node
/**
 * 走不到的纵深防御，单独测（阶段三清单第 1 条：server/src/routes/sop-page.ts，/sop/<slug>/ 的附件分支）。
 *
 * 附件分支有两道防穿越：
 *   第一道：rel = posix.normalize(rest)；rel 是「.」、以「/」或「..」开头 → 400 路径非法
 *   第二道：abs = join(root, rel)；abs 不以 root 开头 → 400 路径非法
 * 第一道在前，从任何请求都走不到第二道（规范化之后「..」只会在开头）。这里不改实现，在代码的副本上去掉前面那一道，
 * 看后面那一道单独拦不拦得住：
 *   原代码         越界的请求一律 400，不读到根外的文件
 *   只剩第二道     越界到台目录、别的台的请求照样 400
 *   两道都去掉     对照：越界的文件被读到（说明本测试真的能看出两道都没了）
 * 已知缺口（只剩第二道时）：第二道是不带分隔符的前缀比较，root 是 …/v1 时，../v10/x 拼出来的 …/v10/x 也以 root 开头，
 * 同一个台的 v10 目录能被读到。原代码里有第一道挡着，走不到。这一项只记录、不断言；修了第二道（比 root 加分隔符）之后改成断言。
 *
 *   node scripts/sop-page-path-defense-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TAG = `${process.pid}-${Date.now().toString(36)}`;
const OUT = join(ROOT, 'tmp', `sop-page-defense-${TAG}`);
// 副本放在 server/ 下面，模块解析能找到 server/node_modules
const COPIES = join(ROOT, 'server', `.defense-copy-${TAG}`);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };

const FIRST = "if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });";
const SECOND = "if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });";

/** 在子进程里加载这一份 sop-page.ts，用假的 HTTP 服务拿到处理函数，逐个请求跑一遍，回状态码和读了哪个文件 */
const PROBE = (srcDir, appsRoot, dataDir, rests) => `
const { registerSopPageRoutes } = await import(${JSON.stringify(pathToFileURL(join(srcDir, 'routes', 'sop-page.ts')).href)});
let handler = null;
const http = { get: (_p, _spec, h) => { handler = h; } };
registerSopPageRoutes(http, {
  readActiveManifest: (slug) => slug === 'demo' ? { manifest: {}, app: { active_version: 1, status: 'published' } } : null,
  renderSopRunner: () => '<runner>', appsRoot: ${JSON.stringify(appsRoot)}, wmAppToken: () => 't'.repeat(64), wmWorkbenchIdFor: () => null,
});
const out = [];
for (const rest of ${JSON.stringify(rests)}) {
  const r = { status: 200, file: null, body: null };
  const res = { setHeader() { return res; }, status(s) { r.status = s; return res; }, json(b) { r.body = b; return res; }, type() { return res; }, send(b) { r.body = String(b); return res; }, sendFile(f) { r.file = f; return res; } };
  try { handler({ path: '/sop/demo/' + rest, query: {} }, res); } catch (e) { r.status = 'throw'; r.body = String(e); }
  out.push({ rest, status: r.status, file: r.file, error: r.body && r.body.error });
}
console.log('PROBE ' + JSON.stringify(out));
process.exit(0);
`;

function variant(name, transform) {
  const dir = join(COPIES, name);
  cpSync(join(ROOT, 'server', 'src'), join(dir, 'src'), { recursive: true });
  const p = join(dir, 'src', 'routes', 'sop-page.ts');
  const src = readFileSync(p, 'utf8');
  for (const line of [FIRST, SECOND]) if (src.split(line).length !== 2) throw new Error(`sop-page.ts 里这一道的写法变了，测试要跟着改：${line}`);
  writeFileSync(p, transform(src));
  return join(dir, 'src');
}

const REST = ['../secret.txt', 'a/../../secret.txt', '../../other/v1/secret.txt', '../v10/secret.txt', 'ok.txt'];
function run(srcDir) {
  const dataDir = join(OUT, `data-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PROBE(srcDir, join(OUT, 'apps'), dataDir, REST)],
    { env: { PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir, NODE_ENV: 'test', REDIS_URL: '', MCP_GATEWAY: 'off' }, encoding: 'utf8', timeout: 120000 });
  const m = /PROBE (.*)/.exec(r.stdout);
  if (!m) throw new Error(`子进程没跑完：${(r.stderr || r.stdout).slice(-800)}`);
  return Object.fromEntries(JSON.parse(m[1]).map((x) => [x.rest, x]));
}

try {
  rmSync(OUT, { recursive: true, force: true });
  // 台文件：demo 的 v1 是当前版本；同一个台的 v10、台目录、别的台各放一个不该被读到的文件
  for (const [p, c] of [['demo/v1/ok.txt', 'ok'], ['demo/secret.txt', 'secret'], ['demo/v10/secret.txt', 'secret'], ['other/v1/secret.txt', 'secret']]) {
    mkdirSync(dirname(join(OUT, 'apps', p)), { recursive: true });
    writeFileSync(join(OUT, 'apps', p), c);
  }
  const outside = (x) => typeof x.file === 'string' && x.file.includes('secret');
  const blocked = (x) => x.status === 400 && x.error === '路径非法' && !x.file;

  const real = run(join(ROOT, 'server', 'src'));
  for (const rest of REST.filter((r) => r !== 'ok.txt')) check(blocked(real[rest]), `原代码：${rest} → 400 路径非法，不读根外的文件`, JSON.stringify(real[rest]));
  check(real['ok.txt'].file?.endsWith(join('demo', 'v1', 'ok.txt')), '原代码：版本目录里的附件照常读到', JSON.stringify(real['ok.txt']));

  const secondOnly = run(variant('second-only', (s) => s.replace(FIRST, '')));
  for (const rest of ['../secret.txt', 'a/../../secret.txt', '../../other/v1/secret.txt']) check(blocked(secondOnly[rest]), `只剩第二道：${rest} → 照样 400 路径非法`, JSON.stringify(secondOnly[rest]));
  check(secondOnly['ok.txt'].file?.endsWith(join('demo', 'v1', 'ok.txt')), '只剩第二道：版本目录里的附件照常读到');
  const gap = secondOnly['../v10/secret.txt'];
  console.log(`  · 已知缺口（只记录、不断言）：只剩第二道时 ../v10/secret.txt → ${outside(gap) ? '读到了 …/v10/secret.txt（前缀比较没带分隔符）' : `${gap.status} ${gap.error ?? ''}`}`);

  const neither = run(variant('neither', (s) => s.replace(FIRST, '').replace(SECOND, '')));
  check(outside(neither['../secret.txt']) && outside(neither['../../other/v1/secret.txt']), '对照：两道都去掉，越界的文件被读到（本测试能看出两道都没了）', JSON.stringify(neither['../secret.txt']));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(COPIES, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
