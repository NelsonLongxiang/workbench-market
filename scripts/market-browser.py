"""工作台市场（照原型 3fbfd0b 重做的 /market）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
合成实例里有两个登记的工作台、一个发布了的流程，没有技能。
  · 不是管理员：分类胶囊只有 全部 / 工作台 / 流程 / 技能（「连接器」只给管理员，也不去问），1440 宽三列卡片，卡片数 = 三个接口里该上市场的条数；
  · 「全部」里卡片第一个标签补类别，某一类的页签里不重复类别（#584）；工作台卡片右上角有「详情」入口，卡片本身照旧去打开；
  · 管理员多一个「连接器」，卡片数 = MCP 上游条数（没有就说为什么空）；
  · 切分类改地址（?k=），只剩那一类；空的一类说为什么空；
  · 一个来源读不到只在它那一类给提示，别的照常；应答形状不对不带崩整页；
  · 管理员才有「管理工作台」，点进去是原来的工作台表格（/market/manage，顶栏「工作台市场 / 管理工作台」）。"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, TOK = cfg['base'], cfg['token']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def api(path):
    with urllib.request.urlopen(urllib.request.Request(M + path)) as r: return json.load(r)

wbs = [w for w in api('/api/workbenches') if w.get('enabled', True)]
sops = [s for s in api('/api/sops') if s.get('status') == 'published' and s.get('slug') != 'task-center']
sk = api('/api/skills'); sk = sk if isinstance(sk, list) else sk.get('items', [])
skills = [k for k in sk if (k.get('versions') or 0) > 0]
want = len(wbs) + len(sops) + len(skills)

# 弹出层「开好了」：盒子有尺寸、动画的类已经摘掉（和 sider-menu-browser.py 同一个判断）。不用「此刻可见」——动画起点那一帧尺寸是 0
SETTLED = """(sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect();
  const host = e.closest('.ant-popover, .ant-dropdown'); if (!host || r.width === 0 || r.height === 0) return false;
  return ![...host.classList].some(c => /-(appear|enter|leave)(-|$)/.test(c)) && !host.classList.contains('ant-popover-hidden') && !host.classList.contains('ant-dropdown-hidden'); }"""
def settled(pg, sel, timeout=10000): pg.wait_for_function(SETTLED, arg=sel, timeout=timeout)
def slow(page):
    """本机模拟慢 runner：WM_BROWSER_CPU_THROTTLE=6 把页面 CPU 放慢 6 倍。缺省不放慢。"""
    import os
    rate = float(os.environ.get('WM_BROWSER_CPU_THROTTLE', '0') or 0)
    if rate > 1: page.context.new_cdp_session(page).send('Emulation.setCPUThrottlingRate', {'rate': rate})

def set_token(pg):
    pg.locator('[data-testid=wm-me]').click()
    pg.locator('[data-testid=wm-me][aria-expanded=true]').wait_for(); settled(pg, '.wm-me-pop')
    pg.locator('.wm-me-pop button', has_text='口令').click()
    pg.locator('.ant-popover input[type=password]').last.wait_for(); settled(pg, '.ant-popover input[type=password]')
    pg.locator('.ant-popover input[type=password]').last.fill(TOK)
    pg.locator('.ant-popover button', has_text='保').last.click()
    pg.wait_for_selector('[data-testid=nav-admin]', timeout=10000)
    pg.keyboard.press('Escape'); pg.mouse.click(800, 26); pg.wait_for_timeout(300)  # 点顶栏空白处关掉用户卡；别点内容区，会点到卡片

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    pg = ctx.new_page(); pg.set_default_timeout(10000); slow(pg)
    upstream_asked = []
    pg.on('request', lambda r: upstream_asked.append(r.url) if '/api/mcp/upstreams' in r.url else None)
    pg.goto(M + '/market'); pg.wait_for_selector('[data-testid=mkt-card]')
    check('顶栏标题是导航名「工作台市场」', pg.locator('.wm-top-title').inner_text().strip() == '工作台市场')
    tabs = [t.strip() for t in pg.locator('.wm-mkt-tab').all_inner_texts()]
    check('不是管理员：分类只有 全部 / 工作台 / 流程 / 技能，连接器不出现、也不去问', tabs == ['全部', '工作台', '流程', '技能'] and upstream_asked == [], (tabs, upstream_asked))
    pg.goto(M + '/market?k=连接器'); pg.wait_for_selector('[data-testid=mkt-card]')
    check('不是管理员地址里带 ?k=连接器：落「全部」，仍不去问', pg.locator('.wm-mkt-tab.on').inner_text().strip() == '全部' and upstream_asked == [], upstream_asked)
    check('合成数据里有工作台和流程（不然后面是空过）', len(wbs) >= 2 and len(sops) >= 1 and want >= 3, (len(wbs), len(sops)))
    cards = pg.locator('[data-testid=mkt-card]')
    check(f'卡片数 = 该上市场的条数（{cards.count()} / {want}）', cards.count() == want)
    tops = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].slice(0,3).map(e=>Math.round(e.getBoundingClientRect().top))")
    widths = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].slice(0,3).map(e=>Math.round(e.getBoundingClientRect().width))")
    check('1440 宽：一行三张、等宽', len(set(tops)) == 1 and max(widths) - min(widths) <= 1 and len(tops) == 3, (tops, widths))
    check('没有质量评级（没有来源）', pg.locator('text=质量评级').count() == 0)
    hrefs = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].map(e=>e.getAttribute('href'))")
    check('工作台卡片去 /use/<id>，流程卡片去 /sops/<slug>', all(f'/use/{w["id"]}' in hrefs for w in wbs) and all(f'/sops/{s["slug"]}' in hrefs for s in sops), hrefs)
    check('没有管理员：不露「管理」', pg.locator('[data-testid=mkt-manage]').count() == 0)
    tags_rows = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].map(e=>[e.dataset.kind,[...e.querySelectorAll('.wm-mkt-tag')].map(t=>t.innerText.trim())])")
    check('「全部」里几类混排：第一个标签补类别，后面不再重复类别', all(tags and tags[0] == kind and kind not in tags[1:] for kind, tags in tags_rows), tags_rows)
    details = pg.evaluate("[...document.querySelectorAll('.wm-mkt-cell')].map(c=>[c.querySelector('[data-testid=mkt-card]').dataset.kind, c.querySelector('[data-testid=mkt-detail]')?.getAttribute('href')||''])")
    check('工作台卡片右上角有「详情」入口去 /market/wb/<id>，流程卡片没有；卡片本身照旧去打开', sorted(h for k, h in details if k == '工作台') == sorted(f'/market/wb/{w["id"]}' for w in wbs) and all(h == '' for k, h in details if k != '工作台'), details)
    descs = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].map(e=>e.querySelector('.wm-mkt-desc')?.innerText.trim()||'')")
    check('每张卡片都有说明区：没有说明的写「还没有说明」', all(d for d in descs), descs)
    bottoms = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].slice(0,3).map(e=>Math.round(e.getBoundingClientRect().bottom))")
    check('同一排卡片底部对齐', len(set(bottoms)) == 1, bottoms)

    pg.locator('[data-testid="mkt-tab-流程"]').click(); pg.wait_for_timeout(200)
    kinds = set(pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].map(e=>e.dataset.kind)"))
    check('切到「流程」：地址带 ?k=流程，只剩流程', '?k=' in pg.url and kinds == {'流程'} and pg.locator('[data-testid=mkt-card]').count() == len(sops), (pg.url, kinds))
    pg.reload(); pg.wait_for_selector('[data-testid=mkt-card]')
    check('刷新后停在「流程」', pg.locator('.wm-mkt-tab.on').inner_text().strip() == '流程')
    one_kind = pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card]')].map(e=>[...e.querySelectorAll('.wm-mkt-tag')].map(t=>t.innerText.trim()))")
    check('某一类的页签里不重复类别（#584）', all('流程' not in tags for tags in one_kind), one_kind)
    if not skills:
        pg.locator('[data-testid="mkt-tab-技能"]').click(); pg.wait_for_timeout(200)
        desc = pg.locator('.ant-empty-description').all_inner_texts()
        check('「技能」空着：说为什么空、下一步，不写「暂无数据」', len(desc) == 1 and '还没有发布的技能' in desc[0] and '暂无数据' not in pg.locator('.wm-page-body').inner_text(), desc)

    # 一个来源坏了不拖垮整页
    pg2 = ctx.new_page(); pg2.set_default_timeout(10000); slow(pg2)
    pg2.route('**/api/skills', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":"boom"}'))
    pg2.route('**/api/workbenches', lambda r: r.fulfill(status=200, content_type='application/json', body='{"not":"an array"}'))
    pg2.goto(M + '/market'); pg2.wait_for_selector('[data-testid=mkt-card]')
    check('技能读不到：给「读不到技能，稍后再试」', pg2.locator('.ant-alert', has_text='读不到技能，稍后再试').count() == 1)
    check('工作台应答形状不对：按空处理，流程照常显示', pg2.locator('[data-testid=mkt-card][data-kind=流程]').count() == len(sops) and pg2.locator('[data-testid=mkt-card][data-kind=工作台]').count() == 0)
    pg2.goto(M + '/market?k=工作台'); pg2.wait_for_timeout(600)
    check('只看「技能」以外的类：不提技能的问题', pg2.locator('.ant-alert', has_text='技能').count() == 0)
    pg2.route('**/api/sops', lambda r: r.fulfill(status=403, content_type='application/json', body='{"error":"forbidden"}'))
    pg2.goto(M + '/market?k=流程'); pg2.wait_for_selector('.ant-alert')
    check('流程 403：说「你的账号现在不能查看流程」，不弹口令', pg2.locator('.ant-alert', has_text='你的账号现在不能查看流程').count() == 1 and pg2.locator('.ant-modal').count() == 0)
    pg2.close()

    # 管理员
    set_token(pg)
    btn = pg.locator('[data-testid=mkt-manage]')
    btn.wait_for(timeout=5000)
    check('管理员：顶栏有「管理」，且不是主按钮', btn.count() == 1 and pg.locator('.wm-top-actions .ant-btn-primary').count() == 0)
    btn.click(); pg.locator('.ant-dropdown-menu', has_text='管理工作台').wait_for(); settled(pg, '.ant-dropdown-menu')
    items = [t.strip() for t in pg.locator('.ant-dropdown-menu .ant-dropdown-menu-item').all_inner_texts()]
    check('「管理」里是工作台、流程、技能三处原来的管理面', items == ['管理工作台', '流程的发布与绑定', '技能的版本'], items)
    pg.locator('.ant-dropdown-menu a', has_text='管理工作台').click(); pg.wait_for_url(M + '/market/manage'); pg.wait_for_selector('.ant-table-row')
    crumb = pg.locator('.wm-top-crumb').inner_text().replace('\n', ' ')
    check('管理页：顶栏「工作台市场 / 管理工作台」，原来的工作台表格在', '工作台市场' in crumb and '管理工作台' in crumb and pg.locator('.ant-table-row').count() == len(wbs), crumb)
    pg.locator('.wm-top-crumb a').click(); pg.wait_for_url(M + '/market'); pg.wait_for_selector('[data-testid=mkt-card]')
    check('点「工作台市场」回到市场', pg.locator('.wm-mkt-tabs').count() == 1)
    tabs = [t.strip() for t in pg.locator('.wm-mkt-tab').all_inner_texts()]
    check('管理员：多一个「连接器」页签，排最后', tabs == ['全部', '工作台', '流程', '技能', '连接器'], tabs)
    with urllib.request.urlopen(urllib.request.Request(M + '/api/mcp/upstreams', headers={'x-admin-token': TOK})) as r: ups = json.load(r)
    pg.locator('[data-testid=mkt-tab-连接器]').click(); pg.wait_for_timeout(800)
    n = pg.locator('[data-testid=mkt-card][data-kind=连接器]').count()
    empty = pg.locator('.ant-empty-description').all_inner_texts()
    check(f'连接器：卡片数 = MCP 上游条数（{n} / {len(ups)}）；没有就说为什么空', n == len(ups) and (n > 0 or any('还没有接上的连接器' in e for e in empty)), (n, len(ups), empty))
    # 合成两个上游（一个连得上、一个连不上），看卡片怎么说
    UPS = [{'prefix': 'synb', 'kind': 'http', 'enabled': True, 'reachable': False, 'tools': 0, 'last_checked_at': ''},
           {'prefix': 'syna', 'kind': 'ygl-trees', 'enabled': True, 'reachable': True, 'tools': 3, 'last_checked_at': '2026-11-12 08:00:00'}]
    pg.route('**/api/mcp/upstreams', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(UPS)))
    # 口令只存在本页、离开就清（#292）：重新进市场、再设一次口令，页面才会按管理员去问上游
    pg.goto(M + '/market'); pg.wait_for_selector('[data-testid=mkt-card]'); set_token(pg)
    pg.locator('[data-testid=mkt-tab-连接器]').click(); pg.wait_for_selector('[data-testid=mkt-card][data-kind=连接器]')
    conn = [''.join(t.split()) for t in pg.locator('[data-testid=mkt-card][data-kind=连接器]').all_inner_texts()]
    check('连接器卡片：按名字排，写连得上几个工具 / 连不上；点了去 MCP 网关管理页；没有「详情」入口', len(conn) == 2 and 'syna' in conn[0] and 'synb' in conn[1] and '连得上·3个工具' in conn[0] and '连不上' in conn[1]
          and all(h == '/mcp-gateways' for h in pg.evaluate("[...document.querySelectorAll('[data-testid=mkt-card][data-kind=连接器]')].map(e=>e.getAttribute('href'))")) and pg.locator('[data-testid=mkt-detail]').count() == 0, conn)
    pg.unroute('**/api/mcp/upstreams')
    b.close()

print(f'market-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
