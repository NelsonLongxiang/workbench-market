#!/usr/bin/env node
/** 自产台数据提交面冒烟（独立实例）：写入→读回→游标分页→掩码边界→大小限制。 */
import { spawn, fixtureLanHost } from './owned-script-fixture.mjs';

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
import { rmSync, mkdirSync } from 'node:fs';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = 9816;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-appdata-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const gh = await startFakeGithub(); // 自产台/SOP 台只从 GitHub main 同步：本机替身仓库
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, ADMIN_TOKEN: 'synthetic-appdata-admin', MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: `../${DATA}`, WM_GITHUB_API: gh.api }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // 发布一个台（数据面挂接对象）
  const pub0 = await ghPublish(BASE, gh, { slug: 'appdata-smoke', title: 'T', files: [{ path: 'index.html', content: '<h1>x</h1>' }] });
  ok('台经 GitHub main 同步发布 → 201', pub0.status === 201, `status=${pub0.status}`);
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
  // 同一个台、同一个幂等键的提交同时到：只落一行，其余认成重复（200 duplicate），不撞唯一索引出 500（提交在进程内按台排队）
  {
    const same = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/apps/appdata-smoke/data', { data: { race: 1 }, idempotency_key: 'race-key-0001' })));
    const codes = same.map((x) => x.status).sort().join(',');
    ok('同键并发六笔：一笔 201，五笔 200 重复，没有 500', codes === '200,200,200,200,200,201' && same.filter((x) => x.body?.duplicate === true).length === 5, codes);
  }
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
  const lanIp = fixtureLanHost(); // Local interface only, owned child port required.
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
    ok('远程 IP 不带台令牌读数据 403（读要台令牌、管理员或本机命令行）', rg.status === 403, `status=${rg.status}`);
  } else {
    console.log(`  · 跳过远程面三项（LAN ${lanIp}:${PORT} 不可达）`);
  }
  // 契约要求附件（file_ids）：引用的附件必须是本台的、存在的、没软删的；三种不合格的都拒并点名，真实存在的收下
  {
    const contract = { version: 1, type_fields: ['type'], types: { t: { file_ids: true } } };
    const pubC = await ghPublish(BASE, gh, { slug: 'appdata-con', title: 'C', files: [{ path: 'index.html', content: '<h1>c</h1>' }, { path: 'data-contract.json', content: JSON.stringify(contract) }] });
    const del = (path) => fetch(BASE + path, { method: 'DELETE', headers: { 'x-admin-token': 'synthetic-appdata-admin' } }).then((r) => ({ status: r.status }));
    const upload = async (slug, name) => { const fd = new FormData(); fd.append('file', new Blob([`内容-${name}`], { type: 'text/plain' }), name); const r = await fetch(`${BASE}/api/apps/${slug}/files`, { method: 'POST', body: fd }); return (await r.json()).id; };
    const fileA = await upload('appdata-con', 'a.txt'), fileOther = await upload('appdata-smoke', 'b.txt'), fileGone = await upload('appdata-con', 'c.txt');
    const delGone = await del(`/api/apps/appdata-con/files/${fileGone}`);
    const sub = (ids) => call('POST', '/api/apps/appdata-con/data', { data: { type: 't', file_ids: ids } });
    const missing = await sub([999999]), other = await sub([fileOther]), gone = await sub([fileGone]), good = await sub([fileA]);
    const named = (r, id) => r.status === 400 && (r.body?.violations ?? []).some((v) => String(v).includes(String(id)));
    ok('（准备）带契约的台发布成功、三个附件上传成功、软删一个', pubC.status === 201 && [fileA, fileOther, fileGone].every(Number.isInteger) && delGone.status === 200, JSON.stringify({ pub: pubC.status, fileA, fileOther, fileGone, del: delGone.status }));
    ok('契约：file_ids 引用不存在的附件 → 400，点名那个 id', named(missing, 999999), JSON.stringify(missing.body));
    ok('契约：file_ids 引用别的台的附件 → 400，点名', named(other, fileOther), JSON.stringify(other.body));
    ok('契约：file_ids 引用已软删的附件 → 400，点名', named(gone, fileGone), JSON.stringify(gone.body));
    ok('契约：file_ids 引用本台真实存在的附件 → 201 收下', good.status === 201 && Number.isInteger(good.body?.id), JSON.stringify(good.body));
    // 删不存在的、删两次：404
    const dNoData = await del('/api/apps/appdata-con/data/999999');
    const dNoFile = await del('/api/apps/appdata-con/files/999999');
    const d1 = await del(`/api/apps/appdata-con/data/${good.body?.id}`), d2 = await del(`/api/apps/appdata-con/data/${good.body?.id}`);
    const f1 = await del(`/api/apps/appdata-con/files/${fileA}`), f2 = await del(`/api/apps/appdata-con/files/${fileA}`);
    ok('删不存在的提交、不存在的附件 → 404', dNoData.status === 404 && dNoFile.status === 404, `${dNoData.status} ${dNoFile.status}`);
    ok('同一条提交、同一个附件删两次：第一次 200，第二次 404', d1.status === 200 && d2.status === 404 && f1.status === 200 && f2.status === 404, `${d1.status} ${d2.status} ${f1.status} ${f2.status}`);
    await del('/api/apps/appdata-con');
  }
  // 清理
  await call('DELETE', '/api/apps/appdata-smoke');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 数据面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
