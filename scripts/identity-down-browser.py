"""身份服务连不上的浏览器回归；由 scripts/identity-down-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
合成员工 alpha 登录着（cookie）。页面里把 /api/attention 截下来回 502 identity_unavailable：
外壳挂整页提示、侧栏角标和全景「等你拍板」写「暂时取不到」（不是 0、不是空态），不跳登录页、登录 cookie 还在；
页面会自己退避重试；放开之后提示自己消失、页面重读；「现在重试」不等计时。
别的 502（error 不是这个代号）和 401 不进这个状态。别的接口回这个代号也会挂提示（请求层统一认）。"""
import json, sys
from os import environ as os_env
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
DOWN = json.dumps({'error': 'identity_unavailable'})
# 固定等待改成等条件（#954）：等不到不在等待处抛错，照常往下，由后面原来的断言带着当时的值报
def soft(fn):
    try: fn()
    except PWTimeout: pass
def until(pg, pred, timeout=10000):
    """等测试这边记下的状态（截下的请求数）满足 pred：每 20 毫秒看一次，期间照常处理截下的请求；到点就停，不抛错"""
    for _ in range(timeout // 20):
        if pred(): return
        pg.wait_for_timeout(20)
def painted(pg):
    """等页面再画两帧"""
    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
def reload_after_attention(pg):
    """证明「没有」用：重新加载，等这一页 /api/attention 的应答连正文收完、总结句画出来、再画两帧——要挂提示的话这时已经挂了"""
    try:
        with pg.expect_response(lambda r: '/api/attention' in r.url) as ri: pg.reload()
        ri.value.finished()
    except PWTimeout: pass
    pg.wait_for_selector('[data-testid=home-summary]'); painted(pg); painted(pg)
probes = []
def down(route):
    probes.append(1)
    route.fulfill(status=502, content_type='application/json', body=DOWN)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    lc_down = lambda r: r.fulfill(status=502, content_type='application/json', body=DOWN)
    ctx.route('**/api/attention', down)
    ctx.route('**/api/lifecycle/**', lc_down)
    pg.goto(M + '/')
    banner = pg.locator('[data-testid=wm-identity-down]')
    banner.wait_for(state='visible')
    pg.wait_for_selector('[data-testid=home-decide-down]')
    check('收到 502 identity_unavailable：外壳挂整页提示，说身份服务连不上、会自动重试', '身份服务暂时连不上' in banner.inner_text() and '自动重试' in banner.inner_text(), banner.inner_text())
    check('不跳登录页', pg.url.rstrip('/') == M.rstrip('/'), pg.url)
    check('不清登录态：登录 cookie 还在', any(c['name'] == 'session_id' and c['value'] == cfg['alpha_session'] for c in ctx.cookies()))
    badge = pg.locator('[data-testid=nav-pending]')
    bb = badge.bounding_box() if badge.count() else None
    side = pg.locator('[data-testid=wm-side]').bounding_box()
    check('侧栏角标是中性的「—」，悬停说暂时取不到（不是数字、也不是没有）', badge.count() == 1 and badge.get_attribute('data-state') == 'down' and badge.inner_text().strip() == '—'
          and '暂时取不到' in (badge.get_attribute('title') or '') and '暂时取不到' in (badge.get_attribute('aria-label') or ''), badge.count())
    check('角标没顶到侧栏右缘', bb is not None and bb['x'] + bb['width'] <= side['x'] + side['width'] - 8, (bb, side))
    summary = pg.locator('[data-testid=home-summary]').inner_text()
    check('全景总结句只说暂时取不到（原因由横幅说），不说「没有要你拍板的」', summary.strip() == '等你拍板的事暂时取不到。', summary)
    pg.wait_for_selector('[data-testid=home-lines-down]')
    check('全景表也取不到时写暂时取不到，不用「这里会显示…」那个空态', '暂时取不到' in pg.locator('[data-testid=home-lines-down]').inner_text() and pg.get_by_text('这里会显示').count() == 0)
    check('「等你拍板」的数写「暂时取不到」，下面不是空态', pg.locator('[data-testid=home-decide-n]').inner_text().strip() == '暂时取不到'
          and '暂时取不到' in pg.locator('[data-testid=home-decide-down]').inner_text() and pg.get_by_text('眼下没有要你拍板的').count() == 0)
    if len(sys.argv) > 2: pg.screenshot(path=sys.argv[2])  # 本机看样子用，CI 不传
    n0 = len(probes)
    until(pg, lambda: len(probes) > n0, timeout=5000)  # 还是 5 秒为限，问到了就不再干等
    check(f'页面自己退避重试（5 秒里又问了 {len(probes) - n0} 次）', len(probes) > n0, (n0, len(probes)))
    # 放开：下一次重试问到正常应答，提示自己消失，页面重读
    ctx.unroute('**/api/attention', down)
    ctx.unroute('**/api/lifecycle/**', lc_down)
    banner.wait_for(state='hidden', timeout=15000)
    pg.wait_for_function("!document.querySelector('[data-testid=home-decide-down]')")
    soft(lambda: pg.wait_for_function("() => { const s = document.querySelector('[data-testid=home-summary]'); return !!s && !s.innerText.includes('暂时取不到'); }"))
    check('连上之后提示自己消失，全景重读（不再写暂时取不到）', banner.count() == 0 and '暂时取不到' not in pg.locator('[data-testid=home-summary]').inner_text()
          and (pg.locator('[data-testid=nav-pending]').count() == 0 or pg.locator('[data-testid=nav-pending]').inner_text().strip() != '暂时取不到'))
    # 全景表取到了（合成夹具：两条在走的线）、只有等你拍板取不到：表照样画，总结句说几条线在走 + 暂时取不到
    stages = {'types': [{'type': 'demo', 'name': '合成产品', 'panorama_row': True, 'lane': '合成', 'parent_type': None, 'flags': [],
        'stages': [{'code': f'st_demo_0{i}', 'name': n, 'order': i, 'terminal': False, 'lane': '合成'} for i, n in enumerate(['立项', '打样', '上架'], 1)]}]}
    objects = {'ok': True, 'items': [{'id': f'demo:line-{k}', 'type': 'demo', 'name': f'合成产品 {k}', 'stage': 'st_demo_02', 'since': '2026-11-01T09:00:00+08:00', 'days': 11, 'lane': '合成', 'parents': [], 'flags': []} for k in 'AB'], 'next_cursor': None}
    lc_ok = lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(stages if '/stages' in r.request.url else objects))
    ctx.route('**/api/lifecycle/**', lc_ok)
    ctx.route('**/api/attention', down)
    pg.reload(); pg.wait_for_selector('[data-testid=home-row]'); banner.wait_for(state='visible'); pg.wait_for_selector('[data-testid=home-decide-down]')
    summary = pg.locator('[data-testid=home-summary]').inner_text().strip()
    check('全景表取到了、等你拍板取不到：表照样画两条线，总结句说「公司现在有 2 条线在走，等你拍板的事暂时取不到。」', pg.locator('[data-testid=home-row]').count() == 2 and summary == '公司现在有 2 条线在走，等你拍板的事暂时取不到。', summary)
    if len(sys.argv) > 3: pg.screenshot(path=sys.argv[3])
    ctx.unroute('**/api/attention', down)
    ctx.unroute('**/api/lifecycle/**', lc_ok)
    banner.get_by_role('button', name='现在重试').click()
    banner.wait_for(state='hidden', timeout=3000)
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
    reload_after_attention(pg)
    check('别的 502（error 不是这个代号）不挂提示、角标不写暂时取不到', banner.count() == 0 and pg.locator('[data-testid=home-decide-down]').count() == 0)
    ctx.unroute('**/api/attention', other)
    unauth = lambda r: r.fulfill(status=401, content_type='application/json', body=json.dumps({'error': 'work_items_auth_required'}))
    ctx.route('**/api/attention', unauth)
    reload_after_attention(pg)
    check('401 不进这个状态（照旧按没登录处理）', banner.count() == 0 and pg.locator('[data-testid=home-decide-down]').count() == 0)
    ctx.close()
    # 生命周期状态与身份服务分开：两个公开页面共用同一组状态语义。
    ctx = b.new_context()
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(5000)
    stage_payload = {'ok': True, **stages}
    empty_items = {'ok': True, 'items': [], 'next_cursor': None}
    board_data = {'as_of': '2026-11-27T10:00:00Z', 'summary': {'products': 0, 'by_stage': {}, 'sources_stale': 0}, 'products': [], 'sources': []}
    board_payload = {'ok': True, 'data': board_data}
    for status, content, mime, label, wording in [
        (404, {'error': 'not found'}, 'application/json', 'not-installed', '生命周期功能未接入'),
        (503, {'error': 'lc_unavailable', 'detail': 'PRIVATE-CANARY'}, 'application/json', 'unavailable', '登记或依赖尚未就绪'),
        (200, {'ok': False, 'error': 'PRIVATE-CANARY'}, 'application/json', 'unknown', '暂时无法确认生命周期状态'),
        (200, {'ok': True}, 'application/json', 'unknown', '暂时无法确认生命周期状态'),
        (200, '<html>PRIVATE-CANARY</html>', 'text/html', 'unknown', '暂时无法确认生命周期状态'),
        (401, {}, 'application/json', 'login', '请登录后查看'),
        (403, {}, 'application/json', 'forbidden', '当前账号无权查看'),
    ]:
        response = lambda route: route.fulfill(status=status, content_type=mime, body=json.dumps(content) if mime == 'application/json' else content)
        ctx.route('**/api/lifecycle/**', response)
        for path in ['/', '/lifecycle']:
            pg.goto(M + path, wait_until='networkidle')
            state = pg.locator('[data-testid=lifecycle-state]')
            try:
                state.wait_for(timeout=1100)
                check(f'{path} {status} {label}：原因清楚且数量为未知', state.get_attribute('data-state') == label and wording in state.inner_text() and state.locator('[data-testid=lifecycle-kpi]').inner_text() == '—' and 'PRIVATE-CANARY' not in state.inner_text(), state.inner_text())
            except Exception:
                check(f'{path} {status} {label}：出现状态提示', False)
        ctx.unroute('**/api/lifecycle/**', response)
    def available(route):
        url = route.request.url
        payload = stage_payload if '/stages' in url else (board_payload if '/board' in url else empty_items)
        route.fulfill(status=200, content_type='application/json', body=json.dumps(payload))
    ctx.route('**/api/lifecycle/**', available)
    for path in ['/', '/lifecycle']:
        pg.goto(M + path, wait_until='networkidle')
        empty = pg.locator('[data-testid=lifecycle-state][data-state=empty]')
        try:
            empty.wait_for(timeout=1300)
            check(f'{path} 完整成功的空值显示真零', '暂无符合条件的生命周期对象' in empty.inner_text() and empty.locator('[data-testid=lifecycle-kpi]').inner_text() == '0', empty.inner_text())
        except Exception:
            check(f'{path} 完整成功的空值显示真零', False)
    ctx.unroute('**/api/lifecycle/**', available)

    def partial_page(route):
        url = route.request.url
        if '/stages' in url:
            route.fulfill(status=200, json=stage_payload)
        elif 'cursor=' in url:
            route.abort('timedout')
        else:
            route.fulfill(status=200, json={**objects, 'next_cursor': 'page-2'})
    ctx.route('**/api/lifecycle/**', partial_page)
    pg.goto(M + '/')
    first_failure = pg.locator('[data-testid=lifecycle-state][data-state=unknown]')
    first_failure.wait_for()
    check('首页第二页超时后无部分行或零', first_failure.locator('[data-testid=lifecycle-kpi]').inner_text() == '—' and not pg.locator('[data-testid=home-row]').count())
    ctx.unroute('**/api/lifecycle/**', partial_page)

    board_calls = []
    def retry_board(route):
        board_calls.append(route.request.method)
        if len(board_calls) == 1:
            route.fulfill(status=503, headers={'Retry-After': '2', 'X-Request-Id': 'trace-1088'}, json={'error': 'NOT_REGISTERED', 'detail': 'PRIVATE-CANARY'})
        else:
            route.fulfill(status=200, json=board_payload)
    ctx.route('**/api/lifecycle/board?*', retry_board)
    pg.goto(M + '/lifecycle?pd=sample')
    state = pg.locator('[data-testid=lifecycle-state][data-state=unavailable]')
    state.wait_for()
    check('503 保留请求编号并遵守 Retry-After', 'trace-1088' in state.inner_text() and state.get_by_role('button', name='暂不能重试').is_disabled())
    state.get_by_role('button', name='重试', exact=True).click(timeout=4000)
    empty = pg.locator('[data-testid=lifecycle-state][data-state=empty]')
    empty.wait_for()
    check('重试只发一次只读 GET，真零带筛选条件', board_calls == ['GET', 'GET'] and 'sample' in empty.inner_text() and empty.locator('[data-testid=lifecycle-kpi]').inner_text() == '0')
    ctx.unroute('**/api/lifecycle/board?*', retry_board)

    board_ok = {'ok': True, 'data': {**board_data, 'summary': {'products': 1, 'by_stage': {'打样': 1}, 'sources_stale': 0}, 'products': [{'pd': '合成对象'}]}}
    stale_board = {'ok': True, 'data': {**board_data, 'summary': {'products': 0, 'by_stage': {}, 'sources_stale': 1}}}
    board_reads = []
    def changing_board(route):
        board_reads.append(1)
        route.fulfill(status=200, json=board_ok if len(board_reads) == 1 else stale_board)
    ctx.route('**/api/lifecycle/board', changing_board)
    pg.goto(M + '/lifecycle')
    if os_env.get('WM_TEST_LIFECYCLE_EXTENSION') == '1':
        pg.get_by_text('合成生命周期扩展').wait_for()
        check('完整响应交回已注册的扩展路由', pg.get_by_text('合成生命周期扩展').count() == 1 and not pg.locator('[data-testid=lifecycle-state]').count())
        pg.reload(wait_until='networkidle')
        stale = pg.locator('[data-testid=lifecycle-state][data-state=stale]')
        stale.wait_for()
        check('扩展已登记但响应过期时由公开层显示状态', not pg.get_by_text('合成生命周期扩展').count() and stale.locator('[data-testid=lifecycle-kpi]').inner_text() == '—')
    else:
        pg.get_by_role('button', name='刷新全景').click()
        stale = pg.locator('[data-testid=lifecycle-state][data-state=stale]')
        stale.wait_for()
        check('全景数据过期保留上次成功数量和时点，当期显示未知', stale.locator('[data-testid=lifecycle-kpi]').inner_text() == '—' and '上次成功数量：1' in stale.inner_text() and '2026-11-27T10:00:00' in stale.inner_text(), stale.inner_text())
    ctx.unroute('**/api/lifecycle/board', changing_board)
    ctx.close()
    # 真服务端（#639）：合成身份来源在数据目录里有 fake-identity-down 时不回答——服务端自己回 502 identity_unavailable，不是页面里截的
    import os
    marker = os.path.join(cfg['data_dir'], 'fake-identity-down')
    open(marker, 'w').close()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['flaky_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(20000)
    real = []
    pg.on('response', lambda r: real.append(r.status) if '/api/attention' in r.url else None)
    pg.goto(M + '/')
    banner = pg.locator('[data-testid=wm-identity-down]')
    banner.wait_for(state='visible')
    check(f'真服务端：来源不可达时回 502（{sorted(set(real))}），外壳挂提示，不跳登录页', 502 in real and pg.url.rstrip('/') == M.rstrip('/'), real)
    check('真服务端：角标是中性的「—」', pg.locator('[data-testid=nav-pending]').get_attribute('data-state') == 'down')
    os.remove(marker)
    banner.wait_for(state='hidden', timeout=30000)
    check('真服务端：来源恢复后，页面自己重试连上、提示消失（不用刷新）', banner.count() == 0)
    ctx.close(); b.close()
print(f'identity-down-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
