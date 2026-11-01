"""#321 设计 token 浏览器回归；由 scripts/tokens-surface-smoke.mjs 起合成实例后调用。
执行页与市场前端：主色、次级文字色、正文字号、字体一致；示例自产台：正文、状态、面与线取变量（与 tokens 值相同）。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
CS = "(sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null }"
def css(pg, sel, prop): return pg.evaluate(CS, [sel, prop]) if False else pg.evaluate(f"(a)=>({CS})(a[0],a[1])", [sel, prop])
def var(pg, name): return pg.evaluate(f"getComputedStyle(document.documentElement).getPropertyValue('{name}').trim()")
def rgb(hexv):
    h = hexv.lstrip('#'); return f"rgb({int(h[0:2],16)}, {int(h[2:4],16)}, {int(h[4:6],16)})"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 800})
    # 市场前端
    pg.goto(M + '/sops'); pg.wait_for_selector('.ant-btn-primary')
    mk = {'primary': css(pg, '.ant-btn-primary', 'backgroundColor'), 'secondary': css(pg, '.ant-page-header-heading-sub-title', 'color'),
          'size': css(pg, '.ant-table-cell', 'fontSize'), 'font': css(pg, 'body', 'fontFamily').split(',')[0].strip(' "\'')}
    # 执行页
    pg.goto(M + '/sop/tokens-sop/'); pg.wait_for_selector('.step')
    rn = {'primary': css(pg, '.btn.primary', 'backgroundColor'), 'secondary': css(pg, '.muted', 'color'),
          'size': css(pg, 'body', 'fontSize'), 'font': css(pg, 'body', 'fontFamily').split(',')[0].strip(' "\'')}
    check(f'执行页与市场前端同主色（{rn["primary"]}）', rn['primary'] == mk['primary'], (rn, mk))
    check(f'执行页与市场前端同次级文字色（{rn["secondary"]}）', rn['secondary'] == mk['secondary'], (rn, mk))
    check(f'执行页与市场前端同正文字号（{rn["size"]}）', rn['size'] == mk['size'] == '14px', (rn, mk))
    check(f'执行页与市场前端同字体（{rn["font"]}）', rn['font'] == mk['font'] == 'Inter', (rn, mk))
    check('执行页面板为 surface、页底为 page', css(pg, '.step', 'backgroundColor') == rgb(var(pg, '--wm-color-surface')) and css(pg, 'body', 'backgroundColor') == rgb(var(pg, '--wm-color-page')))
    check('执行页顶栏用 nav-bg（唯一深色区）', css(pg, '.bar', 'backgroundColor') == rgb(var(pg, '--wm-color-nav-bg')))
    # 示例自产台
    pg.goto(M + '/apps/tokens-demo/'); pg.wait_for_selector('.card')
    # 自产台在 CSP sandbox 里（不透明源），读不到 cssRules——改看样式表已加载且变量能解析出值
    check('示例自产台加载了 /design/tokens@1.css 且变量可用（CSP sandbox 下照常生效）', pg.evaluate("!!document.querySelector('link[href$=\"/design/tokens@1.css\"]').sheet") and var(pg, '--wm-color-primary') == '#1E3A5F')
    pairs = [('body', 'color', '--wm-color-text'), ('body', 'backgroundColor', '--wm-color-page'), ('.card', 'backgroundColor', '--wm-color-surface'),
             ('.card', 'borderTopColor', '--wm-color-border'), ('.hint', 'color', '--wm-color-text-secondary'), ('.ok', 'color', '--wm-color-success-text'),
             ('.warn', 'color', '--wm-color-warning-text'), ('.err', 'color', '--wm-color-danger-text'), ('button', 'backgroundColor', '--wm-color-primary')]
    bad = [(s, pr, v, css(pg, s, pr), rgb(var(pg, v))) for s, pr, v in pairs if css(pg, s, pr) != rgb(var(pg, v))]
    check('示例自产台正文、状态、面与线全部取变量值', not bad, bad)
    b.close()
print(f'tokens-surface-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
