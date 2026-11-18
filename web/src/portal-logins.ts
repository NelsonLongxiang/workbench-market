/** 门户名单（台的 access_logins）怎么写、怎么读。Odoo 下线（2026-11-17）后：
 *  - 新写入只收站内账号：表单里填账号名，服务端按 user:<名> 存；
 *  - 库里已有的 odoo:<登录名> 是历史项：改台时只能原样保留或删掉，不能新加（服务端新加的回 400）。
 *  所以表单里 user: 去掉前缀给人看，odoo: 原样留着（去掉前缀再交回去，就会变成同名的站内账号，换了人）。纯函数：scripts/portal-logins-unit.mjs 直接测。 */

/** 表单里显示、也原样交回去的写法：user:<名> 显示成 <名>；odoo:<登录名> 原样 */
export const loginShown = (s: string): string => (s.startsWith('user:') ? s.slice(5) : s);

/** 卡片和详情里怎么说：站内账号写名字；历史 Odoo 登录名写明是历史项 */
export const loginLabel = (s: string): string => (s.startsWith('odoo:') ? `${s.slice(5)}（Odoo 历史登录名）` : loginShown(s));
