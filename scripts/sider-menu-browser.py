"""#316 侧栏五组菜单浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg=json.load(open(sys.argv[1]))
M=cfg['base']; C=cfg['control']; TOK=cfg['token']
ok=fail=0
def check(n,c,x=''):
    global ok,fail
    if c: ok+=1; print('  ✓',n)
    else: fail+=1; print('  ✗',n,x)
def lum(rgb):
    def ch(v):
        v=v/255; return v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
    r,g,b=rgb; return 0.2126*ch(r)+0.7152*ch(g)+0.0722*ch(b)
def ratio(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
NAV=(15,23,42)
JS="""[...document.querySelectorAll('.ant-pro-sider .ant-menu-submenu-title, .ant-pro-sider .ant-menu-item')].filter(e=>e.offsetParent).map(e=>{const cs=getComputedStyle(e);return [e.textContent.trim(), cs.color, cs.backgroundColor]})"""
def rgb(s): return tuple(int(float(x)) for x in s[s.index('(')+1:s.index(')')].split(',')[:3])
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1280,'height':800})
    for path in ['/','/tasks','/cockpit','/sops','/market','/skills','/lifecycle','/mcp-gateways','/types','/settings']:
        pg.goto(M+path); pg.wait_for_selector('.ant-pro-sider .ant-menu')
        check(f'业务面 {path} 旧路由仍可打开（未被重定向到 /）', pg.evaluate('location.pathname')==path, pg.evaluate('location.pathname'))
    pg.goto(M+'/sops'); pg.wait_for_selector('.ant-pro-sider .ant-menu')
    items=pg.evaluate(JS); names=[i[0] for i in items]
    check('业务面菜单五组中的四组按序出现', [n for n in names if n in ('工作','交付','资源','治理','管理')]==['工作','交付','资源','治理'], names)
    check('业务面无口令：看不到管理组', '管理' not in names and 'MCP 网关' not in names, names)
    check('四个日常分组默认展开（9 个页面项可见）', all(n in names for n in ['总览','统一待办','驾驶舱','SOP 交付空间','工作台市场','技能市场','生命周期全景']), names)
    check('页面标题改为 SOP 交付空间', pg.locator('.ant-page-header-heading-title, .ant-pro-page-container-title, h1, .ant-page-header-heading-title').first.inner_text().strip()=='SOP 交付空间' if pg.locator('.ant-page-header-heading-title').count() else 'SOP 交付空间' in pg.content())
    worst=min((ratio(rgb(c), rgb(bg) if 'rgba(0, 0, 0, 0)' not in bg else NAV), n) for n,c,bg in items)
    check(f'侧栏所有文字对比度 ≥4.5（最低 {worst[0]:.2f} @{worst[1]}）', worst[0]>=4.5)
    icons=pg.evaluate("""[...document.querySelectorAll('.ant-pro-sider .ant-menu-item')].map(e=>[...(e.querySelector('.wm-menu-link > .anticon')?.classList||[])].find(c=>c.startsWith('anticon-')))""")
    check('每页专属图标不复用', len(icons)==len(set(icons)) and None not in icons, icons)
    # 控制面：无口令 → 无管理组；输入口令 → 管理组出现且默认折叠；在管理页时展开
    pg.goto(C+'/types'); pg.wait_for_selector('.ant-pro-sider .ant-menu')
    n2=[i[0] for i in pg.evaluate(JS)]
    check('控制面未输口令：看不到管理组', '管理' not in n2, n2)
    pg.goto(C+'/sops'); pg.wait_for_selector('.ant-pro-sider .ant-menu')
    pg.locator('.ant-pro-sider button', has_text='口令').first.click()
    pg.locator('.ant-popover input[type=password]').fill(TOK)
    pg.locator('.ant-popover button', has_text='保').click(); pg.wait_for_timeout(400)
    n3=[i[0] for i in pg.evaluate(JS)]
    check('控制面有口令：管理组出现', '管理' in n3, n3)
    check('管理组默认折叠（子项不可见）', 'MCP 网关' not in n3 and '设置' not in n3, n3)
    pg.locator('.ant-pro-sider .ant-menu-submenu-title', has_text='管理').click(); pg.wait_for_timeout(400)
    n4=[i[0] for i in pg.evaluate(JS)]
    check('点开管理组后四项可见（含凭据库）', all(x in n4 for x in ['MCP 网关','凭据库','类型管理','设置']), n4)
    pg.locator('.ant-pro-sider .ant-menu-item', has_text='类型管理').click(); pg.wait_for_timeout(400)
    check('点击管理组子项跳转 /types', pg.evaluate('location.pathname')=='/types')
    b.close()
print(f'sider-menu-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
