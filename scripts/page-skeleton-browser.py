"""#317 页面骨架浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
每个页面：有 PageContainer、标题 = 菜单页面名、面包屑 = 分组 / 页面（分组不是链接）、右上至多 1 个 primary；
驾驶舱详情：面包屑 = 工作 / 驾驶舱 / <驾驶舱名>，页面名可点回列表。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
PAGES = [('/', '工作', '总览'), ('/tasks', '工作', '统一待办'), ('/cockpit', '工作', '驾驶舱'), ('/sops', '交付', 'SOP 交付空间'),
         ('/market', '资源', '工作台市场'), ('/skills', '资源', '技能市场'), ('/lifecycle', '治理', '生命周期全景'),
         ('/mcp-gateways', '管理', 'MCP 网关'), ('/types', '管理', '类型管理'), ('/settings', '管理', '设置')]
CRUMBS = "[...document.querySelectorAll('.ant-page-header .ant-breadcrumb li')].filter(li=>!li.classList.contains('ant-breadcrumb-separator')).map(li=>[li.innerText.trim(), !!li.querySelector('a')])"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 800})
    for path, group, name in PAGES:
        pg.goto(M + path)
        try: pg.wait_for_selector('.wm-page .ant-page-header-heading-title', timeout=10000)
        except Exception: check(f'{path} 有 PageContainer 骨架', False); continue
        title = pg.locator('.wm-page .ant-page-header-heading-title').first.inner_text().strip()
        crumbs = pg.evaluate(CRUMBS)
        primaries = pg.locator('.wm-page .ant-page-header-heading-extra .ant-btn-primary').count()
        check(f'{path} 骨架齐：标题「{name}」· 面包屑 {group}/{name} · 主操作 ≤1',
              title == name and [c[0] for c in crumbs] == [group, name] and not crumbs[0][1] and primaries <= 1, (title, crumbs, primaries))
    pg.goto(M + f"/cockpit/{cfg['cockpit']}")
    pg.wait_for_selector('.wm-page .ant-breadcrumb')
    pg.wait_for_function("document.querySelectorAll('.ant-page-header .ant-breadcrumb li:not(.ant-breadcrumb-separator)').length===3")
    crumbs = pg.evaluate(CRUMBS)
    check('驾驶舱详情面包屑 = 工作 / 驾驶舱 / 详情名，页面名可点', [c[0] for c in crumbs] == ['工作', '驾驶舱', cfg['cockpit_name']] and crumbs[1][1] and not crumbs[0][1] and not crumbs[2][1], crumbs)
    pg.locator('.ant-page-header .ant-breadcrumb a', has_text='驾驶舱').click()
    pg.wait_for_url(M + '/cockpit')
    check('点面包屑「驾驶舱」回到列表', pg.evaluate('location.pathname') == '/cockpit')
    b.close()
print(f'page-skeleton-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
