/**
 * SSO 回调的路由（/sso/callback）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * Odoo 登录完 302 回到目标台；回跳前核 state 和 cookie、只许本站路径（open-redirect 护栏）。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type { HttpService } from '../http.ts';

export function registerSsoRoutes(app: HttpService): void {
  app.get('/sso/callback', (req, res) => {
    const redirect = String(req.query.redirect ?? '');
    const state = String(req.query.state ?? '');
    if (!redirect || !state) return res.status(400).json({ error: 'redirect 和 state 必填（Odoo 登录回跳统一入口）' });
    {
      // #170 P9：state 必须与 /go/<id>/ 回跳一一对应（伪造 state 旁路拒）
      const mId = /^\/go\/(\d+)\//.exec(redirect);
      if (!mId) return res.status(400).json({ error: 'redirect 形态非法（须 /go/<id>/…）' });
      const ck = new RegExp('(?:^|;\\s*)wm_sso_' + mId[1] + '=([^;\\s]+)').exec(String(req.headers.cookie ?? ''));
      if (!ck || ck[1] !== state) return res.status(400).json({ error: 'SSO state 校验失败（请从市场门户重新进入）' });
    }
    // open-redirect 护栏：只许内域路径（/ 开头且非 //）；再按浏览器 URL 解析复核——WHATWG 把 \ 当 /，/\evil.com 会被解析成外域（#92）
    if (!redirect.startsWith('/') || redirect.startsWith('//') || new URL(redirect, 'http://sso.internal/').host !== 'sso.internal') {
      return res.status(400).json({ error: 'redirect 只许本站路径（/go/... 形态·外域拒）' });
    }
    return res.redirect(302, redirect);
  });
}
