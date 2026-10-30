/** 生命周期全景的纯显示逻辑（不依赖 React，scripts/lifecycle-view-unit.mjs 直接用 node 跑）。 */

/** lc board 的 data.ledger。covered_through 是锚点覆盖到的账本行号（不是时间）；anchor_ok/anchor_failures 是 lc 新增字段，老版本缺省 */
export interface BoardLedger {
  rows: number;
  chain_consistent: boolean;
  anchored: boolean;
  tamper_evident: boolean;
  covered_through: number | null;
  unanchored_rows: number;
  anchor_ok?: boolean | null;
  anchor_failures?: number;
}

/** 时间照内核给的带时区原文显示（不换算成浏览器时区），只截到分钟；不是字符串就原样转成字符串，不抛错 */
export function fmt(s: unknown): string {
  if (s === null || s === undefined || s === '') return '—';
  return typeof s === 'string' ? s.replace('T', ' ').slice(0, 16) : String(s);
}

/** 防篡改徽标：判定顺序 链不一致 → 锚点对不上 → 全部覆盖 → 部分覆盖 → 未防篡改。
 *  锚点对照的是本地检出卷里的文件：每日作业先追加锚点再推送，推送失败时本地会多出没推送的锚点，
 *  内核照样算 tamper_evident:true——按 lifecycle-os AGENTS.md 规则 7，没推送的锚点不算证据，所以文案要写明。 */
export function ledgerBadge(l: BoardLedger, ledger: string | null): { color: 'error' | 'warning' | 'success'; text: string; tip: string } {
  const file = ledger ? `${ledger}.jsonl` : '锚点文件';
  if (!l.chain_consistent) return { color: 'error', text: '账本链不一致', tip: '账本哈希链断裂' };
  if (l.anchor_ok === false) {
    const n = typeof l.anchor_failures === 'number' ? l.anchor_failures : 0;
    return { color: 'error', text: `锚点对不上 · ${n} 行`, tip: `本地检出的锚点文件 ${file} 与账本不符，可能被改写；用 lc ledger --anchor 查明细` };
  }
  const src = ledger ? `对照本地检出的锚点文件 ${file}；只有已推送到远端的锚点才算证据。` : '';
  const cover = l.anchored ? (typeof l.covered_through === 'number' ? `锚点覆盖到第 ${l.covered_through} 行` : '锚点未覆盖任何行') : '账本尚未外部锚定';
  const tip = `${src}${cover}`;
  if (l.tamper_evident && l.unanchored_rows === 0) return { color: 'success', text: '防篡改（本地锚点）', tip };
  if (l.tamper_evident) return { color: 'warning', text: `防篡改 · 最近 ${l.unanchored_rows} 行未受保护`, tip };
  return { color: 'warning', text: `未防篡改 · ${l.unanchored_rows}/${l.rows} 行未锚定`, tip };
}

/** #275：服务端给的 login_url（/go/<Odoo 台>/?return=…）把 return 换成当前页面；只取 path+query，不带出别的源 */
export function odooLoginHref(loginUrl: string, origin = window.location.origin, here = window.location.pathname + window.location.search): string {
  const u = new URL(loginUrl, origin);
  u.searchParams.set('return', here);
  return u.pathname + u.search;
}
