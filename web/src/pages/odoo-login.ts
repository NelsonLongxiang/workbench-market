import { useCallback, useEffect, useRef, useState } from 'react';

// Same-window refresh hint only; consumers must re-fetch whoami, never trust event identity.
export const ODOO_SESSION_CONFIRMED = 'wm:odoo-session-confirmed';

/** #275 弹窗登录 Odoo（真实 Odoo 19 不能跨源回跳，回程由市场页查 /api/lifecycle/whoami 完成）。
 *  - 弹窗被浏览器拦截（window.open 返回 null）→ blocked=true，页面提示用户点按钮（点击属于用户手势，一般不会再被拦）；
 *  - 弹窗读成 closed 不一定是用户关的：Odoo 若带 COOP same-origin，弹窗一跳过去就和本页断开，closed 也读成 true。
 *    所以 closed 后再补查两次（3s/6s），之后靠本页重新获得焦点、切回可见时再查一次；
 *  - 轮询最长 10 分钟；登录成功关弹窗（断开时关不掉也无妨）并回调 onDone。 */
export function useOdooPopupLogin(href: string | null, onDone: () => void) {
  const [polling, setPolling] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const attemptUntil = useRef(0);
  const checking = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const check = useCallback(async (): Promise<boolean> => {
    if (!attemptUntil.current || Date.now() > attemptUntil.current || checking.current) return false;
    checking.current = true;
    try {
      const r = await fetch('/api/lifecycle/whoami', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.ok !== true || typeof j.viewer?.sub !== 'string' || !j.viewer.sub || typeof j.viewer?.login !== 'string' || !j.viewer.login) return false;
      if (Date.now() > attemptUntil.current) return false;
      attemptUntil.current = 0;
      try { popupRef.current?.close(); } catch { /* 断开的弹窗关不掉 */ }
      popupRef.current = null;
      setPolling(false);
      window.dispatchEvent(new Event(ODOO_SESSION_CONFIRMED));
      doneRef.current();
      return true;
    } catch { return false; }
    finally { checking.current = false; }
  }, []);

  const open = useCallback((): boolean => {
    if (!href) return false;
    const w = window.open(href, 'wm_lc_sso', 'width=520,height=680');
    popupRef.current = w;
    attemptUntil.current = w ? Date.now() + 600_000 : 0;
    setBlocked(!w);
    setPolling(!!w);
    return !!w;
  }, [href]);

  useEffect(() => {
    if (!polling) return;
    const t0 = Date.now();
    let closedAt = 0;
    const timer = window.setInterval(async () => {
      const p = popupRef.current;
      if (Date.now() - t0 > 600_000) { try { p?.close(); } catch { /* 忽略 */ } setPolling(false); return; }
      if (!p || p.closed) {
        closedAt ||= Date.now();
        if (Date.now() - closedAt > 6_000) { setPolling(false); return; }
      }
      await check();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [polling, check]);

  // 弹窗断开或被关掉后，用户切回本页时再确认一次
  useEffect(() => {
    if (!href) return;
    const onBack = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => { window.removeEventListener('focus', onBack); document.removeEventListener('visibilitychange', onBack); };
  }, [href, check]);

  return { open, polling, blocked };
}
