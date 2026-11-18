"""Admin-token browser probes (synthetic token, loopback only). Called by admin-token-browser.mjs.
属主 2026-11-02 撤销 #292 M1：业务面凭口令即可做管理写；#292 M4 止血（持口令时不内嵌 /go/、离开页面抹口令）保留。"""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
base, wid, tok = cfg['base'], cfg['wid'], cfg['token']
passed = failed = 0
def ok(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1; print('  ✓', name)
    else: failed += 1; print('  ✗', name, extra)

def go_frames(page):
    return page.locator(f'iframe[src="/go/{wid}/"]').count()

def slow(page):
    """本机模拟慢 runner：WM_BROWSER_CPU_THROTTLE=6 把页面 CPU 放慢 6 倍，动画和取数的先后就和 CI 上接近。缺省不放慢。"""
    import os
    rate = float(os.environ.get('WM_BROWSER_CPU_THROTTLE', '0') or 0)
    if rate > 1: page.context.new_cdp_session(page).send('Emulation.setCPUThrottlingRate', {'rate': rate})

def open_me(page):
    # 新外壳（#571）：口令、登录身份都在侧栏底部用户卡的弹出层里。
    # 开没开看用户卡自己的 aria-expanded，不看弹出层「可见」：弹出层刚开始放大动画时尺寸是 0，
    # 会被当成没开而再点一次、反而关上（CI 上慢，撞上过）。
    me = page.locator('[data-testid=wm-me]')
    if me.get_attribute('aria-expanded') != 'true':
        me.click()
    page.locator('[data-testid=wm-me][aria-expanded=true]').wait_for()
    # 等放大动画走完再往下（动画起点那一帧尺寸是 0）
    page.wait_for_function("""() => { const e = document.querySelector('.wm-me-pop'); if (!e) return false; const r = e.getBoundingClientRect(); const h = e.closest('.ant-popover');
      return !!h && r.width > 0 && r.height > 0 && ![...h.classList].some(c => /-(appear|enter|leave)(-|$)/.test(c)) && !h.classList.contains('ant-popover-hidden'); }""")

def set_token(page):
    open_me(page)
    page.locator('.wm-me-pop').get_by_role('button', name='口令').click()
    page.get_by_placeholder('ADMIN_TOKEN').fill(tok)
    page.get_by_role('button', name=re.compile(r'^保\s*存$')).click()  # antd 两字按钮会插空格
    page.get_by_role('button', name='口令已设').wait_for()

WRITE = '''async ([t]) => { const r = await fetch("/api/workbenches", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": t }, body: JSON.stringify({ name: "from-page", url: "http://127.0.0.1:9/", type: "web" }) }); return { status: r.status, body: await r.json().catch(() => null) }; }'''
ANON = json.dumps({'ok': False, 'auth_required': True, 'login_url': '/login'})

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        print('业务面管理（属主 2026-11-02：口令即可，不再限控制面）')
        c = b.new_context()
        page = c.new_page()
        slow(page)
        page.goto(base + f'/use/{wid}'); page.wait_for_timeout(1200)
        ok('未设口令：使用页照常内嵌 /go/', go_frames(page) == 1)
        page.goto(base + f'/cockpit/{cfg["cockpit"]}'); page.wait_for_timeout(1200)
        ok('未设口令：驾驶舱照常内嵌 /go/、只读（没有新建/加面板）', go_frames(page) == 1 and page.get_by_text('这个驾驶舱你只能看').count() >= 1)  # 只读提示改成一行浅色说明（协调 2026-11-12）
        page.goto(base + '/market'); page.wait_for_timeout(800)
        open_me(page)
        ok('业务面用户卡里有口令输入，没有「管理控制面」链接', page.get_by_role('button', name=re.compile(r'口\s*令$')).count() == 1 and page.get_by_role('link', name=re.compile('管理控制面')).count() == 0)
        set_token(page)
        r = page.evaluate(WRITE, [tok])
        ok('业务面页面带对口令发管理写 → 201', r['status'] == 201, str(r))
        r = page.evaluate(WRITE, ['wrong-token'])
        ok('业务面页面带错口令 → 403', r['status'] == 403, str(r))
        for v in ('/API/workbenches', '/Api/Workbenches'):
            rv = page.evaluate(WRITE.replace('"/api/workbenches"', json.dumps(v)), [''])
            ok(f'业务面页面 fetch 大写变体 {v}（不带口令）→ 403', rv['status'] == 403, str(rv))
        ok('设口令后侧栏出现「设置 / 管理」', page.locator('[data-testid=nav-admin]').count() == 1)
        page.evaluate(f'history.pushState(null, "", "/cockpit/{cfg["cockpit"]}"); dispatchEvent(new PopStateEvent("popstate"))'); page.wait_for_timeout(1200)
        ok('持口令：驾驶舱可编辑（不再显示只读提示）', page.get_by_text('这个驾驶舱你只能看').count() == 0, page.url)
        ok('持口令：驾驶舱不内嵌 /go/（#292 M4 止血保留）', go_frames(page) == 0)
        page.evaluate(f'history.pushState(null, "", "/use/{wid}"); dispatchEvent(new PopStateEvent("popstate"))'); page.wait_for_timeout(1200)
        ok('持口令：使用页不内嵌 /go/，给出「清除口令并内嵌」', go_frames(page) == 0 and page.get_by_role('button', name='清除口令并内嵌').count() == 1)
        page.get_by_role('button', name='清除口令并内嵌').click(); page.wait_for_timeout(1500)
        ok('清除口令后才内嵌 /go/，存储为空', go_frames(page) == 1 and page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        pr = page.frames[-1].evaluate('window.__probe')
        ok('内嵌的上游页读自己和父页都没有口令', pr.get('own') is None and pr.get('parent') is None, str(pr))
        c.close()

        print('同标签页离开市场页面即抹掉口令（#292 M4）')
        c = b.new_context(); page = c.new_page()
        page.goto(base + '/market'); page.wait_for_timeout(600); set_token(page)
        page.goto(base + f'/go/{wid}/'); page.wait_for_timeout(1200)
        ok('同一标签页跳到 /go/ 后，新文档读不到口令', page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        c.close()

        print('业务面登录入口（Odoo 下线后没有弹窗登录：整页去站内登录页）')
        # 旧断言（弹窗没有 opener、弹窗里没有口令、有口令时不发起弹窗）→ 新守护：同一个标签页整页跳到 /login，
        # 不开任何新窗口；跳过去之后新文档里读不到口令（离开即抹，M4）
        c = b.new_context(); opened = []
        c.on('page', lambda pg: opened.append(pg))
        q = c.new_page()
        q.route('**/api/auth/viewer', lambda r: r.fulfill(status=401, content_type='application/json', body=ANON))
        q.goto(base + '/market'); q.evaluate('sessionStorage.setItem("wm-admin-token", "synthetic-browser-admin")')
        open_me(q); q.get_by_test_id('viewer-anon').wait_for()
        ok('用户卡里写「未登录」，没有「未登录 Odoo」的旧说法', q.get_by_text('未登录 Odoo').count() == 0)
        q.get_by_test_id('viewer-login').click(); q.wait_for_url('**/login**', timeout=8000)
        ok('点「登录」：同一个标签页跳到站内登录页，登录完回到原页', '/login?next=%2Fmarket' in q.url, q.url)
        ok('不开任何新窗口（没有弹窗登录了）', len(opened) == 1, f'共 {len(opened)} 个页面')
        ok('跳到登录页之后，新文档里读不到口令', q.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        c.close()
    finally:
        b.close()
print(f'admin-token-browser: {passed} passed / {failed} failed')
sys.exit(1 if failed else 0)
