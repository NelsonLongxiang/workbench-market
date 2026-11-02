window.wmAudit = () => {
  const P = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(',').map(Number); return [a[0], a[1], a[2], a.length > 3 ? a[3] : 1]; };
  const L = ([r, g, b]) => { const f = x => (x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => [0, 1, 2].map(i => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const c = P(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { st.push(c); if (c[3] >= 1) break; } } let b = [255, 255, 255, 1]; for (const c of st.reverse()) b = blend(c, b); return b; };
  const fails = []; let n = 0; const sizes = {};
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some(t => t.nodeType === 3 && t.textContent.trim())) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (!r.width || cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[disabled],option,script,style')) continue;
    n++; const fs = parseFloat(cs.fontSize); if (!el.closest('svg')) sizes[fs] = (sizes[fs] || 0) + 1;
    const fg = P(cs.color); const bg = bgOf(el); const fgb = blend(fg, bg);
    const a = L(fgb), b = L(bg); const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const need = (fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700)) ? 3 : 4.5;
    if (cr < need) fails.push({ t: el.textContent.trim().slice(0, 30), cr: +cr.toFixed(2), fg: cs.color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round) + ')', cls: el.className && String(el.className).slice(0, 30) });
  }
  const q = x => document.querySelectorAll(x).length;
  const offGrid = Object.keys(sizes).filter(k => ![12, 14, 16, 20, 24].includes(+k)).map(k => k + 'px×' + sizes[k]);
  return { texts: n, fails: fails.length, offGrid, menus: q('.wm-menu'), tabs: q('[role=tab]'), tabSel: q('[role=tab][aria-selected=true]'), pressed: q('[aria-pressed]'), unfocusableClick: q('[onclick]:not(button):not(a):not(input):not(select):not([tabindex])'), ux: !!window.__wmUx, sample: fails.slice(0, 5).map(f => f.cr + ' ' + f.fg + ' on ' + f.bg + ' · ' + f.t) };
};
