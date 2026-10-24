#!/usr/bin/env node
/** 自产台数据提交面冒烟（独立实例）：写入→读回→游标分页→掩码边界→大小限制。 */
import { spawn } from 'node:child_process';

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9816;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-appdata-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // 发布一个台（数据面挂接对象）
  await call('POST', '/api/apps', { slug: 'appdata-smoke', title: 'T', files: [{ path: 'index.html', content: '<h1>x</h1>' }] });
  // 双口径对照物理闸（PR#52 教训·direct-2a7684ec）：/api/apps ≥ /api/sops 且 app 类必现
  // ——S2 类批量替换若再装反两口径，此断言先红
  {
    const apps = (await call('GET', '/api/apps')).body ?? [];
    const sops = (await call('GET', '/api/sops')).body ?? [];
    if (!(Array.isArray(apps) && Array.isArray(sops) && apps.length >= sops.length && apps.length >= 1)) {
      console.log(`  ✗ 双口径闸：apps(${apps.length}) < sops(${sops.length})——口径装反`); process.exit(1);
    }
    if (!apps.some((a) => a.kind === 'app')) {
      console.log('  ✗ 双口径闸：apps 列表无 app 类台——apps 误用 sops 过滤'); process.exit(1);
    }
    console.log(`  ✓ 双口径闸：apps=${apps.length} ≥ sops=${sops.length}，app 类在场`);
  }

  // ① 写入（{data:...} 形态）
  let r = await call('POST', '/api/apps/appdata-smoke/data', { data: { form: 'owba', manifest: { version: 1 } }, created_by: 'user-a' });
  ok('写入 201', r.status === 201 && r.body.ok && r.body.id > 0);
  // ② 写入（直接 JSON 形态）
  r = await call('POST', '/api/apps/appdata-smoke/data', { note: '直接对象', value: 42 });
  ok('直接 JSON 形态兼容', r.status === 201);
  // ③ 读回
  r = await call('GET', '/api/apps/appdata-smoke/data');
  ok('读回 2 条倒序', r.body.items.length === 2 && r.body.items[0].data.note === '直接对象' && r.body.items[1].data.form === 'owba');
  ok('has_more=false', r.body.has_more === false);
  // ④ 游标分页（造 10 条，limit=3 分页）
  for (let i = 0; i < 10; i++) await call('POST', '/api/apps/appdata-smoke/data', { seq: i });
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=3');
  ok('limit=3 第一页', r.body.items.length === 3 && r.body.has_more === true && r.body.next_before_id !== null);
  const bid = r.body.next_before_id;
  r = await call('GET', `/api/apps/appdata-smoke/data?limit=3&before_id=${bid}`);
  ok('游标翻页', r.body.items.length === 3 && r.body.items[0].id < bid);
  // ⑤ 未知 slug 404
  r = await call('POST', '/api/apps/no-such/data', { x: 1 });
  ok('未知 slug 404', r.status === 404);
  // ⑤b 分页参数校验（评审 #22：limit=1.5 曾 500、limit=-1 曾绕过上限）
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=1.5');
  ok('limit=1.5 → 400', r.status === 400, `status=${r.status}`);
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=-1');
  ok('limit=-1 → 400（不再绕过上限）', r.status === 400, `status=${r.status}`);
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=0');
  ok('limit=0 → 400', r.status === 400, `status=${r.status}`);
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=999');
  ok('limit=999 夹到 200', r.status === 200 && r.body.items.length <= 200, `status=${r.status}`);
  r = await call('GET', '/api/apps/appdata-smoke/data?before_id=1.5');
  ok('before_id=1.5 → 400', r.status === 400, `status=${r.status}`);
  // ⑥ 1MB 上限
  r = await call('POST', '/api/apps/appdata-smoke/data', { big: 'x'.repeat(1024 * 1024 + 100) });
  ok('1MB 拒 400', r.status === 400);
  // ⑦ 远程收口白名单（主人裁定 A）：经局域网 IP 访问（remoteAddress 非 loopback）——
  //    数据/文件面放行、控制面照旧 403。无局域网 IP 时跳过（fail-open 不阻断本地测试）。
  const lanIp = process.env.LAN_IP || '192.168.3.156';
  let lanReachable = false;
  try {
    const probe = await fetch(`http://${lanIp}:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    lanReachable = probe.ok;
  } catch { lanReachable = false; }
  if (lanReachable) {
    const rr = await fetch(`http://${lanIp}:${PORT}/api/apps/appdata-smoke/data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote: true }),
    });
    ok('远程 IP 提交数据放行 201', rr.status === 201, `status=${rr.status}`);
    const rw = await fetch(`http://${lanIp}:${PORT}/api/workbenches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', url: 'http://127.0.0.1:1/' }),
    });
    ok('远程 IP 控制面写仍 403', rw.status === 403, `status=${rw.status}`);
    const rg = await fetch(`http://${lanIp}:${PORT}/api/apps/appdata-smoke/data?limit=1`);
    ok('远程 IP 读数据放行 200', rg.status === 200, `status=${rg.status}`);
  } else {
    console.log(`  · 跳过远程面三项（LAN ${lanIp}:${PORT} 不可达）`);
  }
  // 清理
  await call('DELETE', '/api/apps/appdata-smoke');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 数据面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
