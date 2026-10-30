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
        ok('清除后内嵌的上游页读到的口令为空', page.frames[-1].evaluate('window.__probe') == {'own': None, 'parent': None}, str(page.frames[-1].evaluate('window.__probe')))

        for target in (f'/go/{wid}/', f'/sop/{cfg["sop"]}/'):
            page.goto(base + '/market'); page.wait_for_timeout(800)
            set_token(page)
            page.goto(base + target); page.wait_for_timeout(800)
            ok(f'同一标签页跳到 {target}：新文档 sessionStorage 里没有口令', page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
    finally:
        b.close()
print(f'admin-token-browser: {passed} passed / {failed} failed')
sys.exit(1 if failed else 0)
