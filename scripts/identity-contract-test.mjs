#!/usr/bin/env node
/**
 * 身份契约的单测：身份服务对提供方的回答怎么收。进程内，不开数据库，不起服务，不访问任何外部系统。
 * 登录提供方换成假的（scripts/identity-fake-provider.mjs）。
 *
 *   node scripts/identity-contract-test.mjs              测本仓库
 *   node scripts/identity-contract-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEADLINE_MS, SESSIONS, fakePlugin, fakeProvider, swapInFake } from './identity-fake-provider.mjs';

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
