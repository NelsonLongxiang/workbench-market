#!/usr/bin/env node
/** 身份变了以后页面重读的核心单测（web/src/session-watch.ts）：只有 /api/auth/me 确认真的没登录、或换了人才算变；
 *  不通、502 不算；合并、去抖；世代号。全是合成值。 */
import { createSessionWatch, guardedFetch, whoKey } from '../web/src/session-watch.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const me = (login, via = 'cookie') => ({ status: 200, body: { authenticated: true, login, via } });
const out = { status: 200, body: { authenticated: false } };

ok('「这是谁」：登录的人按登录名（带登录方式）；没登录是空串；不通、5xx、形状不对不算数', whoKey(200, { authenticated: true, login: 'alpha', via: 'cookie' }) === 'cookie:alpha'
  && whoKey(200, { authenticated: false }) === '' && whoKey(401, null) === '' && whoKey(0, null) === undefined && whoKey(502, { error: 'identity_unavailable' }) === undefined
  && whoKey(500, {}) === undefined && whoKey(200, null) === undefined && whoKey(403, {}) === undefined);

const run = async () => {
  const answers = [me('alpha'), me('alpha'), { status: 502, body: { error: 'identity_unavailable' } }, { status: 0, body: null }, me('beta'), out, out];
  let asks = 0, lost = 0;
  const w = createSessionWatch({ ask: async () => { asks++; return answers.shift(); }, onLost: () => lost++, setTimer: (fn) => fn() });
  await w.check();
  ok('第一次问只是记下是谁，不算变', w.generation() === 0 && lost === 0);
  await w.check();
  ok('还是同一个人：不变', w.generation() === 0 && lost === 0);
  await w.check(); await w.check();
  ok('身份服务连不上（502）、断网：不算变，什么都不清', w.generation() === 0 && lost === 0);
  await w.check();
  ok('换了人：世代号加一、通知一次', w.generation() === 1 && lost === 1);
  await w.check();
  ok('没登录了：再加一', w.generation() === 2 && lost === 2);
  await w.check();
  ok('还是没登录：不再加', w.generation() === 2 && lost === 2 && asks === 7);
  // 合并：同时问多次只发一个请求
  let n = 0; let release;
  const w2 = createSessionWatch({ ask: () => { n++; return new Promise((r) => { release = r; }); } });
  const a = w2.check(), b = w2.check();
  release(me('alpha')); await a; await b;
  ok('正在问的时候再要求确认：合并成一次', n === 1);
  // 去抖：一连串 401 只确认一次
  const timers = [];
  let n3 = 0;
  const w3 = createSessionWatch({ ask: async () => { n3++; return me('alpha'); }, setTimer: (fn) => { timers.push(fn); } });
  w3.saw401(); w3.saw401(); w3.saw401();
  ok('一连串 401：只排一次确认', timers.length === 1);
  timers[0](); await new Promise((r) => setTimeout(r, 0));
  w3.saw401();
  ok('确认过之后再来 401：再排一次', timers.length === 2 && n3 === 1);
  // 启动时那一问没问成：之后第一次问成按「变了」算一次（页面可能是按别人读的），再往后同一个人不再算
  const seq = [{ status: 502, body: { error: 'identity_unavailable' } }, me('alpha'), me('alpha'), me('beta')];
  let lost4 = 0;
  const w4 = createSessionWatch({ ask: async () => seq.shift(), onLost: () => lost4++ });
  await w4.check();
  ok('启动时那一问没问成（502）：不算变', w4.generation() === 0 && lost4 === 0);
  await w4.check();
  ok('之后第一次问成：按变了算一次（重读，免得页面是按别人读的）', w4.generation() === 1 && lost4 === 1);
  await w4.check();
  ok('再问还是同一个人：不再算', w4.generation() === 1 && lost4 === 1);
  await w4.check();
  ok('换了人：照常算', w4.generation() === 2 && lost4 === 2);
  // 拿到响应头之后、正文读完之前换了人：正文不交回
  {
    const who = [me('alpha'), me('beta')];
    const w5 = createSessionWatch({ ask: async () => who.shift() });
    await w5.check();
    let releaseBody;
    const fakeRaw = async () => ({ status: 200, json: () => new Promise((r) => { releaseBody = () => r({ items: ['alpha 的事项'] }); }), text: async () => 'x' });
    const f = guardedFetch(fakeRaw, w5, 'http://wm.invalid');
    const r = await f('/api/work-items');
    let got = 'pending';
    r.json().then((v) => { got = v; });
    await w5.check(); // 这时换成了 beta
    releaseBody(); await new Promise((x) => setTimeout(x, 10));
    ok('响应头已到、正文还没读完时换了人：正文不交回', w5.generation() === 1 && got === 'pending', JSON.stringify(got));
    // 没换人照常交回；不是 /api/ 的不管
    const w6 = createSessionWatch({ ask: async () => me('alpha') }); await w6.check();
    const r2 = await guardedFetch(async () => ({ status: 200, json: async () => ({ ok: 1 }), text: async () => 't' }), w6, 'http://wm.invalid')('/api/x');
    ok('没换人：正文照常交回', JSON.stringify(await r2.json()) === '{"ok":1}' && (await r2.text()) === 't');
  }
  console.log(`\nsession-watch-unit: ${pass} 过 / ${fail} 败`);
  process.exit(fail ? 1 : 0);
};
await run();
