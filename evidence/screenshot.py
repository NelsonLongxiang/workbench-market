"""Playwright UI 渲染证据：五页截图（总览/市场/使用/类型/设置）"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'
OUT = 'evidence'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})

    shots = [
        ('/', '01-dashboard.png', 1500),
        ('/market', '02-market.png', 1500),
        ('/use/1', '03-use-workbench.png', 2500),
        ('/types', '04-types.png', 1500),
        ('/settings', '05-settings.png', 1500),
    ]
    for path, name, wait_ms in shots:
        page.goto(BASE + path)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(wait_ms)
        page.screenshot(path=f'{OUT}/{name}', full_page=True)
        print(f'OK {name} <- {path}')

    browser.close()
print('DONE')
