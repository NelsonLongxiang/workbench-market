/** #292 M1：当前页面是哪个面。服务端在 index.html 注入 <meta name="wm-surface">；没有（vite dev）按 legacy 旧行为。
 *  market = 业务面（不输口令、不做管理写）；control = 控制面（只做管理，不嵌、不跑任何不可信内容）。 */
export type Surface = 'market' | 'control' | 'legacy';
const meta = (n: string) => (typeof document === 'undefined' ? '' : document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? '');
const raw = meta('wm-surface');
export const surface: Surface = raw === 'control' ? 'control' : raw === 'market' ? 'market' : 'legacy';
export const controlUrl: string | null = meta('wm-control-url') || null;
export const marketUrl: string | null = meta('wm-market-url') || null;
/** 同 path 换到另一面（只拼链接；目标地址来自服务端注入，不取自用户数据） */
export const onSurface = (base: string | null, path = window.location.pathname + window.location.search): string | null => (base ? base + path : null);
/** 控制面上不提供的业务页（会嵌入或运行不可信内容、或依赖 /go 登录中继）：跳回业务面同 path */
export const MARKET_ONLY = /^\/(use|cockpit|lifecycle|tasks)(\/|$)/;
