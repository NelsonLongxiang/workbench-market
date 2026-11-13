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
         ('/attention', '等你拍板'), ('/sops', 'SOP 交付空间'), ('/skills', '技能市场'),
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
        # 内容区不能比主区卡片宽（宽表页 wide 在 1440 下曾经向右溢出 64px）
        over = pg.evaluate("(() => { const b = document.querySelector('.wm-page-body'), m = document.querySelector('.wm-main'); if (!b || !m) return 0; return Math.round(b.getBoundingClientRect().right - m.getBoundingClientRect().right); })()")
        check(f'{path} 顶栏：标题「{name}」· 高 52 · 主操作 ≤1 · 无旧面包屑大标题 · 内容区不溢出', title == name and h == 52 and primaries <= 1 and old == 0 and over <= 0, (title, h, primaries, old, over))
    # 宽表页（WmPage wide）：现在没有页面在用，所以在一个页面上临时加上 wide 的类来量——
    # 内容区含内边距不能超出主区卡片，左右留白对称（1440 下曾经向右溢出 64px）
    pg.goto(M + '/market'); pg.wait_for_selector('.wm-page-body')
    wide = pg.evaluate("""(() => { const b = document.querySelector('.wm-page-body'), m = document.querySelector('.wm-main'); b.classList.add('wm-page-body-wide');
      const rb = b.getBoundingClientRect(), rm = m.getBoundingClientRect(); return [Math.round(rb.left - rm.left), Math.round(rm.right - rb.right), Math.round(rb.width)]; })()""")
    check(f'宽表页内容区不溢出主区、左右对称（左 {wide[0]} 右 {wide[1]} 宽 {wide[2]}）', wide[0] >= 0 and wide[1] >= 0 and abs(wide[0] - wide[1]) <= 2, wide)
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
