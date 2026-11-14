"""单个台的详情（/market/wb/:id）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
合成实例里登记了两个工作台（读实例真的）；读不到、停用这几种用 page.route 截下的合成应答。
  · 头部：名字、类别、在线状态；说明（没有写「还没有说明」）；「打开」去 /use/<id>；
  · 不是管理员：没有「管理」那一栏，写一句由管理员来；
  · 不在了（404、台号不对）/ 没权限（403）/ 读不到（500，能再试一次）各说各的；停用的台对不是管理员的人只说已停用、没有「打开」；
  · 管理员：立即检测发 POST /check；编辑回到管理页那一行（?q=台名，表里只剩这一行）；停用先确认，「再想想」不发请求，确认才发 PUT {enabled:false}。
  · 技能（/market/skill/<标识>，2026-11-14 属主定了删掉上一版的 /skills 总表）：点技能卡片的「查看」进这个技能自己的页面；
    名字、层、现在第几版、说明、历次版本（不兼容的标出来）；标识、摘要、快照路径、像标识的审阅人都不写在页面的字上；没有这个技能说没有；/skills 不再是页面。
    合成实例里没有技能：/api/skills 和版本接口用 page.route 截成合成的应答。"""
import json, re, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, TOK = cfg['base'], cfg['token']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
with urllib.request.urlopen(urllib.request.Request(M + '/api/workbenches')) as r: wbs = [w for w in json.load(r) if w.get('enabled', True)]
# 编辑按名字筛管理页：挑一个名字不被别的台名包含的（「列表合成台」会把「列表合成台二」也筛出来）
W = next(w for w in wbs if not any(w['name'] in o['name'] for o in wbs if o is not w))

SETTLED = """(sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect();
  const host = e.closest('.ant-popover, .ant-dropdown'); if (!host || r.width === 0 || r.height === 0) return false;
  return ![...host.classList].some(c => /-(appear|enter|leave)(-|$)/.test(c)) && !host.classList.contains('ant-popover-hidden') && !host.classList.contains('ant-dropdown-hidden'); }"""
def settled(pg, sel, timeout=10000): pg.wait_for_function(SETTLED, arg=sel, timeout=timeout)
def set_token(pg):
    pg.locator('[data-testid=wm-me]').click()
    pg.locator('[data-testid=wm-me][aria-expanded=true]').wait_for(); settled(pg, '.wm-me-pop')
    pg.locator('.wm-me-pop button', has_text='口令').click()
    pg.locator('.ant-popover input[type=password]').last.wait_for(); settled(pg, '.ant-popover input[type=password]')
    pg.locator('.ant-popover input[type=password]').last.fill(TOK)
    pg.locator('.ant-popover button', has_text='保').last.click()
    pg.wait_for_selector('[data-testid=nav-admin]', timeout=10000)
    pg.keyboard.press('Escape'); pg.mouse.click(800, 26); pg.wait_for_timeout(300)
def fake(status, body):
    return lambda r: r.fulfill(status=status, content_type='application/json', body=json.dumps(body))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    # 从市场卡片的「详情」入口进
    pg.goto(M + '/market'); pg.wait_for_selector('[data-testid=mkt-detail]')
    cell = pg.locator('.wm-mkt-cell', has=pg.locator(f'[data-testid=mkt-detail][href="/market/wb/{W["id"]}"]')).first
    box = cell.bounding_box(); d = cell.locator('[data-testid=mkt-detail]').bounding_box(); go = cell.locator('.wm-mkt-go').bounding_box()
    check('「详情」在卡片右下角、「打开 →」右边同一行，是两个字的文字链接（右上角是质量评级那一格，不放东西）',
          d['y'] > box['y'] + box['height'] / 2 and d['x'] + d['width'] > box['x'] + box['width'] * 0.8 and d['x'] >= go['x'] + go['width'] and abs((d['y'] + d['height'] / 2) - (go['y'] + go['height'] / 2)) < 6
          and cell.locator('[data-testid=mkt-detail]').inner_text().strip() == '详情', (box, d, go))
    pg.locator(f'[data-testid=mkt-detail][href="/market/wb/{W["id"]}"]').click(); pg.wait_for_selector('[data-testid=wbd-main]')
    check('从卡片右下角的「详情」进来：地址是 /market/wb/<id>，名字对', pg.url.endswith(f'/market/wb/{W["id"]}') and pg.locator('[data-testid=wbd-name]').inner_text().strip() == W['name'], pg.url)
    crumb = pg.locator('.wm-top-crumb').inner_text().replace('\n', ' ')
    check('顶栏「工作台市场 / 台名」', '工作台市场' in crumb and W['name'] in crumb, crumb)
    check('头部有在线状态；说明区有字（没有说明写「还没有说明」）', pg.locator('[data-testid=wbd-status]').count() == 1 and pg.locator('[data-testid=wbd-desc]').inner_text().strip() != '')
    check('不是管理员：没有「管理」那一栏，写一句由管理员来', pg.locator('[data-testid=wbd-admin]').count() == 0 and pg.locator('[data-testid=wbd-readonly]').count() == 1)
    pg.locator('[data-testid=wbd-open]').click(); pg.wait_for_url(re.compile(rf'/use/{W["id"]}$'))
    check('「打开」去 /use/<id>', pg.url.endswith(f'/use/{W["id"]}'))

    # 这个台的数据视图（#674）：数据视图的台清单里有 workbench_id 正好是这个台号的，就列它的视图名；别的情况整块不出现
    BV = re.compile(r'/api/bench-views$'); DOC = re.compile(r'/api/bench-views/syn-bench/view$')
    def bench_list(match):
        return lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'benches': [{'slug': 'syn-bench', 'title': '合成台', 'workbench_id': W['id'] if match else 99999}, {'slug': 'syn-other', 'title': W['name'], 'workbench_id': None}]}))
    pg.route(DOC, fake(200, {'view': {'content': {'views': [{'key': 'board', 'title': '合成看板'}, {'key': 'rows', 'title': '合成明细'}]}}}))
    pg.route(BV, bench_list(True)); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-views]')
    check('有对应的数据视图台：列视图的名字（只读），说在驾驶舱里怎么挂', [t.strip() for t in pg.locator('[data-testid=wbd-view]').all_inner_texts()] == ['合成看板', '合成明细'] and '驾驶舱' in pg.locator('[data-testid=wbd-views]').inner_text())
    for label, handler in (('没有 workbench_id 对上的（同名的台不算）', bench_list(False)), ('清单 403（没权限）', fake(403, {'error': 'bench_views_forbidden'})), ('数据视图没开（404）', fake(404, {'error': 'bench_views_off'}))):
        pg.unroute(BV); pg.route(BV, handler); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-main]'); pg.wait_for_timeout(600)
        check(f'{label}：整块不出现，不报错', pg.locator('[data-testid=wbd-views]').count() == 0 and pg.locator('.ant-alert-error').count() == 0)
    pg.unroute(BV); pg.route(BV, bench_list(True)); pg.unroute(DOC); pg.route(DOC, fake(403, {'error': 'forbidden'}))
    pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-main]'); pg.wait_for_timeout(600)
    check('对上了但视图读不到（403）：整块不出现', pg.locator('[data-testid=wbd-views]').count() == 0)
    pg.unroute(BV); pg.unroute(DOC)

    # 读不到的几种
    for path, want in [('/market/wb/abc', 'gone'), ('/market/wb/999999', 'gone')]:
        pg.goto(M + path); pg.wait_for_selector('[data-testid=wbd-problem]')
        check(f'{path}：说这个台不在了，有回市场的链接', pg.locator('[data-testid=wbd-problem]').get_attribute('data-kind') == want and '不在了' in pg.locator('[data-testid=wbd-problem]').inner_text())
    ONE = re.compile(rf'/api/workbenches/{W["id"]}$')
    pg.route(ONE, fake(403, {'error': 'forbidden'})); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-problem]')
    check('403：说你的账号现在不能查看，不弹口令', '不能查看这个台' in pg.locator('[data-testid=wbd-problem]').inner_text() and pg.locator('.ant-modal').count() == 0)
    pg.unroute(ONE); pg.route(ONE, fake(500, {'error': 'x'})); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-problem]')
    retry = pg.get_by_role('button', name='再试一次')
    check('500：说读不到、能再试一次', '读不到这个台' in pg.locator('[data-testid=wbd-problem]').inner_text() and retry.count() == 1)
    pg.unroute(ONE); retry.click(); pg.wait_for_selector('[data-testid=wbd-main]')
    check('再试一次：读到了就显示', pg.locator('[data-testid=wbd-name]').inner_text().strip() == W['name'])
    pg.route(ONE, fake(200, dict(W, enabled=False))); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-disabled]')
    check('停用的台，不是管理员：只说已停用，没有「打开」', pg.locator('[data-testid=wbd-open]').count() == 0 and '已经停用' in pg.locator('[data-testid=wbd-disabled]').inner_text())
    pg.unroute(ONE)

    # 管理员
    pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-main]')
    set_token(pg); pg.wait_for_selector('[data-testid=wbd-admin]')
    writes = []
    def on_check(r): writes.append(('check', r.request.method)); r.fulfill(status=200, content_type='application/json', body=json.dumps(dict(W, last_status='up', last_checked_at='2026-11-12 09:00:00')))
    def on_put(r):
        if r.request.method == 'PUT': writes.append(('put', r.request.post_data)); r.fulfill(status=200, content_type='application/json', body=json.dumps(dict(W, enabled=False)))
        else: r.continue_()
    pg.route(re.compile(rf'/api/workbenches/{W["id"]}/check$'), on_check); pg.route(ONE, on_put)
    pg.locator('[data-testid=wbd-check]').click(); pg.wait_for_timeout(600)
    check('管理员「立即检测」：发 POST /check，状态跟着变', writes == [('check', 'POST')] and pg.locator('[data-testid=wbd-status]').inner_text().strip() != '', writes)
    pg.locator('[data-testid=wbd-disable]').click(); pg.locator('.ant-popconfirm').wait_for(); settled(pg, '.ant-popconfirm')
    pg.locator('.ant-popconfirm button', has_text='再想想').click(); pg.wait_for_timeout(400)
    check('停用先确认：「再想想」不发请求', [w for w in writes if w[0] == 'put'] == [], writes)
    pg.locator('[data-testid=wbd-disable]').click(); pg.locator('.ant-popconfirm').wait_for(); settled(pg, '.ant-popconfirm')
    pg.locator('.ant-popconfirm .ant-btn-primary').click(); pg.wait_for_selector('[data-testid=wbd-enable]')
    puts = [json.loads(w[1] or '{}') for w in writes if w[0] == 'put']
    check('确认停用：发 PUT {enabled:false}，页面标「已停用」、换成「启用」', puts == [{'enabled': False}] and pg.locator('[data-testid=wbd-off]').count() == 1, puts)
    pg.unroute(ONE); pg.goto(M + f'/market/wb/{W["id"]}'); pg.wait_for_selector('[data-testid=wbd-main]')
    set_token(pg); pg.wait_for_selector('[data-testid=wbd-admin]')  # 口令离开页面就清（#292），再设一次
    pg.locator('[data-testid=wbd-edit]').click(); pg.wait_for_selector('.ant-table-row')
    pg.wait_for_timeout(600)
    rows = pg.locator('.ant-table-row')
    check('「编辑」回到管理页那一行：地址带 ?q=台名，表里只剩这一行', '/market/manage?q=' in pg.url and rows.count() == 1 and W['name'] in rows.first.inner_text(), (pg.url, rows.count()))
    pg.close()

    # 技能自己的页面
    SK = [{'slug': 'dsh:syn-skill-a', 'name': '合成技能甲', 'layer': 2, 'layer_name': '开发运维', 'family_parent': '合成族', 'description': '把合成数据整理成表。', 'legacy': False, 'versions': 2, 'active_version': 2},
          {'slug': 'dsh:syn-skill-b', 'name': '合成技能乙', 'layer': 1, 'layer_name': '业务角色', 'family_parent': '', 'description': '', 'legacy': True, 'versions': 1, 'active_version': 1}]
    VS = {'slug': 'dsh:syn-skill-a', 'active_version': 2, 'versions': [
        {'version': 1, 'changelog': '首版', 'breaking': 0, 'active': False, 'file_count': 3, 'total_bytes': 2048, 'reviewed_by': '合成审阅人', 'created_at': '2026-11-10 08:00:00', 'tree_digest': 'sha256:feedfacecafe', 'snapshot_path': 'skill-snapshots/dsh%3Asyn-skill-a/v1'},
        {'version': 2, 'changelog': '改了表头', 'breaking': 1, 'active': True, 'file_count': 4, 'total_bytes': 4096, 'reviewed_by': 'user:syn-reviewer', 'created_at': '2026-11-12 08:00:00', 'tree_digest': 'sha256:0badf00d', 'snapshot_path': 'skill-snapshots/dsh%3Asyn-skill-a/v2'}]}
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route(re.compile(r'/api/skills(\?.*)?$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(SK)))
    pg.route(re.compile(r'/api/skills/[^/]+/versions'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(VS)) if 'syn-skill-a' in r.request.url else r.fulfill(status=404, content_type='application/json', body='{"error":"not_found"}'))
    pg.goto(M + '/market?k=技能'); pg.wait_for_selector('[data-testid=mkt-card][data-kind=技能]')
    card = pg.locator('[data-testid=mkt-card][data-kind=技能]', has_text='合成技能甲').first
    check('技能卡片的「查看」去这个技能自己的页面（不是上一版的技能市场总表）', card.get_attribute('href') == '/market/skill/dsh%3Asyn-skill-a', card.get_attribute('href'))
    card.click(); pg.wait_for_selector('[data-testid=skd-main]'); pg.wait_for_selector('[data-testid=skd-version]')
    main = pg.locator('[data-testid=skd-main]').inner_text()
    check('技能页：名字、层、现在第几版、说明、族', pg.locator('[data-testid=skd-name]').inner_text() == '合成技能甲' and '开发运维' in main and '现在是第 2 版' in main and '把合成数据整理成表' in main and '合成族' in main, main)
    vers = pg.locator('[data-testid=skd-version]').all_inner_texts()
    check('历次版本：新的在前；现在用的、不兼容的标出来；改了什么、几个文件', len(vers) == 2 and vers[0].startswith('第 2 版') and '现在用的' in vers[0] and '和上一版不兼容' in vers[0] and '改了表头' in vers[0] and '首版' in vers[1] and '3 个文件' in vers[1], vers)
    check('审阅人写名字；像标识的（user:…）不写', '合成审阅人 审过' in vers[1] and 'syn-reviewer' not in vers[0])
    text = pg.locator('main').inner_text()
    check('技能的标识、摘要、快照路径不写在页面的字上', not any(x in text for x in ('dsh:', 'syn-skill-a', 'sha256', 'feedface', 'skill-snapshots')), text[:120])
    pg.goto(M + '/market/skill/dsh%3Anope'); pg.wait_for_selector('[data-testid=skd-problem]')
    check('没有这个技能：说没有，给回市场的链接', '没有这个技能' in pg.locator('[data-testid=skd-problem]').inner_text() and pg.locator('[data-testid=skd-problem] a', has_text='回到工作台市场').count() == 1)
    pg.goto(M + '/skills'); pg.wait_for_timeout(800)
    check('上一版的 /skills 不再是页面：不出那张按层分类的总表', pg.locator('.ant-pro-table').count() == 0 and '五层治理' not in pg.locator('body').inner_text() and pg.locator('.ant-segmented', has_text='业务角色').count() == 0)
    b.close()

print(f'market-detail-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
