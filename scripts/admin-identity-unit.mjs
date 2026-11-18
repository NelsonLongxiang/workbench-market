#!/usr/bin/env node
/** 站内管理员身份（web/src/admin-token.ts 的 refreshAdminIdentity / adminLogin / adminActive）：
 *  只认 /api/admin/whoami 回 via=grant（管理员授予的站内账号）；Odoo 已下线，via=odoo 再说是管理员也不算；
 *  via=token、没给登录名、出错都不算。先是管理员、后来不是了，结论跟着清掉。全是合成值。 */
let reply = null;
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.fetch = async (url) => {
  if (url !== '/api/admin/whoami') throw new Error('unexpected ' + url);
  if (reply instanceof Error) throw reply;
  return { ok: true, status: 200, json: async () => reply };
};
const { adminActive, adminLogin, refreshAdminIdentity } = await import('../web/src/admin-token.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const as = async (body) => { reply = body; await refreshAdminIdentity(); return adminLogin(); };

ok('via=grant 带登录名：是站内管理员，记下登录名', (await as({ via: 'grant', login: 'syn-admin' })) === 'syn-admin' && adminActive() === true);
ok('接着 via=odoo（服务端遗留的身份来源说法）：不算管理员，先前的结论清掉', (await as({ via: 'odoo', login: 'syn-admin' })) === null && adminActive() === false);
ok('via=odoo 一上来就说是管理员：也不算', (await as({ via: 'odoo', login: 'syn-odoo' })) === null);
ok('via=token（口令）：不算站内管理员（口令另走 adminTokenPresent）', (await as({ via: 'token', login: null })) === null);
ok('via=grant 但没给登录名、登录名不是字符串：不算', (await as({ via: 'grant' })) === null && (await as({ via: 'grant', login: 7 })) === null);
ok('via 大小写不同、带空格：不算（只认恰好 grant）', (await as({ via: 'Grant', login: 'x' })) === null && (await as({ via: ' grant', login: 'x' })) === null);
await as({ via: 'grant', login: 'syn-admin' });
ok('读不到（出错）：不算，先前的结论清掉', (await as(new Error('offline'))) === null && adminActive() === false);
ok('应答不是对象：不算', (await as(null)) === null && (await as('grant')) === null);

console.log(`\nadmin-identity-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
