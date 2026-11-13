"""驾驶舱里的数据视图（#669）浏览器回归；由 scripts/cockpit-bench-view-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
驾驶舱是实例里真的（存着两份视图的引用：一份看得到的台 synth-a，一份看不到的台 synth-hidden）；
数据视图的接口用 page.route 截下、换成合成的应答，并记下页面发了什么。
  一、不能改驾驶舱的人（没有管理身份）：没有「编辑」，也没有「数据视图」的入口；
      看不到的那份只写「你看不到这个台的数据」，小标题是「一份数据视图」——台标识、视图键都不出现在页面上；
  二、能改驾驶舱的人（输了管理口令）：「编辑」里有「数据视图」，打开对话框时「编辑」的弹层收起；
      选台的清单就是服务端给的那几个台（这个人有权限的），清单外的台（驾驶舱里引用着的也算）不出现；
  三、挂上一份：存进驾驶舱（实例里真的多了这条引用），「看板」页签里出现它的小标题「视图名 · 台名」；
  四、共用的筛选：两份都认「月份」的视图，在顶上那一排改一次月份，两份都按新的月份重取（看发出去的取数请求）。"""
import json, sys, urllib.request
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, TOK, CK = cfg['base'], cfg['token'], cfg['cockpit']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

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

# 合成的台：synth-a、synth-b 这个人看得到；synth-hidden 看不到（清单里没有，取数 403）
BENCHES = [{'slug': 'synth-a', 'title': '合成·巡检台'}, {'slug': 'synth-b', 'title': '合成·报修台'}]
DOCS = {'synth-a': [{'key': 'board', 'title': '巡检看板'}, {'key': 'rows', 'title': '巡检明细'}], 'synth-b': [{'key': 'main', 'title': '报修概况'}]}
MONTH = {'name': 'month', 'kind': 'month', 'label': '月份'}
def view_result(bench, view, params):
    title = next(b['title'] for b in BENCHES if b['slug'] == bench)
    vt = next(v['title'] for v in DOCS[bench] if v['key'] == view)
    eff = {'month': params.get('month', '2026-01')}
    n = 63 if eff['month'] == '2026-01' else 42
    return {'title': title, 'version': 1, 'active_version': 1, 'views': DOCS[bench], 'view': {'key': view, 'title': vt}, 'filters': [MONTH], 'params': eff,
            'blocks': [{'type': 'filter-bar', 'fields': [{**MONTH, 'default': '2026-01'}], 'span': 12},
                       {'type': 'stat', 'title': '合成计数', 'unit': '次', 'value': 'v', 'span': 3, 'data': {'columns': [{'name': 'v', 'type': 'integer'}], 'rows': [{'v': n}]}}]}
renders = []
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_bv(route):
    u = urlparse(route.request.url); parts = u.path.split('/')  # ['', 'api', 'bench-views', <台>, ...]
    if u.path == '/api/bench-views': return fake(route, {'benches': BENCHES})
    bench, rest = parts[3], '/'.join(parts[4:])
    if bench not in DOCS: return fake(route, {'error': 'bench_views_forbidden', 'message': '没有这个台的权限'}, 403)
    if rest == 'view': return fake(route, {'view': {'version': 1, 'active_version': 1, 'content': {'title': 'x', 'views': DOCS[bench]}}})
    if rest == 'render':
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        params = {k[2:]: v for k, v in q.items() if k.startswith('p.')}
        renders.append((bench, q.get('view'), params))
        return fake(route, view_result(bench, q.get('view'), params))
    return fake(route, {'error': 'not_found'}, 404)

def read_cockpit():
    with urllib.request.urlopen(urllib.request.Request(M + '/api/cockpits', headers={'x-admin-token': TOK})) as r:
        rows = json.load(r)
    c = next(x for x in rows if x['id'] == CK)
    return [p for p in c['panels'] if p.get('kind') == 'bench-view']

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route('**/api/bench-views**', on_bv)
    pg.goto(f'{M}/cockpit/{CK}')
    pg.wait_for_selector('[data-testid=ck-bench-view-error]')
    pg.wait_for_selector('[data-testid=ck-bench-view]')
    heads = [h.inner_text() for h in pg.locator('[data-testid=ck-bv-head]').all()]
    body = pg.locator('body').inner_text()
    print('一、不能改驾驶舱的人')
    check('没有「编辑」，也没有「数据视图」的入口', pg.locator('[data-testid=ck-edit]').count() == 0 and pg.locator('[data-testid=ck-bv-manage]').count() == 0)
    check('看不到的那份：写「你看不到这个台的数据」，小标题是「一份数据视图」', '你看不到这个台的数据' in pg.locator('[data-testid=ck-bench-view-error]').inner_text() and '一份数据视图' in heads, heads)
    check('看不到的那份的台标识、视图键不出现在页面上', 'synth-hidden' not in body and 'secret' not in body, [h for h in heads])
    check('看得到的那份：小标题是「视图名 · 台名」', '巡检看板 · 合成·巡检台' in heads, heads)

    print('二、能改驾驶舱的人')
    set_token(pg)
    pg.wait_for_selector('[data-testid=ck-edit]')
    pg.locator('[data-testid=ck-edit]').click()
    pg.locator('[data-testid=ck-bv-manage]').wait_for(); settled(pg, '[data-testid=ck-bv-manage]')
    check('「编辑」里有「数据视图」', pg.locator('[data-testid=ck-bv-manage]').is_visible())
    pg.locator('[data-testid=ck-bv-manage]').click()
    pg.wait_for_selector('[data-testid=ck-bv-manage-panel]')
    pg.locator('.wm-ck-bv-add .ant-select').first.wait_for()
    pg.wait_for_timeout(500)
    check('打开对话框时「编辑」的弹层收起了（不压在对话框上）', not pg.locator('[data-testid=ck-edit-panel]').is_visible())
    rows = [r.inner_text() for r in pg.locator('[data-testid=ck-bv-row]').all()]
    check('已挂的两份都列出来；看不到的那份写「一份数据视图」，不写台标识', len(rows) == 2 and any('一份数据视图' in x for x in rows) and not any('synth-hidden' in x or 'secret' in x for x in rows), rows)
    pg.locator('.wm-ck-bv-add .ant-select').nth(0).click()
    opts = pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    opts.first.wait_for()
    names = [o.inner_text() for o in opts.all()]
    check('选台的清单就是服务端给的这个人有权限的台；看不到的台不出现', sorted(names) == sorted(x['title'] for x in BENCHES), names)
    opts.filter(has_text='合成·报修台').first.click()

    print('三、挂上一份')
    pg.wait_for_function("() => !document.querySelectorAll('.wm-ck-bv-add .ant-select')[1].classList.contains('ant-select-disabled')")
    pg.locator('.wm-ck-bv-add .ant-select').nth(1).click()
    pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', has_text='报修概况').first.click()
    pg.locator('[data-testid=ck-bv-add]').click()
    pg.wait_for_function("() => document.querySelectorAll('[data-testid=ck-bv-row]').length === 3")
    saved = read_cockpit()
    check('存进了驾驶舱：多了这条引用，放在「看板」的最后，原来两条还在', [(x['bench'], x['view'], x['tab'], x['order']) for x in saved] == [('synth-a', 'board', 'board', 0), ('synth-hidden', 'secret', 'board', 1), ('synth-b', 'main', 'board', 2)], saved)
    pg.locator('.ant-modal-close').click()
    pg.wait_for_selector('[data-testid=ck-bv-manage-panel]', state='detached')
    pg.wait_for_function("() => [...document.querySelectorAll('[data-testid=ck-bv-head]')].some(h => h.textContent === '报修概况 · 合成·报修台')")
    check('「看板」页签里出现了它的小标题「报修概况 · 合成·报修台」', True)

    print('四、共用的筛选')
    pg.wait_for_selector('[data-testid=ck-bv-filters] [data-filter=month]')
    check('顶上一排里「月份」只有一个（两份视图同名的合成一项），视图自己的筛选栏不画', pg.locator('[data-testid=ck-bv-filters] [data-filter=month]').count() == 1 and pg.locator('[data-testid=ck-bench-view] [data-bb=filter-bar]').count() == 0)
    before = len(renders)
    inp = pg.locator('[data-testid=ck-bv-filters] [data-filter=month] input')
    inp.click(); inp.fill('2026-02'); inp.press('Enter'); pg.mouse.click(800, 26)
    pg.wait_for_function("() => document.querySelectorAll('[data-testid=ck-bench-view] [data-bb=stat]').length === 2 && [...document.querySelectorAll('[data-testid=ck-bench-view] [data-bb=stat]')].every(s => s.innerText.includes('42'))")
    after = renders[before:]
    got = {(bn, v) for bn, v, ps in after if ps.get('month') == '2026-02'}
    check('改一次月份：两份都按新的月份重取（取数请求里带 p.month=2026-02）', {('synth-a', 'board'), ('synth-b', 'main')} <= got, after)
    check('两份显示的都是新月份的数', all('42' in s.inner_text() for s in pg.locator('[data-testid=ck-bench-view] [data-bb=stat]').all()))
    pg.wait_for_timeout(1500)
    check('改完之后不再来回取数（1.5 秒内没有多余的请求）', len(renders) - before <= 4, renders[before:])
    b.close()

print(f'cockpit-bench-view-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
