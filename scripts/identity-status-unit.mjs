#!/usr/bin/env node
/** 身份服务连不上（#639 的 502 identity_unavailable）的纯函数和状态单测：web/src/identity-status.ts、home-view.ts 的总结句。
 *  认法只有「502 且 error 正好是 identity_unavailable」；401 不算；退避重试；连上之后清状态并让页面重读。全是合成值。 */
import { IDENTITY_UNAVAILABLE, createIdentityWatch, isApiUrl, isIdentityUnavailable, retryDelay } from '../web/src/identity-status.ts';
import { DECIDE_DOWN, downLine } from '../web/src/home-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

ok('认法：502 而且 error 正好是 identity_unavailable 才算', isIdentityUnavailable(502, { error: IDENTITY_UNAVAILABLE })
  && !isIdentityUnavailable(502, { error: 'upstream_failed' }) && !isIdentityUnavailable(502, null) && !isIdentityUnavailable(502, 'identity_unavailable')
  && !isIdentityUnavailable(401, { error: IDENTITY_UNAVAILABLE }) && !isIdentityUnavailable(503, { error: IDENTITY_UNAVAILABLE }) && !isIdentityUnavailable(200, { error: IDENTITY_UNAVAILABLE }));
ok('退避：2、4、8、15 秒，之后每 30 秒', [0, 1, 2, 3, 4, 9].map(retryDelay).join() === '2000,4000,8000,15000,30000,30000');
ok('只看同源 /api/ 的请求', isApiUrl('/api/attention', 'http://a.invalid') && isApiUrl('http://a.invalid/api/x', 'http://a.invalid')
  && !isApiUrl('http://b.invalid/api/x', 'http://a.invalid') && !isApiUrl('/assets/x.js', 'http://a.invalid') && !isApiUrl('//b.invalid/api/x', 'http://a.invalid'));

/** 假的计时器：按顺序记下要等多久，手动触发 */
function fakeTimers() {
  const q = [];
  return { q, setTimer: (fn, ms) => { const t = { fn, ms, live: true }; q.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; },
    async fire() { const t = q.filter((x) => x.live).shift(); if (!t) return null; t.live = false; t.fn(); await new Promise((r) => setTimeout(r, 0)); return t.ms; } };
}
const DOWN = { status: 502, body: { error: IDENTITY_UNAVAILABLE } };
{
  const tm = fakeTimers();
  const answers = [DOWN, { status: 0, body: null }, DOWN, { status: 200, body: { items: [] } }];
  let probes = 0, recovered = 0, changes = 0;
  const w = createIdentityWatch({ probe: async () => { probes++; return answers.shift(); }, onRecover: () => recovered++, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  w.subscribe(() => changes++);
  w.observe(502, { error: 'upstream_failed' });
  w.observe(401, { error: 'work_items_auth_required' });
  ok('别的 502、401 不进「连不上」', !w.down() && changes === 0 && tm.q.length === 0);
  w.observe(502, { error: IDENTITY_UNAVAILABLE });
  w.observe(502, { error: IDENTITY_UNAVAILABLE });
  ok('收到一次就进「连不上」，再收到不重复排重试', w.down() && changes === 1 && tm.q.filter((t) => t.live).length === 1);
  const waits = [await tm.fire(), await tm.fire(), await tm.fire()];
  ok('还连不上、断网都接着退避重试', JSON.stringify(waits) === '[2000,4000,8000]' && w.down() && probes === 3 && recovered === 0, JSON.stringify(waits));
  await tm.fire();
  ok('问到正常的应答就算连上：清状态、页面重读一次、不再排重试', !w.down() && recovered === 1 && changes === 2 && probes === 4 && tm.q.filter((t) => t.live).length === 0);
  w.observe(502, { error: IDENTITY_UNAVAILABLE });
  ok('又连不上：退避从头算', w.down() && tm.q.filter((t) => t.live)[0]?.ms === 2000);
}
{
  const tm = fakeTimers();
  let recovered = 0;
  const w = createIdentityWatch({ probe: async () => ({ status: 401, body: { error: 'work_items_auth_required' } }), onRecover: () => recovered++, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  w.observe(502, { error: IDENTITY_UNAVAILABLE });
  w.retryNow();
  await new Promise((r) => setTimeout(r, 0));
  ok('「现在重试」不等计时；来源回答了「认不出」（401）也算连上了——没登录交给登录那一套', !w.down() && recovered === 1 && tm.q.filter((t) => t.live).length === 0);
}
{
  const w = createIdentityWatch({ probe: async () => DOWN, setTimer: () => 1, clearTimer: () => undefined });
  w.retryNow();
  ok('没连不上时「现在重试」什么都不做', !w.down());
}
ok('全景总结句：连不上时不说「没有要你拍板的」；表读到了照样说几条线在走', downLine(null) === DECIDE_DOWN && !DECIDE_DOWN.includes('没有')
  && downLine([{ terminal: false }, { terminal: true }, { terminal: false }]) === `公司现在有 2 条线在走，${DECIDE_DOWN}`);

console.log(`\nidentity-status-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
