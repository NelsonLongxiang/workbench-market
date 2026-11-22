"""身份变了以后页面重读；由 scripts/session-browser.mjs 起合成实例、造好数据后调用，参数为配置 JSON 路径。
alpha 建的两件事项（标题在 cfg['titles']）只有 alpha（和管理员）看得到。每组都看：标题在页面的 DOM 里还在不在。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']; T = cfg['titles']; WID = cfg['items'][0]
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def skip(n, why): print('  - SKIP', n, why)
def shows(pg): return [t for t in T if t in pg.content()]
ME_OUT = json.dumps({'authenticated': False})
DOWN = json.dumps({'error': 'identity_unavailable'})

def open_as(b, session, path):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + path); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(600)
    return ctx, pg
def to_beta(ctx):
    ctx.clear_cookies(); ctx.add_cookies([{'name': 'session_id', 'value': cfg['beta_session'], 'url': M}])
def gone(pg, timeout=6000):
    try: pg.wait_for_function('(ts) => ts.every((t) => !document.documentElement.innerHTML.includes(t))', arg=T, timeout=timeout); return True
    except Exception: return False

with sync_playwright() as p:
    b = p.chromium.launch()
    # 一、接口回 401、问一下确认真的没登录了 → 清（事项列表：点「刷新」触发；事项详情：窗口回到前台触发）
    for path, how in (('/work-items', 'refresh'), (f'/work-items/{WID}', 'focus')):
        ctx, pg = open_as(b, cfg['alpha_session'], path)
        before = shows(pg)
        ctx.route('**/api/**', lambda r: r.fulfill(status=200, content_type='application/json', body=ME_OUT) if '/api/auth/me' in r.request.url else r.fulfill(status=401, content_type='application/json', body='{"error":"work_items_auth_required"}'))
        if how == 'refresh': pg.get_by_role('button', name='刷新').first.click()
        else: pg.evaluate("window.dispatchEvent(new Event('focus'))")
        check(f'{path}：会话没了（401 且确认没登录）→ alpha 的事项从页面上清掉（之前 {len(before)} 件）', len(before) >= 1 and gone(pg), shows(pg))
        ctx.unroute('**/api/**'); ctx.close()
    # 光是 401、问下来还是同一个人 → 不清（有些接口对登录着的人也回 401）
    ctx, pg = open_as(b, cfg['alpha_session'], '/work-items')
    ctx.route('**/api/work-items*', lambda r: r.fulfill(status=401, content_type='application/json', body='{"error":"some_token_required"}'))
    pg.get_by_role('button', name='刷新').first.click(); pg.wait_for_timeout(2000)
    check('只有 401、/api/auth/me 说还是同一个人 → 不清', len(shows(pg)) >= 1, shows(pg))
    ctx.close()
    # 二、换了人（会话换成 beta，窗口回到前台）→ 清、按 beta 重读；左下角的人名跟着变
    for path in ('/work-items', f'/work-items/{WID}', '/'):
        ctx, pg = open_as(b, cfg['alpha_session'], path)
        before = shows(pg); name0 = pg.locator('.wm-me-name').inner_text().strip()
        to_beta(ctx); pg.evaluate("window.dispatchEvent(new Event('focus'))")
        cleared = gone(pg)
        pg.wait_for_timeout(1500)
        name1 = pg.locator('.wm-me-name').inner_text().strip()
        check(f'{path}：换成 beta → alpha 的事项不在页面上（之前 {len(before)} 件）', cleared, shows(pg))
        check(f'{path}：左下角的人跟着变（{name0} → {name1}）', name0 != name1 and 'beta' in name1.lower(), (name0, name1))
        ctx.close()
    # 三、身份服务连不上（502 identity_unavailable）→ 不清、挂横幅
    ctx, pg = open_as(b, cfg['alpha_session'], '/work-items')
    ctx.route('**/api/**', lambda r: r.fulfill(status=502, content_type='application/json', body=DOWN))
    pg.evaluate("window.dispatchEvent(new Event('focus'))"); pg.get_by_role('button', name='刷新').first.click()
    pg.wait_for_selector('[data-testid=wm-identity-down]'); pg.wait_for_timeout(1500)
    check('身份服务连不上（502）→ 不清：alpha 的事项还在，外壳挂着连不上的横幅', len(shows(pg)) == len(T) and pg.locator('[data-testid=wm-identity-down]').count() == 1, shows(pg))
    ctx.close()
    # 四、竞态：旧身份发出去、还在路上的请求，换人之后才回来 → 不写回页面
    ctx, pg = open_as(b, cfg['alpha_session'], '/work-items')
    held = []
    ctx.route('**/api/work-items*', lambda r: held.append(r))
    pg.get_by_role('button', name='刷新').first.click(); pg.wait_for_timeout(500)
    to_beta(ctx); pg.evaluate("window.dispatchEvent(new Event('focus'))"); pg.wait_for_timeout(1500)
    old = held[0] if held else None
    # 先放回旧身份那一个（带着 alpha 的事项），再放换人之后新页面发出的；最后才撤掉拦截
    if old: old.fulfill(status=200, content_type='application/json', body=json.dumps({'items': [{'id': WID, 'title': T[0], 'state': 'held', 'object': '', 'phase': '', 'seat': '', 'last_progress': None, 'updated_at': '2026-11-12T00:00:00Z'}], 'counts': {}, 'total': 1, 'next_cursor': None}))
    for r in held[1:]: r.continue_()
    pg.wait_for_timeout(500)
    ctx.unroute('**/api/work-items*')
    pg.wait_for_timeout(2500)
    check('换人之前发出、换人之后才回来的那个应答（alpha 的事项）不写回页面', old is not None and T[0] not in pg.content(), (len(held), shows(pg)))
    ctx.close()
    # 五、从浏览器缓存恢复的页面（后退）也确认一次
    ctx, pg = open_as(b, cfg['alpha_session'], '/work-items')
    pg.add_init_script("window.addEventListener('pageshow', (e) => { window.__wmPersisted = e.persisted; })")
    pg.evaluate("window.addEventListener('pageshow', (e) => { window.__wmPersisted = e.persisted; })")
    pg.goto(M + '/api/health'); to_beta(ctx); pg.go_back(); pg.wait_for_timeout(800)
    persisted = pg.evaluate('window.__wmPersisted === true')
    if not persisted: skip('从浏览器缓存恢复的页面（后退）', '这次没命中浏览器缓存（无头 Chromium 常不进 bfcache），页面是重新加载的')
    else: check('从浏览器缓存恢复的页面（后退）：换了人 → alpha 的事项不在页面上', gone(pg), shows(pg))
    check('后退回来（不管命不命中缓存）：页面上没有 alpha 的事项', gone(pg), shows(pg))
    ctx.close()
    # 六、启动时第一问没问成（/api/auth/me 回 502）→ 换成 beta → 身份服务恢复 → alpha 的事项被清掉（首问失败后第一次问成按「变了」算）
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    ctx.route('**/api/auth/me', lambda r: r.fulfill(status=502, content_type='application/json', body=DOWN))
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + '/work-items'); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(800)
    before = shows(pg)
    to_beta(ctx); ctx.unroute('**/api/auth/me')
    pg.evaluate("window.dispatchEvent(new Event('focus'))")
    check(f'首问失败（502）→ 换成 beta → 恢复：alpha 的事项被清掉（之前 {len(before)} 件）', len(before) >= 1 and gone(pg), shows(pg))
    ctx.close()
    # 七、确定的「从浏览器缓存恢复」：页面里发一个合成的 pageshow（persisted=true），会话已经换成 beta → 清
    ctx, pg = open_as(b, cfg['alpha_session'], '/work-items')
    before = shows(pg); to_beta(ctx)
    pg.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))")
    check(f'合成的 pageshow（persisted=true）+ 换成 beta → alpha 的事项被清掉（之前 {len(before)} 件）', len(before) >= 1 and gone(pg), shows(pg))
    ctx.close()
    # 八、其余各页：alpha 打开 → 换成 beta、回到前台 → 页面上没有 alpha 的内容；没有 alpha 专属内容的页，断言这一页的读请求按 beta 的会话重发了一次
    def reread(path, api_pat, label, tab=None):
        ctx, pg = open_as(b, cfg['alpha_session'], path)
        if tab: pg.locator(f'[data-testid={tab}]').click(); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(600)
        seen = []
        pg.on('request', lambda r: seen.append((r.url.split(M)[-1], r.all_headers().get('cookie', ''))) if r.url.startswith(M + '/api/') else None)
        before = shows(pg)
        to_beta(ctx); pg.evaluate("window.dispatchEvent(new Event('focus'))")
        cleared = gone(pg); pg.wait_for_timeout(1500)
        again = [u for u, c in seen if api_pat in u and cfg['beta_session'] in c]
        need_before = tab is not None
        check(f'{label}：换成 beta → 没有 alpha 的内容（之前 {len(before)} 件），{api_pat} 按 beta 的会话重读了', cleared and len(again) >= 1 and (len(before) >= 1 or not need_before), (shows(pg), [u for u, _ in seen][:8]))
        ctx.close()
    reread(f"/cockpit/{cfg['cockpit']}", '/api/attention', '驾驶舱（右栏「事项」里 alpha 的事项、左栏「等你拍板」）', tab='ck-tab-items-items')
    reread(f"/cockpit/{cfg['cockpit']}", '/api/bench-views/', '驾驶舱里的数据视图面板')
    # 团队页：页面上要有只属于 alpha 的东西，「换人后没有 alpha 的内容」才不是空过（阶段四要求）。
    # 截下 /api/teams，按请求带的会话给不同的应答：alpha 有一个合成部门，beta 什么都没有
    ALPHA_DEPT = '合成：只给 alpha 看的部门'
    def teams_by_session(route):
        mine = cfg['alpha_session'] in (route.request.headers.get('cookie') or '')
        body = {'departments': [{'id': 'syn-alpha-dept', 'name': ALPHA_DEPT, 'lead': {'principal': 'user:alpha', 'display_name': 'Synthetic alpha'}, 'teams': []}] if mine else [], 'unclaimed': []}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    ctx.route(re.compile(r'/api/teams(\?|$)'), teams_by_session)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + '/team'); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(600)
    had = ALPHA_DEPT in pg.content()
    to_beta(ctx); pg.evaluate("window.dispatchEvent(new Event('focus'))")
    try: pg.wait_for_function('(t) => !document.documentElement.innerHTML.includes(t)', arg=ALPHA_DEPT, timeout=6000); cleared = True
    except Exception: cleared = False
    check('团队页：alpha 看得到只属于他的部门 → 换成 beta → 这个部门不在页面上了', had and cleared, (had, cleared))
    ctx.close()
    reread('/access', '/api/grants', '谁能做什么')
    reread('/attention', '/api/attention', '「等你拍板」完整列表（/attention，#656 按新外壳重写的那一版）')
    b.close()
print(f'session-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
