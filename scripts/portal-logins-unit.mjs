#!/usr/bin/env node
/** 门户名单的写法（web/src/portal-logins.ts）：新写站内账号，历史 odoo: 项原样保留。 */
const { loginShown, loginLabel } = await import('../web/src/portal-logins.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
ok('站内账号 user:<名>：表单里只显示名字（交回去服务端按 user: 算）', loginShown('user:bob') === 'bob');
ok('历史 odoo:<登录名>：表单里原样留着（去掉前缀交回去会变成同名的站内账号，换了人）', loginShown('odoo:jia') === 'odoo:jia');
ok('没前缀的旧写法照显示', loginShown('alice') === 'alice');
ok('卡片上：站内账号写名字，历史项写明是 Odoo 历史登录名', loginLabel('user:bob') === 'bob' && loginLabel('odoo:jia') === 'jia（Odoo 历史登录名）' && loginLabel('alice') === 'alice');
console.log(`\nportal-logins-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
