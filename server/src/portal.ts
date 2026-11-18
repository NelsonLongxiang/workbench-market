/** 统一门户 /go/:id/* 反向代理（S3 抽离，注册顺序与逻辑逐行不变）。
 *
 * 阶段三：这里只造两个处理函数（前置准备、代理），路由由 routes/portal.ts 经 HTTP 服务注册（ALL 加正则、报动作 portal.use）。
 * 处理函数的内容一个字没改；原来是两层全局中间件，现在是同一条路由上的两个处理函数，前后紧挨着，次序不变。
 *
 * 关键约束（原注释原样保留）：
 * - 必须全局挂载（不能 app.use('/go', ...)——Express 会剥 req.url 前缀，pathFilter 失配）。经 HTTP 服务注册的正则路由不剥前缀
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
import { isInsideRoot } from './path-inside.ts';
import { stripOutgoing } from './portal-forward-headers.ts';


export const goPrefix = /^\/go\/(\d+)(.*)$/;

/** Odoo 的会话 cookie 名。门户、WebSocket 门户把它从转发的 Cookie 头里剥掉，不给任何上游 */
export const ODOO_SESSION_COOKIE = 'session_id';
/** 从请求头里剥掉 session_id（大小写照 cookie 名原样比；剥完没有别的 cookie 就整个去掉 Cookie 头） */
export function stripSessionIdCookie(headers: { cookie?: string | string[] }): void {
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie;
  if (!raw) return;
  const kept = raw.split(';').map((c) => c.trim()).filter((c) => c && c.split('=')[0].trim() !== ODOO_SESSION_COOKIE).join('; ');
  if (kept) headers.cookie = kept; else delete headers.cookie;
}

/** 启动自检用：合成几种带 session_id 的 Cookie 头，剥完都不能再有它，别的 cookie 原样留着 */
export function verifyPortalSessionStrip(): { ok: boolean; reason: string | null } {
  const cases: [string | string[], string | undefined][] = [
    ['session_id=s1', undefined],
    ['a=1; session_id=s1; b=2', 'a=1; b=2'],
    [' session_id = s1 ;a=1', 'a=1'],
    [['a=1', 'session_id=s1'], 'a=1'],
    ['session_idx=1; session_id=s1', 'session_idx=1'],
  ];
  const ok = cases.every(([cookie, want]) => { const h: { cookie?: string | string[] } = { cookie }; stripSessionIdCookie(h); return h.cookie === want; });
  return { ok, reason: ok ? null : 'session-id-forwarded' };
}

/** 门户的处理函数：同 Express（返回值不用） */
export type PortalHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;

/** /go/ 代理实例（createPortal 装配；upgrade 段与其它模块共用） */
export let moduleProxy: any = null;

export function createPortal(
  wbById: (id: number) => any | null,
  deps: {
    serveApp: (req: express.Request, res: express.Response) => any;
    readActiveManifest: (slug: string) => { manifest: any; app: any } | null;
    renderSopRunner: (manifest: any, app: any) => string;
    appsRoot: string;
    authorize?: express.RequestHandler;
  },
): { prepare: PortalHandler; proxy: PortalHandler } {
  const { serveApp, readActiveManifest, renderSopRunner, appsRoot } = deps;
  const goPrefix = /^\/go\/(\d+)(.*)$/;

  // id 校验 + 404（在代理前拦截，避免 router 内抛错变 500）
  // 注意：必须全局挂载（不能用 app.use('/go', ...) 前缀挂载——Express 会剥掉
  // req.url 的挂载前缀，goPrefix 与 http-proxy-middleware 的 pathFilter 都会失配）
  const prepare: PortalHandler = (req, res, next) => {
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
        if (!isInsideRoot(root, abs)) return res.status(400).json({ error: '路径非法' });
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
      // 浏览器带来的 Odoo 会话 cookie（session_id）一律不转给任何上游（Odoo 下线，2026-11-17；以前只转给可信 Odoo 源）
      stripSessionIdCookie(req.headers);
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
  };

  // 每个 URL 从第一个 ? 或 %（任何百分号编码，含 %3F、%253F 这类多重编码的查询串）起到空白或 ] 为止一律换成 …；
  // 对象参数（如错误对象）只取 message 再抹，不把整个对象（可能带 url/headers）打出来
  const redactQuery = (x: unknown): unknown => {
    if (typeof x === 'string') return x.replace(/[?%][^\s\]]*/g, '…');
    if (x instanceof Error) return `${x.name}: ${String(redactQuery(x.message))}`;
    if (x && typeof x === 'object') return '[object]';
    return x;
  };
  const hpmLogger = {
    info: (...a: unknown[]) => console.log(...a.map(redactQuery)),
    warn: (...a: unknown[]) => console.warn(...a.map(redactQuery)),
    error: (...a: unknown[]) => console.error(...a.map(redactQuery)),
  };
  moduleProxy = createProxyMiddleware({
    // HPM 4.x 默认 logger 是 noopLogger（options.logger || noop）——pathFilter/配置错误零输出，
    // 静默漏到 SPA fallback 返回 200 假绿（实测踩坑：RegExp pathFilter 坏了整整一天没人发现）。
    // 显式传 console，让配置类错误至少可见。HPM 的访问日志会打完整 URL（含查询串，里面可能有 SSO state、台凭据参数），先抹掉查询串再打
    logger: hpmLogger,
    // HPM 4.x 的 pathFilter 不支持 RegExp（matchPathFilter 抛 Invalid pathFilter，被 shouldProxy
    // 吞成 next() → 静默漏到 SPA fallback）；函数形式走 custom-matching 分支（实测透传 3080 的 401）
    pathFilter: (pathname: string) => goPrefix.test(pathname),
    target: 'http://127.0.0.1', // 占位：router 按请求覆盖
    changeOrigin: true,
    xfwd: true,
    // 不让 HPM 自挂 upgrade 监听（ws: true 时首个经过的 HTTP 请求就会 server.on('upgrade')，绕过 index.ts 的升级处理器：
    // 启动自检门、Odoo 会话剥除与登录门都不再生效）。WS 只走 index.ts 显式调 moduleProxy.upgrade 这一个入口
    ws: false,
    cookieDomainRewrite: '', // 上游 Cookie 去掉 Domain 属性，落到 9800 同域
    // cookiePathRewrite 交给 proxyRes 钩子（需按 /go/<id>/ 精确改写）；HPM 内建 '/' 会在钩子后覆盖回去（实测）
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
        // #P0（总工 direct-0bf10126）：上游请求强制 identity——不取压缩体（改写只对明文做·字节面天然完好）
        proxyReq.setHeader('accept-encoding', 'identity');
        const rq = req as typeof req & { goAuth?: string; goOrigin?: string; goCookies?: string; goHost?: string };
        if (rq.goAuth) proxyReq.setHeader('authorization', rq.goAuth);
        if (rq.goOrigin) proxyReq.setHeader('origin', rq.goOrigin);
        if (rq.goOrigin) proxyReq.setHeader('referer', rq.goOrigin + '/'); // #170 P7 不泄：Referer 只到目标源，不携带 /go/<id>/ 市场路径
        // Cookie 池注入（派单 direct-5fbb2176）：前置中间件解析好的 goCookies（按目标 host
        // 匹配 + 未过期过滤后的 Cookie 头值），**替换**而非追加（确定性语义）
        if (rq.goCookies) proxyReq.setHeader('cookie', rq.goCookies);
        // 市场自己的口令、令牌、凭据头和会话 cookie 不往台带（清单在 portal-forward-headers.ts，WS 握手在 index.ts 用同一份）
        stripOutgoing(proxyReq, !!rq.goAuth);
      },
      proxyRes: (proxyRes, req, res) => {
        // 只记台 id、路径长度与 cookie 名：Set-Cookie 的值里有上游会话（如 Odoo session_id）；路径本身也不记——
        // 查询串可能以 ? / %3F / %253F 等各种编码藏在路径里（运维席 direct-d9c28a29），按字符截断挡不全
        const scNames = ([] as string[]).concat(proxyRes.headers['set-cookie'] ?? []).map((c) => String(c).split('=')[0].trim()).filter(Boolean);
        console.log('[proxres-entry]', `/go/${(req as any).goWid ?? '?'}/`, `(path ${String(req.url ?? '').length}B)`, '| sc:', scNames.join(',') || '-');
        // 登录态保持（属主报障 /use/1861 Sub2API）：目标台 Set-Cookie 改写——去 Domain（存市场域）+ Path 加 /go/<id>/（各台隔离）
        // 登录态保持（#157）+ #170 P1②：Set-Cookie 属性透传——去 Domain/Path 加 /go/<id>/；非 HTTPS 入口剥 Secure（否则浏览器拒存）；__Host-/__Secure- 前缀保留 Path=/ 语义（前缀强制 Secure+Path=/）
        if (proxyRes.headers['set-cookie']) {
          const _wid = (req as express.Request & { goWid?: string }).goWid ?? '';
          const _base = (req as express.Request & { goBase?: string }).goBase ?? '';
          const _https = req.secure || String(req.headers['x-forwarded-proto'] ?? '').includes('https');
          const _strip = (p0: string) => (_base && (p0 === _base || p0.startsWith(_base + '/'))) ? (p0 === _base ? '/' : p0.slice(_base.length)) : p0;
          proxyRes.headers['set-cookie'] = (proxyRes.headers['set-cookie'] as string[]).map((c) => {
            let out = c.replace(/;\s*domain=[^;]*/i, '');
            const name = out.split('=')[0]?.trim() ?? '';
            const isPrefix = /^__(Host|Secure)-/i.test(name);
            if (isPrefix) {
              // __Host-/__Secure- 语义：Secure+Path=/+无 Domain——Path 不做前缀改写（前缀规则会反噬）；HTTP 入口下浏览器本就拒收 → 保留 Secure 如实透出
              out = out.replace(/;\s*path=[^;]*/i, '; Path=/');
              if (!/path=/i.test(out)) out += '; Path=/';
              if (!/;\s*secure\b/i.test(out)) out += '; Secure';
            } else {
              const pm = /;\s*path=([^;]*)/i.exec(out);
              if (pm) { const np = '/go/' + _wid + (_strip(pm[1]) === '/' ? '/' : _strip(pm[1])); out = out.replace(/;\s*path=[^;]*/i, '; Path=' + np); }
              else out += '; Path=/go/' + _wid + '/';
              // 非 HTTPS 下剥 Secure（否则浏览器静默丢弃该 cookie=登录态丢的隐性根因）
              if (!_https) out = out.replace(/;\s*secure\b/ig, '');
              // #170 P1⑤：缺省补 SameSite=Lax（跨站携带收窄·不改目标显式声明）
              if (!/;\s*samesite=/i.test(out)) out += '; SameSite=Lax';
            }
            return out;
          });
        }
        // 剥禁嵌头：代理后与市场同源，这两个头只会误伤 iframe 嵌入（使用页/驾驶舱）
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        // #292 M5：上游可发 Service-Worker-Allowed: / 把 SW 作用域扩到全站（市场源上 HTTPS/localhost 时可常驻接管所有页面、截获管理员口令）
        delete proxyRes.headers['service-worker-allowed'];
        // 台地址带路径（base）时 /go/N/<p> 只对应上游 base+<p>。上游跳到 base 之外照旧硬拼成 /go/N/<loc>（issue #4 的契约，
        // E2E redir-relative：base /xfo、跳 /landed → /go/N/landed）。但若跳转目标里还含着刚请求的上游路径
        // （如 Odoo 台登记成 …/web，语言跳转 /web/ → /zh_CN/web/），硬拼后再请求就是 base+/zh_CN/web/，每跳叠一层、永不收敛。
        // 只有这种自增长跳转才 502 说明原因，不让浏览器进循环；修法是把台地址改成上游的源（不带路径）。
        const outsideBase = (() => {
          const loc = proxyRes.headers.location, base = (req as express.Request & { goBase?: string }).goBase ?? '';
          if (typeof loc !== 'string' || !base) return false;
          let p: string | null = null;
          if (loc.startsWith('/') && !loc.startsWith('//')) p = loc;
          else if (/^https?:\/\//i.test(loc)) {
            try { const lu = new URL(loc); if (lu.origin === (req as express.Request & { goOrigin?: string }).goOrigin) p = lu.pathname; } catch { /* 异常 URL 透传 */ }
          }
          if (p === null) return false;
          const path = p.split(/[?#]/)[0];
          if (path === base || path.startsWith(base + '/')) return false;
          // req.url 此时已是上游路径（pathRewrite 之后）；去掉尾斜杠再比，/web/ 与 /zh_CN/web/ 也算包含
          const upPath = String(req.url ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
          // 按路径段比：两边补尾斜杠再比，/website/info 不算含 /web（子串比会误拦，见 #458 评审 R1）
          return upPath.length > 1 && (path.replace(/\/+$/, '') + '/').includes(upPath + '/');
        })();
        if (outsideBase) {
          const wid0 = (req as express.Request & { goWid?: string }).goWid ?? '?';
          const base0 = (req as express.Request & { goBase?: string }).goBase ?? '';
          console.warn('[go-outside-base]', `/go/${wid0}/`, `base ${base0}`, '上游跳转落在台地址路径之外，已拦下');
          const body = Buffer.from(JSON.stringify({
            error: 'go_redirect_outside_base',
            detail: `工作台 ${wid0} 的登记地址带路径 ${base0}，上游跳到了这个路径之外，门户无法映射（硬拼会逐跳叠加前缀）。请把该台地址改成上游的源（不带路径）。`,
          }));
          proxyRes.statusCode = 502;
          proxyRes.statusMessage = 'Bad Gateway'; // 否则抄上游原因短语，状态行成了「502 See Other」
          delete proxyRes.headers.location;
          delete proxyRes.headers['content-length'];
          delete (proxyRes.headers as any)['transfer-encoding'];
          delete proxyRes.headers['content-encoding'];
          proxyRes.headers['content-type'] = 'application/json; charset=utf-8';
          proxyRes.headers['cache-control'] = 'no-store';
          const origEnd = res.end.bind(res);
          (res as any).write = () => true; // 丢弃上游 3xx 正文
          (res as any).end = () => { try { res.removeHeader('transfer-encoding'); } catch { /* 未设 */ } res.setHeader('content-length', String(body.length)); return origEnd(body); };
          return;
        }
        // Pocket meta-refresh 改写（业务实盘 DSH 台实测根因）：DSH Pocket（如 13080 端口）在
        // token→cookie 交换后返回 <meta refresh url=/>，在门户上下文 / 会跳回市场 SPA 根。
        // 仅对 HTML 响应包装 res.write/end 做字符串替换（JSON/二进制零开销透传）。
        const pWid = (req as express.Request & { goWid?: string }).goWid;
        const pCt = String(proxyRes.headers['content-type'] ?? '');
        const pIsJs = /text\/javascript|application\/javascript/.test(pCt);
        const pIsCss = pCt.includes('text/css');
        const pEnc = String(proxyRes.headers['content-encoding'] ?? '').toLowerCase();
        // #P0（总工 direct-0bf10126）：压缩/二进面零字符串改写——gzip/br/deflate 编码体一律字节透传（文本改写只走 identity）
        const rewritable = pWid && !pEnc && (pCt.includes('text/html') || pIsJs || pIsCss);
        if (rewritable) {
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
            // 台地址自带路径时，上游页面里 base 下的绝对路径先去掉 base（/go/N/<p> 会再拼回 base+<p>，不去掉就成 base+base+<p>）
            const upBase = (req as express.Request & { goBase?: string }).goBase ?? '';
            const stripBase = (u: string) => (upBase && (u === upBase || u.startsWith(upBase + '/') || u.startsWith(upBase + '?') || u.startsWith(upBase + '#')) ? (u.slice(upBase.length).startsWith('/') ? u.slice(upBase.length) : '/' + u.slice(upBase.length)) : u);
            const fixAttr = (m: string, name: string, q: string, url: string) => {
              if (!url.startsWith('/') || url.startsWith('//') || url.startsWith(goBase + '/')) return m;
              if (/^\/go\/\d+\//.test(url)) return m; // 已是任意 /go/N/ 形
              return `${name}=${q}${goBase}${stripBase(url)}${q}`;
            };
            if (pCt.includes('text/html')) {
              body = body.replace(/(src|href)=(["'])(\/[^"']*)\2/gi, (m, n, q, u) => fixAttr(m, n, q, u));
              // #170 P6 绝对链接：指向目标源自身的完整地址 → /go/<id>/ 前缀（跨源外链不动）
              const _tgtOrigin = String((req as express.Request & { goOrigin?: string }).goOrigin ?? '');
              if (_tgtOrigin) body = body.replace(/(src|href)=(["'])(https?:\/\/[^"']+)\2/gi, (m, n, q, u) => {
                if (!u.startsWith(_tgtOrigin)) return m;
                const rest = u.slice(_tgtOrigin.length) || '/';
                return n + '=' + q + goBase + stripBase(rest) + q;
              });
            }
            // 白屏第二层（监督席 direct-aa94cbd4）：Vite 动态 chunk——JS/CSS 内绝对 /assets/ 前缀改写（仅此单前缀·避免误伤）
            // 外链护栏（监督席 direct-ef4d0f97·丢失补回）：跨源绝对 URL 内 /assets/ 不动——交替匹配保护（airwallex 支付脚本实证）
            if (pIsJs || pIsCss) body = body.replace(/(https?:\/\/[^\s"'`()]+)|(\/assets\/)|(\/api\/)/g, (m, url, ast, api) => (url ? url : goBase + (ast || api))); // 第四层：JS/CSS 字面 /api/ 同加前缀（Sub2API fetch('/api/v1') 打错后端根因）
            // #170 P1③：泛化根路径改写——字面量 "/xxx" 形态（排除 //、/go/、已带前缀；data:/javascript: 非根路径不命中）→ /go/<id>/xxx
            if (pIsJs) body = body.replace(/(["'`])(\/(?!\/|go\/)[A-Za-z0-9_.~%-][^"'`\s]{0,120})\1/g, (m, q, path) => (path.includes(' =>') ? m : `${q}${goBase}${path}${q}`));
            // 白屏第三层（监督席 direct-a85fd99c·丢失补回）：Vite assetsURL 根绝对化 helper——return "/"+e → return "/go/<id>/"+e（base='/' 应用经子路径反代的通用坑·仅 JS 段·窄正则）
            if (pIsJs) body = body.replace(/return\s*"\/"\s*\+\s*([A-Za-z_$][\w$]*)/g, (m, v) => 'return "' + goBase + '/"+' + v);
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
              // base 本身（/web、/web?x）映射到台根 /go/N/，base 下的路径去掉 base；base 之外的自增长跳转已在上面拦成 502，其余照 issue #4 映射
              const inBase = base && (loc === base || loc.startsWith(base + '?') || loc.startsWith(base + '#'));
              proxyRes.headers.location = `/go/${wid}${inBase ? '/' + loc.slice(base.length) : loc.startsWith(base + '/') ? loc.slice(base.length) : loc}`;
            } else if (/^https?:\/\//i.test(loc)) {
              try {
                const lu = new URL(loc);
                if (lu.origin === (req as express.Request & { goOrigin?: string }).goOrigin) {
                  let p = lu.pathname;
                  if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length) || '/';
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
  const authorizedPrepare: PortalHandler = (req, res, next) => deps.authorize ? deps.authorize(req, res, error => error ? next(error) : prepare(req, res, next)) : prepare(req, res, next);
  return { prepare: authorizedPrepare, proxy: moduleProxy };
}
