#!/usr/bin/env node
/** Odoo 弹窗登录链接（web/src/pages/odoo-login-href.ts，node 直接剥类型运行）：return 换成当前页面（含 query），只回 path。 */
const { odooLoginHref } = await import('../web/src/pages/odoo-login-href.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const h = odooLoginHref('/go/7/?return=%2Ftasks', 'http://wm.test:9800', '/tasks?q=2026-12-18T18:00:00+08:00');
ok('return 换成当前页面（含 query），只回 path', h === '/go/7/?return=%2Ftasks%3Fq%3D2026-12-18T18%3A00%3A00%2B08%3A00', h);
const x = odooLoginHref('http://evil.example/go/7/?return=%2Ftasks', 'http://wm.test:9800', '/tasks');
ok('绝对地址也只取 path+query，不带出别的源', x === '/go/7/?return=%2Ftasks', x);
console.log(`odoo-login-href-unit: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
