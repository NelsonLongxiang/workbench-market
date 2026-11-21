"""视图台页面（/use/<卡片 id>）浏览器回归；由 scripts/bench-page-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
实例里有一张真的卡片（没有台库）。是视图台的那一种：入口、取数、交表单用 page.route 截下、换成合成的应答，并记下页面发了什么。
  一、视图台：进数据视图页，台名、视图标题、两个视图页签；台标识、视图键不写在页面的字上；
  二、换视图、改筛选：地址跟着变（?v=、p.<字段>），按新的视图和筛选取数；拿这个地址重开，看到的是同一份；
      「巡检明细」那份的三张卡没写宽度：平分一整行，最右一张的右边缘和下面整行的表格对齐（统筹 11-13）；
  三、交表单：请求带视图、第几块、版本、填的值；交上去之后整页重新取数；版本变了、不让交，各说一句；
  四、取数没成：看不到、数据视图没开、只有一份视图（不出页签）；
  五、入口：没有台的卡片照原来嵌页面、不存在的卡片照原来说不存在（都走实例里真的入口）；入口 403、读不到（再试一次）。"""
import json, os, re, sys
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
# #761 页内刷新：席位改了视图描述之后的两个新入口形态——改总标题、加一份视图；把当前那份删掉
ENTRY2 = {**ENTRY, 'version': 6, 'title': '合成巡检总览·二',
          'views': [{'key': 'vk-board', 'title': '巡检看板'}, {'key': 'vk-rows', 'title': '巡检明细'}, {'key': 'vk-extra', 'title': '新加的视角'}]}
ENTRY3 = {**ENTRY, 'version': 7, 'title': '合成巡检总览·三', 'views': [ENTRY['views'][0]]}
SITE = {'name': 'site', 'kind': 'search', 'label': '区域'}
OWNER = {'name': 'owner', 'kind': 'search', 'label': '负责人'}
FORM = {'type': 'form', 'title': '登记一次巡检', 'span': 6, 'columns': [{'name': 'site', 'type': 'text', 'label': '区域', 'required': True}, {'name': 'n', 'type': 'integer', 'label': '件数'}], 'submit_label': '登记'}
XSS = '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">'
RECORDS = {'type': 'records', 'title': '下一动作', 'title_col': 't', 'badges': ['st'], 'fields': ['who', 'purpose'], 'details': ['note'], 'date_col': 'day',
           'links': [{'col': 'url', 'label': '查看依据'}, {'col': 'url2', 'label': '打开资料'}], 'value_labels': {'st': {'open': {'text': '进行中', 'tone': 'warning'}}}, 'page_size': 5, 'span': 12,
           'data': {'columns': [{'name': 't', 'type': 'text', 'label': '动作'}, {'name': 'st', 'type': 'text', 'label': '状态'}, {'name': 'who', 'type': 'text', 'label': '负责人'}, {'name': 'purpose', 'type': 'text', 'label': '目的'},
                                {'name': 'note', 'type': 'text', 'label': '说明'}, {'name': 'day', 'type': 'date', 'label': '约定时间'}, {'name': 'url', 'type': 'text', 'label': '来源'}, {'name': 'url2', 'type': 'text', 'label': '资料'}],
                    'rows': [{'t': XSS, 'st': 'open', 'who': None, 'purpose': '长' * 200, 'note': XSS, 'day': None, 'url': 'https://ok.example/doc', 'url2': 'javascript:alert(1)'}]
                            + [{'t': f'合成动作{i}', 'st': 'weird', 'who': '合成乙', 'purpose': '短', 'note': '短', 'day': '2026-11-21', 'url': None, 'url2': None} for i in range(2, 8)], 'truncated': False},
           'link_targets': [[{'href': 'https://ok.example/doc', 'host': 'ok.example'}, None]] + [[None, None] for _ in range(2, 8)]}
def view_result(view, params):
    if mode.get('records') in ('on', 'truncated'):
        block = RECORDS if mode['records'] == 'on' else {**RECORDS, 'data': {**RECORDS['data'], 'truncated': True}}
        return {'title': ENTRY['title'], 'version': 5, 'view': {'key': view, 'title': '巡检看板'}, 'params': params, 'blocks': [block]}
    vt = next(v['title'] for v in ENTRY['views'] if v['key'] == view)
    n = 63 if not params.get('site') else 7
    rows = [{'site': '东区', 'n': 21, 'state': '正常'}, {'site': '西区', 'n': 42, 'state': '待查'}] if not params.get('site') else [{'site': params['site'], 'n': 7, 'state': '正常'}]
    blocks = [{'type': 'filter-bar', 'fields': [SITE, OWNER] if mode['filters'] == 'two' else [SITE], 'span': 12},
              {'type': 'stat', 'title': '本月巡检', 'unit': '次', 'value': 'v', 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': n}]}},
              {'type': 'progress', 'title': '完成度', 'value': 'v', 'total': 80, 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': n}]}}]
    if view == 'vk-board':
        blocks += [{'type': 'bar', 'title': '各区巡检次数', 'x': 'site', 'y': 'n', 'span': 6, 'data': {'columns': [{'name': 'site', 'type': 'text'}, {'name': 'n', 'type': 'integer'}], 'rows': rows}},
                   {'type': 'table', 'title': '巡检记录', 'span': 6, 'data': {'columns': [{'name': 'site', 'type': 'text', 'label': '区域'}, {'name': 'n', 'type': 'integer', 'label': '次数'}, {'name': 'state', 'type': 'text', 'label': ''}], 'rows': rows}}, {**FORM, 'can_submit': True},
                   {**FORM, 'title': '改巡检计划', 'can_submit': False, 'span': 12}]
    else:
        # 这份视图的卡都不写宽度：统计、进度，再加一张进度，三张平分一整行
        for blk in blocks[1:]: blk.pop('span', None)
        blocks += [{'type': 'progress', 'title': '本周完成度', 'value': 'v', 'total': 20, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': 5}]}}]
        blocks += [{'type': 'table', 'title': '明细', 'span': 12, 'data': {'columns': [{'name': 'site', 'type': 'text'}, {'name': 'n', 'type': 'integer'}], 'rows': rows}}]
    return {'title': ENTRY['title'], 'version': 5, 'view': {'key': view, 'title': vt}, 'params': params, 'blocks': blocks}

log = {'entry': 0, 'render': [], 'form': [], 'title': []}
mode = {'entry': 'ok', 'render': 'ok', 'form': 'ok', 'title': 'ok', 'filters': 'one'}
held = []  # 压住不回的取数（render 应答由测试自己放行）
held_entry = []  # 压住不回的入口应答
# 改台名（#905）：管理层的入口带 can.rename；台名改了以后入口照新名字回
# 卡片名（#927）：能改名的人的入口里带 card_title（卡片现在的名字），「跟卡片同名」照它出不出
mgr = {'title': ENTRY['bench']['title'], 'card': ENTRY['bench']['title']}
def mgr_entry(): return {**ENTRY, 'bench': {**ENTRY['bench'], 'title': mgr['title'], 'card_title': mgr['card']}, 'can': {'rename': True}}
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_bv(route):
    u = urlparse(route.request.url); parts = u.path.split('/')
    if parts[3] != str(CARD): return route.continue_()  # 别的卡片走实例里真的入口
    rest = '/'.join(parts[4:])
    if rest == 'entry':
        log['entry'] += 1
        if mode['entry'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        if mode['entry'] == '500': return fake(route, {'error': 'internal'}, 500)
        if mode['entry'] == '401': return fake(route, {'error': 'auth_required'}, 401)
        if mode['entry'] == 'one': return fake(route, {**ENTRY, 'views': ENTRY['views'][:1]})
        if mode['entry'] == 'v2': return fake(route, ENTRY2)
        if mode['entry'] == 'v3': return fake(route, ENTRY3)
        if mode['entry'] == 'mgr': return fake(route, mgr_entry())
        if mode['entry'] == 'hold': held_entry.append((route, mgr_entry())); return None  # 应答照发出那一刻的名字，由测试晚些放行
        return fake(route, ENTRY)
    if rest == 'render':
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        params = {k[2:]: v for k, v in q.items() if k.startswith('p.')}
        log['render'].append((q.get('view'), params))
        if mode['render'] == 'hold': held.append((route, q.get('view') or 'vk-board', params)); return None
        if mode['render'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        if mode['render'] == 'off': return fake(route, {'error': 'bench_views_off'}, 404)
        return fake(route, view_result(q.get('view') or 'vk-board', params))
    if rest == 'form':
        log['form'].append(json.loads(route.request.post_data or '{}'))
        if mode['form'] == '409': return fake(route, {'error': 'conflict', 'message': '版本变了'}, 409)
        if mode['form'] == '403': return fake(route, {'error': 'bench_views_forbidden'}, 403)
        return fake(route, {'ok': True})
    if rest == 'title':
        body = json.loads(route.request.post_data or '{}'); log['title'].append(body)
        if mode['title'] == '409': return fake(route, {'error': 'conflict', 'message': '台的名字已经被改过了，先重新读一次再改'}, 409)
        nt = mgr['card'] if body.get('from_card') is True else body.get('title', mgr['title'])
        changed = nt != mgr['title']; mgr['title'] = nt
        return fake(route, {'bench': mgr_entry()['bench'], 'changed': changed})
    return fake(route, {'error': 'not_found'}, 404)

def q_of(pg): return {k: v[0] for k, v in parse_qs(urlparse(pg.url).query).items()}
def body_text(pg): return pg.locator('body').inner_text()

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    # 切回标签页重新取入口有 30 秒节流：测试里把页面的 Date.now 往后拨（window.__wmShift 毫秒），不真等
    ctx.add_init_script("(() => { const real = Date.now.bind(Date); window.__wmShift = 0; Date.now = () => real() + window.__wmShift; })()")
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
    check('块都在：筛选栏、统计、进度、柱图、表格、两张表单，带外框', all(pg.locator(f'[data-bb={k}][data-bb-frame=card]').count() == (2 if k == 'form' else 1) for k in ('filter-bar', 'stat', 'progress', 'bar', 'table', 'form')))
    deny = pg.locator('[data-bb=form]').nth(1)
    check('表单块 can_submit 是 false：那一块按钮不可点、旁边说不能填、找管理层开通；另一块照常能交', deny.locator('button[type=submit]').is_disabled() and '你的账号不能在这个台上填表' in deny.inner_text() and '请管理层为你开通' in deny.inner_text() and not pg.locator('[data-bb=form]').nth(0).locator('button[type=submit]').is_disabled())
    t = body_text(pg)
    check('台标识、视图键、卡片背后的编号不写在页面的字上', SLUG not in t and 'vk-' not in t and '4242' not in t)
    check('浏览器标签页标题：视图标题 · 台名', pg.title() == '合成巡检总览 · 合成·巡检台', pg.title())
    check('「详情」去这张卡片的详情页', pg.locator('[data-testid=bench-page-detail]').get_attribute('href') == f'/market/wb/{CARD}')
    check('没有嵌页面的框', pg.locator('iframe').count() == 0)
    heads = [h.inner_text().strip() for h in pg.locator('[data-bb=table] th').all()]
    # 统筹 11-13 后改定（阶段四验收要求）：没配说明名的列，表头写「第 N 列」，悬停也不露键名；夹具里 state 那一列故意没配说明名
    th_html = pg.locator('[data-bb=table] thead').inner_html()
    check('表头：有列标题用列标题；没配说明名的那一列写「第 3 列」，表头文字和悬停都不露视图定义里的原始键名', heads[:3] == ['区域', '次数', '第 3 列'] and not any(k in heads for k in ('site', 'n', 'state')) and 'state' not in th_html, (heads, th_html[:200]))
    hs = pg.evaluate("() => ['stat','progress','bar'].map(k => document.querySelector(`[data-bb=${k}]`).getBoundingClientRect().height)")
    check('统计卡、进度按内容的高度，不跟同一行的柱图撑高', hs[0] < hs[2] * 0.6 and hs[1] < hs[2] * 0.6, hs)

    print('二、换视图、改筛选')
    n0 = len(log['render'])
    # 换视图时先回骨架：把下一次取数扣住，看新数据回来之前正文不是上一份视图的
    held = []
    pg.route(re.compile(r'/api/bench-views/[^/]+/render'), lambda r: held.append(r))
    pg.locator('[data-testid=bench-page-tab]', has_text='巡检明细').click()
    pg.wait_for_selector('[data-testid=bench-page-loading]')
    check('换视图：新数据回来之前正文是骨架，不留着上一份视图的块', pg.locator('[data-bb]').count() == 0 and pg.locator('[data-testid=bench-page-loading]').count() == 1)
    pg.unroute(re.compile(r'/api/bench-views/[^/]+/render'))
    for r in held: on_bv(r)

    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-tab][aria-selected=true]')?.textContent === '巡检明细'")
    pg.wait_for_selector('[data-bb=table] >> text=明细')
    check('换到「巡检明细」：地址带 v，按它取数', q_of(pg).get('v') == 'vk-rows' and log['render'][n0:][-1:] == [('vk-rows', {})], (pg.url, log['render'][n0:]))
    pg.wait_for_function("() => document.querySelectorAll('[data-bb=progress][data-bb-state=ready]').length === 2")
    r = pg.evaluate("() => ({ cards: [...document.querySelectorAll('[data-bb=stat],[data-bb=progress]')].map(e => { const b = e.getBoundingClientRect(); return [b.left, b.right, b.top]; }), table: (b => [b.left, b.right])(document.querySelector('[data-bb=table]').getBoundingClientRect()) })")
    ws = [c[1] - c[0] for c in r['cards']]
    check('三张没写宽度的卡同在一行、一样宽，最右一张的右边缘和整行表格的右边缘对齐（左边缘也对齐）',
          len(r['cards']) == 3 and len({round(c[2]) for c in r['cards']}) == 1 and max(ws) - min(ws) <= 1
          and abs(r['cards'][-1][1] - r['table'][1]) <= 1 and abs(r['cards'][0][0] - r['table'][0]) <= 1, r)
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
    form = pg.locator('[data-bb=form]').first
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
    pg.wait_for_function("() => document.querySelector('[data-bb=form] .ant-alert-warning')?.textContent.includes('没交上去：你的账号不能在这个台上填表')")
    check('不让交（403）：说这个账号不能在这个台上填表、找管理层开通，不露代号', '请管理层为你开通' in form.inner_text() and 'bench_views' not in form.inner_text())
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

    print('六、页内刷新同步入口（#761）')
    mode['render'] = 'ok'; mode['entry'] = 'ok'
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    e0, r0 = log['entry'], len(log['render'])
    mode['entry'] = 'v2'
    pg.locator('[data-testid=bench-page-refresh]').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-title]')?.textContent === '合成巡检总览·二'")
    tabs = [t.inner_text() for t in pg.locator('[data-testid=bench-page-tab]').all()]
    check('刷新后：入口又问了一次，总标题换成新的，页签变三份（新加的在列）', log['entry'] > e0 and tabs == ['巡检看板', '巡检明细', '新加的视角'], (log['entry'], tabs))
    check('还在当前那份视图，正文按同一份重新取了数；标签页标题也换了', pg.locator('[data-testid=bench-page-tab][aria-selected=true]').inner_text() == '巡检看板' and log['render'][-1] == ('vk-board', {}) and pg.title() == '合成巡检总览·二 · 合成·巡检台', (log['render'][r0:], pg.title()))
    pg.locator('[data-testid=bench-page-tab]', has_text='巡检明细').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-tab][aria-selected=true]')?.textContent === '巡检明细'")
    mode['entry'] = 'v3'
    r1 = len(log['render'])
    pg.locator('[data-testid=bench-page-refresh]').click()
    # 只剩一份视图时不出页签（和四里「只有一份视图」同一规则）：等页签消失，正文出现只有看板那份才有的柱图
    pg.wait_for_function("() => document.querySelectorAll('[data-testid=bench-page-tab]').length === 0")
    pg.wait_for_selector('[data-bb=bar][data-bb-state=ready]')
    check('刷新后当前视图被删了：回到默认那一份重新取数，不停在失效键上', ('vk-board', {}) in [tuple(x) for x in log['render'][r1:]] and pg.locator('[data-bb=bar]').count() == 1, log['render'][r1:])
    check('标题换成第三版，页签不再出（只剩一份）', pg.locator('[data-testid=bench-page-title]').inner_text() == '合成巡检总览·三' and pg.locator('[data-testid=bench-page-tab]').count() == 0)
    mode['entry'] = '500'
    r2 = len(log['render'])
    pg.locator('[data-testid=bench-page-refresh]').click()
    pg.wait_for_timeout(800)
    check('入口这次读不到（500）：页面保持现状不换，正文照常重新取数，不整页报错', len(log['render']) > r2 and pg.locator('[data-testid=bench-page-title]').inner_text() == '合成巡检总览·三' and pg.locator('[data-testid=use-entry-error]').count() == 0, (len(log['render']) - r2))
    mode['entry'] = 'ok'

    print('七、改台名（#905）')
    mode['render'] = 'ok'; mode['entry'] = 'ok'
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    check('入口没给 can.rename（不是管理层）：顶栏不出「改名」', pg.locator('[data-testid=bench-page-rename]').count() == 0)
    mode['entry'] = 'mgr'; mgr['title'] = ENTRY['bench']['title']
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-rename]')
    check('入口给了 can.rename：顶栏台名旁出「改名」，和「详情」在一处', pg.locator('.wm-bp-bar-extra [data-testid=bench-page-rename]').count() == 1)
    pg.locator('[data-testid=bench-page-rename]').click(); inp = pg.locator('[data-testid=bench-rename-input]'); inp.wait_for()
    check('点开：输入框预填现在的台名', inp.input_value() == '合成·巡检台', inp.input_value())
    check('卡片名和台名一样：不出「跟卡片同名」（#927）', pg.locator('[data-testid=bench-rename-from-card]').count() == 0)
    inp.fill('合成·巡检台（新）'); pg.locator('[data-testid=bench-rename-save]').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-name]')?.textContent === '合成·巡检台（新）'")
    # 对话框关的时候有收起动画，输入框在动画结束后才从页面上拿掉：等它真没了再断言（等不到就超时失败）
    pg.wait_for_selector('[data-testid=bench-rename-input]', state='detached')
    check('保存：请求带新名字和点开时看到的名字（base_title）；对话框关了，顶栏和标签页标题换成新名字',
          log['title'][-1:] == [{'title': '合成·巡检台（新）', 'base_title': '合成·巡检台'}] and pg.locator('[data-testid=bench-rename-input]').count() == 0 and pg.title() == '合成巡检总览 · 合成·巡检台（新）', (log['title'][-1:], pg.title()))
    # 409：别人在这之间改过
    mode['title'] = '409'
    pg.locator('[data-testid=bench-page-rename]').click(); inp = pg.locator('[data-testid=bench-rename-input]'); inp.wait_for()
    inp.fill('我想改成这个'); pg.locator('[data-testid=bench-rename-save]').click()
    pg.wait_for_selector('[data-testid=bench-rename-msg]')
    msg = pg.locator('[data-testid=bench-rename-msg]').inner_text()
    check('409：照服务端的说法提示，带「重新读一次」；对话框不关、输入框不动', '台的名字已经被改过了，先重新读一次再改' in msg and pg.locator('[data-testid=bench-rename-reload]').count() == 1 and inp.input_value() == '我想改成这个', msg)
    mgr['title'] = '合成·别人改的名字'; mode['title'] = 'ok'
    pg.locator('[data-testid=bench-rename-reload]').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-rename-input]')?.value === '合成·别人改的名字'")
    check('「重新读一次」：输入框换成现在的名字，顶栏也跟上', pg.locator('[data-testid=bench-page-name]').inner_text() == '合成·别人改的名字')
    # 「重新读一次」这一次没取到（入口 500）：输入框不动、说一句；之后后台再取到新名字，也不改输入框
    mode['title'] = '409'
    inp.fill('又想改成这个'); pg.locator('[data-testid=bench-rename-save]').click()
    pg.wait_for_selector('[data-testid=bench-rename-reload]')
    mode['entry'] = '500'; mgr['title'] = '合成·读不到时别人又改的'
    pg.locator('[data-testid=bench-rename-reload]').click()
    pg.wait_for_function("() => (document.querySelector('[data-testid=bench-rename-msg]')?.textContent ?? '').includes('读不到现在的名字')")
    check('「重新读一次」没取到：输入框还是自己填的那个，说读不到、还能再点', inp.input_value() == '又想改成这个' and pg.locator('[data-testid=bench-rename-reload]').count() == 1, inp.input_value())
    mode['entry'] = 'mgr'; e1 = log['entry']
    pg.evaluate("() => { window.__wmShift += 31000; window.dispatchEvent(new Event('focus')); }")
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-name]')?.textContent === '合成·读不到时别人又改的'")
    check('……之后后台重取到了新名字：顶栏换了，对话框里的输入仍然不被覆盖', log['entry'] > e1 and inp.input_value() == '又想改成这个', inp.input_value())
    mode['title'] = 'ok'; mgr['title'] = '合成·别人改的名字'
    pg.locator('[data-testid=bench-rename-reload]').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-rename-input]')?.value === '合成·别人改的名字'")
    pg.locator('[data-testid=bench-rename-save]').click()
    pg.wait_for_function("() => (document.querySelector('[data-testid=bench-rename-msg]')?.textContent ?? '').includes('名字没变')")
    check('没改名字就保存：说「名字没变」，请求的 base_title 是重新读到的名字', '名字没变' in pg.locator('[data-testid=bench-rename-msg]').inner_text() and log['title'][-1].get('base_title') == '合成·别人改的名字', log['title'][-1:])
    # 对话框开着时，页面在后台重新取了入口：输入框不被覆盖
    inp.fill('正在输入的名字')
    e0 = log['entry']
    pg.evaluate("() => window.dispatchEvent(new Event('focus'))"); pg.wait_for_timeout(400)
    check('切回标签页不到 30 秒：不重新取入口', log['entry'] == e0, (e0, log['entry']))
    mgr['title'] = '合成·后台又改了'
    pg.evaluate("() => { window.__wmShift += 31000; window.dispatchEvent(new Event('focus')); }")
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-name]')?.textContent === '合成·后台又改了'")
    check('过了 30 秒再切回来：重新取了一次入口，顶栏换成别人改的新名字', log['entry'] == e0 + 1, (e0, log['entry']))
    check('……对话框开着：输入框还是正在输入的那个，没被覆盖', inp.input_value() == '正在输入的名字', inp.input_value())
    pg.keyboard.press('Escape')
    pg.wait_for_selector('[data-testid=bench-rename-input]', state='detached')
    # 「跟卡片同名」（#927）：没有对应卡片（card_title 为 null）不出；卡片名和台名不同才出，按钮上写着卡片名；点了请求带 from_card 和 base_title
    mgr['card'] = None
    # 等这一次入口真回来再往下（等不到就超时失败），不靠固定时长：机器慢时入口没回来就点开对话框，用的还是旧的 card_title
    with pg.expect_response(lambda r: r.url.endswith('/entry')): pg.locator('[data-testid=bench-page-refresh]').click()
    pg.locator('[data-testid=bench-page-rename]').click(); pg.locator('[data-testid=bench-rename-input]').wait_for()
    check('台没有对应卡片（card_title 为 null）：不出「跟卡片同名」', pg.locator('[data-testid=bench-rename-from-card]').count() == 0)
    # Esc 要落在对话框里才关（焦点还在顶栏的「改名」上时按 Esc 不关），所以按在输入框上
    pg.locator('[data-testid=bench-rename-input]').press('Escape'); pg.wait_for_selector('[data-testid=bench-rename-input]', state='detached')
    mgr['card'] = '合成·巡检卡片'
    # 等这一次入口真回来再往下（等不到就超时失败），不靠固定时长：机器慢时入口没回来就点开对话框，用的还是旧的 card_title
    with pg.expect_response(lambda r: r.url.endswith('/entry')): pg.locator('[data-testid=bench-page-refresh]').click()
    pg.locator('[data-testid=bench-page-rename]').click(); fc = pg.locator('[data-testid=bench-rename-from-card]'); fc.wait_for()
    check('卡片名和台名不同：出「跟卡片同名」，按钮上写着卡片名', '合成·巡检卡片' in fc.inner_text(), fc.inner_text())
    base = mgr['title']; fc.click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-name]')?.textContent === '合成·巡检卡片'")
    pg.wait_for_selector('[data-testid=bench-rename-input]', state='detached')
    check('点了「跟卡片同名」：请求带 from_card 和 base_title，顶栏换成卡片名', log['title'][-1:] == [{'from_card': True, 'base_title': base}], log['title'][-1:])
    pg.locator('[data-testid=bench-page-rename]').click(); pg.locator('[data-testid=bench-rename-input]').wait_for()
    check('同名之后再点开：不再出「跟卡片同名」', pg.locator('[data-testid=bench-rename-from-card]').count() == 0)
    pg.locator('[data-testid=bench-rename-input]').press('Escape'); mode['entry'] = 'ok'

    print('七之二、连着重取两次入口，先发出的那次晚到')
    mode['entry'] = 'mgr'; mgr['title'] = '合成·旧名'; held_entry.clear()
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    mode['entry'] = 'hold'
    pg.locator('[data-testid=bench-page-refresh]').click()
    for _ in range(250):  # 等到第一次重取确实压在半路，等不到就失败
        if held_entry: break
        pg.wait_for_timeout(20)
    check('（前提）第一次重取入口压在半路，它带的还是旧名', len(held_entry) == 1 and held_entry[0][1]['bench']['title'] == '合成·旧名', len(held_entry))
    mgr['title'] = '合成·新名'; mode['entry'] = 'mgr'
    pg.locator('[data-testid=bench-page-refresh]').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=bench-page-name]')?.textContent === '合成·新名'")
    with pg.expect_event('requestfinished', lambda r: r.url.endswith('/entry')):
        route, body = held_entry.pop(); fake(route, body)
    pg.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")  # 晚到的应答交给页面以后，再等两帧让它画完
    check('先发出的那次晚到（带旧名）：顶栏仍是后一次的新名字，不退回旧名', pg.locator('[data-testid=bench-page-name]').inner_text() == '合成·新名' and pg.title().endswith('合成·新名'), (pg.locator('[data-testid=bench-page-name]').inner_text(), pg.title()))
    mode['entry'] = 'ok'

    print('八、连着改两个筛选（第一次取数还没回来就改第二个）')
    mode['render'] = 'ok'; mode['entry'] = 'ok'; mode['filters'] = 'two'
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    mode['render'] = 'hold'; held.clear()
    s1 = pg.locator('[data-filter=site] input'); s1.fill('北区'); s1.press('Enter')
    pg.wait_for_function("() => new URLSearchParams(location.search).get('p.site') === '北区'")
    for _ in range(250):  # 等到第一次取数确实压在半路（不回应答），等不到就失败
        if held: break
        pg.wait_for_timeout(20)
    check('（前提）改了第一个筛选：地址带上了，它的取数压在半路还没回来', len(held) == 1 and held[0][2] == {'site': '北区'}, [h[2] for h in held])
    s2 = pg.locator('[data-filter=owner] input'); s2.fill('合成甲'); s2.press('Enter')
    pg.wait_for_function("() => new URLSearchParams(location.search).get('p.owner') === '合成甲'")
    q = q_of(pg)
    check('紧接着改第二个筛选：第一个没被冲掉，地址里两个都在', q.get('p.site') == '北区' and q.get('p.owner') == '合成甲', q)
    for _ in range(250):
        if len(held) >= 2: break
        pg.wait_for_timeout(20)
    check('第二次取数带着两个筛选', len(held) >= 2 and held[-1][2] == {'site': '北区', 'owner': '合成甲'}, [h[2] for h in held])
    mode['render'] = 'ok'
    for route, view, params in held: fake(route, view_result(view, params))
    held.clear()
    pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    q = q_of(pg)
    check('压着的取数放行以后：地址里两个筛选仍在，筛选栏里两个框都是填的值', q.get('p.site') == '北区' and q.get('p.owner') == '合成甲' and pg.locator('[data-filter=site] input').input_value() == '北区' and pg.locator('[data-filter=owner] input').input_value() == '合成甲', (q, pg.locator('[data-filter=site] input').input_value()))
    mode['filters'] = 'one'

    print('九、记录卡（#858）')
    mode['render'] = 'ok'; mode['entry'] = 'ok'; mode['records'] = 'on'
    ctx.route('https://ok.example/**', lambda r: r.fulfill(status=200, content_type='text/plain', body='合成的来源页'))
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=records][data-bb-state=ready]')
    cards = pg.locator('[data-testid=rec-card]')
    check('每行一张卡片，按 page_size 分页：7 行这一页 5 张，上方写共 7 条', cards.count() == 5 and pg.locator('[data-testid=rec-count]').inner_text().startswith('共 7 条'), (cards.count(), pg.locator('[data-testid=rec-count]').inner_text()))
    first = cards.first
    check('字段一律当纯文本：带 <script>、<img onerror> 的标题原样当文字显示，页面上没有这两个元素、脚本没跑', XSS in first.inner_text() and first.locator('script, img').count() == 0 and pg.evaluate('() => window.__xss === undefined'), first.inner_text()[:200])
    check('空值写「—」、空日期写「未填」；徽标照说法（进行中）', '—' in first.inner_text() and '未填' in first.inner_text() and '进行中' in first.inner_text())
    check('没定义说法的取值：照原值显示，标「未定义的取值」', '未定义的取值' in cards.nth(1).inner_text())
    link = first.locator('[data-testid=rec-link]')
    check('来源链接只显示说法，不露网址；新窗口打开、带 noopener noreferrer；悬停和读屏给主机名', link.inner_text() == '查看依据' and 'ok.example/doc' not in first.inner_text()
          and link.get_attribute('target') == '_blank' and link.get_attribute('rel') == 'noopener noreferrer' and 'ok.example' in (link.get_attribute('title') or '') and 'ok.example' in (link.get_attribute('aria-label') or ''), (link.get_attribute('title'), link.get_attribute('aria-label')))
    check('javascript: 的来源：标「来源地址无效」，不渲染成链接', '来源地址无效' in first.locator('[data-testid=rec-link-invalid]').inner_text() and first.locator('a[href^="javascript"]').count() == 0)
    check('长字段不撑破卡片：卡片宽度不超过网格的一列', pg.evaluate("() => { const c = document.querySelector('[data-testid=rec-card]'); return c.scrollWidth <= c.clientWidth + 1; }"))
    check('次要字段收在「展开」里：一开始看不到', '说明' not in first.locator('dl').all_inner_texts()[0] and first.locator('.wm-rec-details').count() == 0)
    # 键盘：Tab 走到「展开」，Enter 展开、再 Enter 收起；焦点样式看得见
    toggle = first.locator('[data-testid=rec-toggle]')
    pg.locator('[data-testid=bench-page-title]').click()
    for _ in range(40):
        pg.keyboard.press('Tab')
        if pg.evaluate("() => document.activeElement?.getAttribute('data-testid') === 'rec-toggle'"): break
    check('键盘 Tab 能走到「展开」，焦点样式看得见（有外框）', pg.evaluate("() => document.activeElement?.getAttribute('data-testid') === 'rec-toggle' && getComputedStyle(document.activeElement).outlineStyle !== 'none'"))
    pg.keyboard.press('Enter')
    pg.wait_for_function("() => document.querySelector('[data-testid=rec-toggle]')?.getAttribute('aria-expanded') === 'true'")
    check('Enter 展开：次要字段出来了，长文字不再截断', first.locator('.wm-rec-details').count() == 1 and '说明' in first.inner_text() and first.locator('.wm-rec-clamp').count() == 0)
    pg.keyboard.press('Enter')
    pg.wait_for_function("() => document.querySelector('[data-testid=rec-toggle]')?.getAttribute('aria-expanded') === 'false'")
    check('再 Enter 收起', first.locator('.wm-rec-details').count() == 0)
    pg.keyboard.press('Tab')
    check('再 Tab 走到来源链接，焦点样式看得见', pg.evaluate("() => document.activeElement?.getAttribute('data-testid') === 'rec-link' && getComputedStyle(document.activeElement).outlineStyle !== 'none'"))
    with ctx.expect_page() as popup:
        pg.keyboard.press('Enter')
    newp = popup.value; newp.wait_for_load_state()
    check('Enter 在新窗口打开来源，打开的是这条记录的地址', newp.url == 'https://ok.example/doc', newp.url)
    newp.close()
    check('没截断：不出框架的截断提示', pg.locator('[data-bb=records] .wm-bb-truncated').count() == 0)
    # 查询被截断：截断只说一次（框架那句），不再写「共 N 条」——那不是总数
    mode['records'] = 'truncated'
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-bb=records][data-bb-state=ready] [data-testid=rec-card]')
    rec = pg.locator('[data-bb=records]')
    check('截断了：框架说一次「数据不止这些，只显示了前 7 行」；不写「共 7 条」，也没有第二处截断提示',
          rec.locator('.wm-bb-truncated').count() == 1 and '只显示了前 7 行' in rec.locator('.wm-bb-truncated').inner_text() and rec.locator('[data-testid=rec-count]').count() == 0 and rec.inner_text().count('只显示') == 1,
          (rec.locator('.wm-bb-truncated').all_inner_texts(), rec.locator('[data-testid=rec-count]').all_inner_texts()))
    mode['records'] = 'off'

    print('五、入口')
    mode['entry'] = '403'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('.wm-use-frame')
    check('入口 403（只带管理口令、跨站）：照原来嵌页面，不拦成提示页、不进视图台页面', pg.locator('[data-testid=bench-page]').count() == 0 and pg.locator('.wm-use-frame').count() == 1)
    mode['entry'] = '401'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('.wm-use-frame')
    check('入口 401（没登录）：照原来嵌页面，不拦成「去登录」、不进视图台页面', pg.locator('[data-testid=bench-page]').count() == 0 and pg.get_by_role('button', name='去登录').count() == 0)
    mode['entry'] = '500'; pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=use-entry-error]')
    check('入口读不到：说这会儿打不开，带「再试一次」，不提「这个台」', '这会儿打不开' in body_text(pg) and '这个台' not in pg.locator('[data-testid=use-entry-error]').inner_text())
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
