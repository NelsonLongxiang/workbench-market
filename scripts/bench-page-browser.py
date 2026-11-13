"""视图台页面（/use/<卡片 id>）浏览器回归；由 scripts/bench-page-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
实例里有一张真的卡片（没有台库）。是视图台的那一种：入口、取数、交表单用 page.route 截下、换成合成的应答，并记下页面发了什么。
  一、视图台：进数据视图页，台名、视图标题、两个视图页签；台标识、视图键不写在页面的字上；
  二、换视图、改筛选：地址跟着变（?v=、p.<字段>），按新的视图和筛选取数；拿这个地址重开，看到的是同一份；
  三、交表单：请求带视图、第几块、版本、填的值；交上去之后整页重新取数；版本变了、不让交，各说一句；
  四、取数没成：看不到、数据视图没开、只有一份视图（不出页签）；
  五、入口：没有台的卡片照原来嵌页面、不存在的卡片照原来说不存在（都走实例里真的入口）；入口 403、读不到（再试一次）。"""
import json, os, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, CARD = cfg['base'], cfg['card']
SHOT = os.environ.get('BENCH_PAGE_SHOT')
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

SLUG = 'synth-bench-slug'
ENTRY = {'bench': {'slug': SLUG, 'title': '合成·巡检台', 'workbench_id': 4242}, 'version': 5, 'title': '合成巡检总览', 'default_view': 'vk-board',
         'views': [{'key': 'vk-board', 'title': '巡检看板'}, {'key': 'vk-rows', 'title': '巡检明细'}]}
SITE = {'name': 'site', 'kind': 'search', 'label': '区域'}
FORM = {'type': 'form', 'title': '登记一次巡检', 'span': 6, 'columns': [{'name': 'site', 'type': 'text', 'label': '区域', 'required': True}, {'name': 'n', 'type': 'integer', 'label': '件数'}], 'submit_label': '登记'}
def view_result(view, params):
    vt = next(v['title'] for v in ENTRY['views'] if v['key'] == view)
    n = 63 if not params.get('site') else 7
    rows = [{'site': '东区', 'n': 21, 'state': '正常'}, {'site': '西区', 'n': 42, 'state': '待查'}] if not params.get('site') else [{'site': params['site'], 'n': 7, 'state': '正常'}]
    blocks = [{'type': 'filter-bar', 'fields': [SITE], 'span': 12},
              {'type': 'stat', 'title': '本月巡检', 'unit': '次', 'value': 'v', 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': n}]}},
              {'type': 'progress', 'title': '完成度', 'value': 'v', 'total': 80, 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': n}]}}]
    if view == 'vk-board':
        blocks += [{'type': 'bar', 'title': '各区巡检次数', 'x': 'site', 'y': 'n', 'span': 6, 'data': {'columns': [{'name': 'site', 'type': 'text'}, {'name': 'n', 'type': 'integer'}], 'rows': rows}},
                   {'type': 'table', 'title': '巡检记录', 'span': 6, 'data': {'columns': [{'name': 'site', 'type': 'text', 'label': '区域'}, {'name': 'n', 'type': 'integer', 'label': '次数'}, {'name': 'state', 'type': 'text'}], 'rows': rows}}, FORM]
    else:
        blocks += [{'type': 'table', 'title': '明细', 'span': 12, 'data': {'columns': [{'name': 'site', 'type': 'text'}, {'name': 'n', 'type': 'integer'}], 'rows': rows}}]
    return {'title': ENTRY['title'], 'version': 5, 'view': {'key': view, 'title': vt}, 'params': params, 'blocks': blocks}

log = {'entry': 0, 'render': [], 'form': []}
mode = {'entry': 'ok', 'render': 'ok', 'form': 'ok'}
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_bv(route):
    u = urlparse(route.request.url); parts = u.path.split('/')
    if parts[3] != str(CARD): return route.continue_()  # 别的卡片走实例里真的入口
    rest = '/'.join(parts[4:])
    if rest == 'entry':
        log['entry'] += 1
        if mode['entry'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        if mode['entry'] == '500': return fake(route, {'error': 'internal'}, 500)
        if mode['entry'] == 'one': return fake(route, {**ENTRY, 'views': ENTRY['views'][:1]})
        return fake(route, ENTRY)
    if rest == 'render':
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        params = {k[2:]: v for k, v in q.items() if k.startswith('p.')}
        log['render'].append((q.get('view'), params))
        if mode['render'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        if mode['render'] == 'off': return fake(route, {'error': 'bench_views_off'}, 404)
        return fake(route, view_result(q.get('view') or 'vk-board', params))
    if rest == 'form':
        log['form'].append(json.loads(route.request.post_data or '{}'))
        if mode['form'] == '409': return fake(route, {'error': 'conflict', 'message': '版本变了'}, 409)
        if mode['form'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        return fake(route, {'ok': True})
    return fake(route, {'error': 'not_found'}, 404)

def q_of(pg): return {k: v[0] for k, v in parse_qs(urlparse(pg.url).query).items()}
def body_text(pg): return pg.locator('body').inner_text()

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route('**/api/bench-views/**', on_bv)

    print('一、视图台')
    pg.goto(f'{M}/use/{CARD}')
    pg.wait_for_selector('[data-testid=bench-page] [data-bb=stat][data-bb-state=ready]')
    pg.wait_for_selector('[data-bb=bar][data-bb-state=ready]'); pg.wait_for_timeout(600)
    if SHOT: pg.screenshot(path=SHOT)
    tabs = [t.inner_text() for t in pg.locator('[data-testid=bench-page-tab]').all()]
    check('进的是数据视图页：顶栏台名「合成·巡检台」，标题「合成巡检总览」', pg.locator('[data-testid=bench-page-name]').inner_text() == '合成·巡检台' and pg.locator('[data-testid=bench-page-title]').inner_text() == '合成巡检总览')
    check('两个视图页签，按入口的次序；默认那一份选中', tabs == ['巡检看板', '巡检明细'] and pg.locator('[data-testid=bench-page-tab][aria-selected=true]').inner_text() == '巡检看板', tabs)
    check('第一次取数取的是默认那一份，没带筛选', log['render'][:1] == [('vk-board', {})], log['render'])
    check('块都在：筛选栏、统计、进度、柱图、表格、表单，带外框', all(pg.locator(f'[data-bb={k}][data-bb-frame=card]').count() == 1 for k in ('filter-bar', 'stat', 'progress', 'bar', 'table', 'form')))
    t = body_text(pg)
    check('台标识、视图键、卡片背后的编号不写在页面的字上', SLUG not in t and 'vk-' not in t and '4242' not in t)
    check('浏览器标签页标题：视图标题 · 台名', pg.title() == '合成巡检总览 · 合成·巡检台', pg.title())
    check('「详情」去这张卡片的详情页', pg.locator('[data-testid=bench-page-detail]').get_attribute('href') == f'/market/wb/{CARD}')
    check('没有嵌页面的框', pg.locator('iframe').count() == 0)
    heads = [h.inner_text().strip() for h in pg.locator('[data-bb=table] th').all()]
    check('表头：有列标题用列标题，没有才退回列名', heads[:3] == ['区域', '次数', 'state'], heads)
    hs = pg.evaluate("() => ['stat','progress','bar'].map(k => document.querySelector(`[data-bb=${k}]`).getBoundingClientRect().height)")
    check('统计卡、进度按内容的高度，不跟同一行的柱图撑高', hs[0] < hs[2] * 0.6 and hs[1] < hs[2] * 0.6, hs)

    print('二、换视图、改筛选')
    n0 = len(log['render'])
    pg.locator('[data-testid=bench-page-tab]', has_text='巡检明细').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-tab][aria-selected=true]')?.textContent === '巡检明细'")
    pg.wait_for_selector('[data-bb=table] >> text=明细')
    check('换到「巡检明细」：地址带 v，按它取数', q_of(pg).get('v') == 'vk-rows' and log['render'][n0:][-1:] == [('vk-rows', {})], (pg.url, log['render'][n0:]))
    inp = pg.locator('[data-filter=site] input')
    inp.fill('北区'); inp.press('Enter')
    pg.wait_for_function("() => new URLSearchParams(location.search).get('p.site') === '北区'")
    pg.wait_for_selector('[data-bb=stat] >> text=7')
    check('改筛选：地址带 p.site，按新的值取数', log['render'][-1] == ('vk-rows', {'site': '北区'}), log['render'][-3:])
    url = pg.url
    pg2 = ctx.new_page(); pg2.route('**/api/bench-views/**', on_bv)
    n1 = len(log['render'])
    pg2.goto(url); pg2.wait_for_selector('[data-bb=stat][data-bb-state=ready] >> text=7')
    check('拿这个地址重开：同一份视图、同一个筛选', log['render'][n1:][:1] == [('vk-rows', {'site': '北区'})] and pg2.locator('[data-testid=bench-page-tab][aria-selected=true]').inner_text() == '巡检明细' and pg2.locator('[data-filter=site] input').input_value() == '北区', log['render'][n1:])
    pg2.close()
    pg.go_back(); pg.wait_for_function("() => !new URLSearchParams(location.search).has('p.site')")
    pg.go_back(); pg.wait_for_function("() => !new URLSearchParams(location.search).has('v')")
    pg.wait_for_selector('[data-bb=form]')
    check('后退两次回到默认那一份（换视图、改筛选各记一步）', pg.locator('[data-testid=bench-page-tab][aria-selected=true]').inner_text() == '巡检看板')

    print('三、交表单')
    form = pg.locator('[data-bb=form]')
    form.locator('textarea').fill('南区'); form.locator('input').first.fill('3')
    n2 = len(log['render'])
    form.locator('button[type=submit]').click()
    form.locator('.ant-alert-success').wait_for()
    pg.wait_for_function(f"() => true"); pg.wait_for_timeout(500)
    check('请求带视图、第几块（从 0 数）、版本、填的值', log['form'][-1:] == [{'view': 'vk-board', 'block': 5, 'version': 5, 'values': {'site': '南区', 'n': 3}}], log['form'])
    check('交上去了：说「已经交上去了」，整页按现在的视图重新取了一次', '已经交上去了' in form.inner_text() and len(log['render']) > n2 and log['render'][-1] == ('vk-board', {}), log['render'][n2:])
    mode['form'] = '409'
    form.locator('textarea').fill('南区'); form.locator('button[type=submit]').click()
    form.locator('.ant-alert-warning').wait_for()
    check('版本变了（409）：说页面过期了', '这个页面过期了' in form.inner_text(), form.inner_text())
    mode['form'] = '403'
    form.locator('textarea').fill('南区'); form.locator('button[type=submit]').click()
    pg.wait_for_function("() => document.querySelector('[data-bb=form] .ant-alert-warning')?.textContent.includes('不能在这个台上填表')")
    check('不让交（403）：说这个账号不能在这个台上填表，不露代号', 'bench_views' not in form.inner_text())
    mode['form'] = 'ok'

    print('四、取数没成')
    mode['render'] = '403'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-error]')
    check('看不到：说「你看不到这个台的数据」，带「再试一次」', '你看不到这个台的数据' in pg.locator('[data-testid=bench-page-error]').inner_text() and pg.get_by_role('button', name='再试一次').count() == 1)
    mode['render'] = 'ok'; pg.get_by_role('button', name='再试一次').click(); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    check('「再试一次」之后画出来了', pg.locator('[data-testid=bench-page-error]').count() == 0)
    mode['render'] = 'off'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-off]')
    check('数据视图没开：中性的一句「数据视图未开启」，不用警示色', '数据视图未开启' in pg.locator('[data-testid=bench-page-off]').inner_text() and pg.locator('.ant-result-warning').count() == 0)
    mode['render'] = 'ok'; mode['entry'] = 'one'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    check('只有一份视图：不出页签', pg.locator('[data-testid=bench-page-tab]').count() == 0)

    print('五、入口')
    mode['entry'] = '403'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=use-entry-forbidden]')
    check('入口 403（只带管理口令、跨站）：说要用自己的账号，不取数', '要用你自己的账号' in body_text(pg) and pg.locator('[data-testid=bench-page]').count() == 0)
    mode['entry'] = '500'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=use-entry-error]')
    check('入口读不到：说读不到，带「再试一次」', '读不到这个台' in body_text(pg))
    mode['entry'] = 'ok'; pg.get_by_role('button', name='再试一次').click(); pg.wait_for_selector('[data-testid=bench-page]')
    check('「再试一次」之后进了视图台页面', True)
    pg.unroute('**/api/bench-views/**')
    seen = []
    pg.on('response', lambda r: seen.append((urlparse(r.url).path, r.status)) if '/entry' in r.url else None)
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('.wm-use-frame')
    check('没有台的卡片：实例里真的入口回 404，照原来嵌页面（顶栏是卡片名）', (f'/api/bench-views/{CARD}/entry', 404) in seen and '合成·嵌页台' in pg.locator('.wm-use-bar').inner_text() and pg.locator('[data-testid=bench-page]').count() == 0, seen)
    pg.goto(f'{M}/use/99999'); pg.wait_for_selector('text=工作台不存在')
    check('不存在的卡片：入口一样回 404，照原来说「工作台不存在」', ('/api/bench-views/99999/entry', 404) in seen, seen)
    b.close()
print(f'\nbench-page-browser: {ok} 过 / {fail} 败'); sys.exit(1 if fail else 0)
