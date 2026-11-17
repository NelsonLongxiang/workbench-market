/**
 * Cookie 池的路由（/api/cookies）。处理函数、两个只有它们用的辅助函数和两个接口声明原样搬自 index.ts，一个字没改；
 * 路由那一段只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 这一组路由没有自己的守卫：写请求由 index.ts 里的写请求总门把关，读开放。读出来的 value 一律是掩码。
 */
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { CookieService } from '../services/cookie.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import { HttpError, bad } from '../errors.ts';

interface CookieExport { name: string; value: string; domain?: string; path?: string; expirationDate?: number; httpOnly?: boolean; sameSite?: string }
interface CookieRow { id: number; label: string; cookies_json: string; created_at: string }

function cookieExpiryInfo(cookies: CookieExport[]): { total: number; active: number; soonestExpMs: number | null; allExpired: boolean } {
  const now = Date.now();
  let active = 0;
  let soonest: number | null = null;
  for (const c of cookies) {
    if (!c.expirationDate || c.expirationDate * 1000 > now) {
      active++;
      if (c.expirationDate) {
        const ms = c.expirationDate * 1000 - now;
        if (soonest === null || ms < soonest) soonest = ms;
      }
    }
  }
  return { total: cookies.length, active, soonestExpMs: soonest, allExpired: cookies.length > 0 && active === 0 };
}

function maskCookies(cookies: CookieExport[]): CookieExport[] {
  return cookies.map((c) => ({ ...c, value: '****' }));
}

export function registerCookieRoutes(app: HttpService): void {
  app.post('/api/cookies', { action: 'cookie.create', kind: 'admin' }, (req, res) => {
    const b = req.body ?? {};
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (!label) bad('label 必填（如「DSH-3080 生产」）');
    const arr = b.cookies;
    if (!Array.isArray(arr) || arr.length === 0) bad('cookies 必须是非空数组（Cookie-Editor/EditThisCookie 导出格式）');
    // 校验每条 name+value 必填（浏览器扩展标准导出全对象 verbatim 存储）
    const clean: CookieExport[] = [];
    for (const c of arr) {
      if (typeof c?.name !== 'string' || !c.name) bad('每条 cookie 的 name 必填');
      if (typeof c?.value !== 'string') bad(`cookie "${c.name}" 缺 value`);
      clean.push({ name: c.name, value: c.value, domain: String(c.domain ?? ''), path: String(c.path ?? '/'), expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined, httpOnly: !!c.httpOnly, sameSite: String(c.sameSite ?? '') });
    }
    const r = svc<CookieService>('cookie').create(label, JSON.stringify(clean)) as unknown as { lastInsertRowid: number | bigint };
    const info = cookieExpiryInfo(clean);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), label, cookie_count: clean.length, active: info.active, cookies: maskCookies(clean) });
  });

  app.get('/api/cookies', { action: 'cookie.list', kind: 'read' }, (_req, res) => {
    const rows = svc<CookieService>('cookie').all() as unknown as CookieRow[];
    res.json(rows.map((r) => {
      let cookies: CookieExport[] = [];
      try { cookies = JSON.parse(r.cookies_json || '[]'); } catch { cookies = []; }
      const info = cookieExpiryInfo(cookies);
      return {
        id: r.id, label: r.label, cookie_count: info.total, active: info.active,
        all_expired: info.allExpired, soonest_exp_days: info.soonestExpMs !== null ? Math.floor(info.soonestExpMs / 86400000) : null,
        created_at: r.created_at,
        cookies: maskCookies(cookies), // value 全掩码——明文不回任何 API
      };
    }));
  });

  app.delete('/api/cookies/:id', { action: 'cookie.delete', kind: 'admin' }, (req, res) => {
    const id = Number(req.params.id);
    const r = svc<CookieService>('cookie').delete(id);
    if (!r.changes) throw new HttpError(404, `cookie set not found: ${id}`);
    // 挂接了该池的台自动取消引用
    svc<WorkbenchService>('workbench').clearCookieSet(id);
    res.json({ ok: true, deleted: id });
  });
}
