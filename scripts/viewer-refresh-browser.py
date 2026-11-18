"""当前用户 chip（web/src/components/ViewerChip.tsx）浏览器回归：真组件，/api/auth/viewer 全部打桩成合成应答。
先 node scripts/viewer-refresh-build.mjs，再 python scripts/viewer-refresh-browser.py tmp/viewer-refresh/fixture.js。
Odoo 下线（2026-11-17）后的语义（服务端 #823）：
  200 显示是谁（不写登录来源、不露主体标识）；401 「未登录」+ 站内登录页链接（登录完回到当前页；外站地址不用）；
  403 「账号已停用」+ 退出；503 只提示，不清会话、不跳走、不调登出；接口不通或回答不认得就不显示。
  不再有弹窗登录：整个过程不开新窗口。切回页面最多每分钟复查一次。数据全是合成的。"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

bundle = Path(sys.argv[1]).read_text(encoding='utf-8')
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

VIEWER = {'ok': True, 'viewer': {'login': 'fixture-a', 'sub': 'user:fixture-a', 'name': 'Fixture A', 'kind': '人'}, 'roles': None}
CASES = {
    'ok': (200, VIEWER),
    'anon': (401, {'ok': False, 'error': '没有登录', 'auth_required': True, 'login_url': '/login'}),
    'anon-evil': (401, {'ok': False, 'auth_required': True, 'login_url': 'http://evil.example/web/login?redirect=%2F'}),
    'disabled': (403, {'ok': False, 'error': '账号已停用', 'auth_required': False}),
    'unavailable': (503, {'ok': False, 'error': '还没有配置任何登录方式'}),
    'failed': (500, {'ok': False}),
    'bad-json': (200, 'not-json'),
    'missing-viewer': (200, {'ok': True}),
}

with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        def open_case(name, path='/work-items?q=1'):
            ctx = browser.new_context()
            page = ctx.new_page()
            st = {'case': name, 'calls': 0, 'logout': 0, 'popups': 0}
            ctx.on('page', lambda _p: st.__setitem__('popups', st['popups'] + 1))
            def route(r):
                u = r.request.url
                if '/api/auth/viewer' in u:
                    st['calls'] += 1
                    code, body = CASES[st['case']]
                    r.fulfill(status=code, body=body if isinstance(body, str) else json.dumps(body), content_type='application/json')
                elif '/api/auth/logout' in u:
                    st['logout'] += 1; r.fulfill(status=200, body='{"ok":true}', content_type='application/json')
                elif u.endswith('/bundle.js'): r.fulfill(body=bundle, content_type='text/javascript')
                else: r.fulfill(body='<div id="root"></div><script src="/bundle.js"></script>', content_type='text/html')
            page.route('**/*', route)
            page.goto('http://fixture.test' + path)
            return ctx, page, st

        ctx, page, st = open_case('ok')
        chip = page.get_by_test_id('viewer-ok')
        expect(chip).to_have_text('Fixture A（fixture-a）')
        chip.click(); page.get_by_text('当前用户').wait_for()
        pop = page.locator('.ant-popover').inner_text()
        check('200：显示名字和登录名；弹出层没有「来源」「Odoo」、不露主体标识（user:…）', '登录名' in pop and '来源' not in pop and 'Odoo' not in pop and 'user:' not in pop, pop)
        check('200：整页不再出现「Odoo」', 'Odoo' not in page.locator('body').inner_text())
        before = st['calls']
        page.evaluate("for(let i=0;i<10;i++)window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(300)
        check('切回页面一分钟内不重复查', st['calls'] == before, st['calls'])
        ctx.close()

        ctx, page, st = open_case('anon')
        expect(page.get_by_test_id('viewer-anon')).to_have_text('未登录')
        href = page.get_by_test_id('viewer-login').get_attribute('href')
        check('401：「未登录」+「登录」链接去站内登录页，登录完回到当前页', href == '/login?next=%2Fwork-items%3Fq%3D1', href)
        check('401：没有「未登录 Odoo」的旧说法', page.get_by_text('未登录 Odoo').count() == 0)
        page.get_by_test_id('viewer-login').click(); page.wait_for_url('**/login?next=*')
        check('点「登录」：同一个标签页整页跳过去，不开新窗口（没有弹窗登录了）', st['popups'] == 0 and '/login?next=' in page.url, (st['popups'], page.url))
        ctx.close()

        ctx, page, st = open_case('anon-evil')
        href = page.get_by_test_id('viewer-login').get_attribute('href')
        check('401 带外站登录地址（以前的 Odoo 登录页）：不用，换成站内登录页', href == '/login?next=%2Fwork-items%3Fq%3D1', href)
        ctx.close()

        ctx, page, st = open_case('anon', '/')
        check('在首页没登录：登录链接就是 /login', page.get_by_test_id('viewer-login').get_attribute('href') == '/login')
        ctx.close()

        ctx, page, st = open_case('disabled')
        expect(page.get_by_test_id('viewer-disabled')).to_have_text('账号已停用')
        page.get_by_role('button', name='退出').click(); page.wait_for_url('**/login')
        check('403：「账号已停用」，点「退出」调登出并回登录页', st['logout'] == 1 and page.url.endswith('/login'), (st['logout'], page.url))
        ctx.close()

        ctx, page, st = open_case('unavailable')
        expect(page.get_by_test_id('viewer-unavailable')).to_have_text('暂时登录不了')
        page.wait_for_timeout(800)
        check('503：只提示「暂时登录不了」；不调登出、不跳走、没有登录按钮', st['logout'] == 0 and page.url == 'http://fixture.test/work-items?q=1' and page.get_by_test_id('viewer-login').count() == 0, (st['logout'], page.url))
        ctx.close()

        for name in ('failed', 'bad-json', 'missing-viewer'):
            ctx, page, st = open_case(name)
            page.wait_for_timeout(800)
            check(f'{name}：不显示 chip', page.locator('[data-testid^=viewer-]').count() == 0)
            ctx.close()

        ctx, page, st = open_case('anon')
        expect(page.get_by_test_id('viewer-anon')).to_be_visible()
        st['case'] = 'ok'
        calls_before = st['calls']
        page.evaluate('(() => { const t = Date.now() + 61000; Date.now = () => t; })()')
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        try: page.get_by_test_id('viewer-ok').wait_for(state='visible', timeout=5000)
        except Exception: pass
        check('隔一分钟以上切回页面：重新查，登录后的身份显示出来', st['calls'] > calls_before and page.get_by_test_id('viewer-ok').count() == 1 and page.get_by_test_id('viewer-anon').count() == 0, (st['calls'], page.locator('header').inner_text()[:80] if page.locator('header').count() else ''))
        ctx.close()
    finally:
        browser.close()

print(f'viewer-refresh-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
