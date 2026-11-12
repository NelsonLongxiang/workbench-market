"""页面骨架浏览器回归（新外壳 #571）；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
每个页面：52px 顶栏，标题 = 导航里的页面名（旧入口也有名字），没有 antd 面包屑大标题，右上至多 1 个 primary；
详情页：顶栏「页面名 / 详情名」，页面名可点回列表。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
PAGES = [('/', '全景'), ('/work-items', '事项'), ('/cockpit', '驾驶舱'), ('/team', '团队'), ('/access', '谁能做什么'), ('/market', '工作台市场'), ('/knowledge', '经验库'),
         ('/overview', '原来的总览'), ('/attention', '关注'), ('/tasks', '统一待办'), ('/sops', 'SOP 交付空间'), ('/skills', '技能市场'),
         ('/owner-pending', '待属主看板'), ('/mcp-gateways', 'MCP 网关'), ('/vault', '凭据库'), ('/types', '类型管理'), ('/settings', '设置')]
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 900})
    for path, name in PAGES:
        pg.goto(M + path)
        try: pg.wait_for_selector('.wm-page [data-testid=wm-top]', timeout=10000)
        except Exception: check(f'{path} 有新外壳的顶栏', False); continue
        top = pg.locator('.wm-page [data-testid=wm-top]').first
        title = top.locator('.wm-top-title').first.inner_text().strip() if top.locator('.wm-top-title').count() else ''
        h = round(top.bounding_box()['height'])
        primaries = top.locator('.wm-top-actions .ant-btn-primary').count()
        old = pg.locator('.ant-page-header, .ant-pro-page-container .ant-breadcrumb').count()
        check(f'{path} 顶栏：标题「{name}」· 高 52 · 主操作 ≤1 · 无旧面包屑大标题', title == name and h == 52 and primaries <= 1 and old == 0, (title, h, primaries, old))
    pg.goto(M + f"/cockpit/{cfg['cockpit']}")
    pg.wait_for_selector('.wm-top-crumb')
    pg.wait_for_function(f"document.querySelector('.wm-top-crumb')?.innerText.includes({json.dumps(cfg['cockpit_name'])})")
    crumb = pg.locator('.wm-top-crumb').inner_text().replace('\n', '').replace(' ', '')
    check('驾驶舱详情顶栏 = 驾驶舱 / 详情名', crumb == f"驾驶舱/{cfg['cockpit_name']}".replace(' ', ''), crumb)
    pg.locator('.wm-top-crumb a', has_text='驾驶舱').click()
    pg.wait_for_url(M + '/cockpit')
    check('点「驾驶舱」回到列表', pg.evaluate('location.pathname') == '/cockpit')
    b.close()
print(f'page-skeleton-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
