"""UX 校对截图：五页 1440x900 + 移动端 390x844"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'
shots = [
    ('/', 'ux-dashboard', (1440, 900)),
    ('/market', 'ux-market', (1440, 900)),
    ('/types', 'ux-types', (1440, 900)),
    ('/settings', 'ux-settings', (1440, 900)),
    ('/use/1', 'ux-use', (1440, 900)),
    ('/', 'ux-dashboard-mobile', (390, 844)),
    ('/market', 'ux-market-mobile', (390, 844)),
]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for path, name, vp in shots:
        page = b.new_page(viewport={'width': vp[0], 'height': vp[1]})
        page.goto(BASE + path, wait_until='networkidle')
        page.wait_for_timeout(1800)
        page.screenshot(path=f'evidence/{name}.png', animations='disabled')
        print(f'{name}.png  ({vp[0]}x{vp[1]})')
        page.close()
    b.close()
