"""#320 驾驶舱旧布局的浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
驾驶舱：旧布局（宽 5/7）读时吸附到 4 档、不丢面板、只读页不发布局写、接口数据不变。
原来的总览（/overview）那一半随页面删了（属主 2026-11-11：旧版页面弃用）。"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def get(path): return json.load(urllib.request.urlopen(M + path))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    # Explicit synthetic task authority for all fixture pages, without business-page token storage.
    ctx.route(M + '/api/tasks', lambda r: r.continue_(headers={**r.request.headers, 'x-admin-token': cfg['token']}))
    # ── 驾驶舱旧布局读时迁移 ──
    cid = cfg['legacy_cockpit']
    before = get(f'/api/cockpits/{cid}')['panels']
    writes = []
    pg3 = ctx.new_page(); pg3.set_default_timeout(10000)
    pg3.on('request', lambda r: writes.append(f'{r.method} {r.url}') if r.method != 'GET' and '/api/cockpits' in r.url else None)
    pg3.goto(M + f'/cockpit/{cid}'); pg3.wait_for_selector('.wm-ck-benches .wm-panel')
    pg3.wait_for_timeout(800)
    n = pg3.locator('.wm-ck-benches .wm-panel').count()
    check(f'旧布局升级后不丢卡片（{n}/{len(before)}）', n == len(before))
    # 内嵌的工作台按栏宽单列排：一个台占满栏宽，不能拖、不能拉伸
    ws = pg3.evaluate("""(()=>{const g=document.querySelector('.wm-ck-benches');const gw=g.getBoundingClientRect().width;
      return [...g.querySelectorAll(':scope > .wm-panel')].map(e=>Math.round(e.getBoundingClientRect().width-gw))})()""")
    check(f'内嵌台单列、占满栏宽（{ws}）', len(ws) == n and all(abs(d) <= 2 for d in ws))
    check('没有拖动和拉伸的把手', pg3.locator('.react-resizable-handle, .react-draggable, .wm-panel-grip').count() == 0)
    check('只读页挂载不发布局写请求', not writes, writes)
    check('接口里的布局数据不被改（读时迁移不回写）', get(f'/api/cockpits/{cid}')['panels'] == before)
    ctx.unroute(M + '/api/tasks'); ctx.close(); b.close()
print(f'dashboard-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
