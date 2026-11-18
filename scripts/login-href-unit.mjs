#!/usr/bin/env node
/** 登录入口地址单测（web/src/login-href.ts）：Odoo 下线后只认本站 /login；外站和别的路径换成站内登录页，回首页的换成回到当前页。 */
const { loginHref } = await import('../web/src/login-href.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
ok('服务端给 /login（回首页）：换成登录完回到当前页', loginHref('/login', '/work-items?q=2026-12-18T18:00:00+08:00') === '/login?next=%2Fwork-items%3Fq%3D2026-12-18T18%3A00%3A00%2B08%3A00');
ok('服务端给带 next 的 /login：照用', loginHref('/login?next=%2Fmarket', '/work-items') === '/login?next=%2Fmarket');
ok('当前页就是首页：只回 /login', loginHref('/login', '/') === '/login');
ok('外站地址不用（以前的 Odoo 登录地址）：换成站内登录页', loginHref('http://evil.example/web/login?redirect=%2F', '/work-items') === '/login?next=%2Fwork-items');
ok('// 开头的协议相对地址不用', loginHref('//evil.example/login', '/a') === '/login?next=%2Fa');
ok('以前的同域 Odoo 中继 /web/login、门户 /go/ 不用', loginHref('/web/login?redirect=%2F', '/a') === '/login?next=%2Fa' && loginHref('/go/7/?return=%2F', '/a') === '/login?next=%2Fa');
ok('没给 login_url、不是字符串：站内登录页', loginHref(undefined, '/a') === '/login?next=%2Fa' && loginHref(42, '/') === '/login');
ok('结尾锚定：只是前缀像 /login 的不用（/loginx、/login.evil、/login/x、/login/../go/）', ['/loginx', '/login.evil.example', '/login/x', '/login/../go/7/'].every((u) => loginHref(u, '/a') === '/login?next=%2Fa'));
ok('结尾锚定：查询串里带 # 或空白的不用（# 后、空白后可以接任意东西）', loginHref('/login?next=%2Fa#//evil.example', '/b') === '/login?next=%2Fb' && loginHref('/login?next=%2Fa x', '/b') === '/login?next=%2Fb' && loginHref('/login\n//evil', '/b') === '/login?next=%2Fb');
ok('当前页地址不正常（// 开头）：不带 next', loginHref('/login', '//evil.example/x') === '/login');
console.log(`\nlogin-href-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
