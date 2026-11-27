"""「安排一件事」浏览器端到端；由 scripts/arrange-e2e-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
实例里任务中心上绑着两个合成的通知团队（合成甲队、合成乙队）。页面上的请求一个都不截，走实例里真的接口：
  一、正例：首页「安排一件事」→ 抽屉里列出两个可派团队 → 选团队、填标题/要做什么/交什么 → 安排
      → 进 /work-items/<新事项>，页头是这个标题；接口里这一件的建立人是本人、派给选中的团队；回「事项」列表能看到它。
  二、反例·缺必填：不写标题就点安排 → 标题下面说「写一个标题」，抽屉不关、不发 POST /api/work-items、地址不变。
  三、反例·团队不能派：抽屉打开、选好合成乙队之后，管理员撤掉乙队的绑定 → 点安排 → 服务端拒（team_not_assignable），
      抽屉里说「这个团队现在不能派，换一个」，不跳走；接口里也没有多出一件。
断言都等条件成立（wait_for_*），不用固定等待。数据全是合成的。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ADMIN = {'x-admin-token': cfg['admin_token'], 'sec-fetch-site': 'same-origin'}
SAME = {'sec-fetch-site': 'same-origin'}
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    pg = ctx.new_page(); pg.set_default_timeout(15000)
    posts = []
    pg.on('request', lambda r: posts.append(r.url) if r.method == 'POST' and re.search(r'/api/work-items$', r.url) else None)
    api = ctx.request
    def my_items():
        r = api.get(M + '/api/work-items', headers=SAME)
        body = r.json() if r.ok else {}
        return r.status, [x.get('id') for x in (body.get('items') or body.get('rows') or [])]

    def open_drawer():
        pg.goto(M + '/')
        pg.locator('[data-testid=arrange-open]').first.click()
        pg.wait_for_selector('[data-testid=arrange-form]')
    def pick_team(name):
        pg.locator('[data-testid=arrange-form] .ant-select').first.click()
        pg.locator('.ant-select-item-option', has_text=name).click()
        pg.wait_for_function("n => [...document.querySelectorAll('[data-testid=arrange-form] .ant-select-selection-item')].some(e => e.textContent.trim() === n)", arg=name)
    def fill(title, intent, deliverable):
        form = pg.locator('[data-testid=arrange-form]')
        if title is not None: form.locator('input[placeholder="一句话说清是什么事"]').fill(title)
        form.locator('textarea').nth(0).fill(intent)
        form.locator('textarea').nth(1).fill(deliverable)

    # ---------- 一、正例 ----------
    open_drawer()
    pg.locator('[data-testid=arrange-form] .ant-select').first.click()
    pg.wait_for_selector('.ant-select-item-option')
    opts = pg.locator('.ant-select-item-option').all_inner_texts()
    check('可派团队：抽屉里列的是任务中心上绑着的两个通知团队（显示画布队名）', sorted(o.strip() for o in opts) == ['合成乙队', '合成甲队'], opts)
    pg.keyboard.press('Escape')
    pick_team('合成甲队')
    fill('合成：对一下上周的出货', '合成：把出货单和对账单对一遍', '合成：一张差异表')
    pg.locator('[data-testid=arrange-submit]').click()
    pg.wait_for_url(re.compile(r'/work-items/wi_[^/?#]+$'))
    item_id = pg.url.rsplit('/', 1)[1]
    pg.wait_for_selector('[data-testid=work-item-summary]')
    top = pg.locator('[data-testid=wm-top]', has_text='合成：对一下上周的出货')
    top.wait_for()
    check('安排之后进这一件的详情页，页头是标题', top.count() == 1, pg.url)
    check('只发了一次 POST /api/work-items', len(posts) == 1, posts)
    d = api.get(M + f'/api/work-items/{item_id}', headers=SAME)
    it = (d.json() if d.ok else {}).get('item') or {}
    check('接口里：建立人是本人，派给选中的合成甲队，标题照填的', d.status == 200 and it.get('creator_principal') == 'user:alpha' and it.get('target_team') == 'syn/canvas/合成甲队' and it.get('title') == '合成：对一下上周的出货', {'status': d.status, 'item': {k: it.get(k) for k in ('creator_principal', 'target_team', 'title', 'state')}})
    pg.goto(M + '/work-items')
    row = pg.locator('[data-testid=work-item-row]', has=pg.locator(f'a[href="/work-items/{item_id}"]'))
    row.wait_for()
    check('回「事项」列表能看到这一件', row.count() == 1 and '合成：对一下上周的出货' in row.inner_text())
    st0, before = my_items()

    # ---------- 二、反例·缺必填（标题） ----------
    posts.clear()
    open_drawer()
    pick_team('合成甲队')
    fill(None, '合成：没写标题的一件', '合成：随便交点什么')
    url0 = pg.url
    pg.locator('[data-testid=arrange-submit]').click()
    help_ = pg.locator('[data-testid=arrange-form] .ant-form-item-explain-error', has_text='写一个标题')
    help_.wait_for()
    # 页面上的校验和 POST 在同一次点击里：提示出来了还没发，就是没发
    check('缺标题：标题下面说「写一个标题」，没发 POST /api/work-items', help_.count() == 1 and posts == [], posts)
    check('缺标题：抽屉还开着、地址没变', pg.locator('[data-testid=arrange-form]').is_visible() and pg.url == url0, pg.url)
    pg.keyboard.press('Escape')
    pg.locator('[data-testid=arrange-form]').wait_for(state='detached')

    # ---------- 三、反例·团队不能派（打开抽屉之后绑定被撤） ----------
    posts.clear()
    open_drawer()
    pick_team('合成乙队')
    fill('合成：派给已撤团队的一件', '合成：这件不该建出来', '合成：无')
    rv = api.delete(M + f"/api/bindings/{cfg['bindings']['合成乙队']}", headers=ADMIN)
    check('管理员撤掉合成乙队的绑定', rv.status == 200, rv.status)
    with pg.expect_response(lambda r: r.request.method == 'POST' and re.search(r'/api/work-items$', r.url) is not None) as resp:
        pg.locator('[data-testid=arrange-submit]').click()
    r = resp.value
    check('服务端拒：400 team_not_assignable', r.status == 400 and (r.json() or {}).get('error') == 'team_not_assignable', r.status)
    failure = pg.locator('[data-testid=arrange-failure]', has_text='这个团队现在不能派，换一个')
    failure.wait_for()
    check('抽屉里照服务端说「这个团队现在不能派，换一个」，不跳走', failure.count() == 1 and pg.locator('[data-testid=arrange-form]').is_visible() and '/work-items/' not in pg.url, pg.url)
    st1, after = my_items()
    check('接口里没有多出一件', st0 == 200 and st1 == 200 and sorted(after) == sorted(before) and item_id in after, {'before': before, 'after': after})
    # ---------- 四、属主安排后没有新的过目卡（#1143） ----------
    release_path = f'/api/work-items/{item_id}/release'
    denied = api.post(M + release_path, headers=SAME, data={})
    check('普通员工不能放行这件由团队负责过目的 held 单', denied.status == 403 and denied.json().get('error') == 'work_item_release_not_yours', denied.status)
    policy = api.put(M + '/api/task-center/policy', headers=ADMIN, data={'agent_dispatch_enabled': True})
    check('测试开启任务中心总开关', policy.status == 200, policy.status)
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['owner_session'], 'url': M}])
    owner_title = '合成：属主整队派发免过目'
    open_drawer()
    pick_team('合成甲队')
    fill(owner_title, '合成：核对直接派发', '合成：一份核对记录')
    with pg.expect_response(lambda res: res.request.method == 'POST' and res.url.endswith('/api/work-items')) as created_response:
        pg.locator('[data-testid=arrange-submit]').click()
    created = created_response.value
    arranged = created.json()
    check('真实页面提交后服务端直接派出，事项不是 held', created.status == 201 and arranged.get('state') == 'delivered' and arranged.get('held') is False, arranged)
    pg.wait_for_url(re.compile(r'/work-items/wi_[^/?#]+$'))
    check('浏览器跳转到刚建的事项', pg.url.endswith('/' + arranged['item_id']), pg.url)
    with pg.expect_response(lambda res: res.url.split('?')[0].endswith('/api/attention') and res.ok) as attention_response:
        pg.goto(M + '/')
    pending = attention_response.value.json().get('items', [])
    pg.locator('[data-testid=home-decide-loading]').wait_for(state='hidden')
    check('属主首页：普通员工建的 held 单仍有过目卡；属主新单没有过目卡',
          any(x.get('source_id') == item_id and x.get('category') == 'glance' for x in pending)
          and all(x.get('source_id') != arranged['item_id'] for x in pending)
          and pg.get_by_text(owner_title, exact=True).count() == 0)
    released = api.post(M + release_path, headers=SAME, data={})
    check('属主浏览器会话可放行旧 held 单', released.status == 200 and released.json().get('released') == 1, released.status)
    b.close()
print(f'arrange-e2e-browser: {ok} 过 / {fail} 失败')
sys.exit(1 if fail else 0)
