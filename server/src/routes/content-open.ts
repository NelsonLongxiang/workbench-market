/**
 * 市场面上内容面的两层：启动页 /content/open/<目标号>，和迁移跳转（开了迁移的目标，浏览器顶层导航到 /go/<号>/… 时送去启动页）。
 * 处理函数在 content-surface.ts（createContentSurface 造的 launch、migrate，原样）；这里只把它们经 HTTP 服务注册、报上动作。
 *
 * 原来两层是 index.ts 里随内容面配置才挂的全局中间件。现在不管配没配都注册，挂在原来的位置（内容面整面分发之后、CORS 之前），
 * 没配内容面时直接 next()，和原来「没挂这一层」一样。这样路由一直在快照里，配置决定的只是它放不放过。
 *   · 启动页：ALL 加正则 ^/content/open/。原来按 req.url 前缀判，里面照旧再核一遍；不是市场面的回 404（原样）。
 *   · 迁移跳转：GET 加正则 ^/go/<正整数>(/|$)，不分大小写（和 migrate 里判的同一个正则）。原来什么方法都进、
 *     不是 GET/HEAD 的在里面放过；GET 路由也接 HEAD，别的方法本来就走不进去，结果一样。不是市场面的放过（原样）。
 *
 * 动作：content.launch、content.migrate，都是读。启动页的 401 是「还没在可信入口登录」、404 是目标或入口不对；
 * 迁移的 404 是入口不对。都不是「谁能做什么」的结论。今天谁来都进得了这两层（认人在启动页里），匿名清单里有它们。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import type { createContentSurface } from '../content-surface.ts';
import { surfaceOf } from '../surfaces.ts';

type ContentRuntime = ReturnType<typeof createContentSurface>;

export function registerContentOpenRoutes(app: HttpService, contentRuntime: ContentRuntime | null): void {
  app.all(/^\/content\/open\//, {
    action: 'content.launch', kind: 'read',
    statusNotVerdict: '401 是还没在可信入口登录，404 是目标或入口不对，不是授权结论',
  }, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!contentRuntime) return next();
    if (!req.url.startsWith('/content/open/')) return next();
    if (surfaceOf(req) !== 'market') { res.status(404).end(); return; }
    contentRuntime.launch(req, res, next);
  });
  app.get(/^\/go\/([1-9][0-9]*)(?:\/|$)/i, {
    action: 'content.migrate', kind: 'read',
    statusNotVerdict: '只把浏览器送到可信入口；404 是入口不对，不是授权结论',
  }, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!contentRuntime) return next();
    if (surfaceOf(req) !== 'market') return next();
    contentRuntime.migrate(req, res, next);
  });
}
