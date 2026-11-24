#!/usr/bin/env node
/** #292 M4 口令守卫单测（node 直跑 .ts；替身 window/sessionStorage）：
 *  设口令写 sessionStorage 并广播变更 · pagehide 抹掉 sessionStorage（新文档读不到）但本文档内存保留 · 清除口令后 present=false。 */
const store = new Map();
const listeners = new Map();
globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = {
  addEventListener: (t, f) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(f); },
  removeEventListener: (t, f) => listeners.get(t)?.delete(f),
  dispatchEvent: (e) => { for (const f of listeners.get(e.type) ?? []) f(e); return true; },
};
const fire = (t) => window.dispatchEvent(new Event(t));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const m = await import('../web/src/admin-token.ts');
m.installAdminTokenLeaveGuard();
let changes = 0;
const off = m.subscribeAdminToken(() => changes++);

ok('初始无口令', m.adminTokenPresent() === false);
m.setAdminToken('synthetic-admin-token');
ok('设口令：present=true、写进 sessionStorage', m.adminTokenPresent() && store.get('wm-admin-token') === 'synthetic-admin-token');
ok('设口令广播一次变更（GoFrame/顶栏据此切换）', changes === 1, String(changes));
fire('pagehide');
ok('pagehide（同标签页跳去 /go/、/sop/、刷新）后 sessionStorage 里没有口令', !store.has('wm-admin-token'));
ok('本文档内存副本仍在（只证明内存；真实 bfcache 恢复见浏览器用例，未命中记 SKIP）', m.getAdminToken() === 'synthetic-admin-token');
m.setAdminToken('');
ok('清除口令：present=false、存储为空、再广播一次', !m.adminTokenPresent() && !store.has('wm-admin-token') && changes === 2, String(changes));
off();
m.setAdminToken('x');
ok('退订后不再收到变更', changes === 2, String(changes));

for (const [code, text] of [['bench_views_cross_origin_denied', '请求来源'], ['bench_views_forbidden', '台的 MCP 授权']]) {
  globalThis.fetch = async () => Response.json({ error: code }, { status: 403 });
  const err = await m.apiFetch('/api/bench-views/example/mcp-requests/1').catch((e) => e);
  ok(`授权卡区分 ${code}，不引导输入管理员口令`, err.message.includes(text) && !err.needAdminToken, err.message);
}
globalThis.fetch = async () => Response.json({ error: 'forbidden' }, { status: 403 });
const adminErr = await m.apiFetch('/api/admin-token').catch((e) => e);
ok('未分类的管理接口 403 仍提示管理员', adminErr.needAdminToken === true);

console.log(`admin-token-guard-unit: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
