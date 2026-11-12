"""「等你拍板」三处同数的浏览器回归；由 scripts/home-count-browser.mjs 起合成实例、造好数据后调用，参数为配置 JSON 路径。
管理员：有两件轮到他、能当场放行的事项 → 侧栏角标、总结句、卡片区件数都是 2；要到别处处理的不进这三处，单列一组。
不刷新页面，当场放行一件 → 三处一起变成 1；再放行一件 → 角标消失、总结句不再说有等你拍板的、卡片区为 0。
建立人 alpha：这件事等的是别人放行，不轮到他 → 没有角标，卡片区为 0。"""
import json, re, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def attention(session):
    req = urllib.request.Request(M + '/api/attention', headers={'cookie': f'session_id={session}', 'sec-fetch-site': 'same-origin'})
    return json.load(urllib.request.urlopen(req)).get('items', [])
def three(pg):
    """页面上的三个数：角标、总结句里的数、「等你拍板」标题旁的数"""
    badge = pg.locator('[data-testid=nav-pending]')
    summary = pg.locator('[data-testid=home-summary]').inner_text()
    m = re.search(r'有 (\d+) 件等你拍板', summary)
    head = pg.locator('.wm-sec-h .wm-sec-n').first.inner_text().strip()
    return (int(badge.inner_text()) if badge.count() else 0, int(m.group(1)) if m else 0, int(head), summary)
def open_home(b, session):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
    pg = ctx.new_page(); pg.goto(M + '/')
    pg.wait_for_selector('[data-testid=home-summary]')
    pg.wait_for_function("document.querySelector('.wm-sec-h .wm-sec-n') && !document.querySelector('.wm-home .ant-skeleton')")
    pg.wait_for_timeout(800)
    return ctx, pg

with sync_playwright() as p:
    b = p.chromium.launch()
    items = attention(cfg['admin_session'])
    mine_now = [x for x in items if x.get('answers') and x.get('mine') is not False]
    elsewhere = [x for x in items if not x.get('answers')]
    check(f'造出来的数据：管理员有 2 件轮到他能当场办的、{len(elsewhere)} 件要到别处处理的', sorted(x.get('source_id') for x in mine_now) == sorted(cfg['items']) and len(elsewhere) >= 3, (len(mine_now), len(elsewhere)))
    ctx, pg = open_home(b, cfg['admin_session'])
    badge, in_sum, head, summary = three(pg)
    check(f'管理员：角标、总结句、卡片区件数三处同数，都是 2（{badge} / {in_sum} / {head}）', badge == 2 and in_sum == 2 and head == 2, summary)
    now = pg.locator('[data-testid=decisions-now] [data-testid=decision-card]')
    texts = ' '.join(now.all_inner_texts())
    check('「等你拍板」里就是那两件，都带「派出去」', now.count() == 2 and all(t in texts for t in cfg['titles']) and texts.count('派出去') == 2, texts)
    other = pg.locator('[data-testid=decisions-elsewhere] [data-testid=decision-card]')
    check(f'要到别处处理的单列一组（{other.count()} 张），总结句另说一句、不算进等你拍板', other.count() == len(elsewhere) and f'{len(elsewhere)} 件要到别处处理' in summary, summary)
    check('没有「可以代办」的条目时不出现那一组', pg.locator('[data-testid=decisions-proxy]').count() == 0)
    # 完整列表（/attention，全景「全部 →」链过去）：同一张卡、同一个算法——等你拍板的件数和全景一样，要到别处处理的单列
    pa = ctx.new_page(); pa.goto(M + '/attention'); pa.wait_for_selector('[data-testid=attention-summary]')
    pa.wait_for_function("!document.querySelector('.wm-home .ant-skeleton')"); pa.wait_for_timeout(600)
    a_sum = pa.locator('[data-testid=attention-summary]').inner_text()
    a_now = pa.locator('[data-testid=attention-now] [data-testid=decision-card]').count()
    a_else = pa.locator('[data-testid=attention-elsewhere] [data-testid=decision-card]').count()
    check(f'完整列表：总结句和全景同一句，等你拍板 {a_now} 张、要到别处处理的 {a_else} 张', a_sum == summary and a_now == 2 and a_else == len(elsewhere), (a_sum, summary))
    pa.locator('[data-testid=attention-filter]').get_by_text('等审核', exact=False).first.click(); pa.wait_for_timeout(300)
    check('按类别筛：只看「等审核」时等你拍板那一组不在了，总结句不变', pa.locator('[data-testid=attention-now]').count() == 0 and pa.locator('[data-testid=attention-summary]').inner_text() == a_sum)
    pa.close()
    # 当场放行一件（不刷新页面）：三处一起从 2 变成 1。角标不能直接没了
    now.first.get_by_role('button', name=re.compile('派出去')).click()
    pg.wait_for_function("document.querySelectorAll('[data-testid=decisions-now] [data-testid=decision-card]').length === 1", timeout=10000)
    pg.wait_for_timeout(1500)
    badge, in_sum, head, summary = three(pg)
    check(f'办完一件，三处一起从 2 变成 1（{badge} / {in_sum} / {head}）', badge == 1 and in_sum == 1 and head == 1, summary)
    # 再放行一件：三处都是 0
    pg.locator('[data-testid=decisions-now] [data-testid=decision-card]').first.get_by_role('button', name=re.compile('派出去')).click()
    pg.wait_for_function("!document.querySelector('[data-testid=nav-pending]')", timeout=10000)
    pg.wait_for_timeout(600)
    badge, in_sum, head, summary = three(pg)
    check(f'都放行之后三处一起变成 0（{badge} / {in_sum} / {head}），总结句不再说有等你拍板的', badge == 0 and in_sum == 0 and head == 0 and '眼下没有要你当场拍板的' in summary, summary)
    ctx.close()
    # 建立人：这件事（已派出去）不轮到他
    ctx, pg = open_home(b, cfg['alpha_session'])
    badge, in_sum, head, summary = three(pg)
    check(f'建立人 alpha：没有轮到他的，三处都是 0（{badge} / {in_sum} / {head}）', badge == 0 and in_sum == 0 and head == 0, summary)
    # 外壳两处：用户卡写显示名（不是登录名），头像取显示名首字；两个字的按钮不插空格（全站一处设）
    me_name = pg.locator('[data-testid=wm-me-name]').inner_text().strip()
    me_av = pg.locator('[data-testid=wm-me-avatar]').inner_text().strip()
    check(f'用户卡写显示名、头像取显示名首字（{me_name} / {me_av}）', me_name == 'Synthetic alpha' and me_av == 'S', (me_name, me_av))
    pg.goto(M + '/work-items'); pg.wait_for_selector('[data-testid=work-items-views]')
    btn = pg.get_by_role('button', name='刷新').first
    check('两个字的按钮不在字中间插空格（「刷新」不是「刷 新」）', btn.inner_text().strip() == '刷新', btn.inner_text())
    # 地址里带视角和席位（驾驶舱「AI 员工」点卡过来的）：页面认得；这个视角还不能用时退回能看的、告诉一声，不报错
    pg.goto(M + '/work-items?view=seats&seat=s-synthetic'); pg.wait_for_selector('[data-testid=work-items-views]'); pg.wait_for_timeout(800)
    shown = pg.locator('[data-testid=work-items-url-filter], [data-testid=work-items-url-filter-note]')
    check('事项列表认地址里的 view / seat：要么按它筛着，要么说清这个视角还看不了', shown.count() >= 1 and pg.locator('.ant-alert-error').count() == 0, shown.all_inner_texts())
    ctx.close()
    # 卡片上的链接和两种要填的答法（条目用页面里截下来的合成夹具）：
    #   接口地址、路由表里没有的页面不做成链接；MCP 权限申请「不给」可写一句理由（可空）；对接外部账号勾「新建」要再确认一次
    syn = [
        {'source': 'relation-proposals', 'source_id': '9001', 'category': 'grant', 'title': '合成：关系的提议', 'waiting_for': 'person:x', 'waiting_for_name': '合成同事甲', 'since': '2026-11-12T00:00:00Z', 'answers': [], 'object': '', 'phase': '', 'link': '/teams', 'mine': True},
        {'source': 'relation-proposals', 'source_id': '9003', 'category': 'grant', 'title': '合成：另一条关系的提议（新形状）', 'waiting_for': 'person:synthetic-beta', 'since': '2026-11-12T00:00:00Z', 'answers': [], 'object': '', 'phase': 'team-lead', 'link': '/team', 'mine': True, 'creator': {'principal': 'person:synthetic-beta', 'display_name': 'Synthetic beta'}},
        {'source': 'principal-pending', 'source_id': 'synthetic:ext-1', 'category': 'grant', 'title': '合成账号等对接到主体', 'waiting_for': 'synthetic:ext-1', 'since': '2026-11-12T00:00:00Z', 'answers': ['bind'], 'object': '', 'phase': '', 'link': '/api/principals/pending', 'mine': True},
        {'source': 'mcp-access', 'source_id': '9002', 'category': 'grant', 'title': 'MCP 会话 合成会话 申请工具：list_rows', 'waiting_for': 'mcp:合成会话', 'since': '2026-11-12T00:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '/mcp-gateways?access_request=9002', 'mine': True},
    ]
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); ctx.add_cookies([{'name': 'session_id', 'value': cfg['admin_session'], 'url': M}])
    ctx.route('**/api/attention', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'items': syn, 'counts': {'total': len(syn)}, 'sources': {}})))
    sent = []
    ctx.route('**/api/attention/answer', lambda r: (sent.append(json.loads(r.request.post_data or '{}')), r.fulfill(status=200, content_type='application/json', body='{"ok":true}')))
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-card]'); pg.wait_for_timeout(500)
    card = lambda t: pg.locator('[data-testid=decision-card]', has_text=t).first
    check('路由表里没有的页面（/teams）不做成坏链接，按来源给缺省去处（团队页）', card('合成：关系的提议').locator('a.wm-decision-more').get_attribute('href') == '/team')
    check('新形状的关系提议自带 /team：要到别处处理的卡都有去处', card('另一条关系的提议').locator('a.wm-decision-more').get_attribute('href') == '/team')
    heads = ' '.join(pg.locator('[data-testid=decision-card] .wm-decision-head').all_inner_texts())
    check('卡片第一行不露主体键和来源代号（person: / synthetic: / mcp: / task-center）', not any(x in heads for x in ['person:', 'synthetic:', 'mcp:', 'task-center']) and 'Synthetic beta' in heads and '一个外部账号' in heads and '合成同事甲' in heads, heads)
    check('接口地址（/api/…）不做成链接', card('合成账号').locator('a.wm-decision-more[href^="/api"]').count() == 0)
    check('站内真有的页面照样是链接', card('合成会话').locator('a.wm-decision-more').get_attribute('href') == '/mcp-gateways?access_request=9002')
    mc = card('合成会话'); mc.get_by_role('button', name=re.compile('不\\s*给')).click(); pg.wait_for_timeout(300)
    check('MCP 权限申请「不给」：展开一格理由，可以空着直接确定', mc.locator('textarea').count() == 1 and mc.get_by_role('button', name=re.compile('确定')).is_enabled())
    check('展开理由时只留「确定不给」和「取消」，「批准」先收起来', mc.get_by_role('button', name=re.compile('批\\s*准')).count() == 0 and mc.locator('[data-testid=decision-cancel]').count() == 1)
    mc.locator('[data-testid=decision-cancel]').click(); pg.wait_for_timeout(200)
    check('「取消」收起理由框、回到原来两个按钮', mc.locator('textarea').count() == 0 and mc.get_by_role('button', name=re.compile('批\\s*准')).count() == 1)
    mc.get_by_role('button', name=re.compile('不\\s*给')).click(); pg.wait_for_timeout(300)
    mc.locator('textarea').fill('先不开'); mc.get_by_role('button', name=re.compile('确定')).click(); pg.wait_for_timeout(500)
    check('理由带在请求里', any(x.get('source') == 'mcp-access' and x.get('answer') == 'reject' and x.get('input', {}).get('note') == '先不开' for x in sent), sent)
    pc = card('合成账号'); pc.get_by_role('button', name=re.compile('对\\s*接')).click(); pg.wait_for_timeout(300)
    pc.locator('textarea').fill('user:synthetic-new'); pc.locator('[data-testid=decision-bind-create]').click()
    pc.locator('[data-testid=decision-confirm]').click(); pg.wait_for_timeout(300)
    check('勾了「新建主体」：先弹再确认一次，没确认不发', pg.locator('.ant-popconfirm').count() >= 1 and not any(x.get('source') == 'principal-pending' for x in sent))
    pg.get_by_role('button', name='新建并对接').click(); pg.wait_for_timeout(500)
    check('确认之后发：对到的主体、create 为真', any(x.get('source') == 'principal-pending' and x.get('input', {}).get('principal') == 'user:synthetic-new' and x.get('input', {}).get('create') is True for x in sent), sent)
    ctx.close()
    # 本机看样子用（CI 不设 WM_SHOT）：三组都有内容、按类别筛过、「不给」展开理由，各截一张 1440
    import os
    shot = os.environ.get('WM_SHOT')
    if shot:
        full = syn + [
            {'source': 'work-items', 'source_id': 'wi-synthetic-proxy', 'category': 'accept', 'title': '合成：核对到货数量（等建立人验收）', 'waiting_for': 'person:synthetic-beta', 'since': '2026-11-12T01:00:00Z', 'answers': ['verify', 'return'], 'object': '', 'phase': '', 'link': '', 'mine': False, 'creator': {'principal': 'person:synthetic-beta', 'display_name': 'Synthetic beta'}},
            {'source': 'tasks', 'source_id': 'task-synthetic-1', 'category': 'review', 'kind': 'sop-run', 'title': '合成：样品检验流程 #12 在跑', 'waiting_for': 'task-center', 'since': '2026-11-11T08:00:00Z', 'answers': [], 'object': '', 'phase': '', 'link': '/tasks', 'mine': True},
        ]
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}); ctx.add_cookies([{'name': 'session_id', 'value': cfg['admin_session'], 'url': M}])
        ctx.route('**/api/attention', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'items': full, 'counts': {'total': len(full)}, 'sources': {}})))
        pg = ctx.new_page(); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=attention-proxy]'); pg.wait_for_timeout(600)
        pg.screenshot(path=shot.replace('.png', '-三组.png'))
        pg.locator('[data-testid=attention-filter]').get_by_text('待核准', exact=False).first.click(); pg.wait_for_timeout(400)
        pg.screenshot(path=shot.replace('.png', '-按类别.png'))
        mc = pg.locator('[data-testid=decision-card]', has_text='合成会话').first
        mc.get_by_role('button', name=re.compile('不\\s*给')).click(); pg.wait_for_timeout(300)
        mc.locator('textarea').fill('这个会话只需要读，不给写的工具')
        pg.screenshot(path=shot.replace('.png', '-不给理由.png'))
        ctx.close()
    b.close()
print(f'home-count-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
