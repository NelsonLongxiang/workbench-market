"""经验库（照原型 3fbfd0b 的 #/knowledge）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
读接口还没有：页面顶上那一句照原型，下面说清现在没有、以后按依据 / 经验 / 方法 / 检查四类出现；不列条目、不造数据，也不发取数请求。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    asked = []
    pg.on('request', lambda r: asked.append(r.url) if 'knowledge' in r.url and '/api/' in r.url else None)
    pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-empty]'); pg.wait_for_load_state('networkidle')
    check('顶栏标题是导航名「经验库」，不再是「这一页还在做」', pg.locator('.wm-top-title').inner_text().strip() == '经验库' and pg.locator('[data-testid=not-yet]').count() == 0)
    check('顶上那一句照原型', pg.locator('[data-testid=kn-intro]').inner_text().startswith('公司越用越聪明'))
    kinds = [pg.locator('[data-testid=kn-kind]').nth(i).locator('.ant-list-item-meta-title').inner_text().strip() for i in range(pg.locator('[data-testid=kn-kind]').count())]
    check('说清四类，先后照原型：依据、经验、方法、检查', kinds == ['依据', '经验', '方法', '检查'], kinds)
    empty = pg.locator('[data-testid=kn-empty] .ant-empty-description').inner_text()
    check('空态说现在没有、以后从事项里来；不说在等哪个接口', '还没有内容' in empty and '事项' in empty and '接口' not in empty, empty)
    check('不造条目：没有「来自事项」的链接，也不去取经验库的数据', pg.locator('[data-testid=kn-empty] a').count() == 0 and asked == [], asked)
    b.close()

print(f'knowledge-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
