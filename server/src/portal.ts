/** 统一门户 /go/:id/* 反向代理（S3 抽离，注册顺序与逻辑逐行不变）。
 *
 * 关键约束（原注释原样保留）：
 * - 必须全局挂载（不能 app.use('/go', ...)——Express 会剥 req.url 前缀，pathFilter 失配）
 * - HPM 4.x 的 pathFilter 不支持 RegExp（静默漏到 SPA fallback），用函数形式
 * - upgrade 事件不流经 Express 中间件链，必须重做同一套准备（见 handlePortalUpgrade）
 */
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { svc } from './context.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { CookieService } from './services/cookie.ts';


export const goPrefix = /^\/go\/(\d+)(.*)$/;

/** /go/ 代理实例（installPortal 装配；upgrade 段与其它模块共用） */
export let moduleProxy: any = null;

export function installPortal(
  app: express.Express,
  wbById: (id: number) => any | null,
  deps: {
    serveApp: (req: express.Request, res: express.Response) => any;
    readActiveManifest: (slug: string) => { manifest: any; app: any } | null;
    renderSopRunner: (manifest: any, app: any) => string;
    appsRoot: string;
  },
): void {
  const { serveApp, readActiveManifest, renderSopRunner, appsRoot } = deps;
  const goPrefix = /^\/go\/(\d+)(.*)$/;

  // id 校验 + 404（在代理前拦截，避免 router 内抛错变 500）
  // 注意：必须全局挂载（不能用 app.use('/go', ...) 前缀挂载——Express 会剥掉
  // req.url 的挂载前缀，goPrefix 与 http-proxy-middleware 的 pathFilter 都会失配）
  app.use((req, res, next) => {
    if (!goPrefix.test(req.url ?? '')) return next();
    const m = goPrefix.exec(req.url ?? '')!;
    let origin = '', basePath = '', goQuery = '', goAuth = '';
    try {
      const w = wbById(Number(m[1]));
      if (!w) return res.status(404).json({ error: `工作台不存在: ${m[1]}` });
      if (w.url.startsWith('/sop/')) {
        // SOP 台：重写为 /sop/<slug>/… 后直接交给 SOP Runner 路由（同自产台坑：next() 不回流已注册路由）
        req.url = w.url.replace(/\/+$/, '') + (m[2] || '/');
        const mm = /^\/sop\/([a-z0-9][a-z0-9-]*)\/?(.*)$/.exec(req.path ?? req.url ?? '');
        const rest = mm ? mm[2] || '' : '';
        const hit = readActiveManifest(mm ? mm[1] : '');
        if (!hit) return res.status(404).json({ error: `SOP not found` });
        res.setHeader('X-App-Version', `v${hit.app.active_version}`);
        if (rest === '' || rest === '/' || rest === 'index.html') {
          // issue #11：门户内联分流同款——draft 403 瘦身，不渲染 Runner
          if (hit.app.status !== 'published') {
            return res.status(403).type('text').send(`SOP ${hit.app.slug} 状态为 ${hit.app.status}，未上架不可执行\n`);
          }
          return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app));
        }
        const root = join(appsRoot, mm![1], `v${hit.app.active_version}`);
        let rel = posix.normalize(rest);
        if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
        const abs = join(root, rel);
        if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });
        if (!existsSync(abs)) return res.status(404).json({ error: `file not found: ${rel}` });
        return res.sendFile(abs);
      }
      if (w.url.startsWith('/')) {
        // 自产台：本服务静态路径，重写后直接交给静态托管（/go/N/xyz → /apps/<slug>/xyz）。
        // 不能只 next()：serveApp 路由注册在本中间件之前，重写后的 URL 不会再流经它，
        // 会漏到 web/dist SPA fallback（实测踩坑）。
        req.url = w.url.replace(/\/+$/, '') + (m[2] || '/');
        return serveApp(req, res);
      }
      const u = new URL(w.url);
      origin = u.origin;
      basePath = u.pathname.replace(/\/+$/, ''); // base 自带路径（如 /preview）时保留
      // base 自带 query（如 dsh web 启动 token ?token=…）：请求自身无 query 时补上，
      // 否则 token 换 cookie 的一次性认证过不了门户代理（实测 /go/84/ 401 踩坑）
      goQuery = u.search;
      // 凭据注入：在此解析（此处还知道工作台 id）；proxyReq 钩子里 req.url 已被
      // pathRewrite 改写成上游路径，无法再从 URL 反查 id（实测注入不达的根因）
      if (w.auth?.type === 'bearer') goAuth = `Bearer ${w.auth.value}`;
      else if (w.auth?.type === 'basic') goAuth = `Basic ${Buffer.from(w.auth.value, 'utf8').toString('base64')}`;
      // SSO v1（监督席 direct-d2330efc 技术审 PASS·两注全收）：Odoo 类台免登——
      // ①浏览器无 session_id → 302 Odoo 登录（redirect 回跳+state 防 open-redirect·评审注②）
      // ②有 session_id → 白名单单键透传（只透 session_id·不透全 Cookie 头·评审注①）
      const isOdooLike = /odoo/i.test(String(w.type ?? '')) || /:8069/.test(w.url);
      if (isOdooLike) {
        const browserCookies = String(req.headers.cookie ?? '');
        const sidMatch = /(?:^|;\s*)session_id=([^;\s]+)/.exec(browserCookies);
        if (!sidMatch) {
          const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          const redirectUri = encodeURIComponent(`/go/${m[1]}/`);
          return res.redirect(302, `${u.origin}/web/login?redirect=${redirectUri}&state=${state}`);
        }
        (req as express.Request & { goSsoSid?: string }).goSsoSid = sidMatch[1];
      }
      // Cookie 池注入（派单 direct-5fbb2176）：台挂了 cookie_set 时按目标 host 匹配
      // cookie.domain + 未过期过滤 → 拼 Cookie 头（proxyReq 里替换而非追加）
      const rawWb = svc<WorkbenchService>('workbench').cookieSetId(Number(m[1])) as { cookie_set_id?: number } | undefined;
      const csid = rawWb?.cookie_set_id ?? 0;
      if (csid > 0) {
        const cs = svc<CookieService>('cookie').cookiesJsonById(csid) as { cookies_json: string } | undefined;
        if (cs) {
          try {
            const cookies: CookieExport[] = JSON.parse(cs.cookies_json || '[]');
            const targetHost = u.hostname;
            const now = Date.now();
            const matched = cookies.filter((c) => {
              if (c.expirationDate && c.expirationDate * 1000 <= now) return false; // 过期过滤
              if (!c.domain) return true; // 无 domain 视为全域
              // 域匹配：上游 host 等于 domain（去前导点）或以其结尾
              const d = c.domain.replace(/^\./, '').toLowerCase();
              const h = targetHost.toLowerCase();
              return h === d || h.endsWith('.' + d);
            });
            if (matched.length > 0) {
              (req as express.Request & { goCookies?: string }).goCookies = matched.map((c) => `${c.name}=${c.value}`).join('; ');
            }
          } catch { /* cookies_json 坏值跳过注入 */ }
        }
      }
    } catch {
      return res.status(502).json({ error: `工作台地址非法: ${m[1]}` });
    }
    (req as express.Request & { goOrigin?: string }).goOrigin = origin;
    (req as express.Request & { goBase?: string }).goBase = basePath;
    (req as express.Request & { goQuery?: string }).goQuery = goQuery;
    (req as express.Request & { goAuth?: string }).goAuth = goAuth;
    // issue #4：3xx Location 改写在 proxyRes 里也要 id——但那时 req.url 已被 pathRewrite
    // 写回上游路径（goPrefix 失配，改写从不生效）；在此备份原始 id 供 proxyRes 使用。
    (req as express.Request & { goWid?: string }).goWid = m[1];
    next();
  });

  moduleProxy = createProxyMiddleware({
    // HPM 4.x 默认 logger 是 noopLogger（options.logger || noop）——pathFilter/配置错误零输出，
    // 静默漏到 SPA fallback 返回 200 假绿（实测踩坑：RegExp pathFilter 坏了整整一天没人发现）。
    // 显式传 console，让配置类错误至少可见。
    logger: console,
    // HPM 4.x 的 pathFilter 不支持 RegExp（matchPathFilter 抛 Invalid pathFilter，被 shouldProxy
    // 吞成 next() → 静默漏到 SPA fallback）；函数形式走 custom-matching 分支（实测透传 3080 的 401）
    pathFilter: (pathname: string) => goPrefix.test(pathname),
    target: 'http://127.0.0.1', // 占位：router 按请求覆盖
    changeOrigin: true,
    xfwd: true,
    ws: true,
    cookieDomainRewrite: '', // 上游 Cookie 去掉 Domain 属性，落到 9800 同域
    cookiePathRewrite: '/',
    router: (req) => (req as express.Request & { goOrigin?: string }).goOrigin ?? 'http://127.0.0.1',
    pathRewrite: (path, req) => {
      const m = goPrefix.exec(path);
      if (!m) return path;
      const base = (req as express.Request & { goBase?: string; goQuery?: string }).goBase ?? '';
      const rest = m[2] || '/';
      if (!rest.startsWith('/')) return path;
      // /go/N/xyz → base + /xyz（base 是工作台地址自带的路径前缀，可空）
      // 请求自身无 query 时补 base 自带 query（启动 token 等）；请求显式带 query 则原样透传。
      // 已带 dsh-auth-* cookie（token 换票完成）后不再补，否则根路径每次被强制重签 → 303 死循环（实测踩坑）
      const goQuery = (req as express.Request & { goBase?: string; goQuery?: string }).goQuery ?? '';
      const hasAuth = /(?:^|;\s*)dsh-auth-/.test(String(req.headers.cookie ?? ''));
      return base + rest + (goQuery && !rest.includes('?') && !hasAuth ? goQuery : '');
    },
    on: {
      // 凭据注入：前置中间件已解析好 req.goAuth（此处 req.url 已被 pathRewrite 改写，
      // 不能再从 URL 反查工作台——实测注入不达的根因）
      // Origin 改写：上游若做 Origin 校验（如 DSH web 的 authority 防护），浏览器经门户
      // 发出的 Origin=http://…:9800 与上游 authority 不符会被 403 拒（WS 握手同理，
      // 实测握手 403→改写后通过）。代理作为可信客户端把 Origin 重写为上游自身 origin。
      proxyReq: (proxyReq, req) => {
        const rq = req as typeof req & { goAuth?: string; goOrigin?: string; goCookies?: string; goHost?: string; goSsoSid?: string };
        // SSO v1 白名单单键：Odoo 台只透 session_id（覆写 Cookie 头·评审注①——其他站 cookie 不泄入）
        if (rq.goSsoSid) proxyReq.setHeader('cookie', `session_id=${rq.goSsoSid}`);
        if (rq.goAuth) proxyReq.setHeader('authorization', rq.goAuth);
        if (rq.goOrigin) proxyReq.setHeader('origin', rq.goOrigin);
        // Cookie 池注入（派单 direct-5fbb2176）：前置中间件解析好的 goCookies（按目标 host
        // 匹配 + 未过期过滤后的 Cookie 头值），**替换**而非追加（确定性语义）
        if (rq.goCookies) proxyReq.setHeader('cookie', rq.goCookies);
      },
      proxyRes: (proxyRes, req, res) => {
        // 剥禁嵌头：代理后与市场同源，这两个头只会误伤 iframe 嵌入（使用页/驾驶舱）
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        // Pocket meta-refresh 改写（.157 DSH 台实测根因）：DSH Pocket（如 13080 端口）在
        // token→cookie 交换后返回 <meta refresh url=/>，在门户上下文 / 会跳回市场 SPA 根。
        // 仅对 HTML 响应包装 res.write/end 做字符串替换（JSON/二进制零开销透传）。
        const pWid = (req as express.Request & { goWid?: string }).goWid;
        const pCt = String(proxyRes.headers['content-type'] ?? '');
        const pIsJs = /text\/javascript|application\/javascript/.test(pCt);
        const pIsCss = pCt.includes('text/css');
        if (pWid && (pCt.includes('text/html') || pIsJs || pIsCss)) {
          const origEnd = res.end.bind(res);
          const chunks: Uint8Array[] = [];
          (res as any)._wmIntercepting = true;
          // 拦截 write 收集 HTML 块，end 时统一改写后写出
          const origWrite = res.write.bind(res);
          (res as any).write = (chunk: any, ...rest: any[]) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            return true;
          };
          (res as any).end = (chunk: any, ...rest: any[]) => {
            if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            let body = Buffer.concat(chunks).toString('utf8');
            // 改写 meta refresh url=/ → /go/<wid>/
            body = body.replace(/content="0;\s*url=\/"/gi, `content="0; url=/go/${pWid}/"`);
            // 白屏修（监督席 direct-9cd36827）：SPA 绝对路径资产引用改写——src="/…"·href="/…" → /go/<wid>/…
            // 排除：//协议相对·data:/http(s): 等 scheme·已带 /go/ 前缀·单引号同款兼容
            const goBase = `/go/${pWid}`;
            const fixAttr = (m: string, name: string, q: string, url: string) => {
              if (!url.startsWith('/') || url.startsWith('//') || url.startsWith(goBase + '/')) return m;
              if (/^\/go\/\d+\//.test(url)) return m; // 已是任意 /go/N/ 形
              return `${name}=${q}${goBase}${url}${q}`;
            };
            if (pCt.includes('text/html')) body = body.replace(/(src|href)=(["'])(\/[^"']*)\2/gi, (m, n, q, u) => fixAttr(m, n, q, u));
            // 白屏第二层（监督席 direct-aa94cbd4）：Vite 动态 chunk——JS/CSS 内绝对 /assets/ 前缀改写（仅此单前缀·避免误伤）
            if (pIsJs || pIsCss) body = body.split('/assets/').join(`${goBase}/assets/`).split(`${goBase}${goBase}/assets/`).join(`${goBase}/assets/`);
            res.write = origWrite;
            res.end = origEnd;
            const buf = Buffer.from(body, 'utf8');
            delete (proxyRes.headers as any)['transfer-encoding']; // 防冲突
            try { res.removeHeader('transfer-encoding'); } catch { /* 未设 */ } // writeHead 已排队的 TE 也要摘（CL+TE 并存=协议错）
            res.setHeader('content-length', String(buf.length));
            return origEnd(buf);
          };
        }
        // 3xx Location 改写回 /go/N/ 前缀，防跳回原域丢前缀（issue #4：req.url 已被
        // pathRewrite 写回上游路径，goPrefix 失配——改用前置中间件备份的 req.goWid）
        const loc = proxyRes.headers.location;
        const wid = (req as express.Request & { goWid?: string }).goWid;
        if (typeof loc === 'string' && wid) {
          {
            const base = (req as express.Request & { goBase?: string }).goBase ?? '';
            if (loc.startsWith('/')) {
              proxyRes.headers.location = `/go/${wid}${loc.startsWith(base + '/') ? loc.slice(base.length) : loc}`;
            } else if (/^https?:\/\//i.test(loc)) {
              try {
                const lu = new URL(loc);
                if (lu.origin === (req as express.Request & { goOrigin?: string }).goOrigin) {
                  let p = lu.pathname;
                  if (base && p.startsWith(base)) p = p.slice(base.length);
                  proxyRes.headers.location = `/go/${wid}${p}${lu.search}${lu.hash}`;
                }
              } catch { /* 异常 URL 透传 */ }
            }
          }
        }
        void res;
      },
    },
  });
  app.use(moduleProxy);
}
