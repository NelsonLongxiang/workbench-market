"""嵌台防护（驾驶舱不把市场套进市场）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
用合成实例里「旧布局舱」的两个工作台面板：
  · 登记的地址和市场同源、又不在台的路径下（合成实例里登记的是 <市场>/api/health）：不嵌，写「这个台的地址指向市场本身，不能嵌在驾驶舱里」；
  · 地址在台的路径下（截下 /api/workbenches 改成 /apps/…），但 /go/<id>/ 回来的是市场自己的页面（真的市场首页）：框里的市场页认出自己被市场嵌着，只写一句，不起整个市场；
    嵌台框本身不加事件、不加 ref（判据 65：框的属性只有 key/className/src/title/allow）；
  · 回来的是别的页面：照常嵌；
  · 框读不到（台的页面是沙箱的不透明源）：哪怕带着市场的标记也照常嵌、不报错——防护只在框本来同源可读时生效，不靠改框的 sandbox。"""
import json, re, sys
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
TEXT = '这个台的地址指向市场本身，不能嵌在驾驶舱里'
def soft(fn):
    """等条件成立；等不到不在这里抛错，照常往下，由后面原来的断言报（带着当时的值）"""
    try: fn()
    except PWTimeout: pass
def until(pg, pred, timeout=10000):
    """等测试这边记下的状态（请求日志）满足 pred：每 20 毫秒看一次，期间照常处理截下的请求；到点就停，不抛错"""
    for _ in range(timeout // 20):
        if pred(): return
        pg.wait_for_timeout(20)
def painted(pg):
    """等页面再画两帧"""
    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    url = M + f'/cockpit/{cfg["legacy_cockpit"]}'
    pg.goto(url); pg.wait_for_selector('.wm-panel')
    # 嵌不嵌只看登记的地址，和框是同一次渲染定的：等两个面板都画成说明（这时也就知道框没起）
    soft(lambda: pg.wait_for_function("() => document.querySelectorAll('[data-testid=go-self]').length === 2", timeout=10000))
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
    pg.goto(url); pg.wait_for_selector('.wm-panel')
    # 等两个框都起来、都读得到：一个里面的市场页已经认出自己被嵌、换成那一句，另一个是别的页面
    soft(lambda: pg.wait_for_function("""() => { const fs = [...document.querySelectorAll('.wm-panel-body iframe')]; if (fs.length !== 2) return false;
      const ts = fs.map(f => { try { return f.contentDocument?.body?.innerText || ''; } catch { return ''; } });
      return ts.some(t => t.includes('指向市场本身')) && ts.some(t => t.includes('a bench')); }""", timeout=15000))
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
    # 证明「没有」：两个框各要一次 /go/（截下的应答记下来），等两次应答都回来、框都加载完、页面画完，再看没换成说明、没报错
    go_resp = []
    pg.on('response', lambda r: go_resp.append(r.url) if re.search(r'/go/\d+/', r.url) else None)
    pg.goto(url); pg.wait_for_selector('.wm-panel')
    until(pg, lambda: len(go_resp) >= 2)
    for f in pg.main_frame.child_frames:
        soft(lambda: f.wait_for_load_state('load', timeout=10000))
    painted(pg)
    readable = pg.evaluate("[...document.querySelectorAll('.wm-panel-body iframe')].map(f => { try { return !!f.contentDocument && !!f.contentDocument.querySelector('meta'); } catch { return 'blocked'; } })")
    check('读不到的框（沙箱的不透明源）：照常嵌，不换成说明、不报错', pg.locator('.wm-panel-body iframe').count() == 2 and pg.locator('[data-testid=go-self]').count() == 0 and not errors and all(r is not True for r in readable), (readable, errors))
    check('嵌台框没有 sandbox 属性（防护不靠改框的属性）', pg.evaluate("[...document.querySelectorAll('.wm-panel-body iframe')].every(f => !f.hasAttribute('sandbox'))"))
    b.close()

print(f'cockpit-embed-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
