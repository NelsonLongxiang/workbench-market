#!/usr/bin/env node
/**
 * 身份契约的单测：身份服务对提供方的回答怎么收。进程内，不开数据库，不起服务，不访问任何外部系统。
 * 登录提供方换成假的（scripts/identity-fake-provider.mjs）。
 *
 *   node scripts/identity-contract-test.mjs              测本仓库
 *   node scripts/identity-contract-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSIONS, fakePlugin, fakeProvider, swapInFake } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
// 自带的提供方读这些环境变量；清掉，保证「没配置」这一支是确定的
for (const k of ['WM_ODOO_URL', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_ODOO_LOGIN_PROXY', 'WM_ODOO_BROWSER_URL']) delete process.env[k];

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const cookie = (sid) => `other=1; session_id=${sid}`;
const show = (v) => JSON.stringify(v);

// ---------- 一、出厂的装配 ----------
const { pathToFileURL } = await import('node:url');
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
  const bad = [null, {}, { name: 'x' }, { name: '', configured() {}, credentialOf() {}, resolveViewer() {} }, { name: 'x', configured: true, credentialOf() {}, resolveViewer() {} }];
  let rejected = 0;
  for (const p of bad) { try { id().register(p); } catch { rejected++; } }
  check(rejected === bad.length && id().providerName() === null, '不合契约的提供方登记不上', `${rejected}/${bad.length}`);
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

console.log(`identity-contract-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
