"""#1063 设置页「个人令牌」：浏览器这一段；由 scripts/personal-tokens-browser.mjs 起合成实例、授好属主后调用，参数为配置 JSON 路径。个人令牌接口不截。
  一、属主：空清单；签发对话框没填不能点；只选报告维度、不选台可以签；
  二、只显示一次：原文 wmu_ 加 43 位、可复制，对话框关上；不进本地存储、会话存储、地址；本页存着管理口令也不随请求发出；点「我已保存」就没了，刷新后行还在、原文看不到；
  三、名字重复：对话框里照服务端说，对话框不关、不出原文；「算了」关上，再开清掉旧说法；
  四、撤销：二次确认后行变已撤销、撤销按钮没了，请求是 DELETE；之后拿这枚令牌请求一律 401；
  五、非属主：卡片说只有属主，没有「签发令牌」。"""
import json, re, sys
from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
TOKEN = re.compile(r'^wmu_[A-Za-z0-9_-]{43}$')

with sync_playwright() as p:
    b = p.chromium.launch()
    def ctx_for(session):
        c = b.new_context(viewport={'width': 1400, 'height': 1000})
        c.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
        return c
    def modal_gone(pg):
        pg.wait_for_function("() => [...document.querySelectorAll('.ant-modal-wrap')].every(w => getComputedStyle(w).display === 'none')", timeout=5000)
        return True
    def cancel(pg):
        pg.locator('.ant-modal-footer .ant-btn').filter(has_text='算').click()

    print('一、属主')
    ctx = ctx_for(cfg['session_owner']); pg = ctx.new_page(); pg.set_default_timeout(15000)
    reqs = []
    pg.on('request', lambda r: reqs.append((r.method, dict(r.headers))) if '/api/owner/personal-tokens' in r.url else None)
    pg.goto(f'{M}/'); pg.evaluate("() => sessionStorage.setItem('wm-admin-token', 'synthetic-pt-admin-token')")
    pg.goto(f'{M}/settings'); pg.wait_for_selector('[data-testid=pt-list]')
    pg.wait_for_function("() => document.querySelector('[data-testid=pt-list]').textContent.includes('还没有签过个人令牌')")
    check('设置页有「个人令牌」卡片、空清单，属主看得到「签发令牌」', pg.locator('[data-testid=pt-new]').count() == 1)
    pg.locator('[data-testid=pt-new]').click(); pg.wait_for_selector('.ant-modal [data-testid=pt-draft-name]')
    issue = pg.locator('[data-testid=pt-issue]')
    check('没填之前「签发」不能点，说名字怎么写', issue.is_disabled() and '名字' in pg.locator('[data-testid=pt-draft-problem]').inner_text())
    pg.locator('[data-testid=pt-draft-name]').fill('laptop wm')
    pg.locator('[data-testid=pt-draft-scopes] input[value=view]').check()
    pg.wait_for_function("() => document.querySelector('[data-testid=pt-draft-problem]')?.textContent.includes('台')")
    check('选了按台的作用域却没选台：不能点，说要选台', issue.is_disabled())
    pg.locator('[data-testid=pt-draft-scopes] input[value=view]').uncheck()
    pg.locator('[data-testid=pt-draft-scopes] input[value=report-dimensions]').check()
    pg.wait_for_function("() => document.querySelector('[data-testid=pt-issue]')?.disabled === false")
    check('只选报告维度、不选台：可以签', not issue.is_disabled())

    print('二、只显示一次')
    issue.click(); pg.wait_for_selector('[data-testid=pt-fresh-token]')
    token = pg.locator('[data-testid=pt-fresh-token]').inner_text().strip()
    check('原文 wmu_ 加 43 位，清单里有这一行', bool(TOKEN.match(token)) and 'laptop wm' in pg.locator('[data-testid=pt-list]').inner_text(), token[:8])
    check('签发后对话框关上', modal_gone(pg))
    where = pg.evaluate('() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + location.href')
    check('原文不在本地存储、会话存储、地址', token not in where)
    check('个人令牌的请求不带管理口令与 Authorization（本页存着管理口令）', len(reqs) >= 2 and all('x-admin-token' not in h and 'authorization' not in h for _, h in reqs), [m for m, _ in reqs])
    pg.locator('[data-testid=pt-fresh-done]').click()
    pg.wait_for_selector('[data-testid=pt-fresh]', state='detached')
    check('点「我已保存」：原文从页面上消失', token not in pg.content())
    pg.reload(); pg.wait_for_function("() => document.querySelector('[data-testid=pt-list]')?.textContent.includes('laptop wm')")
    t = pg.locator('[data-testid=pt-list]').inner_text()
    check('刷新后：行还在，原文看不到', token not in pg.content())
    check('这一行：还没用过、可用、报告维度、还剩 30 天', all(s in t for s in ['还没用过', '可用', '报告维度', '还剩 30 天']), t)

    print('三、名字重复')
    pg.locator('[data-testid=pt-new]').click(); pg.wait_for_selector('.ant-modal [data-testid=pt-draft-name]')
    pg.locator('[data-testid=pt-draft-name]').fill('laptop wm')
    pg.locator('[data-testid=pt-draft-scopes] input[value=report-dimensions]').check()
    pg.locator('[data-testid=pt-issue]').click(); pg.wait_for_selector('.ant-modal [data-testid=pt-issue-err]')
    check('对话框里照服务端说「此令牌名称已使用」，对话框不关、不出原文', '此令牌名称已使用' in pg.locator('.ant-modal [data-testid=pt-issue-err]').inner_text()
          and pg.locator('[data-testid=pt-fresh]').count() == 0 and pg.locator('[data-testid=pt-err]').count() == 0)
    cancel(pg); check('「算了」：对话框关上', modal_gone(pg))
    pg.locator('[data-testid=pt-new]').click(); pg.wait_for_selector('.ant-modal [data-testid=pt-draft-name]')
    check('再开对话框：旧的出错说法清掉了', pg.locator('[data-testid=pt-issue-err]').count() == 0)
    cancel(pg); modal_gone(pg)

    print('四、撤销')
    api = p.request.new_context()
    before = api.get(f'{M}/api/bench-views', headers={'authorization': 'Bearer ' + token}).status
    pg.locator('[data-testid=pt-revoke]').click()
    pg.locator('.ant-popover .ant-btn-dangerous').click()
    pg.wait_for_function("() => document.querySelector('[data-testid=pt-state]')?.textContent === '已撤销'")
    check('撤销后这一行是已撤销，撤销按钮没了，页面没有残留对话框', pg.locator('[data-testid=pt-revoke]').count() == 0 and modal_gone(pg))
    check('撤销请求是 DELETE', any(m == 'DELETE' for m, _ in reqs))
    after = api.get(f'{M}/api/bench-views', headers={'authorization': 'Bearer ' + token}).status
    check('撤销前令牌被认出（不是 401），撤销后一律 401', before != 401 and after == 401, (before, after))
    api.dispose(); ctx.close()

    print('五、非属主')
    ctx = ctx_for(cfg['session_other']); pg = ctx.new_page(); pg.set_default_timeout(15000)
    pg.goto(f'{M}/settings'); pg.wait_for_selector('[data-testid=pt-problem]')
    check('卡片说只有属主，没有「签发令牌」', '属主' in pg.locator('[data-testid=pt-problem]').inner_text() and pg.locator('[data-testid=pt-new]').count() == 0)
    ctx.close(); b.close()
print(f'\npersonal-tokens-browser: {ok} 过 / {fail} 败'); sys.exit(1 if fail else 0)
