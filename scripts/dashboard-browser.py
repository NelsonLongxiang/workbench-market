"""#320 数据看板浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
总览：12 列栅格、卡片宽度只取 3/4/6/12、卡片内不嵌套卡片、列表卡 ≤5 行 + 查看全部、趋势卡 ≤5 个系列与行、指标卡可跳转、
数据过期时卡片头显示「数据截至」；驾驶舱：旧布局（宽 5/7）读时吸附到 4 档、不丢面板、只读页不发布局写、接口数据不变。"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def get(path): return json.load(urllib.request.urlopen(M + path))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    # Explicit synthetic task authority for all fixture pages, without business-page token storage.
    ctx.route(M + '/api/tasks', lambda r: r.continue_(headers={**r.request.headers, 'x-admin-token': cfg['token']}))
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.clock.install()
    pg.goto(M + '/'); pg.wait_for_selector('.wm-dash-grid .wm-dash-list li')
    cols = pg.evaluate("getComputedStyle(document.querySelector('.wm-dash-grid')).gridTemplateColumns.split(' ').length")
    check('总览是 12 列栅格', cols == 12, cols)
    spans = pg.evaluate("[...document.querySelectorAll('.wm-dash-grid > .wm-dash-card')].map(e=>e.dataset.span)")
    check(f'卡片宽度只取 3/4/6/12（{spans}）', spans and all(s in ('3', '4', '6', '12') for s in spans))
    check('卡片内不嵌套卡片', pg.locator('.wm-dash-card .wm-dash-card, .wm-dash-card .ant-card').count() == 0)
    body = pg.locator('body').inner_text()
    check('保留 E2E 依赖的文案（工作台总数/平均延迟/全部检测/待办/进行中）', all(t in body for t in ['工作台总数', '平均延迟', '全部检测', '待办', '进行中']))
    lst = pg.locator('.wm-dash-card', has=pg.locator('.wm-dash-card-title', has_text='我的待办'))
    check('列表卡最多 5 行（待办 ≥25 条时正好 5 行）', lst.locator('.wm-dash-list li').count() == 5, lst.locator('.wm-dash-list li').count())
    check('列表卡「查看全部」链到 /tasks', lst.locator('a.wm-dash-more').get_attribute('href') == '/tasks')
    trend = pg.locator('.wm-dash-card', has=pg.locator('.wm-dash-card-title', has_text='分类在线率'))
    check('趋势卡图例在上、系列 ≤5、行 ≤5', trend.locator('.wm-dash-legend span').count() <= 5 and 0 < trend.locator('.wm-dash-bar-row').count() <= 5)
    check('状态卡给出工作台状态网格', pg.locator('.wm-dash-status-item').count() >= 1)
    check('过期提示默认不出现', pg.locator('.wm-dash-stale').count() == 0)
    pg.route('**/api/summary', lambda r: r.fulfill(status=500, body='{}'))
    pg.clock.fast_forward(45_000); pg.wait_for_timeout(300)
    check('拉取失败超过两个刷新周期 → 卡片头显示「数据截至 HH:mm」', pg.locator('.wm-dash-stale').count() >= 1 and '数据截至' in pg.locator('.wm-dash-stale').first.inner_text())
    pg.unroute('**/api/summary')
    pg2 = ctx.new_page(); pg2.set_default_timeout(10000)
    pg2.goto(M + '/'); pg2.wait_for_selector('.wm-stat-card')
    pg2.locator('.wm-stat-card', has_text='工作台总数').click(); pg2.wait_for_url(M + '/market')
    check('指标卡点击跳到对应列表页', True)
    pg2.set_viewport_size({'width': 375, 'height': 800}); pg2.goto(M + '/'); pg2.wait_for_selector('.wm-dash-grid')
    w = pg2.evaluate("[...document.querySelectorAll('.wm-dash-grid > .wm-dash-card')].map(e=>Math.round(e.getBoundingClientRect().width))")
    gw = pg2.evaluate("Math.round(document.querySelector('.wm-dash-grid').getBoundingClientRect().width)")
    check('手机宽度下卡片单列占满', all(abs(x - gw) <= 2 for x in w), (w, gw))
    # ── 驾驶舱旧布局读时迁移 ──
    cid = cfg['legacy_cockpit']
    before = get(f'/api/cockpits/{cid}')['panels']
    writes = []
    pg3 = ctx.new_page(); pg3.set_default_timeout(10000)
    pg3.on('request', lambda r: writes.append(f'{r.method} {r.url}') if r.method != 'GET' and '/api/cockpits' in r.url else None)
    pg3.goto(M + f'/cockpit/{cid}'); pg3.wait_for_selector('.wm-cockpit-grid .wm-panel')
    pg3.wait_for_timeout(800)
    n = pg3.locator('.wm-cockpit-grid .wm-panel').count()
    check(f'旧布局升级后不丢卡片（{n}/{len(before)}）', n == len(before))
    cols = pg3.evaluate("""(()=>{const g=document.querySelector('.wm-cockpit-grid');const gw=g.getBoundingClientRect().width;
      return [...g.querySelectorAll(':scope > .react-grid-item')].map(e=>{const s=e.style.width;return Math.round((e.getBoundingClientRect().width+12)/(gw+12)*12*10)/10})})()""")
    check(f'面板宽度吸附到 3/4/6/12 档（{cols}）', all(min(abs(c - k) for k in (3, 4, 6, 12)) <= 0.3 for c in cols))
    check('只读页挂载不发布局写请求', not writes, writes)
    check('接口里的布局数据不被改（读时迁移不回写）', get(f'/api/cockpits/{cid}')['panels'] == before)
    ctx.unroute(M + '/api/tasks'); ctx.close(); b.close()
print(f'dashboard-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
