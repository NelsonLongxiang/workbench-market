/**
 * 设计 token 固定路径的路由（/design/tokens@<版本>.css）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 主版本按需重新验证，完整版本长缓存；别的版本 404。公开：登录门特意放行它（自产台的页面要引用）。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type { HttpService } from '../http.ts';
import { loadTokensCss, resolveTokensPath } from '../design-tokens-css.ts';

export function registerDesignTokenRoutes(app: HttpService): void {
  app.get(/^\/design\/tokens@[0-9.]+\.css$/, { action: 'design-token.read', kind: 'read' }, (req, res) => {
    const t = loadTokensCss();
    const kind = t ? resolveTokensPath(req.path, t) : null;
    if (!t || !kind) return res.status(404).type('text').send(t ? `只提供 tokens@${t.major}.css 与 tokens@${t.version}.css\n` : 'design tokens 不可用\n');
    res.setHeader('Cache-Control', kind === 'exact' ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-WM-Tokens-Version', t.version);
    res.type('text/css').send(t.css);
  });
}
