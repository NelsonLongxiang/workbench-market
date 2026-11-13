"""经验库（照原型 3fbfd0b 的 #/knowledge）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
读接口（#717：GET /api/knowledge、/api/knowledge/:key）在页面里用 page.route 截下、换成合成的应答：
  一、有内容：四类筛（地址带 ?k=）、条数、一条一行（类别、标题、状态、谁能看）、点进详情；条目编号只在地址里，不在页面的字上；
  二、来源：还没同步成过——整页说还在准备；最近一轮没同步上——列表照常、轻提示；一条都没有——说四类；某一类空——说这一类还没有；
  三、读不到：403 管理口令说「经验库是业务内容」；503 暂时读不到、带再试一次；
  四、详情：markdown 正文、依据的原文（出处只认 http/https 链接）；404 一律「没有这一条」；503 不当成空。"""
import json, os, re, sys
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
SHOT = os.environ.get('WM_SHOT_KNOWLEDGE')
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

KEYS = {'claim': 'k0000000000000000claim1', 'kb': 'k000000000000000000kb01', 'kb2': 'k000000000000000000kb02', 'verify': 'k00000000000000verify01'}
def it(key, kind, title, **more):
    return {'key': key, 'kind': kind, 'title': title, 'summary': more.pop('summary', ''), 'status': more.pop('status', None), 'tags': more.pop('tags', []),
            'created': '2026-11-12 08:00:00', 'updated': '2026-11-13 02:00:00', 'scope_label': more.pop('scope', '全公司'), **more}
# 夹具按身份给（和 #717 的判法一致）：员工只拿得到全公司的和他有部门授予的（采购部）；管理层另外拿得到「只给管理层」的。页面只照应答画，不自己补
MGMT_ONLY = it('k000000000000000000kb02', 'kb', '合成：月底对账只看已到货的', scope='只给管理层')
ITEMS = [
    it(KEYS['claim'], 'claim', '合成：三家报价里最低的一家交期最稳', status='supported', summary='对比了近三个月的到货记录，最低价那家准时率最高。', tags=['采购', '报价'], scope='采购部'),
    it(KEYS['kb'], 'kb', '合成：样品检验不过时先退回供应商，不直接换供应商', summary='第一次不过先退回整改，不直接换供应商。', tags=['检验']),
    it(KEYS['verify'], 'verify', '合成：到货数量和订单对得上', status='FAIL', summary='有 2 张单子少了。'),
]
DETAIL = {'item': ITEMS[0], 'body': '## 结论\n\n最低价那家 **准时率最高**。\n\n<script>window.__xss=1</script>\n\n- 近三个月 12 批\n- 11 批准时',
          'evidence': [{'quote': '第三季度到货记录：12 批中 11 批准时。', 'note': '看的是到货单', 'stance': 'supports', 'created': '2026-11-12 08:00:00', 'source': {'title': '合成到货台账', 'url': 'https://records.example/q3'}},
                       {'quote': '有一批晚了两天。', 'note': '', 'stance': 'refutes', 'created': '2026-11-12 08:00:00', 'source': {'title': '合成异常记录', 'url': 'javascript:alert(1)'}}]}
mode = {'list': 'ok', 'detail': 'ok'}
who = {'role': 'member'}
ME = {'member': {'authenticated': True, 'via': 'cookie', 'login': 'synthetic-alpha', 'display_name': '合成员工甲', 'principal': 'user:synthetic-alpha', 'roles': [{'id': 'member', 'name': '普通员工', 'scope': '*', 'preset': True}]},
      'management': {'authenticated': True, 'via': 'cookie', 'login': 'synthetic-boss', 'display_name': '合成管理层', 'principal': 'user:synthetic-boss', 'roles': [{'id': 'management', 'name': '管理层', 'scope': '*', 'preset': True}]}}
asked = []
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_kn(route):
    u = urlparse(route.request.url); asked.append(u.path)
    if u.path == '/api/knowledge':
        m = mode['list']
        if m == 'ok': return fake(route, {'items': ITEMS + ([MGMT_ONLY] if who['role'] == 'management' else []), 'source': 'ok'})
        if m == 'degraded': return fake(route, {'items': ITEMS[:2], 'source': 'degraded'})
        if m == 'not_ready': return fake(route, {'items': [], 'source': 'not_ready'})
        if m == 'not_connected': return fake(route, {'items': [], 'source': 'not_connected'})
        if m == 'empty': return fake(route, {'items': [], 'source': 'ok'})
        if m == '403': return fake(route, {'error': 'admin_token_not_business'}, 403)
        if m == '503': return fake(route, {'error': 'knowledge_unavailable'}, 503)
    key = unquote(u.path.split('/api/knowledge/')[-1])
    m = mode['detail']
    if m == '503': return fake(route, {'error': 'knowledge_unavailable'}, 503)
    if key == KEYS['claim'] and m == 'ok': return fake(route, DETAIL)
    return fake(route, {'error': 'not_found'}, 404)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route(re.compile(r'/api/knowledge(/[^?]*)?(\?.*)?$'), on_kn)
    # 登录着的合成员工（左下角写名字；经验库是业务内容，真实环境里要登录）
    pg.route(re.compile(r'/api/auth/me$'), lambda r: fake(r, ME[who['role']]))

    print('一、有内容')
    pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-list]')
    check('顶栏标题是导航名「经验库」；顶上那一句照原型', pg.locator('.wm-top-title').inner_text().strip() == '经验库' and pg.locator('[data-testid=kn-intro]').inner_text().startswith('公司越用越聪明'))
    tabs = pg.locator('[data-testid=kn-tabs] .ant-segmented-item-label').all_inner_texts()
    check('普通员工：筛的一排照应答数——全部 3、依据 1、经验 1、方法 0、检查 1，先后照原型', tabs == ['全部 3', '依据 1', '经验 1', '方法 0', '检查 1'], tabs)
    check('普通员工：页面只照应答画，没有「只给管理层」的条目，也不自己补', '只给管理层' not in pg.locator('main').inner_text() and '月底对账' not in pg.locator('main').inner_text())
    rows = pg.locator('[data-testid=kn-item]')
    first = rows.nth(0).inner_text()
    check('一条一行：类别、标题、状态、谁能看（原样）', rows.count() == 3 and '依据' in first and '三家报价' in first and '有依据支持' in first and '采购部' in first, first)
    check('检查的结论「没通过」；经验没有状态就不写', '没通过' in rows.nth(2).inner_text() and rows.nth(1).locator('[data-testid=kn-item-status]').count() == 0)
    check('条目的摘要照服务端原样写，不加「你拍过板」这类针对看的人的说法（顶上那一句是原型的介绍，不算）', '你拍过板' not in pg.locator('[data-testid=kn-list]').inner_text())
    text = pg.locator('main').inner_text()
    check('条目编号不写在页面的字上（只在地址里）', not any(k in text for k in KEYS.values()))
    if SHOT: pg.wait_for_timeout(500); pg.screenshot(path=SHOT.replace('.png', '-列表.png'))
    pg.locator('[data-testid=kn-tabs]').get_by_text('经验 1').click()
    pg.wait_for_function("() => new URLSearchParams(location.search).get('k') === 'kb'")
    check('点「经验」：地址带 ?k=kb，只剩那一条经验', rows.count() == 1 and '经验' in rows.nth(0).locator('[data-testid=kn-item-kind]').inner_text())
    # 换成管理层：应答里多了「只给管理层」的那条，页面照着多画一条
    who['role'] = 'management'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-list]')
    pg.wait_for_function("() => document.querySelector('[data-testid=wm-me-name]')?.textContent.trim() === '合成管理层'")
    tabs = pg.locator('[data-testid=kn-tabs] .ant-segmented-item-label').all_inner_texts()
    check('管理层：应答里多了「只给管理层」的那条——全部 4、经验 2，谁能看写「只给管理层」', tabs[:3] == ['全部 4', '依据 1', '经验 2'] and '只给管理层' in pg.locator('main').inner_text(), tabs)
    if SHOT: pg.wait_for_timeout(400); pg.screenshot(path=SHOT.replace('.png', '-管理层.png'))
    who['role'] = 'member'
    pg.locator('[data-testid=kn-tabs]').get_by_text('方法 0').click(); pg.wait_for_selector('[data-testid=kn-kind-empty]')
    check('某一类空着：说「「方法」这一类还没有内容。」', '「方法」这一类还没有内容' in pg.locator('[data-testid=kn-kind-empty]').inner_text())
    pg.goto(M + '/knowledge?k=claim'); pg.wait_for_selector('[data-testid=kn-list]')
    check('拿带 ?k=claim 的地址重开：停在「依据」', rows.count() == 1 and pg.locator('[data-testid=kn-tabs] .ant-segmented-item-selected').inner_text().strip() == '依据 1')
    pg.locator('[data-testid=kn-item-title]').first.click(); pg.wait_for_selector('[data-testid=kn-detail]')
    check('点标题进详情：地址是 /knowledge/<编号>', urlparse(pg.url).path == '/knowledge/' + KEYS['claim'], pg.url)

    print('四、详情')
    d = pg.locator('[data-testid=kn-detail]')
    check('标题、类别、状态、谁能看', pg.locator('[data-testid=kn-detail-title]').inner_text().startswith('合成：三家报价') and '依据' in d.inner_text() and '有依据支持' in d.inner_text() and '谁能看：采购部' in d.inner_text())
    body = pg.locator('[data-testid=kn-detail-body]')
    check('正文按 markdown 画：小标题、加粗、列表', body.locator('h2').inner_text() == '结论' and body.locator('strong').inner_text() == '准时率最高' and body.locator('li').count() == 2)
    check('正文里的原始 HTML 整段丢掉：不执行、不插进页面、也不当成字显示出来', pg.evaluate('window.__xss') is None and body.locator('script').count() == 0 and 'script' not in body.inner_text())
    ev = pg.locator('[data-testid=kn-evidence-row]')
    check('依据的原文两条：支持、反驳各标出来', ev.count() == 2 and '支持' in ev.nth(0).inner_text() and '反驳' in ev.nth(1).inner_text())
    check('出处只认 http/https：第一条是新标签页打开的链接，第二条（javascript:）不是链接', ev.nth(0).locator('a').get_attribute('href') == 'https://records.example/q3' and ev.nth(0).locator('a').get_attribute('target') == '_blank' and 'noopener' in ev.nth(0).locator('a').get_attribute('rel') and ev.nth(1).locator('a').count() == 0)
    check('详情页的字上也不露编号', KEYS['claim'] not in pg.locator('main').inner_text())
    if SHOT: pg.wait_for_timeout(400); pg.screenshot(path=SHOT.replace('.png', '-详情.png'))
    pg.goto(M + '/knowledge/k0000000000000000nope01'); pg.wait_for_selector('[data-testid=kn-detail-problem]')
    check('看不到或不存在（404）：一律写「没有这一条」，给回经验库的按钮', '没有这一条' in pg.locator('[data-testid=kn-detail-problem]').inner_text() and pg.get_by_role('button', name='回经验库').count() == 1)
    mode['detail'] = '503'; pg.goto(M + '/knowledge/' + KEYS['claim']); pg.wait_for_selector('[data-testid=kn-detail-problem]')
    check('详情暂时读不到（503）：说暂时读不到、带再试一次，不当成空', '暂时读不到' in pg.locator('[data-testid=kn-detail-problem]').inner_text() and pg.get_by_role('button', name='再试一次').count() == 1 and '没有这一条' not in pg.locator('main').inner_text())
    mode['detail'] = 'ok'; pg.get_by_role('button', name='再试一次').click(); pg.wait_for_selector('[data-testid=kn-detail]')
    check('「再试一次」之后画出来了', True)

    print('二、来源')
    mode['list'] = 'degraded'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-list]')
    check('最近一轮没同步上：列表照常，上面轻提示可能不是最新的', pg.locator('[data-testid=kn-degraded]').count() == 1 and '可能不是最新的' in pg.locator('[data-testid=kn-degraded]').inner_text() and pg.locator('[data-testid=kn-item]').count() == 2)
    mode['list'] = 'not_ready'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-not-ready]')
    check('还没同步成过：整页说「经验库还在准备」，下面说清四类；不是「没有内容」', '还在准备' in pg.locator('[data-testid=kn-not-ready]').inner_text() and pg.locator('[data-testid=kn-kind]').count() == 4 and '还没有内容' not in pg.locator('main').inner_text())
    mode['list'] = 'not_connected'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-not-connected]')
    nc = pg.locator('[data-testid=kn-not-connected]').inner_text()
    check('没接上经验库：中性地说「经验库未接入」，下面说清四类；不是出错、不给再试、不说还在准备', '经验库未接入' in nc and pg.locator('[data-testid=kn-kind]').count() == 4 and pg.locator('.ant-alert').count() == 0 and pg.get_by_role('button', name='再试一次').count() == 0 and '还在准备' not in pg.locator('main').inner_text())
    mode['list'] = 'empty'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-empty]')
    kinds = [pg.locator('[data-testid=kn-kind]').nth(i).locator('.ant-list-item-meta-title').inner_text().strip() for i in range(pg.locator('[data-testid=kn-kind]').count())]
    check('一条都没有：说还没有内容、以后从事项里来，下面四类照原型：依据、经验、方法、检查', '还没有内容' in pg.locator('[data-testid=kn-empty]').inner_text() and kinds == ['依据', '经验', '方法', '检查'], kinds)

    print('三、读不到')
    mode['list'] = '403'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-problem]')
    check('403（管理口令、跨站）：说「经验库是业务内容，请用自己的账号登录」，不给再试', '经验库是业务内容' in pg.locator('[data-testid=kn-problem]').inner_text() and pg.get_by_role('button', name='再试一次').count() == 0)
    mode['list'] = '503'; pg.goto(M + '/knowledge'); pg.wait_for_selector('[data-testid=kn-problem]')
    check('503：说暂时读不到，带再试一次；不当成空', '暂时读不到' in pg.locator('[data-testid=kn-problem]').inner_text() and pg.get_by_role('button', name='再试一次').count() == 1 and pg.locator('[data-testid=kn-empty]').count() == 0)
    mode['list'] = 'ok'; pg.get_by_role('button', name='再试一次').click(); pg.wait_for_selector('[data-testid=kn-list]')
    check('「再试一次」之后列出来了', pg.locator('[data-testid=kn-item]').count() == 3)
    check('页面只问了经验库的两个读接口', all(a == '/api/knowledge' or a.startswith('/api/knowledge/') for a in asked) and '/api/knowledge' in asked, sorted(set(asked))[:5])
    b.close()

print(f'knowledge-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
