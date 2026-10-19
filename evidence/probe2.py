"""探针2：设置页按钮 / 编辑 modal footer 结构"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={'width': 1440, 'height': 900})
    page.set_default_timeout(6000)
    page.on('pageerror', lambda e: print('PAGE-ERR:', str(e)[:400]))

    # A. 设置页
    page.goto(BASE + '/settings')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1200)
    print('A1 body has 巡检间隔:', '巡检间隔' in page.inner_text('body'))
    btns = page.locator('button')
    print('A2 page buttons:', btns.count())
    for i in range(btns.count()):
        t = btns.nth(i)
        print(f'  [{i}] name={t.get_by_role("button").count() and "" or ""}text={t.inner_text()!r} type={t.get_attribute("type")} class~primary={"ant-btn-primary" in (t.get_attribute("class") or "")}')
    # aria name 实测
    save = page.get_by_role('button', name='保 存')
    print('A3 get_by_role 保 存 count:', save.count())
    print('A4 get_by_role 保存 count:', page.get_by_role('button', name='保存').count())

    # B. 市场：编辑 modal
    page.goto(BASE + '/market')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    row = page.locator('.ant-table-row').first
    print('B1 first row:', row.inner_text()[:60].replace('\n', ' '))
    row.get_by_role('button', name='编辑').click()
    page.wait_for_timeout(1000)
    modal = page.locator('.ant-modal-content')
    print('B2 modal count:', modal.count(), '| .ant-modal-footer count:', page.locator('.ant-modal-footer').count())
    foot = page.locator('.ant-modal-footer')
    if foot.count():
        fb = foot.locator('button')
        for i in range(fb.count()):
            x = fb.nth(i)
            print(f'  footer-btn[{i}] text={x.inner_text()!r} primary={"ant-btn-primary" in (x.get_attribute("class") or "")}')
    # 直接测 footer 内 primary 定位
    print('B3 footer primary count:', page.locator('.ant-modal-footer .ant-btn-primary').count())
    print('B4 modal-title:', page.locator('.ant-modal-title').inner_text())
    b.close()
