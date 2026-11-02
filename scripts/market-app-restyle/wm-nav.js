/* 工作台统一导航层 · 菜单 / 目录 / 视图（PATTERNS.md §7.4）。读 window.WM_NAV 配置，台内 DOM 只加 class/id，不移动、不改逻辑。
   WM_NAV = { title, home, groups: [{ key, label, sections: ['区块标题前缀', …] }],
              hideSections: ['只给工程/agent 看的区块标题前缀'], hideNodes: ['业务区块里技术说明段落的开头文字'], keepNodes: ['隐藏区块里仍要给业务看的段落开头'],
              hideColumns: ['表头文字'], hideFields: ['字段名前缀'], scrub: ['正则：从正文里删掉的批注'] }
   只给业务看：hideSections/hideNodes 命中的内容不进菜单、目录，任何视图都不显示（数据与接口不动）。
   区块 = 一个 h2 及其后的兄弟元素（到下一个 h2 为止）；h2 之前的内容是页头，始终显示。 */
(function () {
  var C = window.WM_NAV; if (!C || window.__wmNav) return; window.__wmNav = 1;
  var NS = 'wm:' + (window.WM_APP_SLUG || location.pathname.replace(/\/+$/, '')) + ':nav:';
  function get(k) { try { return localStorage.getItem(NS + k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(NS + k, v); } catch (e) { } }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  var sections = [], groups = [], state = { view: 'group', group: null, section: null };

  /* ---------- 区块识别 ---------- */
  function collect() {
    var heads = Array.prototype.filter.call(document.querySelectorAll('h2'), function (h) { return !h.closest('[data-wm-nav]'); });
    sections = heads.map(function (h, i) {
      // 外面包着只含这一个 h2 的容器（如 <section>）时，区块就是那个容器
      var box = h;
      while (box.parentElement && box.parentElement !== document.body && box.parentElement.querySelectorAll('h2').length === 1) box = box.parentElement;
      var nodes = [box], n = box.nextElementSibling;
      while (n && !(n.tagName === 'H2' || n.querySelector && n.querySelector('h2'))) {
        if (!/^(SCRIPT|STYLE|TEMPLATE)$/.test(n.tagName) && !n.hasAttribute('data-wm-nav')) nodes.push(n);
        n = n.nextElementSibling;
      }
      if (!h.id) h.id = 'wm-s-' + (i + 1);
      var text = norm(h.textContent), label = text, gkey = null;
      C.groups.forEach(function (g) {
        g.sections.forEach(function (p) { if (!gkey && text.indexOf(p) === 0) { gkey = g.key; label = p; } });
      });
      var hidden = !gkey && (C.hideSections || []).some(function (p) { return text.indexOf(p) === 0; });
      return { h: h, id: h.id, nodes: nodes, label: label.slice(0, 24), group: hidden ? 'hidden' : (gkey || 'other') };
    });
    hideNonBusiness();
    groups = C.groups.map(function (g) { return { key: g.key, label: g.label, items: sections.filter(function (s) { return s.group === g.key; }) }; })
      .filter(function (g) { return g.items.length; });
    var other = sections.filter(function (s) { return s.group === 'other'; });
    if (other.length) groups.push({ key: 'other', label: '其他', items: other });
  }

  /* ---------- 只给业务看：工程/agent 内容整块不显示 ---------- */
  function starts(e, list) {
    var t = norm(e.textContent); return (list || []).some(function (p) { return t.indexOf(p) === 0; });
  }
  function hideNonBusiness() {
    var keep = C.keepNodes || [];
    // 每次重算：台内脚本会挪动节点，旧标记不能跟着节点走
    Array.prototype.forEach.call(document.querySelectorAll('.wm-hide'), function (e) { e.classList.remove('wm-hide'); });
    sections.forEach(function (s) {
      if (s.group !== 'hidden') return;
      var parent = s.nodes[0].parentElement;
      s.nodes.forEach(function (n) { if (n.parentElement === parent && !starts(n, keep)) n.classList.add('wm-hide'); });
    });
    scrubFields();
    if (!(C.hideNodes || []).length) return;
    // 业务区块与页头里的技术说明段落：取最外层命中的元素
    Array.prototype.forEach.call(document.body.querySelectorAll('div,p,small,span'), function (e) {
      if (e.closest('[data-wm-nav]') || e.classList.contains('wm-hide')) return;
      if (starts(e, C.hideNodes) && !(e.parentElement && e.parentElement !== document.body && starts(e.parentElement, C.hideNodes))) e.classList.add('wm-hide');
    });
  }

  /* 业务区块里夹带的工程字段：整列、整个字段、批注文字（台内异步渲染后会重跑） */
  function field(e, list) { return starts(e, list) && !e.closest('[data-wm-nav]'); }
  function scrubFields() {
    (C.hideColumns || []).length && Array.prototype.forEach.call(document.querySelectorAll('table'), function (t) {
      var head = t.querySelector('tr'); if (!head) return;
      Array.prototype.forEach.call(head.children, function (th, i) {
        if (!field(th, C.hideColumns)) return;
        Array.prototype.forEach.call(t.rows, function (r) { var c = r.cells[i]; if (c) c.classList.add('wm-hide'); });
      });
    });
    var f = C.hideFields || [];
    if (f.length) {
      Array.prototype.forEach.call(document.querySelectorAll('label'), function (l) {
        if (!field(l, f)) return;
        l.classList.add('wm-hide');
        var ctl = l.htmlFor && document.getElementById(l.htmlFor); if (ctl) ctl.classList.add('wm-hide');
        for (var s = l.nextElementSibling; s && s.tagName !== 'LABEL'; s = s.nextElementSibling) if (s.classList.contains('help') || s === ctl) s.classList.add('wm-hide');
      });
      Array.prototype.forEach.call(document.querySelectorAll('dt'), function (d) {
        if (!field(d, f)) return;
        d.classList.add('wm-hide'); if (d.nextElementSibling && d.nextElementSibling.tagName === 'DD') d.nextElementSibling.classList.add('wm-hide');
      });
      Array.prototype.forEach.call(document.querySelectorAll('strong,b'), function (k) {
        var p = k.parentElement;
        if (field(k, f) && p && p.firstElementChild === k && starts(p, [norm(k.textContent)])) p.classList.add('wm-hide');
      });
    }
    var res = (C.scrub || []).map(function (s) { return new RegExp(s, 'g'); });
    if (!res.length) return;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (t) {
      var p = t.parentElement; return p && !/^(SCRIPT|STYLE|TEXTAREA|OPTION)$/.test(p.tagName) && !p.closest('[data-wm-nav]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    } });
    for (var t; (t = w.nextNode());) {
      var v = t.nodeValue, nv = v;
      res.forEach(function (re) { nv = nv.replace(re, ''); });
      if (nv !== v) t.nodeValue = nv;
    }
  }

  /* ---------- 外壳：应用栏 + 目录 ---------- */
  var bar, menu, views, toc, tocBtn, scrim;
  function build() {
    menu = el('div', { class: 'wm-nav-menu', role: 'tablist', 'aria-label': '菜单' });
    groups.forEach(function (g) {
      var b = el('button', { type: 'button', role: 'tab', class: 'wm-nav-menu-item', 'data-g': g.key, id: 'wm-tab-' + g.key, text: g.label });
      b.addEventListener('click', function () { go(g.key, null, true); });
      menu.appendChild(b);
    });
    views = el('div', { class: 'wm-nav-views', role: 'radiogroup', 'aria-label': '视图' });
    [['group', '分组'], ['all', '全部']].forEach(function (v) {
      var b = el('button', { type: 'button', role: 'radio', class: 'wm-nav-view', 'data-v': v[0], text: v[1] });
      b.addEventListener('click', function () { setView(v[0]); });
      views.appendChild(b);
    });
    tocBtn = el('button', { type: 'button', class: 'wm-nav-tocbtn', 'aria-expanded': 'false', 'aria-controls': 'wm-toc', text: '目录' });
    tocBtn.addEventListener('click', function () { drawer(tocBtn.getAttribute('aria-expanded') !== 'true'); });
    var home = el('a', { class: 'wm-nav-home', href: C.home || '/', target: '_top', text: '← 工作台市场' });
    var title = el('span', { class: 'wm-nav-title', text: C.title || norm((document.querySelector('h1') || {}).textContent || document.title) });
    bar = el('header', { class: 'wm-nav-bar', 'data-wm-nav': '', 'data-wm-skip': '' }, [tocBtn, home, title, menu, views]);

    toc = el('nav', { class: 'wm-nav-toc', id: 'wm-toc', 'aria-label': '目录', 'data-wm-nav': '', 'data-wm-skip': '' });
    groups.forEach(function (g) {
      var list = el('ul', {});
      g.items.forEach(function (s) {
        var a = el('a', { href: '#' + s.id, 'data-s': s.id, text: s.label });
        a.addEventListener('click', function (e) { e.preventDefault(); go(g.key, s.id, true); drawer(false); });
        list.appendChild(el('li', {}, [a]));
      });
      toc.appendChild(el('div', { class: 'wm-nav-toc-group', 'data-g': g.key }, [el('div', { class: 'wm-nav-toc-title', text: g.label }), list]));
    });
    scrim = el('div', { class: 'wm-nav-scrim', 'data-wm-nav': '', hidden: '' });
    scrim.addEventListener('click', function () { drawer(false); });
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.appendChild(toc); document.body.appendChild(scrim);
    document.documentElement.classList.add('wm-has-nav');
    // 菜单与视图的方向键
    [menu, views].forEach(function (g) {
      g.addEventListener('keydown', function (e) {
        var items = Array.prototype.slice.call(g.children), i = items.indexOf(document.activeElement);
        if (i < 0 || !/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
        var j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowLeft' ? (i - 1 + items.length) % items.length : (i + 1) % items.length;
        e.preventDefault(); items[j].focus(); items[j].click();
      });
    });
  }
  function drawer(open) {
    tocBtn.setAttribute('aria-expanded', String(open));
    toc.classList.toggle('wm-open', open); scrim.hidden = !open;
    if (open) { var a = toc.querySelector('a[aria-current]') || toc.querySelector('a'); if (a) a.focus(); }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && toc && toc.classList.contains('wm-open')) { drawer(false); tocBtn.focus(); } });

  /* ---------- 状态 ---------- */
  function render() {
    // 台内脚本可能把节点先插到顶层、再挪进容器：先清掉残留的隐藏标记，再按当前区块重打
    Array.prototype.forEach.call(document.querySelectorAll('.wm-off'), function (n) { n.classList.remove('wm-off'); });
    sections.forEach(function (s) {
      if (s.group === 'hidden') return;
      var off = state.view === 'group' && s.group !== state.group;
      var parent = s.nodes[0].parentElement;
      s.nodes.forEach(function (n) { if (n.parentElement === parent) n.classList.toggle('wm-off', off); });
    });
    Array.prototype.forEach.call(menu.children, function (b) {
      var on = b.getAttribute('data-g') === state.group;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (on && menu.scrollWidth > menu.clientWidth) menu.scrollLeft = b.offsetLeft - (menu.clientWidth - b.offsetWidth) / 2;  // 窄屏：当前项滚到可见处
    });
    Array.prototype.forEach.call(views.children, function (b) {
      var on = b.getAttribute('data-v') === state.view;
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(toc.querySelectorAll('.wm-nav-toc-group'), function (g) {
      g.classList.toggle('wm-current', g.getAttribute('data-g') === state.group);
    });
    mark(state.section);
  }
  function mark(id) {
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) {
      if (a.getAttribute('data-s') === id) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
  }
  function writeHash() {
    var h = '#wm=' + state.group + (state.section ? '/' + state.section : '') + (state.view === 'all' ? '&v=all' : '');
    try { history.replaceState(null, '', h); } catch (e) { }
    set('group', state.group); set('view', state.view);
  }
  function go(g, sid, user) {
    state.group = g; state.section = sid || (groups.filter(function (x) { return x.key === g; })[0] || groups[0]).items[0].id;
    render(); writeHash();
    var target = document.getElementById(state.section);
    if (user && target) {
      if (state.view === 'group' && !sid) scrollTo(0, 0);
      else target.scrollIntoView({ block: 'start' });
    }
  }
  function setView(v) { state.view = v; set('view', v); go(state.group, state.section, true); }

  /* 滚动时：目录高亮当前区块；「全部」视图下菜单跟随 */
  var ticking = false;
  addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    setTimeout(function () {  // 不用 rAF：后台标签页里 rAF 会暂停
      ticking = false;
      var top = (bar.getBoundingClientRect().height || 0) + 24, cur = null;
      sections.forEach(function (s) { if (s.group !== 'hidden' && !s.nodes[0].classList.contains('wm-off') && s.h.getBoundingClientRect().top <= top) cur = s; });
      if (!cur) return;
      if (cur.id !== state.section) { state.section = cur.id; mark(cur.id); }
      if (state.view === 'all' && cur.group !== state.group) { state.group = cur.group; render(); }
    }, 80);
  }, { passive: true });

  function boot() {
    collect(); if (!groups.length) return;
    build();
    var m = /#wm=([\w-]+)(?:\/([\w-]+))?(&v=all)?/.exec(location.hash);
    var keys = groups.map(function (g) { return g.key; });
    state.view = m ? (m[3] ? 'all' : 'group') : (get('view') === 'all' ? 'all' : 'group');
    var g = m && keys.indexOf(m[1]) >= 0 ? m[1] : (keys.indexOf(get('group')) >= 0 ? get('group') : keys[0]);
    var sid = m && m[2] && document.getElementById(m[2]) ? m[2] : null;
    go(g, sid, !!sid);
    // 链接指定了区块：台加载过程中会改动滚动（异步内容、自动聚焦），加载完成后再对齐一次
    if (sid) {
      var moved = false;
      ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (t) { addEventListener(t, function (e) { if (e.isTrusted) moved = true; }, { capture: true, passive: true }); });
      var align = function () { var t = document.getElementById(sid); if (t && !moved) { state.section = sid; mark(sid); t.scrollIntoView({ block: 'start' }); } };
      addEventListener('load', function () { setTimeout(align, 300); });
      setTimeout(align, 1200);
    }
    // 台内后插入的顶层节点（异步渲染）归入所在区块
    new MutationObserver(function (rs) {
      if (rs.some(function (r) { return r.target === document.body && (r.addedNodes.length || r.removedNodes.length); })) { collect(); render(); }
    }).observe(document.body, { childList: true });
    // 区块内部异步渲染（列表、卡片、表格）：稍后补做字段清理与段落隐藏
    var deep;
    new MutationObserver(function (rs) {
      if (!rs.some(function (r) { return !(r.target.closest && r.target.closest('[data-wm-nav]')); })) return;
      clearTimeout(deep); deep = setTimeout(function () { hideNonBusiness(); }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
