#!/usr/bin/env node
/**
 * 身份契约的单测：身份服务对提供方的回答怎么收，认出来的人怎么对到主体上。进程内，不开数据库，不起服务，不访问任何外部系统。
 * 登录提供方换成假的，主体目录用内存版（都在 scripts/identity-fake-provider.mjs）。
 *
 *   node scripts/identity-contract-test.mjs              测本仓库
 *   node scripts/identity-contract-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEADLINE_MS, SESSIONS, directoryPlugin, fakePlugin, fakeProvider, memoryDirectory, onceSession, swapInFake } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
// 自带的提供方读这些环境变量；清掉，保证「没配置」这一支是确定的
for (const k of ['WM_ODOO_URL', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_ODOO_LOGIN_PROXY', 'WM_ODOO_BROWSER_URL']) delete process.env[k];
// 假提供方的夹具只在测试环境里干活（它自己有守卫，见第五节）
process.env.NODE_ENV = 'test';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const cookie = (sid) => `other=1; session_id=${sid}`;
const show = (v) => JSON.stringify(v);

// ---------- 一、出厂的装配 ----------
const shipped = await import(pathToFileURL(join(ROOT, 'server/src/identity.ts')).href);
check(shipped.identity().providerName() === 'odoo', '出厂：身份服务后面是自带的提供方');
check(shipped.identity().configured() === false, '出厂、没配身份来源：configured() 为 false');
{
  const who = await shipped.identity().whoami(cookie(SESSIONS.alpha));
  check(who.http === 503 && who.body.ok === false && !('auth_required' in who.body), '出厂、没配身份来源：whoami 503，不带 auth_required', show(who));
  const r = await shipped.identity().resolveViewer(cookie(SESSIONS.alpha));
  check(r.ok === false && r.http === 503, '出厂、没配身份来源：认不出人（503）', show(r));
}
check(typeof shipped.loginRelay().sessionOf === 'function' && shipped.loginRelay().isSessionTarget('http://anything.invalid/') === false, '出厂：登录中继在，没配可信源时谁都不给会话');

// ---------- 二、换成假的提供方：服务怎么收它的回答 ----------
const tree = await swapInFake(ROOT);
const id = tree.identity;
check(id().providerName() === 'fake' && id().configured() === true, '换提供方不用改核心：卸掉自带的插件，装上假的');
// 不开库，主体目录用内存版。没有目录，身份服务不认任何人（见「二之二」）
const directory = memoryDirectory();
let directoryFiber = tree.root.plugin(directoryPlugin(directory));
await directoryFiber;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const deny = async (label, sid, http) => {
  let r, threw = null;
  try { r = await id().resolveViewer(sid === null ? '' : cookie(sid)); } catch (e) { threw = e; }
  check(!threw && r?.ok === false && r.http === http, `${label} → 认不出（${http}）`, threw ? `抛错：${threw.message}` : show(r));
};
await deny('没有会话', null, 401);
await deny('伪造的会话', SESSIONS.forged, 401);
await deny('身份来源不可达', SESSIONS.unreachable, 502);
await deny('提供方抛错：按失败处理，服务自己不抛', SESSIONS.throws, 502);
await deny('非内部账号', SESSIONS.portal, 403);
await deny('回答畸形（ok:true 却没有查看者）', SESSIONS.malformed, 502);
await deny('冒名主体（登录名 mallory，主体写成 user:alpha）', SESSIONS.impersonate, 502);
// 四条形状校验，各有各的假回答：主体都照着登录名写、还自称管理员，只有那一条拦得住
await deny('登录名前面带空格', SESSIONS.paddedLogin, 502);
await deny('登录名里有控制字符', SESSIONS.controlLogin, 502);
await deny('登录名超过 128 个字符', SESSIONS.longLogin, 502);
await deny('登录名不是字符串', SESSIONS.numericLogin, 502);
await deny('uid 是字符串', SESSIONS.stringUid, 502);
await deny('没有 uid', SESSIONS.missingUid, 502);
await deny('显示名是数字', SESSIONS.numberName, 502);
await deny('没有显示名这一项', SESSIONS.missingName, 502);
await deny('说认不出、状态码却是 200：不照传，按认不出', SESSIONS.refusal200, 502);
await deny('说认不出、状态码是 302：不照传', SESSIONS.refusal302, 502);
await deny('说认不出、却没有说法', SESSIONS.refusalNoText, 502);
// 回答对象自己会抛错：服务不抛，按认不出
await deny('回答对象的 ok 一读就抛错', SESSIONS.okThrows, 502);
await deny('回答对象的 viewer 一读就抛错', SESSIONS.viewerThrows, 502);
{
  // 每个字段只读一次：交出去的查看者，登录名和主体对得上
  const r = await id().resolveViewer(cookie(SESSIONS.flipLogin));
  check(r.ok === true && r.viewer.login === 'alpha' && r.viewer.sub === 'user:alpha' && r.viewer.admin === false, '登录名再读一次会变的回答：只读一次，登录名和主体对得上', show(r));
}
{
  // 期限：提供方永远不回答，到它自报的期限就按不可用处理。外面再套一块 3 秒的表，防的是期限没生效时测试自己挂住
  const outer = () => new Promise((done) => setTimeout(() => done('still-waiting'), 3000));
  const t0 = Date.now();
  const r = await Promise.race([id().resolveViewer(cookie(SESSIONS.hangs)), outer()]);
  const ms = Date.now() - t0;
  const inTime = r !== 'still-waiting' && r.ok === false && r.http === 502 && ms >= DEADLINE_MS - 20;
  check(inTime, `提供方永远不回答 → 到期限（${DEADLINE_MS} 毫秒）按不可用处理，不一直等`, `${ms} 毫秒：${show(r)}`);
  const w = inTime ? await Promise.race([id().whoami(cookie(SESSIONS.hangs)), outer()]) : 'still-waiting';
  check(w !== 'still-waiting' && w.http === 502 && w.body.ok === false, 'whoami 提供方永远不回答 → 502', show(w));
}

const viewerOf = async (sid) => { const r = await id().resolveViewer(cookie(sid)); return r.ok ? r.viewer : null; };
{
  const v = await viewerOf(SESSIONS.noAdminFlag);
  check(v?.login === 'no-flag' && v.admin === false, '管理员标记缺失 → 认得出人，但不是管理员', show(v));
}
{
  const v = await viewerOf(SESSIONS.truthyAdmin);
  check(v?.login === 'truthy-flag' && v.admin === false, '管理员标记是字符串 "true" → 不是管理员（只认布尔 true）', show(v));
}
{
  const v = await viewerOf(SESSIONS.alpha);
  check(v && show(v) === show({ login: 'alpha', uid: 11, sub: 'user:alpha', name: 'Synthetic alpha', admin: false }), '对照：内部员工认得出，字段与顺序照契约', show(v));
}
{
  const v = await viewerOf(SESSIONS.admin);
  check(v?.login === 'root-admin' && v.admin === true, '对照：管理员标记是 true → 是管理员', show(v));
}

// whoami
{
  const anon = await id().whoami('');
  check(anon.http === 401 && anon.body.ok === false && anon.body.auth_required === true, 'whoami 没有会话 → 401，auth_required', show(anon));
  const down = await id().whoami(cookie(SESSIONS.unreachable));
  check(down.http === 502 && down.body.auth_required === false, 'whoami 身份来源不可达 → 502，不让人去重新登录', show(down));
  const crash = await id().whoami(cookie(SESSIONS.throws));
  check(crash.http === 502 && crash.body.ok === false, 'whoami 提供方抛错 → 502', show(crash));
  const lie = await id().whoami(cookie(SESSIONS.refusal200));
  check(lie.http === 502 && lie.body.ok === false, 'whoami 说认不出、状态码却是 200 → 502（登录探测把 200 当成已登录）', show(lie));
  const boom = await id().whoami(cookie(SESSIONS.okThrows)).catch((e) => ({ http: 0, body: { threw: String(e?.message ?? e) } }));
  check(boom.http === 502 && boom.body.ok === false, 'whoami 回答对象一读就抛错 → 502，服务自己不抛', show(boom));
  const noFlag = await id().whoami(cookie(SESSIONS.noAdminFlag));
  check(noFlag.http === 200 && noFlag.body.viewer?.admin === false, 'whoami 管理员标记缺失 → admin 是 false', show(noFlag));
  const ok = await id().whoami(cookie(SESSIONS.alpha));
  check(ok.http === 200 && show(ok.body) === show({ ok: true, viewer: { login: 'alpha', uid: 11, sub: 'user:alpha', name: 'Synthetic alpha', admin: false, kind: '人' }, roles: null }), '对照：whoami 内部员工 → 200，应答的形状不变', show(ok));
}

// 凭据：只取不验
check(id().credentialOf(cookie(SESSIONS.alpha)) === SESSIONS.alpha && id().credentialOf('other=1') === '', 'credentialOf：取出会话，没有就是空串');

// ---------- 二之二、主体目录：提供方认出的人，对到主体上才算数 ----------
{
  const c = cookie(SESSIONS.beta);
  const before = await id().resolveViewer(c);
  check(before.ok === true && before.viewer.sub === 'user:beta', '对照：beta 认得出，主体是 user:beta', show(before));
  directory.disable('user:beta');
  const off = await id().resolveViewer(c);
  check(off.ok === false && off.http === 403 && off.error === '主体已停用' && before.ok === true, '主体停用 → 认不出（403，主体已停用）', show(off));
  const who = await id().whoami(c);
  check(who.http === 403 && who.body.ok === false && who.body.auth_required === false && !('viewer' in who.body), 'whoami 主体停用 → 403，不带查看者，不让人去重新登录', show(who));
  const other = await id().resolveViewer(cookie(SESSIONS.alpha));
  check(other.ok === true && other.viewer.login === 'alpha', '对照：停用 beta 不影响 alpha', show(other));
  directory.restore('user:beta');
  const back = await id().resolveViewer(c);
  check(back.ok === true && back.viewer.sub === 'user:beta' && off.ok === false, '恢复之后 → 照常认得出', show(back));
}
{
  // 主体标识用目录给的，不用提供方自己写的：把 no-flag 这个登录预先绑到另一个主体上
  directory.bind('fake', 'no-flag', 'user:renamed');
  const r = await id().resolveViewer(cookie(SESSIONS.noAdminFlag));
  check(r.ok === true && r.viewer.login === 'no-flag' && r.viewer.sub === 'user:renamed', '查看者的主体标识用目录给的（登录名 no-flag，主体 user:renamed）', show(r));
}
{
  // 标识被别的主体占着、这个外部身份却没绑定：不自动认领（用一个还没被认过的登录）
  directory.occupy('user:occupied');
  const r = await id().resolveViewer(cookie(onceSession('occupied', true)));
  check(r.ok === false && r.http === 403 && /没有对到主体/.test(r.error), '标识已被占用、外部身份没绑定 → 不认领（403）', show(r));
}
{
  // 认不出的人不去问目录：目录里不会多出没被认出的人
  const asked = directory.admitted, size = directory.size;
  for (const sid of [SESSIONS.forged, SESSIONS.unreachable, SESSIONS.portal, SESSIONS.impersonate, SESSIONS.malformed]) await id().resolveViewer(cookie(sid));
  check(directory.admitted === asked && directory.size === size, '提供方没认出来的，不问目录、不建主体', `问了 ${directory.admitted - asked} 次`);
}
{
  // 目录的回答同样不照单全收：只有 ok:true 加一个人的主体标识才放行
  const garbage = [
    ['null', () => null], ['undefined', () => undefined], ['一个字符串', () => 'yes'], ['空对象', () => ({})],
    ['ok:true 却没有主体', () => ({ ok: true })], ['主体是数字', () => ({ ok: true, principal: 5 })], ['主体是空串', () => ({ ok: true, principal: '' })],
    ['主体不是人（seat:）', () => ({ ok: true, principal: 'seat:alpha' })], ['主体只有前缀', () => ({ ok: true, principal: 'user:' })], ['主体的名前面带空格', () => ({ ok: true, principal: 'user: alpha' })],
    ['ok 是字符串 "true"', () => ({ ok: 'true', principal: 'user:alpha' })], ['ok 是 1', () => ({ ok: 1, principal: 'user:alpha' })],
    ['ok:false 却没有原因', () => ({ ok: false })], ['ok:false、原因不认识', () => ({ ok: false, reason: 'whatever' })],
    ['ok 一读就抛错', () => ({ get ok() { throw new Error('synthetic'); } })], ['principal 一读就抛错', () => ({ ok: true, get principal() { throw new Error('synthetic'); } })],
  ];
  const leaked = [];
  for (const [label, answer] of garbage) {
    directory.answerWith(answer);
    let r, threw = null;
    try { r = await id().resolveViewer(cookie(SESSIONS.alpha)); } catch (e) { threw = e; }
    if (threw || r?.ok !== false || r.http !== 503) leaked.push(`${label}：${threw ? `抛错 ${threw.message}` : show(r)}`);
  }
  check(leaked.length === 0, `目录的回答形状不对（${garbage.length} 种）→ 一律认不出（503），服务自己不抛`, leaked.join('；'));
  directory.answerWith(() => ({ ok: false, reason: 'disabled' }));
  const disabled = await id().resolveViewer(cookie(SESSIONS.alpha));
  directory.answerWith(() => ({ ok: false, reason: 'unbound' }));
  const unbound = await id().resolveViewer(cookie(SESSIONS.alpha));
  check(disabled.ok === false && disabled.http === 403 && unbound.ok === false && unbound.http === 403, '目录说停用、说对不上 → 403', show([disabled, unbound]));
  directory.answerWith(null);
  directory.failWith(new Error('synthetic directory failure'));
  const down = await id().resolveViewer(cookie(SESSIONS.admin)).catch((e) => ({ threw: String(e?.message ?? e) }));
  check(down.ok === false && down.http === 503, '目录抛错 → 认不出（503），管理员会话也一样，服务自己不抛', show(down));
  directory.failWith(null);
  const ok = await id().resolveViewer(cookie(SESSIONS.alpha));
  check(ok.ok === true && ok.viewer.sub === 'user:alpha', '对照：目录正常时照常认得出', show(ok));
}
{
  // 没装目录：谁都不认。装回去才认
  await directoryFiber.dispose();
  const none = await id().resolveViewer(cookie(SESSIONS.admin));
  const who = await id().whoami(cookie(SESSIONS.admin));
  check(none.ok === false && none.http === 503 && who.http === 503 && who.body.ok === false, '主体目录没装上 → 不认任何人（503），管理员会话也一样', show([none, who]));
  // 装了一个形状不对的东西：照样当没有
  const bogus = tree.root.plugin({ name: 'principal-directory-bogus', apply(ctx) { ctx.provide('principals', { admit: 'not-a-function' }); } });
  await bogus;
  const wrong = await id().resolveViewer(cookie(SESSIONS.admin));
  check(wrong.ok === false && wrong.http === 503, '装上的目录形状不对 → 照样不认', show(wrong));
  await bogus.dispose();
  directoryFiber = tree.root.plugin(directoryPlugin(directory));
  await directoryFiber;
  const back = await id().resolveViewer(cookie(SESSIONS.admin));
  check(back.ok === true && back.viewer.admin === true && none.ok === false, '对照：目录装回去，照常认得出', show(back));
}

// ---------- 二之三、带缓存的认人：提供方的回答可以留一会儿，主体那一步每次现查 ----------
{
  const original = fakeProvider.resolveViewer;
  let asked = 0;
  fakeProvider.resolveViewer = (...args) => { asked++; return original(...args); };
  try {
    const TTL = 400;
    const cached = id().cachedResolver({ ttlMs: TTL, max: 2 });
    const c = cookie(onceSession('cache-a', true));
    let n = asked;
    const first = await cached(c), second = await cached(c);
    check(first.ok === true && second.ok === true && second.viewer.login === 'cache-a' && second.viewer.admin === true && asked - n === 1, '缓存期内同一个会话：提供方只被问一次', `问了 ${asked - n} 次：${show(second)}`);
    const live = await id().resolveViewer(c);
    check(live.ok === false && live.http === 401, '对照：不带缓存的认人每次现查（这个会话提供方只认第一次）', show(live));
    // 主体那一步不进缓存
    const admitted = directory.admitted;
    await cached(c);
    check(directory.admitted === admitted + 1, '缓存命中也照样问主体目录');
    directory.disable('user:cache-a');
    n = asked;
    const off = await cached(c);
    check(off.ok === false && off.http === 403 && asked === n, '缓存命中时主体已停用 → 立即认不出（不等缓存过期，也不用重问提供方）', show(off));
    directory.restore('user:cache-a');
    const back = await cached(c);
    check(back.ok === true && back.viewer.login === 'cache-a' && asked === n, '恢复 → 立即认得出（停用时的拒绝没有进缓存）', show(back));
    {
      // 停用期间才第一次来的会话：提供方认得出，目录不认。这一次的拒绝不进缓存——恢复之后不用等缓存过期
      const later = cookie(onceSession('cache-a', false)); // 同一个登录名的另一个会话，缓存里还没有它
      directory.disable('user:cache-a');
      const during = await cached(later);
      directory.restore('user:cache-a');
      const after = await cached(later);
      check(during.ok === false && during.http === 403 && after.ok === true && after.viewer.login === 'cache-a', '停用期间第一次来的会话：当时不认；恢复之后立即认得出（缓存的是提供方的回答，不是目录的结论）', show([during, after]));
    }
    // 交出去的是副本
    back.viewer.login = 'root-admin'; back.viewer.sub = 'user:root-admin';
    const again = await cached(c);
    check(again.ok === true && again.viewer.login === 'cache-a' && again.viewer.sub === 'user:cache-a', '调用方改了拿到的查看者，改不到缓存里的那一份', show(again));
    // 认不出也留着，同样是副本
    n = asked;
    const no1 = await cached(cookie(SESSIONS.forged));
    no1.ok = true; no1.http = 200;
    const no2 = await cached(cookie(SESSIONS.forged));
    check(no2.ok === false && no2.http === 401 && asked - n === 1, '认不出的回答也留着（提供方只被问一次），调用方改不到缓存', `问了 ${asked - n} 次：${show(no2)}`);
    // 没有凭据不缓存
    n = asked;
    await cached('other=1'); await cached('other=1');
    check(asked - n === 2, '没有凭据的请求不进缓存');
    // 过期
    await sleep(TTL + 60);
    n = asked;
    const expired = await cached(c);
    check(expired.ok === false && expired.http === 401 && asked - n === 1, '过了期限 → 重新问提供方（这个会话已经失效）', show(expired));
    // 容量：超过 max 就清空，不会无限长
    const small = id().cachedResolver({ ttlMs: 60_000, max: 2 });
    n = asked;
    for (const sid of [SESSIONS.alpha, SESSIONS.beta, SESSIONS.admin, SESSIONS.portal]) await small(cookie(sid));
    await small(cookie(SESSIONS.alpha));
    check(asked - n === 5, '缓存有容量：放满之后清空，最早的那个要重新问', `问了 ${asked - n} 次`);
    // 各建各的，互不相干
    const one = id().cachedResolver({ ttlMs: 60_000, max: 10 }), two = id().cachedResolver({ ttlMs: 60_000, max: 10 });
    n = asked;
    await one(cookie(SESSIONS.alpha)); await two(cookie(SESSIONS.alpha)); await one(cookie(SESSIONS.alpha)); await two(cookie(SESSIONS.alpha));
    check(asked - n === 2, '两个带缓存的认人各有各的缓存', `问了 ${asked - n} 次`);
    // 换了提供方，旧回答作废
    const kept = id().cachedResolver({ ttlMs: 60_000, max: 10 });
    const before = await kept(cookie(SESSIONS.admin));
    await tree.fiber.dispose();
    const off2 = id().register({ name: 'other', configured: () => true, credentialOf: fakeProvider.credentialOf, resolveViewer: async () => ({ ok: false, http: 401, error: '另一个提供方不认这个会话' }) });
    const after = await kept(cookie(SESSIONS.admin));
    check(before.ok === true && before.viewer.admin === true && after.ok === false && after.http === 401, '换了提供方：旧提供方的回答作废，不拿来放行', show(after));
    off2();
    tree.fiber = tree.root.plugin(fakePlugin);
    await tree.fiber;
    // 参数写得不对，建不出来
    let rejected = 0;
    const bad = [undefined, {}, { ttlMs: 0, max: 10 }, { ttlMs: -1, max: 10 }, { ttlMs: 300_001, max: 10 }, { ttlMs: '30000', max: 10 }, { ttlMs: NaN, max: 10 }, { ttlMs: 1000, max: 0 }, { ttlMs: 1000, max: 1.5 }, { ttlMs: 1000 }];
    for (const o of bad) { try { id().cachedResolver(o); } catch { rejected++; } }
    check(rejected === bad.length, '带缓存的认人：期限或容量写得不对就建不出来', `${rejected}/${bad.length}`);
  } finally {
    fakeProvider.resolveViewer = original;
  }
}

// ---------- 三、登记的规矩 ----------
{
  let msg = '';
  try { id().register({ ...fakeProvider, name: 'second' }); } catch (e) { msg = e.message; }
  check(/已经有登录提供方/.test(msg) && id().providerName() === 'fake', '同时只能有一个提供方：第二个登记被拒，原来的不受影响', msg);
}

// ---------- 四、撤销 ----------
await tree.fiber.dispose();
check(id().providerName() === null && id().configured() === false, '插件卸载：提供方随之撤销');
{
  const r = await id().resolveViewer(cookie(SESSIONS.admin));
  check(r.ok === false && r.http === 503, '没装提供方 → 认不出人（503），管理员会话也一样', show(r));
  const who = await id().whoami(cookie(SESSIONS.admin));
  check(who.http === 503 && who.body.ok === false, '没装提供方 → whoami 503', show(who));
  check(id().credentialOf(cookie(SESSIONS.admin)) === '', '没装提供方 → 没有凭据可取');
  let threw = false;
  try { tree.loginRelay(); } catch { threw = true; }
  check(threw, '没装登录中继 → 取用即抛错，不给一个什么都放行的空实现');
}
{
  const whole = { name: 'x', configured() {}, credentialOf() {}, resolveViewer() {} };
  const bad = [null, {}, { name: 'x' }, { ...whole, name: '' }, { ...whole, configured: true },
    { ...whole, deadlineMs: 0 }, { ...whole, deadlineMs: -1 }, { ...whole, deadlineMs: 60001 }, { ...whole, deadlineMs: '250' }, { ...whole, deadlineMs: Infinity }, { ...whole, deadlineMs: NaN }];
  let rejected = 0;
  for (const p of bad) { try { id().register(p); } catch { rejected++; } }
  check(rejected === bad.length && id().providerName() === null, '不合契约的提供方登记不上（含期限写得不对的）', `${rejected}/${bad.length}`);
}
{
  // 提供方连 configured()、credentialOf() 都抛错：照样朝认不出收
  const off = id().register({ name: 'broken', configured() { throw new Error('x'); }, credentialOf() { throw new Error('x'); }, async resolveViewer() { return 'nonsense'; } });
  const r = await id().resolveViewer(cookie(SESSIONS.alpha));
  check(id().configured() === false && id().credentialOf('session_id=x') === '' && r.ok === false && r.http === 502, '提供方处处出错 → 没配置、没凭据、认不出', show(r));
  off();
  check(id().providerName() === null, '撤销函数只撤自己登记的那一个');
}
{
  // 装回去还能用：撤销是干净的
  const again = tree.root.plugin(fakePlugin);
  await again;
  const v = await viewerOf(SESSIONS.alpha);
  check(v?.login === 'alpha', '撤销之后重新装上，照常认人');
  await again.dispose();
}

// ---------- 五、夹具的守卫：不是测试环境，假提供方装不上 ----------
{
  const preload = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
  const probe = "import(process.argv[1]).then((m) => console.log('PROVIDER=' + m.identity().providerName()))";
  const start = (nodeEnv) => {
    const env = { ...process.env, IDENTITY_SEAM_ROOT: ROOT };
    if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
    return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', preload, '-e', probe, pathToFileURL(join(ROOT, 'server/src/identity.ts')).href], { env, encoding: 'utf8', timeout: 60000 });
  };
  for (const [label, nodeEnv] of [['production', 'production'], ['没设', undefined], ['development', 'development']]) {
    const r = start(nodeEnv);
    check(r.status === 1 && /拒绝加载/.test(r.stderr) && !r.stdout.includes('PROVIDER='), `NODE_ENV=${label}：预加载拒绝，进程退出，后面的入口不会运行`, `status=${r.status} ${r.stdout.trim()} ${r.stderr.trim().slice(0, 160)}`);
  }
  const ok = start('test');
  check(ok.status === 0 && ok.stdout.includes('PROVIDER=fake'), '对照·NODE_ENV=test：预加载照常把提供方换成假的', `status=${ok.status} ${ok.stdout.trim()} ${ok.stderr.trim().slice(0, 160)}`);
  // 不经预加载、直接用夹具，同样拒绝：换提供方的函数不干活，假插件自己也装不上
  const direct = (code) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code, pathToFileURL(join(HERE, 'identity-fake-provider.mjs')).href, ROOT], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 60000 });
  const swap = direct("import(process.argv[1]).then((m) => m.swapInFake(process.argv[2])).then(() => console.log('DONE'), (e) => { console.error(String(e.message)); process.exit(3); })");
  check(swap.status === 3 && /只在 NODE_ENV=test 下可用/.test(swap.stderr) && !swap.stdout.includes('DONE'), 'NODE_ENV=production：直接调夹具的 swapInFake 也拒绝', `status=${swap.status} ${swap.stderr.trim().slice(0, 160)}`);
  const plug = direct("import(process.argv[1]).then((m) => { try { m.fakePlugin.apply({ effect() {}, provide() {}, get() {} }); console.log('DONE'); } catch (e) { console.error(String(e.message)); process.exit(3); } })");
  check(plug.status === 3 && /只在 NODE_ENV=test 下可用/.test(plug.stderr) && !plug.stdout.includes('DONE'), 'NODE_ENV=production：假插件自己也装不上', `status=${plug.status} ${plug.stderr.trim().slice(0, 160)}`);
}

// ---------- 六、身份服务不在：取用即抛错 ----------
{
  for (const fiber of [...(tree.root.registry.get(shipped.IdentityService)?.fibers ?? [])]) await fiber.dispose();
  let msg = '';
  try { id(); } catch (e) { msg = String(e?.message ?? e); }
  check(msg === '身份服务没有装上', '身份服务被卸掉之后，identity() 取用即抛错，不交出 undefined', msg || '没有抛错');
}

console.log(`identity-contract-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
