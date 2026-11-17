"""#762 真实后端→浏览器闭环：业务接口不 page.route，页面看到的就是实例里真的数据。
身份是合成的（identity-fake-provider；标注：合成身份，不冒充生产身份）。由 scripts/bench-real-loop-browser.mjs 起实例、
种子数据后调用，参数为配置 JSON 路径。核对（查询、重放、版本、回退、解绑、跨台）用 Python 直接打同一批正式 REST 入口。
  一、打开与取数一致：统计值/明细行数 == 同口径真实查询
  二、筛选真的改结果：地址带 p.<字段>，统计与明细跟着变，仍与真实查询一致
  三、表单提交落库：浏览器交一次，查询里多出这一行
  四、同幂等键重放：duplicate，行数不再多
  五、旧版本表单拒：保存新版后，页面还拿着旧版交，409「这个页面过期了」，数据不变
  六、回退重读：退回首版，整页重开，标题与取数回到首版
  七、解绑（撤权）：取数 403；页面重开不进数据视图页（照原样嵌卡片页）
  八、跨台隔离：别的部门的台，取数 403，页面照原样嵌卡片页
"""
import json, sys, urllib.request
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1]))
M, CARD, OTHER = cfg['base'], cfg['card'], cfg['other_card']
BETA, ALPHA = cfg['session_beta'], cfg['session_alpha']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

def rest(method, path, body=None, session=BETA, raw=None, headers=None):
    h = {'cookie': f'session_id={session}', 'origin': M, 'sec-fetch-site': 'same-origin'}
    if raw is not None or body is not None: h['content-type'] = 'application/json'
    if headers: h.update(headers)
    data = raw.encode() if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(M + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

FLD = [{'col': 'day', 'op': 'prefix', 'value': '$month'}, {'col': 'region', 'op': '=', 'value': '$region'}]
DOC2 = {'title': '现场登记台·二', 'views': [
    {'key': 'overview', 'title': '总览', 'blocks': [
      {'type': 'filter-bar', 'fields': [{'name': 'month', 'kind': 'search', 'label': '月份'}, {'name': 'region', 'kind': 'search', 'label': '区域'}]},
      {'type': 'stat', 'title': '合计金额', 'query': {'dataset': 'visits', 'filter': FLD, 'measures': [{'fn': 'sum', 'col': 'amount', 'as': 'v', 'label': '金额'}]}, 'value': 'v', 'unit': '元'},
      {'type': 'table', 'title': '记录', 'query': {'dataset': 'visits', 'filter': FLD, 'sort': [{'col': 'id'}]}, 'span': 12},
    ]},
    {'key': 'entry', 'title': '补录', 'blocks': [{'type': 'form', 'dataset': 'visits', 'fields': ['id', 'day', 'region', 'amount'], 'submit_label': '登记'}]},
] }

def q_sum(month='', region=''):
    fl = []
    if month: fl.append({'col': 'day', 'op': 'prefix', 'value': month})
    if region: fl.append({'col': 'region', 'op': '=', 'value': region})
    st, j = rest('POST', '/api/bench-views/field/query', {'query': {'dataset': 'visits', 'filter': fl, 'measures': [{'fn': 'sum', 'col': 'amount', 'as': 'v'}]}})
    return (j or {}).get('rows', [{}])[0].get('v') if st == 200 else None

def q_rows(month='', region=''):
    fl = []
    if month: fl.append({'col': 'day', 'op': 'prefix', 'value': month})
    if region: fl.append({'col': 'region', 'op': '=', 'value': region})
    st, j = rest('POST', '/api/bench-views/field/query', {'query': {'dataset': 'visits', 'filter': fl, 'sort': [{'col': 'id'}]}})
    return (j or {}).get('rows', []) if st == 200 else None

def stat_num(pg):
    t = pg.locator('[data-bb=stat]').inner_text()
    return ''.join(ch for ch in t if ch.isdigit() or ch == '.')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': BETA, 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(10000)

    print('一、打开与取数一致')
    pg.goto(f'{M}/use/{CARD}')
    pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    pg.wait_for_selector('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)')
    rows_n = pg.locator('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').count()
    check('打开即总览：统计值与真实查询一致', abs(float(stat_num(pg)) - float(q_sum())) < 0.01, (stat_num(pg), q_sum()))
    check('明细行数与真实查询一致', rows_n == len(q_rows()), (rows_n, len(q_rows())))

    print('二、筛选真的改结果')
    inp = pg.locator('[data-filter=month] input')
    inp.fill('2026-01'); inp.press('Enter')
    pg.wait_for_function("() => new URLSearchParams(location.search).get('p.month') === '2026-01'")
    pg.wait_for_function("() => document.querySelectorAll('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').length === 2")
    rows_n = pg.locator('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').count()
    check('按月份筛：统计与明细都变，且与同口径真实查询一致', abs(float(stat_num(pg)) - float(q_sum(month='2026-01'))) < 0.01 and rows_n == len(q_rows(month='2026-01')), (stat_num(pg), q_sum(month='2026-01'), rows_n))
    inp2 = pg.locator('[data-filter=region] input')
    inp2.fill('东区'); inp2.press('Enter')
    pg.wait_for_function("() => new URLSearchParams(location.search).get('p.region') === '东区'")
    pg.wait_for_function("() => document.querySelectorAll('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').length === 1")
    rows_n = pg.locator('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').count()
    check('再叠区域筛：行数与真实查询一致', rows_n == len(q_rows(month='2026-01', region='东区')), (rows_n, len(q_rows(month='2026-01', region='东区'))))

    print('三、表单提交落库')
    pg.locator('[data-testid=bench-page-tab]', has_text='补录').click()
    pg.wait_for_selector('[data-bb=form] button[type=submit]')
    before = len(q_rows())
    form = pg.locator('[data-bb=form]').first
    form.locator('input').first.fill('50')
    tas = form.locator('textarea')
    tas.nth(0).fill('2026-03-01'); tas.nth(1).fill('北区')
    form.locator('input').nth(1).fill('7.5')
    form.locator('button[type=submit]').click()
    form.locator('.ant-alert-success').wait_for()
    after = q_rows()
    check('浏览器交表单：真实查询里多出这一行', len(after) == before + 1 and any(r.get('id') == 50 and r.get('region') == '北区' for r in after), (before, len(after)))

    print('四、同幂等键重放')
    body60 = {'view': 'entry', 'block': 0, 'version': 1, 'values': {'id': 60, 'day': '2026-03-05', 'region': '北区', 'amount': 2.5}}
    st, j = rest('POST', '/api/bench-views/field/form', body60, headers={'idempotency-key': 'loop-form-0001'})
    st2, j2 = rest('POST', '/api/bench-views/field/form', body60, headers={'idempotency-key': 'loop-form-0001'})
    check('同幂等键重放：认得是同一次，行数不再多', st == 200 and st2 == 200 and (j2 or {}).get('duplicate') is True and len(q_rows()) == before + 2, (st, st2, (j2 or {}).get('duplicate'), len(q_rows())))

    print('五、旧版本表单拒')
    st, j = rest('PUT', '/api/bench-views/field/view', {'doc': DOC2, 'base': 1, 'note': '二版'}, session=ALPHA)
    check('（准备）席位存了二版', st == 200 and (j or {}).get('version') == 2, (st, j))
    form.locator('input').first.fill('51')
    tas.nth(0).fill('2026-03-02'); tas.nth(1).fill('南区')
    form.locator('input').nth(1).fill('3')
    form.locator('button[type=submit]').click()
    form.locator('.ant-alert-warning').wait_for()
    check('页面还拿着旧版：409「这个页面过期了」，数据不变', '这个页面过期了' in form.inner_text() and len(q_rows()) == before + 2, form.inner_text()[:120])

    print('六、回退重读')
    st, j = rest('POST', '/api/bench-views/field/view/rollback', {'to': 1, 'base': 2, 'note': '回到首版'}, session=ALPHA)
    check('（准备）回退：首版重新生效', st == 200 and (j or {}).get('active_version') == 1, (st, j))
    pg.reload()
    pg.wait_for_selector('[data-bb=form] button[type=submit]')
    pg.locator('[data-testid=bench-page-tab]', has_text='总览').click()
    pg.wait_for_selector('[data-bb=stat][data-bb-state=ready]')
    pg.wait_for_function("() => document.querySelectorAll('[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)').length === 6")
    check('整页重开：标题回到首版，取数照常', pg.locator('[data-testid=bench-page-title]').inner_text() == '现场登记台' and abs(float(stat_num(pg)) - float(q_sum())) < 0.01, pg.locator('[data-testid=bench-page-title]').inner_text())

    print('七、解绑（撤权）')
    st, j = rest('PUT', '/api/bench-views/field/binding', {'department': ''}, session=ALPHA)
    st2, _ = rest('GET', '/api/bench-views/field/render?view=overview')
    pg.goto(f'{M}/use/{CARD}')
    pg.wait_for_selector('.wm-use-frame')
    check('解绑后：取数 403；页面照原样嵌卡片页，不进数据视图页', st == 200 and st2 == 403 and pg.locator('[data-testid=bench-page]').count() == 0, (st, st2))

    print('八、跨台隔离')
    st, _ = rest('GET', '/api/bench-views/other/render?view=overview')
    pg.goto(f'{M}/use/{OTHER}')
    pg.wait_for_selector('.wm-use-frame')
    check('别的部门的台：取数 403，页面照原样嵌卡片页', st == 403 and pg.locator('[data-testid=bench-page]').count() == 0, st)
    b.close()
print(f'\nbench-real-loop-browser: {ok} 过 / {fail} 败'); sys.exit(1 if fail else 0)