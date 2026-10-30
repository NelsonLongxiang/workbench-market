"""#292 M4 browser probes (synthetic token, loopback only). Called by admin-token-browser.mjs."""
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

def set_token(page):
    page.get_by_role('button', name='口令').click()
    page.get_by_placeholder('ADMIN_TOKEN').fill(tok)
    page.get_by_role('button', name=re.compile(r'^保\s*存$')).click()  # antd 两字按钮会插空格
    page.get_by_role('button', name='口令已设').wait_for()

def spa(page, path):  # 站内路由跳转（不换文档，口令仍在内存与 sessionStorage）
    page.evaluate('p => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }', path)
    page.wait_for_timeout(800)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        page = b.new_context().new_page()
        page.goto(base + f'/use/{wid}'); page.wait_for_timeout(1200)
        ok('对照：没设口令时使用页照常内嵌 /go/', go_frames(page) == 1)

        page.goto(base + '/market'); page.wait_for_timeout(800)
        set_token(page)
        ok('设口令后本标签页 sessionStorage 有口令（前提成立）', page.evaluate('sessionStorage.getItem("wm-admin-token")') == tok)
        spa(page, f'/use/{wid}')
        ok('有口令：使用页不出现 /go/ iframe', go_frames(page) == 0)
        ok('有口令：使用页给出「新标签页打开」与「清除口令并内嵌」', page.get_by_role('button', name='新标签页打开').count() == 1 and page.get_by_role('button', name='清除口令并内嵌').count() == 1)
        spa(page, f'/cockpit/{cfg["cockpit"]}')
        ok('有口令：驾驶舱面板也不出现 /go/ iframe', go_frames(page) == 0 and page.get_by_role('button', name='清除口令并内嵌').count() >= 1)

        with page.context.expect_page() as newp:
            page.get_by_role('button', name='新标签页打开').first.click()
        np = newp.value; np.wait_for_load_state(); np.wait_for_timeout(500)
        ok('「新标签页打开」：新标签页拿不到口令、没有 opener', np.evaluate('window.__probe && window.__probe.own') is None and np.evaluate('window.opener') is None, str(np.evaluate('window.__probe')))
        np.close()

        page.get_by_role('button', name='清除口令并内嵌').first.click(); page.wait_for_timeout(1200)
        ok('清除口令后：驾驶舱内嵌恢复、存储为空', go_frames(page) == 1 and page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        ok('清除后内嵌的上游页读到的口令为空', (lambda pr: pr.get('own') is None and pr.get('parent') is None)(page.frames[-1].evaluate('window.__probe')), str(page.frames[-1].evaluate('window.__probe')))

        # ⑤ 登录弹窗（顶栏 ViewerChip → useOdooPopupLogin）
        who = {'state': 'anon'}
        def whoami(route):
            if who['state'] == 'anon':
                route.fulfill(status=401, content_type='application/json', body=json.dumps({'ok': False, 'auth_required': True, 'login_url': f'/go/{wid}/'}))
            else:
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'viewer': {'login': 'pm-a', 'uid': 7, 'sub': 'user:pm-a', 'name': '测试 PM-A', 'kind': '人'}, 'roles': None}))
        lp = b.new_context().new_page()
        lp.route('**/api/lifecycle/whoami', whoami)
        lp.goto(base + '/market'); lp.get_by_text('未登录 Odoo').wait_for()
        set_token(lp)
        ok('有口令：顶栏不给「登录」，只给「清除口令并登录」', lp.get_by_role('button', name=re.compile(r'^登\s*录$')).count() == 0 and lp.get_by_role('button', name='清除口令并登录').count() == 1)
        with lp.context.expect_page() as pp:
            lp.get_by_role('button', name='清除口令并登录').click()
        pop = pp.value; pop.wait_for_load_state(); pop.wait_for_function('window.__probe !== undefined')
        pr = pop.evaluate('window.__probe')
        ok('清除口令并登录：父页口令已清空（内存与存储）', lp.evaluate('sessionStorage.getItem("wm-admin-token")') is None and lp.get_by_role('button', name=re.compile(r'口\s*令$')).count() == 1)
        ok('登录弹窗的 sessionStorage 里没有口令（没复制到）', pr.get('own') is None, str(pr))
        ok('登录弹窗 window.opener 为 null（读不到父页存储）', pr.get('opener') == 'no-opener', str(pr))
        who['state'] = 'ok'
        lp.get_by_text('测试 PM-A（pm-a）· 人').wait_for(timeout=8000)
        ok('登录成功：whoami 轮询收尾、顶栏显示用户、弹窗自动关闭', pop.is_closed())

        who['state'] = 'anon'
        lp2 = b.new_context().new_page()
        lp2.route('**/api/lifecycle/whoami', whoami)
        lp2.goto(base + '/market'); lp2.get_by_text('未登录 Odoo').wait_for()
        with lp2.context.expect_page() as pp2:
            lp2.get_by_role('button', name=re.compile(r'^登\s*录$')).click()
        pop2 = pp2.value; pop2.wait_for_load_state(); pop2.wait_for_function('window.__probe !== undefined')
        ok('无口令时顶栏「登录」照常开弹窗，弹窗同样没有 opener', pop2.evaluate('window.__probe').get('opener') == 'no-opener')
        pop2.close()  # 模拟 COOP 断开 / 用户先关弹窗：之后 6 秒内 whoami 变 200 仍要收尾
        lp2.wait_for_timeout(500); who['state'] = 'ok'
        lp2.get_by_text('测试 PM-A（pm-a）· 人').wait_for(timeout=8000)
        ok('弹窗先关、随后才登录成功：轮询补查照常收尾', True)
        lp.context.close(); lp2.context.close()

        # ⑥ bfcache：真实往返缓存路径
        bp = b.new_context().new_page()
        bp.add_init_script('addEventListener("pageshow", e => { window.__persisted = e.persisted; })')
        bp.goto(base + '/market'); bp.wait_for_timeout(600); set_token(bp)
        bp.goto(base + f'/go/{wid}/'); bp.wait_for_timeout(500)
        bp.go_back(); bp.wait_for_timeout(800)
        if bp.evaluate('window.__persisted') is True:
            spa(bp, f'/use/{wid}')
            ok('bfcache 命中：恢复的旧页面内存里仍有口令，GoFrame 继续拒嵌', go_frames(bp) == 0)
        else:
            print('  - SKIP bfcache：后退未命中往返缓存（persisted=false），恢复旧页面时内存口令的路径未验证')
        bp.context.close()

        for target in (f'/go/{wid}/', f'/sop/{cfg["sop"]}/'):
            page.goto(base + '/market'); page.wait_for_timeout(800)
            set_token(page)
            page.goto(base + target); page.wait_for_timeout(800)
            ok(f'同一标签页跳到 {target}：新文档 sessionStorage 里没有口令', page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
    finally:
        b.close()
print(f'admin-token-browser: {passed} passed / {failed} failed')
sys.exit(1 if failed else 0)
