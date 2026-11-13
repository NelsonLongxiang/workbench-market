"""嵌台防护（驾驶舱不把市场套进市场）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
用合成实例里「旧布局舱」的两个工作台面板：
  · 登记的地址和市场同源、又不在台的路径下（合成实例里登记的是 <市场>/api/health）：不嵌，写「这个台的地址指向市场本身，不能嵌在驾驶舱里」；
  · 地址在台的路径下（截下 /api/workbenches 改成 /apps/…），但 /go/<id>/ 回来的是市场自己的页面（真的市场首页）：框里的市场页认出自己被市场嵌着，只写一句，不起整个市场；
    嵌台框本身不加事件、不加 ref（判据 65：框的属性只有 key/className/src/title/allow）；
  · 回来的是别的页面：照常嵌；
  · 框读不到（台的页面是沙箱的不透明源）：哪怕带着市场的标记也照常嵌、不报错——防护只在框本来同源可读时生效，不靠改框的 sandbox。"""
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
    real_market = pg.request.get(M + '/').text()  # 真的市场首页（带脚本），框里的市场页要自己认出来
    other_html = '<!doctype html><html><head><title>bench</title></head><body>a bench</body></html>'
    served = {}
    def go(route):
        wid = int(re.search(r'/go/(\d+)/', route.request.url).group(1))
        served.setdefault(wid, 'market' if not served else 'other')  # 先要的那个面板回市场自己的页面，另一个回别的页面
        route.fulfill(status=200, content_type='text/html', body=real_market if served[wid] == 'market' else other_html)
    pg.route(re.compile(r'/go/\d+/'), go)
    pg.goto(url); pg.wait_for_selector('.wm-panel'); pg.wait_for_timeout(2500)
    frames = pg.locator('.wm-panel-body iframe')
    texts = []
    for i in range(frames.count()):
        fl = pg.frame_locator('.wm-panel-body iframe').nth(i)
        try: texts.append(fl.locator('body').inner_text(timeout=5000))
        except Exception as e: texts.append('ERR ' + str(e)[:60])
    selfs = [t for t in texts if '指向市场本身' in t]
    check('地址在台的路径下、但嵌进来的是市场自己的页面：框里只写一句（不起整个市场，没有侧栏）；另一个照常嵌', len(served) == 2 and frames.count() == 2 and len(selfs) == 1 and '工作台市场' not in selfs[0] and any('a bench' in t for t in texts), (served, texts))
    attrs = pg.evaluate("[...document.querySelectorAll('.wm-panel-body iframe')].map(f => f.getAttributeNames().sort().join(','))")
    check('嵌台框的属性只在 key/className/src/title/allow 里（DOM 上最多 class、src、title、allow），没有事件、没有 sandbox', len(attrs) == 2 and all(set(a.split(',')) <= {'allow', 'class', 'src', 'title'} and {'src', 'title', 'allow'} <= set(a.split(',')) for a in attrs), attrs)
    # 读不到的框（台的页面是 CSP sandbox 的不透明源，和 /apps/ 一样）：哪怕里面带着市场的标记，也安静放过——照常嵌、不报错、不当成市场
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    served.clear()
    def go_sandboxed(route):
        route.fulfill(status=200, headers={'content-type': 'text/html', 'content-security-policy': 'sandbox allow-scripts'}, body=market_html)
    pg.unroute(re.compile(r'/go/\d+/')); pg.route(re.compile(r'/go/\d+/'), go_sandboxed)
    pg.goto(url); pg.wait_for_selector('.wm-panel'); pg.wait_for_timeout(1500)
    readable = pg.evaluate("[...document.querySelectorAll('.wm-panel-body iframe')].map(f => { try { return !!f.contentDocument && !!f.contentDocument.querySelector('meta'); } catch { return 'blocked'; } })")
    check('读不到的框（沙箱的不透明源）：照常嵌，不换成说明、不报错', pg.locator('.wm-panel-body iframe').count() == 2 and pg.locator('[data-testid=go-self]').count() == 0 and not errors and all(r is not True for r in readable), (readable, errors))
    check('嵌台框没有 sandbox 属性（防护不靠改框的属性）', pg.evaluate("[...document.querySelectorAll('.wm-panel-body iframe')].every(f => !f.hasAttribute('sandbox'))"))
    b.close()

print(f'cockpit-embed-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
