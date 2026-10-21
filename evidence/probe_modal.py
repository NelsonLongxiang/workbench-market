"""DOM 探针：定位 E2E 失败的真实原因（modal submit 按钮去向 / 设置页按钮 / 行数）"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'

def dump_buttons(page, scope_desc, sel):
    btns = page.locator(f'{sel} button')
    n = btns.count()
    print(f'--- {scope_desc}: {n} buttons')
    for i in range(min(n, 20)):
        b = btns.nth(i)
        try:
            print(f'  [{i}] type={b.get_attribute("type")!r} text={b.inner_text()!r} visible={b.is_visible()}')
        except Exception as e:
            print(f'  [{i}] ERR {e}')

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={'width': 1440, 'height': 900})
    page.set_default_timeout(6000)
    page.on('console', lambda m: m.type == 'error' and print('CONSOLE-ERR:', m.text[:300]))
    page.on('pageerror', lambda e: print('PAGE-ERR:', str(e)[:300]))

    # ==== A. 市场页 + 新增 modal ====
    page.goto(BASE + '/market')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    print('A0 rows:', page.locator('.ant-table-row').count())
    print('A0 toolbar buttons:', page.locator('.ant-pro-table-list-toolbar button').count())

    page.get_by_role('button', name='新增工作台').click()
    page.wait_for_timeout(800)
    print('A1 modal-content count:', page.locator('.ant-modal-content').count())
    dump_buttons(page, 'A1 modal open', '.ant-modal-content')

    modal = page.locator('.ant-modal-content').filter(has_text='新增工作台')
    print('A2 filtered modal count:', modal.count())

    modal.get_by_label('名称').fill('E2E 测试工作台')
    modal.get_by_label('服务地址').fill('ftp://bad')
    dump_buttons(page, 'A3 after fill ftp', '.ant-modal-content')
    modal.locator('button:has-text("创 建")').click()
    page.wait_for_timeout(600)
    print('A4 after submit ftp: modal count', page.locator('.ant-modal-content').count(),
          '| filtered', modal.count())
    dump_buttons(page, 'A4 modal', '.ant-modal-content')
    print('A4 body has 必须以http:', '必须以 http' in page.inner_text('body'))

    modal.get_by_label('服务地址').fill(BASE)
    modal.get_by_label('分类').fill('E2E')
    tags = modal.get_by_placeholder('回车添加，可多个')
    tags.fill('e2e'); tags.press('Enter')
    page.wait_for_timeout(400)
    dump_buttons(page, 'A5 after all fills', '.ant-modal-content')
    print('A5 filtered modal count:', modal.count())
    try:
        modal.locator('button:has-text("创 建")').click()
        print('A6 submit clicked')
    except Exception as e:
        print('A6 submit FAIL:', str(e).split('\n')[0])
        # dump modal html fragment
        html = page.locator('.ant-modal-content').first.inner_html()
        print('A6 modal html len', len(html))
        print(html[:1500])
    page.wait_for_timeout(1500)
    print('A7 rows:', page.locator('.ant-table-row').count(),
          '| has E2E row:', page.locator('.ant-table-row').filter(has_text='E2E 测试工作台').count())

    # ==== B. 设置页 ====
    page.goto(BASE + '/settings')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    dump_buttons(page, 'B1 settings page', 'body')
    print('B1 has 巡检间隔:', '巡检间隔' in page.inner_text('body'))

    # ==== C. 类型页 modal ====
    page.goto(BASE + '/types')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    print('C0 rows:', page.locator('.ant-table-row').count())
    page.get_by_role('button', name='新增类型').click()
    page.wait_for_timeout(800)
    dump_buttons(page, 'C1 types modal', '.ant-modal-content')

    b.close()
