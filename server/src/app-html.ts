/**
 * 出自产台页面 HTML（serveApp 的 HTML 分支）：注入按台令牌，认得出是启用的人时再注入提交人票据（阶段八 8f-2）。
 *
 *   · 只有当前上架的版本出票；历史版本预览（?version=N）不出票。
 *   · 出票抛错：页面照常返回，不带票据（缓存策略照旧）。
 *   · 别的地方出错（认人、拼页面、登录门改写……）：回到原来的 sendFile（原样页面），并记一笔「出页面回落」。
 *     请求一定有应答，不会挂着。
 * 依赖都从参数进来（不直接引用 index.ts），单测可以换成会抛错的实现。
 */
import type express from 'express';

export type AppHtmlDeps = {
  /** 这个请求是哪个人（只经身份服务）；认不出为 null */
  person: (req: express.Request) => Promise<string | null>;
  appToken: (slug: string) => string;
  workbenchId: (slug: string) => string;
  issueTicket: (principal: string, slug: string) => string;
  rewrite: (req: express.Request, html: string) => string;
  /** 出页面回落时记一笔（不记是谁、不记原因） */
  countFallback: () => void;
};

export function serveAppHtml(req: express.Request, res: express.Response, input: { raw: string; abs: string; slug: string; current: boolean }, deps: AppHtmlDeps): Promise<void> {
  const { raw, abs, slug, current } = input;
  const fallback = () => {
    try { deps.countFallback(); } catch { /* 计数失败不影响应答 */ }
    if (!res.headersSent) res.sendFile(abs);
  };
  return (async () => {
    // 认人出错当认不出（和今天一样出页面，只是没有票据）
    const principal = current ? await deps.person(req).catch(() => null) : null;
    if (res.headersSent) return;
    const tok = deps.appToken(slug);
    let ticket = '';
    if (principal) { try { ticket = deps.issueTicket(principal, slug); } catch { ticket = ''; } }
    const inject = `<meta name="wm-app-token" content="${tok}">${ticket ? `<meta name="wm-submitter-ticket" content="${ticket}">` : ''}<script>window.WM_APP_TOKEN="${tok}";window.WM_APP_SLUG="${slug}";window.WM_WORKBENCH_ID=${deps.workbenchId(slug)};${ticket ? `window.WM_SUBMITTER_TICKET="${ticket}";` : ''}</script>`;
    const out = /<head[^>]*>/i.test(raw) ? raw.replace(/<head([^>]*)>/i, (mm) => mm + inject) : inject + raw;
    const html = deps.rewrite(req, out); // 登录门：本台绝对地址补查看凭证（off 时原样）
    // 带票据的页面是这个人的：不许任何缓存存它，按 Cookie 区分。认不出人时不注入、缓存策略照旧
    if (ticket) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); }
    res.type('html').send(html);
  })().catch(fallback);
}
