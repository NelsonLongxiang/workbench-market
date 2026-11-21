"""报告页（/use/<卡片 id>/reports，报告第 1 步 PR D，#935）浏览器回归；由 scripts/report-page-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
入口和报告的接口用 page.route 截下、换成合成的应答；报告和回应的状态记在这里（未处理的反驳照服务端的算法算），并记下页面发了什么。
  一、入口：服务端没说能看报告（can.reports）：台页面不出「报告」，直接打开报告页说看不到；
  二、清单：按事物分组，被更正过的不出、出更正后的那份；一件事有几个维度给「并排看」；
  三、并排：同一事物的几个维度宽屏并排、窄屏上下排；正文、来源、产出方（AI 标出）、论断类别、未处理的反驳；
  四、回应：立场和理由都有才能交；交上去请求带论断编号、立场、理由，不带回应者；未处理的反驳随之变；
      改主意接在自己的链头上（带 supersedes），旧的划掉；409 照服务端说；AI 的回应另外标出；
  五、单看一份：被更正过的旧报告标出、链到新的；服务端没说能回应（can.respond）时不出回应框。"""
import json, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, CARD = cfg['base'], cfg['card']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

ENTRY = {'bench': {'slug': 'synth-report-bench', 'title': '合成·经营台', 'workbench_id': 4242}, 'version': 3, 'title': '合成经营总览', 'default_view': 'vk-board',
         'views': [{'key': 'vk-board', 'title': '经营看板'}]}
VIEW = {'title': '合成经营总览', 'version': 3, 'view': {'key': 'vk-board', 'title': '经营看板'}, 'params': {},
        'blocks': [{'type': 'stat', 'title': '本月订单', 'value': 'v', 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': 3}]}}]}
can = {'rename': False, 'reports': True, 'respond': True}
TEMPLATE = {'stances': ['agree', 'dispute', 'supplement'], 'claims': [{'kind': 'conclusion', 'label': '结论'}, {'kind': 'risk', 'label': '风险'}]}
ME = 'user:alpha'

def body_of(title, n):
    return {'schema_version': 2, 'title': title, 'body': [
        {'id': 'cover', 'type': 'cover', 'title': title + ' 2026-11', 'content': '合成摘要'},
        {'id': 'detail', 'type': 'section', 'title': '明细', 'children': [
            {'id': 'tbl', 'type': 'data-view', 'component': 'table', 'props': {'columns': ['id', 'amount']},
             'data': {'columns': [{'name': 'id', 'type': 'integer', 'label': '单号'}, {'name': 'amount', 'type': 'decimal', 'label': '金额'}], 'rows': [{'id': i + 1, 'amount': 100 * (i + 1)} for i in range(n)]}}]}]}

def rep(id, dim, subject, at, kind='human', supersedes=None, title='合成·财务'):
    return {'id': id, 'dimension_id': dim, 'template_version': 2, 'binding_version': 1, 'subject': subject, 'content_sha256': 'x' * 8,
            'producer': 'mcp:synth-seat' if kind == 'ai' else ME, 'producer_kind': kind, 'supersedes': supersedes, 'created_at': at,
            'template_sha256': 'y' * 8, 'inputs': {'parameters': {'period': '2026-11'}, 'fields': {}}, 'body': body_of(title, 2),
            'sources': [{'slot': 'orders', 'view': 'vk-board', 'block': 1, 'view_version': 3, 'view_sha256': 'z' * 8, 'rows': 2, 'completeness': 'all'}],
            'claims': [{'claim_key': 'conclusion-1', 'kind': 'conclusion', 'text': title + '：本月合成结论', 'basis': [{'slot': 'orders', 'key': [1]}]}]}
T0 = 1_763_700_000_000
REPORTS = {
    1: rep(1, 'finance', 'item:7', T0, title='合成·财务旧'),
    2: rep(2, 'risk', 'item:7', T0 + 1000, kind='ai', title='合成·风险'),
    3: rep(3, 'finance', 'item:7', T0 + 2000, supersedes=1, title='合成·财务'),
    4: rep(4, 'finance', 'item:9', T0 - 5000, title='合成·另一件'),
}
RESP = [  # 风险那份上已有一条 AI 的反驳（不算未处理）
    {'id': 50, 'report_id': 2, 'claim_key': 'conclusion-1', 'stance': 'dispute', 'reason': '合成：AI 觉得口径不对', 'responder': 'mcp:synth-seat', 'responder_kind': 'ai', 'position': 'mcp', 'supersedes': None, 'created_at': T0 + 3000},
]
mode = {'respond': 'ok'}
log = {'respond': []}

def superseded_by(id):
    return next((r['id'] for r in REPORTS.values() if r['supersedes'] == id), None)
def list_item(r):
    return {k: r[k] for k in ['id', 'dimension_id', 'template_version', 'binding_version', 'subject', 'content_sha256', 'producer', 'producer_kind', 'supersedes', 'created_at']} | {'superseded_by': superseded_by(r['id'])}
def open_dispute(rs, key):
    mine = [x for x in rs if x['claim_key'] == key and x['responder_kind'] == 'human']
    replaced = {x['supersedes'] for x in mine if x['supersedes'] is not None}
    return any(x['id'] not in replaced and x['stance'] == 'dispute' for x in mine)
def read(id):
    r = REPORTS[id]; rs = [x | {'mine': x['responder'] == ME} for x in RESP if x['report_id'] == id]
    head = superseded_by(id) is None
    claims = [c | {'responses': [x for x in rs if x['claim_key'] == c['claim_key']], 'open_dispute': head and open_dispute(rs, c['claim_key'])} for c in r['claims']]
    whole = [x for x in rs if x['claim_key'] == '']
    meta = {k: v for k, v in r.items() if k != 'claims'} | {'superseded_by': superseded_by(id)}
    return {'report': meta, 'claims': claims, 'responses': whole, 'gate': {'open_dispute_blocks_acceptance': True}, 'template': TEMPLATE,
            'open_disputes': sum(1 for c in claims if c['open_dispute']) + (1 if head and open_dispute(rs, '') else 0)}

def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_bv(route):
    u = urlparse(route.request.url); parts = u.path.split('/')
    if parts[3] != str(CARD): return route.continue_()
    rest = '/'.join(parts[4:]); method = route.request.method
    if rest == 'entry': return fake(route, ENTRY | {'can': dict(can)})
    if rest == 'render': return fake(route, VIEW)
    if rest == 'reports' and method == 'GET':
        subject = parse_qs(u.query).get('subject', [None])[0]
        return fake(route, {'reports': [list_item(r) for r in sorted(REPORTS.values(), key=lambda r: -r['id']) if subject is None or r['subject'] == subject]})
    if len(parts) == 6 and parts[4] == 'reports' and method == 'GET':
        id = int(parts[5]); return fake(route, read(id)) if id in REPORTS else fake(route, {'error': 'not_found', 'message': '没有这份报告'}, 404)
    if len(parts) == 7 and parts[4] == 'reports' and parts[6] == 'responses' and method == 'POST':
        b = json.loads(route.request.post_data or '{}'); log['respond'].append(b)
        if mode['respond'] == '409': return fake(route, {'error': 'conflict', 'message': '只能接在你自己回应链的链头上'}, 409)
        row = {'id': 100 + len(RESP), 'report_id': int(parts[5]), 'claim_key': b.get('claim_key', ''), 'stance': b['stance'], 'reason': b['reason'], 'responder': ME,
               'responder_kind': 'human', 'position': 'management@*', 'supersedes': b.get('supersedes'), 'created_at': T0 + 9000 + len(RESP)}
        RESP.append(row); return fake(route, {'response': row}, 201)
    return fake(route, {'error': 'not_found'}, 404)

def docs(pg): return pg.locator('[data-testid=report-doc]')
def doc(pg, dim): return pg.locator(f'[data-testid=report-doc][data-dimension={dim}]')
def claim(d, key='conclusion-1'): return d.locator(f'[data-testid=report-claim][data-claim="{key}"]')
def wait_n(pg, sel, n): pg.wait_for_function(f"() => document.querySelectorAll('{sel}').length === {n}")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route('**/api/bench-views/**', on_bv)

    print('一、入口')
    can['reports'] = False
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-name]'); pg.wait_for_timeout(300)
    check('入口没说能看报告：台页面顶栏不出「报告」', pg.locator('[data-testid=bench-page-reports]').count() == 0)
    pg.goto(f'{M}/use/{CARD}/reports'); pg.wait_for_selector('[data-testid=report-page-denied]')
    check('直接打开报告页：说看不到这个台的报告，不出清单', '看不到这个台的报告' in pg.locator('[data-testid=report-page-denied]').inner_text() and pg.locator('[data-testid=report-group]').count() == 0)
    can['reports'] = True

    print('二、清单')
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-reports]')
    pg.locator('[data-testid=bench-page-reports]').click(); pg.wait_for_selector('[data-testid=report-group]')
    groups = pg.locator('[data-testid=report-group]')
    check('按事物分组：最近有新报告的事物在前', groups.count() == 2 and groups.nth(0).get_attribute('data-subject') == 'item:7' and groups.nth(1).get_attribute('data-subject') == 'item:9', [groups.nth(i).get_attribute('data-subject') for i in range(groups.count())])
    dims = groups.nth(0).locator('[data-testid=report-group-dim]')
    texts = [dims.nth(i).inner_text() for i in range(dims.count())]
    check('一件事下每个维度一份：被更正过的旧财务报告不出，出更正版；AI 产出的标出', dims.count() == 2 and 'finance' in texts[0] and '更正版' in texts[0] and 'risk' in texts[1] and 'AI' in texts[1], texts)
    check('有两个维度：给「并排看」；只有一个维度的事物不给', groups.nth(0).locator('[data-testid=report-group-side]').count() == 1 and groups.nth(1).locator('[data-testid=report-group-side]').count() == 0)

    print('三、并排')
    groups.nth(0).locator('[data-testid=report-group-side]').click(); wait_n(pg, '[data-testid=report-doc]', 2)
    check('地址带上事物；两个维度各一份', 'subject=item%3A7' in pg.url and doc(pg, 'finance').get_attribute('data-report') == '3' and doc(pg, 'risk').get_attribute('data-report') == '2', pg.url)
    bf, br = doc(pg, 'finance').bounding_box(), doc(pg, 'risk').bounding_box()
    check('宽屏并排：两列同一行、左右挨着', abs(bf['y'] - br['y']) < 2 and br['x'] > bf['x'] + bf['width'] - 2, (bf, br))
    f = doc(pg, 'finance')
    check('正文：封面标题、明细表两行；来源写视图版本和行数', '合成·财务 2026-11' in f.inner_text() and f.locator('.wm-rp-table tbody tr').count() == 2 and '第 3 版，2 行' in f.locator('[data-testid=report-sources]').inner_text())
    check('产出方：人产出的标「人」，AI 产出的标「AI」', '人' in f.locator('[data-testid=report-producer]').inner_text() and 'AI' in doc(pg, 'risk').locator('[data-testid=report-producer]').inner_text())
    check('论断：类别用模板里的名字（结论）；更正了之前那份，带链接', '结论' in claim(f).inner_text() and f.locator('[data-testid=report-supersedes] a').count() == 1)
    r = doc(pg, 'risk')
    check('AI 的反驳另外标出，但不算未处理的反驳；验收声明照模板说', r.locator('[data-testid=report-response-ai]').count() == 1 and '没有未处理的反驳' in r.locator('[data-testid=report-open-disputes]').inner_text() and '不能验收' in r.locator('[data-testid=report-gate]').inner_text())
    pg.set_viewport_size({'width': 390, 'height': 900}); pg.wait_for_timeout(300)
    bf, br = doc(pg, 'finance').bounding_box(), doc(pg, 'risk').bounding_box()
    sw = pg.evaluate('() => document.documentElement.scrollWidth')
    check('窄屏（390）：上下排，不横向滚动', br['y'] >= bf['y'] + bf['height'] - 2 and sw <= 390, (bf, br, sw))
    pg.set_viewport_size({'width': 1440, 'height': 900})

    print('四、回应')
    c = claim(f); c.locator('[data-testid=report-respond-open]').click()
    send = c.locator('[data-testid=report-respond-send]')
    check('立场和理由都没有：「提交」不能点', send.is_disabled())
    c.locator('[data-testid=report-respond-stance] label', has_text='反驳').click()
    check('只选了立场、理由空：还是不能点', send.is_disabled())
    c.locator('[data-testid=report-respond-reason]').fill('合成：口径不对')
    send.click()
    pg.wait_for_function("() => (document.querySelector('[data-testid=report-doc][data-dimension=finance] [data-testid=report-open-disputes]')?.textContent ?? '').includes('1 处')")
    check('交上去：请求只带论断编号、立场、理由（不带回应者、类别、位置）；回应出现在论断下，未处理的反驳 1 处，论断标出',
          log['respond'][-1:] == [{'claim_key': 'conclusion-1', 'stance': 'dispute', 'reason': '合成：口径不对'}] and claim(f).locator('[data-testid=report-response]').count() == 1 and claim(f).locator('[data-testid=report-claim-open]').count() == 1, log['respond'][-1:])
    first = RESP[-1]['id']
    btn = claim(f).locator('[data-testid=report-respond-open]')
    check('自己回应过：按钮写「改主意（现在是反驳）」', '改主意（现在是反驳）' in btn.inner_text(), btn.inner_text())
    btn.click(); c = claim(f)
    c.locator('[data-testid=report-respond-stance] label', has_text='认可').click(); c.locator('[data-testid=report-respond-reason]').fill('合成：看错了')
    c.locator('[data-testid=report-respond-send]').click()
    pg.wait_for_function("() => (document.querySelector('[data-testid=report-doc][data-dimension=finance] [data-testid=report-open-disputes]')?.textContent ?? '').includes('没有未处理的反驳')")
    rows = claim(f).locator('[data-testid=report-response]')
    check('改主意：请求带 supersedes（自己上一条）；旧的划掉、新的照常；未处理的反驳没了',
          log['respond'][-1].get('supersedes') == first and rows.count() == 2 and rows.nth(0).get_attribute('data-replaced') == 'true' and rows.nth(1).get_attribute('data-replaced') == 'false', (log['respond'][-1:], rows.count()))
    # 409：照服务端说，回应框不关
    mode['respond'] = '409'
    w = f.locator('[data-testid=report-whole]'); w.locator('[data-testid=report-respond-open]').click()
    w.locator('[data-testid=report-respond-stance] label', has_text='补充').click(); w.locator('[data-testid=report-respond-reason]').fill('合成：补一句')
    w.locator('[data-testid=report-respond-send]').click(); w.locator('[data-testid=report-respond-msg]').wait_for()
    check('对整份报告回应：请求不带论断编号；409 照服务端的说法提示，回应框不关、填的还在',
          'claim_key' not in log['respond'][-1] and '链头' in w.locator('[data-testid=report-respond-msg]').inner_text() and w.locator('[data-testid=report-respond-reason]').input_value() == '合成：补一句', log['respond'][-1:])
    check('409 之后「提交」还能点（可以再交一次）', not w.locator('[data-testid=report-respond-send]').is_disabled())
    mode['respond'] = 'ok'

    print('五、单看一份')
    can['respond'] = False
    pg.goto(f'{M}/use/{CARD}/reports?report=1'); pg.wait_for_selector('[data-testid=report-superseded]')
    old = docs(pg)
    check('被更正过的旧报告：标出已被更正，链到新的那份', old.count() == 1 and old.get_attribute('data-report') == '1' and pg.locator('[data-testid=report-superseded] a').get_attribute('href').endswith('?report=3'))
    check('服务端没说能回应：不出回应框', pg.locator('[data-testid=report-respond-open]').count() == 0)
    pg.goto(f'{M}/use/{CARD}/reports?report=99'); pg.wait_for_selector('[data-testid=report-page-msg]')
    check('没有这份报告：照服务端说', '没有这份报告' in pg.locator('[data-testid=report-page-msg]').inner_text())
    b.close()
print(f'\nreport-page-browser: {ok} 过 / {fail} 败'); sys.exit(1 if fail else 0)
