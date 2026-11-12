"""嵌台防护（驾驶舱不把市场套进市场）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
用合成实例里「旧布局舱」的两个工作台面板：
  · 登记的地址和市场同源、又不在台的路径下（合成实例里登记的是 <市场>/api/health）：不嵌，写「这个台的地址指向市场本身，不能嵌在驾驶舱里」；
  · 地址在台的路径下（截下 /api/workbenches 改成 /apps/…），但 /go/<id>/ 回来的是市场自己的页面（带 wm-surface 标记）：嵌进来以后换成同一句话；
  · 回来的是别的页面：照常嵌。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
TEXT = '这个台的地址指向市场本身，不能嵌在驾驶舱里'

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    url = M + f'/cockpit/{cfg["legacy_cockpit"]}'
    pg.goto(url); pg.wait_for_selector('.wm-panel'); pg.wait_for_timeout(600)
    guards = pg.locator('[data-testid=go-self]')
    check('登记的地址指向市场自己（同源、不在 /apps/ 这类台的路径下）：不嵌，说一句', guards.count() == 2 and all(TEXT in t for t in guards.all_inner_texts()) and pg.locator('.wm-panel-body iframe').count() == 0, (guards.count(), pg.locator('.wm-panel-body iframe').count()))
    # 地址改成台的路径；一个 /go/ 回市场自己的页面，一个回别的页面
    ids = []
    def patch(route):
        r = route.fetch(); body = r.json()
        rows = body if isinstance(body, list) else body.get('items', body)
        for i, w in enumerate(rows if isinstance(rows, list) else []):
            w['url'] = f'/apps/syn-{i}/'; ids.append(w['id'])
        route.fulfill(response=r, body=json.dumps(body))
    pg.route(re.compile(r'/api/workbenches(\?|$)'), patch)
    market_html = '<!doctype html><html><head><meta name="wm-surface" content="market"><title>x</title></head><body>market</body></html>'
    other_html = '<!doctype html><html><head><title>bench</title></head><body>a bench</body></html>'
    served = {}
    def go(route):
        wid = int(re.search(r'/go/(\d+)/', route.request.url).group(1))
        served.setdefault(wid, 'market' if not served else 'other')  # 先要的那个面板回市场自己的页面，另一个回别的页面
        route.fulfill(status=200, content_type='text/html', body=market_html if served[wid] == 'market' else other_html)
    pg.route(re.compile(r'/go/\d+/'), go)
    pg.goto(url); pg.wait_for_selector('.wm-panel'); pg.wait_for_timeout(1500)
    frames = pg.locator('.wm-panel-body iframe').count()
    check('地址在台的路径下、但嵌进来的是市场自己的页面：换成同一句话；另一个照常嵌', len(served) == 2 and pg.locator('[data-testid=go-self]').count() == 1 and TEXT in pg.locator('[data-testid=go-self]').inner_text() and frames == 1, (served, frames, pg.locator('[data-testid=go-self]').count()))
    b.close()

print(f'cockpit-embed-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
