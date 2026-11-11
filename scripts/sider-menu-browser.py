"""外壳浏览器回归（产品化原型 3fbfd0b 的新外壳，#571）；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
断言：旧路由直接打开仍可用 · 侧栏主入口七个按序、各有专属图标 · 侧栏文字对比度 ≥4.5 · 「全景」角标 = 「关注」条数 ·
我的驾驶舱列出驾驶舱并可跳转 · 「设置 / 管理」只对管理员出现、点开五项可跳转 · 用户卡点开是弹出层（口令在里面）·
/ 是全景 · 没有「旧版页面」菜单 · 控制面没口令也看不到管理入口。"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']; C = cfg['control']; TOK = cfg['token']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def lum(rgb):
    def ch(v):
        v = v / 255; return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = rgb; return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True); return (la + 0.05) / (lb + 0.05)
def rgb(s): return tuple(int(float(x)) for x in s[s.index('(') + 1:s.index(')')].split(',')[:3])
def attention_count(token=None):
    req = urllib.request.Request(M + '/api/attention', headers={'x-admin-token': token} if token else {})
    try: return len(json.load(urllib.request.urlopen(req)).get('items', []))
    except Exception: return 0

MAIN = ['全景', '事项', '驾驶舱', '团队', '谁能做什么', '工作台市场', '经验库']
ADMIN = ['待属主看板', 'MCP 网关', '凭据库', '类型管理', '设置']
SIDE = '[data-testid=wm-side]'
MAIN_JS = """[...document.querySelectorAll('[data-testid=wm-side] nav[aria-label="工作"] .wm-nav-item')].map(e=>{const cs=getComputedStyle(e);return [e.innerText.split('\\n')[0].trim(), cs.color, [...(e.querySelector('.wm-nav-icon .anticon')?.classList||[])].find(c=>c.startsWith('anticon-'))||null]})"""

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 900})
    # 旧路由、新路由直接打开都还在（不被重定向到 /），外壳都在
    for path in ['/', '/work-items', '/cockpit', '/team', '/access', '/market', '/knowledge', '/overview', '/attention', '/tasks', '/sops', '/skills', '/reviews', '/mcp-gateways', '/types', '/settings']:
        pg.goto(M + path); pg.wait_for_selector(SIDE)
        check(f'业务面 {path} 直接打开可用（未被重定向到 /）', pg.evaluate('location.pathname') == path, pg.evaluate('location.pathname'))
    pg.goto(M + '/'); pg.wait_for_selector(SIDE)
    check('/ 是全景（顶栏标题）', pg.locator('.wm-top-title').first.inner_text().strip() == '全景', pg.locator('.wm-top-title').first.inner_text())
    items = pg.evaluate(MAIN_JS); names = [i[0] for i in items]
    check('侧栏主入口七个、按原型顺序', names == MAIN, names)
    icons = [i[2] for i in items]
    check('主入口各有专属图标、不复用', None not in icons and len(set(icons)) == len(icons), icons)
    bg = rgb(pg.evaluate(f"getComputedStyle(document.querySelector('{SIDE}')).backgroundColor"))
    worst = min((ratio(rgb(c), bg), n) for n, c, _ in items)
    check(f'侧栏主入口文字对比度 ≥4.5（最低 {worst[0]:.2f} @{worst[1]}）', worst[0] >= 4.5)
    check('当前页在侧栏有选中态', pg.locator('[data-testid="nav-/"].on').count() == 1)
    check('没有「旧版页面」菜单', '旧版页面' not in pg.locator(SIDE).inner_text())
    check('没口令：侧栏没有「设置 / 管理」', pg.locator('[data-testid=nav-admin]').count() == 0)
    # 我的驾驶舱
    ck = pg.locator(f'{SIDE} nav[aria-label="我的驾驶舱"] a', has_text=cfg['cockpit_name'])
    check('「我的驾驶舱」列出驾驶舱', ck.count() == 1, pg.locator(SIDE).inner_text())
    ck.first.click(); pg.wait_for_url(M + f"/cockpit/{cfg['cockpit']}")
    check('点驾驶舱跳到它的详情', pg.evaluate('location.pathname') == f"/cockpit/{cfg['cockpit']}")
    # 用户卡 → 弹出层 → 口令
    pg.goto(M + '/'); pg.wait_for_selector(SIDE)
    pg.locator('[data-testid=wm-me]').click()
    pop = pg.locator('.wm-me-pop'); pop.wait_for()
    check('用户卡点开是弹出层，口令在里面', pop.is_visible() and pop.locator('button', has_text='口令').count() == 1)
    pop.locator('button', has_text='口令').click()
    pg.locator('.ant-popover input[type=password]').last.fill(TOK)
    pg.locator('.ant-popover button', has_text='保').last.click()
    pg.wait_for_selector('[data-testid=nav-admin]', timeout=10000)
    pg.keyboard.press('Escape'); pg.mouse.click(900, 450); pg.wait_for_timeout(300)  # 关掉用户卡弹出层
    check('有口令：侧栏底部出现「设置 / 管理」', pg.locator('[data-testid=nav-admin]').count() == 1)
    # 角标 = 「关注」给这个身份的条数
    want = attention_count(TOK)
    pg.wait_for_timeout(600)
    got = pg.locator('[data-testid=nav-pending]')
    got_n = int(got.inner_text()) if got.count() else 0
    check(f'「全景」角标 = 关注条数（{got_n} / {want}）', want > 0 and got_n == want, (got_n, want))
    # 设置 / 管理：五项，点了跳转
    pg.locator('[data-testid=nav-admin]').click(); pg.wait_for_timeout(400)
    menu = [t.strip() for t in pg.locator('.ant-dropdown:visible .ant-dropdown-menu-item').all_inner_texts()]
    check('「设置 / 管理」里五项', menu == ADMIN, menu)
    pg.locator('.ant-dropdown:visible .ant-dropdown-menu-item', has_text='类型管理').click()
    pg.wait_for_url(M + '/types')
    check('点「类型管理」跳到 /types', pg.evaluate('location.pathname') == '/types')
    check('在管理页时「设置 / 管理」是选中态', pg.locator('[data-testid=nav-admin].on').count() == 1)
    # 控制面：没口令看不到管理入口
    pg2 = b.new_page(viewport={'width': 1440, 'height': 900})
    pg2.goto(C + '/types'); pg2.wait_for_selector(SIDE)
    check('控制面没口令：看不到「设置 / 管理」', pg2.locator('[data-testid=nav-admin]').count() == 0)
    b.close()
print(f'sider-menu-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
