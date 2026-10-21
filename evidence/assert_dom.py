"""DOM 断言验证：关键元素与数据是否真实渲染"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:9800'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})

    def expect(path, texts, wait_ms=1500):
        page.goto(BASE + path)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(wait_ms)
        body = page.inner_text('body')
        missing = [t for t in texts if t not in body]
        status = 'PASS' if not missing else f'FAIL missing={missing}'
        print(f'[{status}] {path}')

    expect('/', ['工作台总数', '在线', '平均延迟', 'DSH Web GUI', 'dead port', '使用'])
    expect('/market', ['工作台市场', 'DSH Web GUI', '服务地址', '分类', '新增工作台'])
    expect('/types', ['工作台类型', 'openai-api', '探测语义', '任意响应即在线', '新增类型'])
    expect('/settings', ['健康巡检', '巡检间隔', '导出 JSON', '导入 JSON', '关于'])
    expect('/use/1', ['DSH Web GUI', '新窗口', '返回市场管理'])
    browser.close()
print('DONE')
