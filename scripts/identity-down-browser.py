"""身份服务连不上的浏览器回归；由 scripts/identity-down-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
合成员工 alpha 登录着（cookie）。页面里把 /api/attention 截下来回 502 identity_unavailable：
外壳挂整页提示、侧栏角标和全景「等你拍板」写「暂时取不到」（不是 0、不是空态），不跳登录页、登录 cookie 还在；
页面会自己退避重试；放开之后提示自己消失、页面重读；「现在重试」不等计时。
别的 502（error 不是这个代号）和 401 不进这个状态。别的接口回这个代号也会挂提示（请求层统一认）。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
DOWN = json.dumps({'error': 'identity_unavailable'})
probes = []
def down(route):
    probes.append(1)
    route.fulfill(status=502, content_type='application/json', body=DOWN)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    ctx.route('**/api/attention', down)
    pg.goto(M + '/')
    banner = pg.locator('[data-testid=wm-identity-down]')
    banner.wait_for(state='visible')
    pg.wait_for_selector('[data-testid=home-decide-down]')
    check('收到 502 identity_unavailable：外壳挂整页提示，说身份服务连不上、会自动重试', '身份服务暂时连不上' in banner.inner_text() and '自动重试' in banner.inner_text(), banner.inner_text())
    check('不跳登录页', pg.url.rstrip('/') == M.rstrip('/'), pg.url)
    check('不清登录态：登录 cookie 还在', any(c['name'] == 'session_id' and c['value'] == cfg['alpha_session'] for c in ctx.cookies()))
    badge = pg.locator('[data-testid=nav-pending]')
    check('侧栏角标写「暂时取不到」，不是数字、也不是没有', badge.count() == 1 and badge.inner_text().strip() == '暂时取不到', badge.count())
    summary = pg.locator('[data-testid=home-summary]').inner_text()
    check('全景总结句说暂时取不到，不说「没有要你拍板的」', '暂时取不到' in summary and '没有要你' not in summary, summary)
    check('「等你拍板」的数写「暂时取不到」，下面不是空态', pg.locator('[data-testid=home-decide-n]').inner_text().strip() == '暂时取不到'
          and '暂时取不到' in pg.locator('[data-testid=home-decide-down]').inner_text() and pg.get_by_text('眼下没有要你拍板的').count() == 0)
    if len(sys.argv) > 2: pg.screenshot(path=sys.argv[2])  # 本机看样子用，CI 不传
    n0 = len(probes)
    pg.wait_for_timeout(3500)
    check(f'页面自己退避重试（3.5 秒里又问了 {len(probes) - n0} 次）', len(probes) > n0, (n0, len(probes)))
    # 放开：下一次重试问到正常应答，提示自己消失，页面重读
    ctx.unroute('**/api/attention', down)
    banner.wait_for(state='hidden', timeout=15000)
    pg.wait_for_function("!document.querySelector('[data-testid=home-decide-down]')")
    pg.wait_for_timeout(600)
    check('连上之后提示自己消失，全景重读（不再写暂时取不到）', banner.count() == 0 and '暂时取不到' not in pg.locator('[data-testid=home-summary]').inner_text()
          and (pg.locator('[data-testid=nav-pending]').count() == 0 or pg.locator('[data-testid=nav-pending]').inner_text().strip() != '暂时取不到'))
    # 「现在重试」：不等计时
    ctx.route('**/api/attention', down)
    pg.reload()
    banner.wait_for(state='visible')
    ctx.unroute('**/api/attention', down)
    banner.get_by_role('button', name='现在重试').click()
    banner.wait_for(state='hidden', timeout=3000)
    check('「现在重试」马上问一次，连上就收起提示', banner.count() == 0)
    # 别的接口回这个代号也挂提示：请求层统一认
    ctx.route('**/api/lifecycle/stages', lambda r: r.fulfill(status=502, content_type='application/json', body=DOWN))
    pg.evaluate("fetch('/api/lifecycle/stages').catch(() => null)")
    banner.wait_for(state='visible')
    check('别的同源 /api/ 接口回 502 identity_unavailable 也挂提示（不必每页各写）', banner.count() == 1)
    ctx.unroute('**/api/lifecycle/stages')
    banner.get_by_role('button', name='现在重试').click()
    banner.wait_for(state='hidden', timeout=3000)
    # 别的 502、401 不进这个状态
    other = lambda r: r.fulfill(status=502, content_type='application/json', body=json.dumps({'error': 'upstream_failed'}))
    ctx.route('**/api/attention', other)
    pg.reload(); pg.wait_for_selector('[data-testid=home-summary]'); pg.wait_for_timeout(1500)
    check('别的 502（error 不是这个代号）不挂提示、角标不写暂时取不到', banner.count() == 0 and pg.locator('[data-testid=home-decide-down]').count() == 0)
    ctx.unroute('**/api/attention', other)
    unauth = lambda r: r.fulfill(status=401, content_type='application/json', body=json.dumps({'error': 'work_items_auth_required'}))
    ctx.route('**/api/attention', unauth)
    pg.reload(); pg.wait_for_selector('[data-testid=home-summary]'); pg.wait_for_timeout(1500)
    check('401 不进这个状态（照旧按没登录处理）', banner.count() == 0 and pg.locator('[data-testid=home-decide-down]').count() == 0)
    ctx.close(); b.close()
print(f'identity-down-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
