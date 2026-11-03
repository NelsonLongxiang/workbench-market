"""Login-gate browser probes (synthetic token, loopback only). Called by login-gate-browser.mjs."""
import json, re, sys
from pathlib import Path
from urllib.parse import quote
from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
base, wid, tok = cfg['base'], cfg['wid'], cfg['token']
passed = failed = 0
def ok(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1; print('  ✓', name)
    else: failed += 1; print('  ✗', name, extra)

def app_result(frame):
    frame.wait_for_selector('#out[data-done="1"]', state='attached', timeout=15000)
    return json.loads(frame.locator('#out').text_content())

def check_app(label, out):
    ok(f'{label}：相对脚本加载', out.get('js') is True, json.dumps(out))
    ok(f'{label}：绝对样式表加载', out.get('css') == 'loaded', json.dumps(out))
    ok(f'{label}：静态 <img> 文件加载', out.get('st', 0) > 0, json.dumps(out))
    ok(f'{label}：动态 <img> 文件加载', out.get('dyn', 0) > 0, json.dumps(out))
    ok(f'{label}：带台令牌读文件列表 200', out.get('files') == 200, json.dumps(out))

def login(page, token):
    page.get_by_placeholder('管理员口令').fill(token)
    page.get_by_role('button', name='输入管理员口令登录').click()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        ctx = b.new_context(viewport={'width': 1440, 'height': 900})
        page = ctx.new_page()
        # ① 匿名 → 登录页
        page.goto(base + '/apps/gate-app/')
        ok('① 匿名打开自产台 → 登录页且 next 带原地址', page.url == f"{base}/login?next={quote('/apps/gate-app/', safe='')}", page.url)
        login(page, 'wrong-synthetic')
        page.get_by_text('口令无效').wait_for(timeout=5000)
        ok('① 错误口令提示「口令无效」并留在登录页', '/login' in page.url)
        login(page, tok)
        page.wait_for_url(re.compile(r'/apps/gate-app/~wm/[0-9a-z]+\.[0-9a-f]{32}/$'), timeout=10000)
        ok('① 口令登录后回到原地址（换成带查看凭证的地址）', '/~wm/' in page.url, page.url)
        cookies = {c['name']: c for c in ctx.cookies()}
        ok('① 登录 cookie HttpOnly + SameSite=Lax', cookies.get('wm_login', {}).get('httpOnly') is True and cookies['wm_login'].get('sameSite') == 'Lax')
        # ② 沙箱自产台
        check_app('② 顶层沙箱页', app_result(page.main_frame))
        ok('② 页面确实是不透明源（沙箱生效）', page.evaluate('() => self.origin') == 'null')
        # ③ 使用页内嵌
        page.goto(f'{base}/use/{wid}')
        page.wait_for_function(f"() => [...document.querySelectorAll('iframe')].some(f => f.src.includes('/go/{wid}/'))", timeout=15000)
        frame = None
        for _ in range(60):
            frame = next((f for f in page.frames if '/~wm/' in f.url), None)
            if frame: break
            page.wait_for_timeout(250)
        ok('③ 使用页 iframe 经 /go 换到带凭证的地址', frame is not None and f'/go/{wid}/~wm/' in frame.url, str([f.url for f in page.frames]))
        if frame: check_app('③ 内嵌沙箱页', app_result(frame))
        # ④ SPA 顶栏身份与退出；会话失效后接口 401 去登录页
        page.goto(base + '/market')
        chip = page.get_by_text('管理员口令登录')
        chip.wait_for(timeout=15000)
        ok('④ 顶栏显示登录身份', chip.is_visible())
        ctx.clear_cookies()
        page.evaluate("() => { history.pushState({}, '', '/sops'); dispatchEvent(new PopStateEvent('popstate')); }")
        page.wait_for_url(re.compile(r'/login\?next='), timeout=15000)
        ok('④ 会话失效后 SPA 接口 401 → 登录页且 next 回当前页', page.url == f"{base}/login?next={quote('/sops', safe='')}", page.url)
        login(page, tok)
        page.wait_for_url(base + '/sops', timeout=10000)
        ok('④ 重新登录后回到 /sops', page.url == base + '/sops')
        page.get_by_role('button', name=re.compile('退\\s*出')).click()
        page.wait_for_url(re.compile(r'/login$'), timeout=10000)
        ok('④ 点「退出」回登录页且 cookie 已清', 'wm_login' not in {c['name'] for c in ctx.cookies()})
        page.goto(base + '/market')
        ok('④ 退出后再进被拦', '/login' in page.url, page.url)
        # ⑤ next 指向站外
        page.goto(base + '/login?next=' + quote('//evil.example/x', safe=''))
        login(page, tok)
        page.wait_for_url(base + '/', timeout=10000)
        ok('⑤ next 指向站外时登录后落在本站首页', page.url == base + '/', page.url)
    finally:
        b.close()
print(f'login-gate-browser: {passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
