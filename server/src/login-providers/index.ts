/**
 * 登录提供方清单：这个部署装哪些登录提供方插件。
 *
 * 换登录方式改的是这里和本目录下的插件，不是核心。清单只交出插件本身（Cordis 的 name / inject / apply），
 * 不转出任何实现里的函数——核心拿到它只能装进上下文，然后经 identity.ts 的契约使用。
 */
import * as odoo from './odoo/index.ts';

export const loginProviders = [odoo];
