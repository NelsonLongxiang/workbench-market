"""#319 列表规则浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
统一待办：ProTable、记录全部可读（翻页收齐 = 接口条数）、ID 不重复、来源用 tag；
工作台市场 / SOP 列表：状态列固定最左、操作列固定最右、每行直接操作 ≤2（其余在「更多」）、时间为相对时间；
类型管理：数字列右对齐；技能市场 / MCP 网关：ProTable。"""
import json, re, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
REL = re.compile(r'前|后|刚刚')
def headers(pg, scope):
    return [t.strip() for t in pg.locator(f'{scope} thead th').all_inner_texts() if t.strip()]
def direct_actions(pg, scope):
    """每行操作列里除「更多操作」外的直接按钮数"""
    out = []
    for r in pg.locator(f'{scope} .ant-table-row').all():
        cell = r.locator('td').last
        out.append(cell.locator('.ant-btn:not([aria-label="更多操作"])').count())
    return out

api_tasks = json.load(urllib.request.urlopen(M + '/api/tasks'))['tasks']
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    # ── 统一待办 ──
    pg.goto(M + '/tasks'); pg.wait_for_selector('.wm-tasks-table .ant-table-row')
    ids = [t['id'] for t in api_tasks]
    check(f'统一待办接口 ID 不重复（{len(ids)} 条）', len(ids) == len(set(ids)) and len(ids) >= cfg['min_tasks'], len(ids))
    check('统一待办是 ProTable，列序 状态 → 标题 → 来源 … → 操作', headers(pg, '.wm-tasks-table')[:3] == ['状态', '标题', '来源'] and headers(pg, '.wm-tasks-table')[-1] == '操作', headers(pg, '.wm-tasks-table'))
    total = pg.locator('.wm-tasks-table .ant-pagination-total-text').inner_text()
    check('分页总数 = 接口条数', total == f'共 {len(api_tasks)} 条', total)
    seen = []
    while True:
        seen += [r.get_attribute('data-row-key') for r in pg.locator('.wm-tasks-table .ant-table-row').all()]
        nxt = pg.locator('.wm-tasks-table .ant-pagination-next')
        if nxt.get_attribute('aria-disabled') == 'true': break
        nxt.click(); pg.wait_for_timeout(150)
    check('翻页收齐全部记录（原先截断 200 条）且每条只出现一次', sorted(seen) == sorted(ids), (len(seen), len(ids)))
    pg.locator('.wm-tasks-table .ant-pagination-item-1').click(); pg.wait_for_timeout(150)
    src = pg.locator('.wm-tasks-table .ant-table-row').first.locator('td').nth(2).inner_text().strip()
    check('来源列用 tag 文字标出', src in ('market', 'ygl-trees', 'a2a', '生命周期'), src)
    pg.locator('.wm-page input[placeholder="搜索标题 / 项目"]').fill('run#1 '); pg.keyboard.press('Enter'); pg.wait_for_timeout(200)
    rows = pg.locator('.wm-tasks-table .ant-table-row').count()
    check('关键词筛选生效', 0 < rows < len(api_tasks), rows)
    # ── 工作台市场 ──
    pg.goto(M + '/market'); pg.wait_for_selector('.ant-table-row')
    h = headers(pg, '.wm-page')
    check('市场列序：状态最左、名称第二、操作最右', h[0] == '状态' and h[1] == '名称' and h[-1] == '操作', h)
    check('市场状态列固定最左、操作列固定最右', pg.locator('.wm-page thead th').first.evaluate("e=>e.className").find('fix-left') >= 0 and pg.locator('.wm-page thead th').last.evaluate("e=>e.className").find('fix-right') >= 0)
    da = direct_actions(pg, '.wm-page')
    check(f'市场每行直接操作 ≤2（{da}）', da and max(da) <= 2)
    pg.locator('.ant-table-row').first.get_by_role('button', name='更多操作').click()
    items = [t.strip() for t in pg.locator('.ant-dropdown:visible .ant-dropdown-menu-item').all_inner_texts()]
    check('「更多」里有 检测 / 复制工作台 / 删除', all(x in items for x in ['检测', '复制工作台', '删除']), items)
    pg.keyboard.press('Escape')
    st = pg.locator('.ant-table-row').first.locator('td').first.inner_text()
    check('市场检测时间为相对时间', bool(REL.search(st)), st)
    # ── SOP 列表 ──
    pg.goto(M + '/sops'); pg.wait_for_selector('.ant-table-row')
    h = headers(pg, '.wm-page .ant-pro-table')
    check('SOP 列序：状态最左、标题第二、操作最右', h[0] == '状态' and h[1] == '标题' and h[-1] == '操作', h)
    da = direct_actions(pg, '.wm-page .ant-pro-table')
    check(f'SOP 每行直接操作 ≤2（{da}）', da and max(da) <= 2)
    upd = pg.locator('.wm-page .ant-pro-table .ant-table-row').first.locator('td').nth(h.index('更新时间')).inner_text()
    check('SOP 更新时间为相对时间', bool(REL.search(upd)), upd)
    # ── 类型管理：数字右对齐 ──
    pg.goto(M + '/types'); pg.wait_for_selector('.ant-table-row')
    h = headers(pg, '.wm-page')
    al = [pg.locator('.ant-table-row').first.locator('td').nth(h.index(c)).evaluate('e=>getComputedStyle(e).textAlign') for c in ('默认端口', '使用中')]
    check('类型数字列右对齐', al == ['right', 'right'], al)
    # ── 技能市场 / MCP 网关：ProTable ──
    for path in ('/skills', '/mcp-gateways'):
        pg.goto(M + path); pg.wait_for_selector('.wm-page .ant-table')
        check(f'{path} 列表为 ProTable', pg.locator('.wm-page .ant-pro-table').count() >= 1)
    b.close()
print(f'list-rules-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
