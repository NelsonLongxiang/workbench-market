/**
 * 登录提供方清单：这个部署装哪些登录提供方插件。
 *
 * 换登录方式改的是这里和本目录下的插件，不是核心。清单只交出插件本身（Cordis 的 name / inject / apply），
 * 不转出任何实现里的函数——核心拿到它只能装进上下文，然后经 identity.ts 的契约使用。
 */
import * as odoo from './odoo/index.ts';
import * as feishu from './feishu/index.ts';

/** Odoo 是身份来源（每次请求现查它的会话）加业务台的登录中继；飞书是发市场会话的登录方式（WM_FEISHU_LOGIN=on 才可用） */
export const loginProviders = [odoo, feishu];
