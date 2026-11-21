"""#904 台上的 MCP 申请：浏览器这一段；由 scripts/bench-mcp-ui-browser.mjs 起合成实例、经 MCP 提好三条申请后调用，参数为配置 JSON 路径。业务接口不截。
  一、看不到的人：只能取数、读视图的 beta，台页面打得开、不出「MCP 授权」，直接打开管理页照服务端说不能管；能看授予、不能批的人看得到申请、没有批准驳回；
  二、找得到：管理层 alpha 在 MCP 网关页「台上的申请」看到三条待批，链到台的授权页；台页面顶栏也有「MCP 授权」；
  三、管理页：待批的三条写着编号、会话、工具读写、理由；批准一条（留一句）：状态、谁定的、留的那句、授予标「批准申请 #n」、留痕；
  四、驳回一条：不写理由不能点，写了才驳回；办过的里看得到驳回理由；
  五、对话框开着时这条被别处先批了：照服务端说（409），对话框不关；之后待批清单空了，MCP 网关页那一栏也空了。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, CARD, BENCH, IDS = cfg['base'], cfg['card'], cfg['bench'], cfg['ids']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def row(scope, id): return scope.locator(f'tr[data-row-key="{id}"]')

with sync_playwright() as p:
    b = p.chromium.launch()
    def ctx_for(session):
        c = b.new_context(viewport={'width': 1440, 'height': 900})
        c.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
        return c

    print('一、看不到的人')
    ctx = ctx_for(cfg['session_beta']); pg = ctx.new_page(); pg.set_default_timeout(15000)
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-name]'); pg.wait_for_timeout(500)
    check('只能取数、读视图的人：台页面打得开，但顶栏不出「MCP 授权」', pg.locator('[data-testid=bench-page-mcp]').count() == 0)
    pg.goto(f'{M}/bench-mcp/{BENCH}'); pg.wait_for_selector('[data-testid=bench-mcp-error]')
    check('直接打开管理页：照服务端说不能管（要有拍板授予），不显示成「没有申请」', '拍板' in pg.locator('[data-testid=bench-mcp-error]').inner_text() and pg.locator('[data-testid=bench-mcp-pending]').count() == 0)
    ctx.close()
    ctx = ctx_for(cfg['session_lister']); pg = ctx.new_page(); pg.set_default_timeout(15000)
    pg.goto(f'{M}/bench-mcp/{BENCH}'); pg.wait_for_selector('[data-testid=bench-mcp-pending] tr[data-row-key]')
    check('能看授予、不能批的人：看得到三条待批，但没有批准、驳回，页面说能看不能批',
          pg.locator('[data-testid=bench-mcp-pending] tr[data-row-key]').count() == 3 and pg.locator('[data-testid=bench-mcp-approve]').count() == 0 and pg.locator('[data-testid=bench-mcp-reject]').count() == 0 and '不能批' in pg.locator('[data-testid=bench-mcp-bench]').inner_text())
    ctx.close()

    print('二、找得到')
    ctx = ctx_for(cfg['session_alpha']); pg = ctx.new_page(); pg.set_default_timeout(15000)
    pg.goto(f'{M}/mcp-gateways'); pg.get_by_role('tab', name='台上的申请').click()
    box = pg.locator('[data-testid=mcp-bench-requests]'); box.locator('tr[data-row-key]').first.wait_for()
    keys = [box.locator('tr[data-row-key]').nth(i).get_attribute('data-row-key') for i in range(box.locator('tr[data-row-key]').count())]
    check('MCP 网关页「台上的申请」：三条待批都在，按编号先来先办', keys == [f'{BENCH}:{i}' for i in IDS], keys)
    go = box.locator(f'tr[data-row-key="{BENCH}:{IDS[0]}"] [data-testid=mcp-bench-requests-go]')
    check('每条链到台的授权页', go.get_attribute('href') == f'/bench-mcp/{BENCH}', go.get_attribute('href'))
    pg.goto(f'{M}/use/{CARD}'); pg.wait_for_selector('[data-testid=bench-page-mcp]')
    pg.locator('[data-testid=bench-page-mcp]').click(); pg.wait_for_selector('[data-testid=bench-mcp-pending]')
    check('台页面顶栏「MCP 授权」：进到这个台的管理页', pg.url.endswith(f'/bench-mcp/{BENCH}') and BENCH in pg.locator('[data-testid=bench-mcp-bench]').inner_text())

    print('三、批准')
    pend = pg.locator('[data-testid=bench-mcp-pending]')
    r1 = row(pend, IDS[0]); t1 = r1.inner_text()
    cats = sorted(r1.locator('[data-testid=bench-mcp-tool]').nth(i).get_attribute('data-category') for i in range(r1.locator('[data-testid=bench-mcp-tool]').count()))
    check('待批的一行：编号、会话、工具（一读一写分开标）、理由', f'#{IDS[0]}' in t1 and 'sess-ui' in t1 and '维护巡检记录' in t1 and cats == ['read', 'write'] and pend.locator('tr[data-row-key]').count() == 3, (t1, cats))
    r1.locator('[data-testid=bench-mcp-approve]').click(); pg.wait_for_selector('[data-testid=bench-mcp-dialog]')
    pg.locator('[data-testid=bench-mcp-note-input]').fill('合成：同意')
    check('批准可以不写理由：「批准」一打开就能点', not pg.locator('[data-testid=bench-mcp-confirm]').is_disabled())
    pg.locator('[data-testid=bench-mcp-confirm]').click()
    pg.wait_for_function(f"() => document.querySelectorAll('[data-testid=bench-mcp-pending] tr[data-row-key]').length === 2")
    done = pg.locator('[data-testid=bench-mcp-done]'); d1 = row(done, IDS[0]).inner_text()
    check('批准后：从待批里挪到办过的，状态已批准、谁定的、留的那句', '已批准' in d1 and 'user:alpha' in d1 and '合成：同意' in d1, d1)
    g = pg.locator('[data-testid=bench-mcp-grant][data-session=sess-ui]')
    srcs = {g.locator('[data-testid=bench-mcp-grant-tool]').nth(i).get_attribute('data-tool'): g.locator('[data-testid=bench-mcp-grant-tool]').nth(i).inner_text() for i in range(g.locator('[data-testid=bench-mcp-grant-tool]').count())}
    check('现有授予：两个工具都在，标着「批准申请 #编号」（和直接授予分得开）', set(srcs) == {'dataset_list', 'dataset_append'} and all(f'批准申请 #{IDS[0]}' in v for v in srcs.values()), srcs)
    check('留痕里有这次批准', '批准申请' in pg.locator('[data-testid=bench-mcp-log]').inner_text())

    print('四、驳回')
    row(pend, IDS[1]).locator('[data-testid=bench-mcp-reject]').click(); pg.wait_for_selector('[data-testid=bench-mcp-dialog]')
    confirm = pg.locator('[data-testid=bench-mcp-confirm]')
    check('驳回不写理由：不能点', confirm.is_disabled())
    pg.locator('[data-testid=bench-mcp-note-input]').fill('合成：这个会话不看页面')
    confirm.click()
    pg.wait_for_function(f"() => document.querySelectorAll('[data-testid=bench-mcp-pending] tr[data-row-key]').length === 1")
    d2 = row(done, IDS[1]).inner_text()
    check('驳回后：办过的里状态已驳回、驳回理由回读得到', '已驳回' in d2 and '合成：这个会话不看页面' in d2, d2)
    check('驳回的工具没进现有授予', g.locator('[data-tool=view_get]').count() == 0)

    print('五、别处先批了')
    row(pend, IDS[2]).locator('[data-testid=bench-mcp-approve]').click(); pg.wait_for_selector('[data-testid=bench-mcp-dialog]')
    other = ctx.request.post(f'{M}/api/bench-views/{BENCH}/mcp-requests/{IDS[2]}', data={'approve': True, 'note': '合成：别处先批'}, headers={'origin': M, 'sec-fetch-site': 'same-origin'})
    pg.locator('[data-testid=bench-mcp-confirm]').click(); pg.wait_for_selector('[data-testid=bench-mcp-dialog-msg]')
    check('对话框开着时别处先批了：照服务端说（已经批准过了），对话框不关', other.status == 200 and '批准过' in pg.locator('[data-testid=bench-mcp-dialog-msg]').inner_text() and pg.locator('[data-testid=bench-mcp-dialog]').count() == 1, (other.status, pg.locator('[data-testid=bench-mcp-dialog-msg]').inner_text()))
    pg.goto(f'{M}/bench-mcp/{BENCH}'); pg.wait_for_selector('[data-testid=bench-mcp-pending]')
    check('刷新后待批清单空了，那条在办过的里是已批准', pg.locator('[data-testid=bench-mcp-pending] tr[data-row-key]').count() == 0 and '已批准' in row(pg.locator('[data-testid=bench-mcp-done]'), IDS[2]).inner_text())
    pg.goto(f'{M}/mcp-gateways'); pg.get_by_role('tab', name='台上的申请').click(); pg.wait_for_selector('[data-testid=mcp-bench-requests-empty]')
    check('MCP 网关页「台上的申请」也空了，说「没有你能批的」', '没有你能批的' in pg.locator('[data-testid=mcp-bench-requests-empty]').inner_text())
    ctx.close(); b.close()
print(f'\nbench-mcp-ui-browser: {ok} 过 / {fail} 败'); sys.exit(1 if fail else 0)
