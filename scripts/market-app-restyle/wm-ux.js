/* 工作台统一交互层 · 菜单 / 焦点 / 状态持久化（DESIGN.md v1.0.0 · PATTERNS §3）。台内逻辑不改，只补语义与记忆。 */
(function () {
  if (window.__wmUx) return; window.__wmUx = 1;
  var NS = 'wm:' + (window.WM_APP_SLUG || location.pathname.replace(/\/+$/, '')) + ':' + location.pathname.split('/').pop() + ':';
  function get(k) { try { return localStorage.getItem(NS + k); } catch (e) { return null; } }
  function set(k, v) { try { v == null ? localStorage.removeItem(NS + k) : localStorage.setItem(NS + k, v); } catch (e) { } }
  function sget(k) { try { return sessionStorage.getItem(NS + k); } catch (e) { return null; } }
  function sset(k, v) { try { sessionStorage.setItem(NS + k, v); } catch (e) { } }
  function txt(el) { return (el.getAttribute('data-tab') || el.getAttribute('data-key') || el.getAttribute('data-view') || el.textContent || '').replace(/\s+/g, ' ').replace(/\d+/g, '#').trim().slice(0, 40); }
  function clickable(el) {
    if (/^(BUTTON|A)$/.test(el.tagName) || el.hasAttribute('onclick') || el.getAttribute('role') === 'tab') return true;
    try { return getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
  }
  function addCls(el, c) { if (!el.classList.contains(c)) el.classList.add(c); }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function isOn(el) {
    var c = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)(on|active|selected|current|is-active|sel)(\s|$)/.test(c)) return true;
    if (el.hasAttribute('data-wm-a')) return false; // aria 是本层写的，以台的 class 为准
    return el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-current') === 'page';
  }

  /* ---------- 菜单 ---------- */
  var MENU_SEL = '[role=tablist],.tabs,.pills,.nav,.segs,.seg-group,.menu,nav';
  function menus() {
    var out = [];
    document.querySelectorAll(MENU_SEL).forEach(function (g) {
      if (g.closest('[data-wm-skip]')) return;
      var items = Array.prototype.filter.call(g.children, function (c) { return clickable(c) && c.textContent.trim(); });
      if (items.length < 2) return;
      out.push({ g: g, items: items });
    });
    return out;
  }
  function syncMenu(m) {
    var g = m.g, items = m.items, onCount = items.filter(isOn).length;
    addCls(g, 'wm-menu');
    // 台自己维护 aria 的组：aria-selected = 页签（补全 tablist/tab 角色、参与记忆）；aria-pressed = 切换按钮组（原样保留）
    var ownSel = items.some(function (it) { return !it.hasAttribute('data-wm-a') && it.hasAttribute('aria-selected'); });
    var ownPress = items.some(function (it) { return !it.hasAttribute('data-wm-a') && it.hasAttribute('aria-pressed'); });
    if (ownSel || ownPress) {
      if (ownSel && !g.getAttribute('role')) setAttr(g, 'role', 'tablist');
      items.forEach(function (it) {
        addCls(it, 'wm-menu-item');
        if (ownSel) { if (!it.getAttribute('role') || it.getAttribute('role') === 'button') setAttr(it, 'role', 'tab'); /* aria-selected 不适用于 button 角色 */ setAttr(it, 'tabindex', it.getAttribute('aria-selected') === 'true' ? '0' : '-1'); }
      });
      m.exclusive = ownSel; return;
    }
    var exclusive = onCount === 1; // 恰好一个选中才是页签；全不选的是锚点导航，只统一样式
    // 只有「单选切换」的组才是页签：补 tablist 语义并可记忆；多选筛选组只补按下态
    if (exclusive && (!g.getAttribute('role') || g.getAttribute('role') === 'group')) setAttr(g, 'role', 'tablist');
    if (!exclusive && onCount === 0) { m.exclusive = false; items.forEach(function (it) { addCls(it, 'wm-menu-item'); }); return; }
    items.forEach(function (it) {
      addCls(it, 'wm-menu-item');
      var own = !it.hasAttribute('data-wm-a') && (it.hasAttribute('aria-selected') || it.hasAttribute('aria-pressed'));
      if (exclusive) {
        if (!it.getAttribute('role') || it.getAttribute('role') === 'button') setAttr(it, 'role', 'tab');
        if (!own) { setAttr(it, 'data-wm-a', ''); setAttr(it, 'aria-selected', String(isOn(it))); }
        setAttr(it, 'tabindex', isOn(it) ? '0' : '-1');
      } else {
        if (!own) { setAttr(it, 'data-wm-a', ''); setAttr(it, 'aria-pressed', String(isOn(it))); }
        if (!/^(BUTTON|A)$/.test(it.tagName)) setAttr(it, 'tabindex', '0');
      }
    });
    m.exclusive = exclusive;
  }
  function menuKey(m, i) { return 'menu:' + i + ':' + txt(m.items[0]).slice(0, 12); }

  /* ---------- 焦点：可点击但不可聚焦的元素补键盘可达 ---------- */
  function fixFocus() {
    document.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea):not([tabindex])').forEach(function (el) {
      el.setAttribute('tabindex', '0');
      if (!el.getAttribute('role')) el.setAttribute('role', /^(TR)$/.test(el.tagName) ? 'link' : 'button');
    });
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    // 回车/空格触发自定义可点击元素
    if ((e.key === 'Enter' || e.key === ' ') && t.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.closest('[role=button],[role=link],[role=tab],[onclick],.wm-menu-item') === t) {
      e.preventDefault(); t.click(); return;
    }
    // 页签方向键
    if (t.getAttribute('role') === 'tab' && !t.closest('[data-wm-nav]') && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) {  /* 导航层自己处理方向键 */
      var g = t.parentElement, tabs = Array.prototype.filter.call(g.children, function (c) { return c.getAttribute('role') === 'tab'; });
      var i = tabs.indexOf(t), n = tabs.length;
      var j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : /Left|Up/.test(e.key) ? (i - 1 + n) % n : (i + 1) % n;
      e.preventDefault(); tabs[j].focus(); tabs[j].click();
    }
  }, true);

  /* ---------- 状态持久化 ---------- */
  var restoring = false;
  document.addEventListener('click', function (e) {
    if (restoring) return;
    var it = e.target.closest && e.target.closest('.wm-menu-item'); if (!it) return;
    var ms = menus();
    ms.forEach(function (m, i) { if (m.items.indexOf(it) < 0) return; syncMenu(m); if (m.exclusive && it.getAttribute('role') === 'tab') set(menuKey(m, i), txt(it)); });
    setTimeout(refresh, 0);
  }, true);
  function fieldKey(el) {
    var id = el.id || el.name; if (!id) return null;
    var hint = (id + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    if (el.tagName === 'SELECT' || el.type === 'search' || /search|filter|query|keyword|\bq\b|kw|sort|搜索|筛选|过滤|查找|排序/.test(hint)) return 'field:' + id;
    return null;
  }
  function persistable(el) { return /^(INPUT|SELECT)$/.test(el.tagName) && !/^(password|hidden|file|submit|button)$/.test(el.type) && fieldKey(el); }
  document.addEventListener('input', onField, true); document.addEventListener('change', onField, true);
  function onField(e) {
    if (restoring) return; var el = e.target; var k = persistable(el); if (!k) return;
    set(k, el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value);
  }
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (restoring || !d || d.tagName !== 'DETAILS') return;
    var s = d.querySelector('summary'); if (s) set('details:' + txt(s), d.open ? '1' : '0');
  }, true);
  addEventListener('scroll', function () { clearTimeout(window.__wmSc); window.__wmSc = setTimeout(function () { sset('scroll', String(scrollY)); }, 150); }, { passive: true });

  var restored = {}, touched = false;
  ['pointerdown', 'keydown'].forEach(function (t) { document.addEventListener(t, function (e) { if (e.isTrusted) touched = true; }, true); });
  function restore() {
    restoring = true;
    try {
      menus().forEach(function (m, i) {
        syncMenu(m);
        var k = menuKey(m, i); if (restored[k] || !m.exclusive) return;
        var want = get(k); if (!want) { restored[k] = 1; return; }
        if (location.hash && m.items.some(function (it) { return it.getAttribute('href') === location.hash; })) { restored[k] = 1; return; } // 链接里已指定视图
        var hit = m.items.filter(function (it) { return txt(it) === want; })[0];
        // 台可能在数据到达后重绘复位页签：窗口期内持续校验，直到确实选中或用户亲自操作
        if (hit && !touched) { if (!isOn(hit)) hit.click(); if (isOn(hit)) restored[k] = 1; }
      });
      document.querySelectorAll('input,select').forEach(function (el) {
        var k = persistable(el); if (!k || restored[k]) return;
        var v = get(k); if (v == null) return;
        if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) return;
        restored[k] = 1;
        if (el.type === 'checkbox' || el.type === 'radio') { if (String(el.checked) === v) return; el.checked = v === 'true'; }
        else { if (el.value === v || (el.value && el.tagName !== 'SELECT')) return; el.value = v; }
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      document.querySelectorAll('details').forEach(function (d) {
        var s = d.querySelector('summary'); if (!s) return; var k = 'details:' + txt(s); if (restored[k]) return;
        var v = get(k); if (v == null) return; restored[k] = 1; d.open = v === '1';
      });
    } finally { restoring = false; menus().forEach(syncMenu); }
  }
  function refresh() { menus().forEach(syncMenu); fixFocus(); }

  var tries = 0, mo;
  function boot() {
    refresh(); restore();
    // 台多为异步渲染：数据到达后再补一次语义与恢复，4 秒后停止追加恢复
    mo = new MutationObserver(function () { clearTimeout(window.__wmMo); window.__wmMo = setTimeout(function () { refresh(); if (tries++ < 20) restore(); }, 120); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(function () { tries = 99; }, 4000);
    var y = +sget('scroll');
    if (y && !location.hash) setTimeout(function () { scrollTo(0, y); }, 400);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
