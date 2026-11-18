/**
 * 登录提供方清单：这个部署装哪些登录提供方插件。
 *
 * 换登录方式改的是这里和本目录下的插件，不是核心。清单只交出插件本身（Cordis 的 name / inject / apply），
 * 不转出任何实现里的函数——核心拿到它只能装进上下文，然后经 identity.ts 的契约使用。
 */
import * as feishu from './feishu/index.ts';
import * as local from './local/index.ts';

/** 飞书是发市场会话的登录方式（WM_FEISHU_LOGIN=on 才可用）；账号密码是站内账号的登录方式（WM_LOCAL_LOGIN，缺省开）。
 *  Odoo（身份来源加业务台的登录中继）已下线（2026-11-17）：不再登记任何身份来源，也不再有业务台的登录中继 */
export const loginProviders = [feishu, local];
