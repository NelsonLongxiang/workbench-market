"""探针3：完整复现 e2e 测试7 编辑改名流程"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={'width': 1440, 'height': 900})
    page.set_default_timeout(8000)
    page.on('pageerror', lambda e: print('PAGE-ERR:', str(e)[:300]))
    page.on('console', lambda m: m.type == 'error' and print('CONSOLE-ERR:', m.text[:200]))

    # 清场 + 造一条 E2E 行
    for w in page.request.fetch(f'{BASE}/api/workbenches').json():
        if w['name'].startswith('E2E'):
            page.request.fetch(f"{BASE}/api/workbenches/{w['id']}", method='DELETE')
    page.request.fetch(f'{BASE}/api/workbenches', method='POST',
                       data='{"name":"E2E 测试工作台","url":"http://127.0.0.1:9800","type":"web","description":"**E2E** 自动化测试条目"}',
                       headers={'Content-Type': 'application/json'})

    page.goto(BASE + '/market')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    row = page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')
    print('1 row count:', row.count())
    row.get_by_role('button', name='编辑').click()
    page.wait_for_timeout(800)
    modal = page.locator('.ant-modal-content').filter(has_text='编辑工作台')
    print('2 modal count:', modal.count())
    print('3 title:', page.locator('.ant-modal-title').inner_text())
    modal.get_by_label('名称').fill('E2E 改名后')
    print('4 name filled')
    loc = modal.locator('.ant-modal-footer .ant-btn-primary')
    print('5 footer-primary count:', loc.count(), 'enabled:', loc.first.is_enabled() if loc.count() else '-')
    try:
        loc.click()
        print('6 CLICK OK')
    except Exception as e:
        print('6 CLICK FAIL:', str(e).split(chr(10))[0])
        html = modal.first.inner_html()
        print('footer html:', html[-1200:])
    page.wait_for_timeout(1500)
    print('7 renamed row count:', page.locator('.ant-table-row').filter(has_text='E2E 改名后').count())
    print('8 modal still open:', page.locator('.ant-modal-content').count())
    r = page.request.fetch(f'{BASE}/api/workbenches').json()
    print('9 api names:', [w['name'] for w in r if w['name'].startswith('E2E')])
    # 清场
    for w in page.request.fetch(f'{BASE}/api/workbenches').json():
        if w['name'].startswith('E2E'):
            page.request.fetch(f"{BASE}/api/workbenches/{w['id']}", method='DELETE')
    b.close()
