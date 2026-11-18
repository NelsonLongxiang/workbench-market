#!/usr/bin/env node
/** 扩展兼容层（web/src/ext/odoo-compat.ts，经 @wm/host 导出）：旧名字 odooLoginHref、useOdooPopupLogin 只认站内 /login。
 *  外站地址（以前的 Odoo 登录页）、/web/login、/go/ 一律退回站内登录页，登录完回到当前页；不开弹窗、不轮询。全是合成值。 */
const assigned = [], warns = [];
globalThis.window = { location: { pathname: '/work-items', search: '?q=1', hash: '', assign: (u) => assigned.push(u) } };
const warn0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
const { odooLoginHref, useOdooPopupLogin, ODOO_SESSION_CONFIRMED } = await import('../web/src/ext/odoo-compat.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const BACK = '/login?next=%2Fwork-items%3Fq%3D1';

ok('odooLoginHref：外站地址（以前的 Odoo 登录页）不用，退回站内登录页、回到当前页', odooLoginHref('https://odoo.example.invalid/web/login?redirect=%2F') === BACK, odooLoginHref('https://odoo.example.invalid/web/login'));
ok('odooLoginHref：// 开头、/web/login、/go/ 都不用', [ '//evil.example.invalid/login', '/web/login?redirect=%2F', '/go/7/?return=%2F' ].every((u) => odooLoginHref(u) === BACK));
ok('odooLoginHref：/loginx、/login/../go/ 这种只是前缀像的也不用', odooLoginHref('/loginx') === BACK && odooLoginHref('/login/../go/7/') === BACK);
ok('odooLoginHref：站内 /login 照用（回首页的换成回到当前页）', odooLoginHref('/login') === BACK && odooLoginHref('/login?next=%2Fmarket') === '/login?next=%2Fmarket');

const p = useOdooPopupLogin('https://odoo.example.invalid/web/login', () => {});
p.open(); p.clearAndOpen();
ok('useOdooPopupLogin：open、clearAndOpen 都整页跳站内登录页，不去外站', assigned.length === 2 && assigned.every((u) => u === BACK), assigned);
ok('useOdooPopupLogin：形状照旧，polling、blocked、tokenHere 恒为 false', p.polling === false && p.blocked === false && p.tokenHere === false);
assigned.length = 0; useOdooPopupLogin(null, () => {}).open();
ok('useOdooPopupLogin：没给地址，什么也不做', assigned.length === 0);
ok('每个旧名字只告警一次', warns.filter((w) => w.includes('odooLoginHref')).length === 1 && warns.filter((w) => w.includes('useOdooPopupLogin')).length === 1, warns);
ok('ODOO_SESSION_CONFIRMED 名字照旧（只为旧扩展能编译）', ODOO_SESSION_CONFIRMED === 'wm:odoo-session-confirmed');

console.warn = warn0;
console.log(`\nodoo-compat-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
