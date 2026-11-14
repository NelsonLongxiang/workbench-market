"""事项列表的视角切换（规范 14 第九节、#626 的 views）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
列表接口用合成的应答（page.route 截下 GET /api/work-items，按 ?view= 回不同的视角），核对：
  · 只出接口说能用的视角，带件数，先后是我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部；不能用的不出；
  · 不带 view 时选中的是接口回的那个视角；点别的视角改地址里的 ?view=、请求带着它；刷新、新开同一链接回到同一视角；
  · 每个视角的空态各说各的；按某个 AI 员工筛着时说这个员工手上，点同一个视角去掉筛选；
  · 「等你拍板」只放轮到你的（和侧栏角标同一份「关注」、同一个判法），别人的另成「等别人处理」写清等谁。
数据全是合成的。"""
import json, re, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

LIST = re.compile(r'/api/work-items(\?|$)')
STATES = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked', 'done', 'failed', 'dropped', 'cancelled']
def item(i, state='progress'):
    return {'id': f'wi-syn-{i}', 'title': f'合成事项 {i}', 'state': state, 'object': None, 'phase': None, 'seat': None, 'last_progress': None, 'updated_at': f'2026-11-12T0{i % 10}:00:00Z'}
def page(view, views, items):
    counts = {s: 0 for s in STATES}
    for x in items: counts[x['state']] += 1
    return {'view': view, 'views': views, 'items': items, 'counts': counts, 'total': len(items), 'next_cursor': None}

def V(**kw):
    return {k: ({'available': True, 'count': kw[k]} if k in kw else {'available': False, 'count': 0}) for k in ['mine', 'seats', 'team', 'all']}

def serve(views, data, default):
    """data：视角 → 这个视角的事项；seat 筛选时回空。记下每次请求带的 view / seat"""
    seen = []
    def handler(route):
        q = parse_qs(urlparse(route.request.url).query)
        view = q.get('view', [None])[0]; seat = q.get('seat', [None])[0]
        seen.append((view, seat))
        if view and not views[view]['available']:
            return route.fulfill(status=403, content_type='application/json', body=json.dumps({'error': 'work_items_view_unavailable', 'views': views}))
        v = view or default
        rows = [] if seat else data.get(v, [])
        route.fulfill(status=200, content_type='application/json', body=json.dumps(page(v, views, rows)))
    return handler, seen

def tabs(pg):
    pg.wait_for_selector('[data-testid=work-items-views] [role=tab]')
    out = []
    for t in pg.locator('[data-testid=work-items-views] [role=tab]').all():
        out.append((t.get_attribute('data-testid').removeprefix('work-items-view-'), ''.join(t.inner_text().split()), t.get_attribute('aria-selected') == 'true'))
    return out
def selected(pg):
    return [k for k, _, on in tabs(pg) if on]
def wait_view(pg, key):
    pg.wait_for_selector(f'[data-testid=work-items-view-{key}][aria-selected=true]')
    pg.wait_for_load_state('networkidle')

with sync_playwright() as p:
    b = p.chromium.launch()

    # 团队负责人那样的人：我安排的 0 件、我的团队的 3 件；AI 员工、全部不能用
    views = V(mine=0, team=3)
    handler, seen = serve(views, {'mine': [], 'team': [item(1), item(2, 'done'), item(3, 'blocked')]}, 'team')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route(LIST, handler)
    pg.goto(M + '/work-items'); wait_view(pg, 'team')
    t = tabs(pg)
    check('只出能用的两个视角，带件数，先后照规范（我安排的在前）', [(k, txt) for k, txt, _ in t] == [('mine', '我安排的0'), ('team', '我的团队的3')], t)
    check('不带 view：选中的是接口回的那个视角（我的团队的），三件都列出来', selected(pg) == ['team'] and pg.locator('[data-testid=work-item-row]').count() == 3, (selected(pg), pg.locator('[data-testid=work-item-row]').count()))
    check('视角一排是页签：role=tablist / tab，选中的有 aria-selected', pg.locator('[data-testid=work-items-views][role=tablist]').count() == 1)
    pg.locator('[data-testid=work-items-view-mine]').click(); wait_view(pg, 'mine')
    q = parse_qs(urlparse(pg.url).query)
    check('点「我安排的」：地址改成 ?view=mine，请求带着 view=mine', q.get('view') == ['mine'] and seen[-1] == ('mine', None), (pg.url, seen[-1:]))
    empty = pg.locator('[data-testid=work-items-empty]').inner_text().strip() if pg.locator('[data-testid=work-items-empty]').count() else ''
    check('我安排的一件都没有：空态说「你还没有安排过事项」', empty == '你还没有安排过事项', empty)
    pg.reload(); wait_view(pg, 'mine')
    check('刷新之后还在「我安排的」', selected(pg) == ['mine'] and seen[-1] == ('mine', None), (selected(pg), seen[-1:]))
    pg2 = ctx.new_page(); pg2.route(LIST, handler)
    pg2.goto(M + '/work-items?view=team'); wait_view(pg2, 'team')
    check('分享的链接（?view=team）打开就是「我的团队的」', selected(pg2) == ['team'] and pg2.locator('[data-testid=work-item-row]').count() == 3, selected(pg2))
    pg2.close()
    # 地址里要的视角不能用（?view=all）：退回能看的、说一声，不报错
    pg.goto(M + '/work-items?view=all'); pg.wait_for_selector('[data-testid=work-items-url-filter-note]')
    check('地址里要的视角不能用：说一声、退回能看的视角，不报错', pg.locator('.ant-alert-error').count() == 0 and selected(pg) == ['team'], (selected(pg), pg.locator('[data-testid=work-items-url-filter-note]').inner_text()))
    ctx.close()

    # 四个视角都能用（管理层那样的人）：四个都出、先后对；团队、AI 员工两个空态各说各的
    views = V(mine=1, seats=0, team=0, all=4)
    handler, seen = serve(views, {'mine': [item(1)], 'seats': [], 'team': [], 'all': [item(1), item(2), item(3), item(4)]}, 'mine')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route(LIST, handler)
    pg.goto(M + '/work-items'); wait_view(pg, 'mine')
    check('四个都能用：四个页签，先后是我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部，件数照接口', [txt for _, txt, _ in tabs(pg)] == ['我安排的1', '我的AI员工手上的0', '我的团队的0', '全部4'], tabs(pg))
    texts = {}
    for k in ['seats', 'team']:
        pg.locator(f'[data-testid=work-items-view-{k}]').click(); wait_view(pg, k)
        texts[k] = pg.locator('[data-testid=work-items-empty]').inner_text().strip()
    check('空态各说各的：AI 员工手上、团队', texts == {'seats': '你的 AI 员工手上现在没有事项', 'team': '你的团队现在没有事项'}, texts)
    pg.locator('[data-testid=work-items-view-all]').click(); wait_view(pg, 'all')
    check('切到「全部」：四件', pg.locator('[data-testid=work-item-row]').count() == 4)
    # 驾驶舱「AI 员工」点卡过来的 ?view=seats&seat=…：说这个员工手上；点同一个视角去掉筛选
    pg.goto(M + '/work-items?view=seats&seat=s-synthetic'); wait_view(pg, 'seats')
    check('按某个 AI 员工筛着：空态说这个员工手上，上面写着只看这个员工', pg.locator('[data-testid=work-items-empty]').inner_text().strip() == '这个 AI 员工手上现在没有事项' and pg.locator('[data-testid=work-items-url-filter]').count() == 1)
    with pg.expect_request(lambda r: LIST.search(r.url) is not None and 'seat=' not in r.url):
        pg.locator('[data-testid=work-items-view-seats]').click()
    wait_view(pg, 'seats')
    check('点同一个视角：去掉席位筛选，地址只剩 ?view=seats', parse_qs(urlparse(pg.url).query) == {'view': ['seats']} and seen[-1] == ('seats', None), (pg.url, seen[-1:]))
    ctx.close()

    # 团队负责人在「我的团队的」：三件等验收里只有 1 件是他自己建的、一件等放行（他不是管理员）。
    # 「关注」（和侧栏角标同一份）截下：只有他建的那件 mine 为真
    views = V(mine=1, team=5)
    views['mine']['decide'] = 1; views['team']['decide'] = 1  # #712：服务端按视角给的「等你拍板」件数（他自己建的那 1 件，两个视角里都有）
    team_rows = [item(1, 'ready'), item(2, 'ready'), item(3, 'ready'), item(4, 'held'), item(5, 'progress')]
    handler, seen = serve(views, {'mine': [item(1, 'ready')], 'team': team_rows}, 'team')
    def acc(i, mine):
        return {'source': 'work-items', 'source_id': f'wi-syn-{i}', 'category': 'accept', 'title': f'合成事项 {i}', 'waiting_for': '', 'since': '2026-11-12T00:00:00Z',
                'answers': ['verify', 'return'] if mine else [], 'object': '', 'phase': '', 'link': f'/work-items/wi-syn-{i}', 'mine': mine,
                'creator': {'principal': 'user:syn-c', 'display_name': '合成建立人'}}
    ATT = {'items': [acc(1, True), acc(2, False), acc(3, False)], 'counts': {'total': 3, 'by_category': {'ask': 0, 'review': 0, 'accept': 3, 'glance': 0, 'grant': 0}}, 'sources': {}}
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route(LIST, handler)
    pg.route(re.compile(r'/api/attention$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(ATT)))
    pg.goto(M + '/work-items?view=team'); wait_view(pg, 'team'); pg.wait_for_selector('[data-testid=work-items-group-others]')
    decide = pg.locator('[data-testid=work-items-group-decide]')
    head = ''.join(decide.locator('.ant-card-head-title').inner_text().split())
    check('负责人在团队视角：建立人不是他的「等验收」不计入红色数——「等你拍板」只有他自己建的 1 件，红色角标写 1', head == '等你拍板1' and decide.locator('.ant-badge').count() == 1 and decide.locator('[data-testid=work-item-row]').count() == 1, head)
    nav = pg.locator('[data-testid=nav-pending]')
    check('和侧栏角标同一个数（同一份「关注」、同一个判法）', nav.count() == 1 and nav.inner_text().strip() == '1', nav.all_inner_texts())
    red = {k: pg.locator(f'[data-testid=work-items-view-decide-{k}]') for k in ('mine', 'team')}
    check('页签上的红数照服务端的 views.<视角>.decide：「我安排的」1、「我的团队的」1；读法是「1 件等你拍板」', all(red[k].count() == 1 and red[k].inner_text().strip() == '1' for k in red) and red['team'].get_attribute('aria-label') == '1 件等你拍板', {k: red[k].all_inner_texts() for k in red})
    others = pg.locator('[data-testid=work-items-group-others]')
    ohead = ''.join(others.locator('.ant-card-head-title').inner_text().split())
    tags = [t.strip() for t in others.locator('[data-testid=work-item-turn]').all_inner_texts()]
    check('别人的另成「等别人处理」，中性色、不标红，每行写清等谁（不露标识）', ohead == '等别人处理3' and others.locator('.ant-badge').count() == 0 and tags == ['等 合成建立人 验收', '等 合成建立人 验收', '等放行'] and '管理员' not in ''.join(tags), (ohead, tags))
    pg.locator('[data-testid=work-items-view-mine]').click(); wait_view(pg, 'mine')
    head = ''.join(pg.locator('[data-testid=work-items-group-decide] .ant-card-head-title').inner_text().split())
    check('「我安排的」视角：建立人自己的验收照旧轮到他、计入红色数；没有「等别人处理」', head == '等你拍板1' and pg.locator('[data-testid=work-items-group-others]').count() == 0, head)
    # #631（放行归负责人）进了之后：负责人能放行的「等放行」，「关注」里带 mine 和 answer_via（直接调放行入口）。
    # 同一个判法下它就轮到他：进「等你拍板」并计红，和侧栏角标同一个数
    ATT['items'].append({'source': 'work-items', 'source_id': 'wi-syn-4', 'category': 'glance', 'title': '合成事项 4', 'waiting_for': '', 'since': '2026-11-12T00:00:00Z',
        'answers': ['release'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-4', 'mine': True, 'creator': {'principal': 'user:syn-c', 'display_name': '合成建立人'},
        'answer_via': {'method': 'POST', 'path': '/api/work-items/wi-syn-4/release', 'answers': {'release': {'body': {}}}}})
    pg.goto(M + '/work-items?view=team'); wait_view(pg, 'team'); pg.wait_for_selector('[data-testid=work-items-group-others]')
    decide = pg.locator('[data-testid=work-items-group-decide]')
    head = ''.join(decide.locator('.ant-card-head-title').inner_text().split())
    ohead = ''.join(pg.locator('[data-testid=work-items-group-others] .ant-card-head-title').inner_text().split())
    nav = pg.locator('[data-testid=nav-pending]')
    check('负责人能放行的「等放行」（夹具：mine + answer_via 放行）：进「等你拍板」计红，等别人处理少一件，侧栏角标同一个数', head == '等你拍板2' and decide.locator('[data-testid=work-item-row]').count() == 2 and ohead == '等别人处理2' and nav.count() == 1 and nav.inner_text().strip() == '2', (head, ohead, nav.all_inner_texts()))
    ctx.close()

    # 统筹在试联上看到的：负责人默认停在「我安排的」（那里 0 件等他），3 件在「我的团队的」里——页签上的红数指出在哪个视角。
    # 夹具照真实的样子给全：登录着的合成负责人（/api/auth/me），「关注」里正好是这 3 件轮到他、能当场办的验收（和 decide 同一个判法）
    views = V(mine=2, team=30)
    views['mine']['decide'] = 0; views['team']['decide'] = 3
    handler, seen = serve(views, {'mine': [item(1, 'progress'), item(2, 'progress')], 'team': team_rows}, 'mine')
    ME = {'authenticated': True, 'via': 'cookie', 'login': 'synthetic-lead', 'display_name': '合成负责人', 'principal': 'user:synthetic-lead', 'roles': []}
    LEAD_ATT = {'items': [acc(i, True) for i in (1, 2, 3)], 'counts': {'total': 3, 'by_category': {'ask': 0, 'review': 0, 'accept': 3, 'glance': 0, 'grant': 0}, 'stuck_count': 0}, 'sources': {}}
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route(LIST, handler)
    pg.route(re.compile(r'/api/attention$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(LEAD_ATT)))
    pg.route(re.compile(r'/api/auth/me$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(ME)))
    pg.goto(M + '/work-items'); wait_view(pg, 'mine')
    pg.wait_for_function("() => document.querySelector('[data-testid=wm-me-name]')?.textContent.trim().length > 0")
    pg.wait_for_selector('[data-testid=nav-pending]')
    import os
    if os.environ.get('WM_SHOT_VIEWS'): pg.wait_for_timeout(500); pg.screenshot(path=os.environ['WM_SHOT_VIEWS'])  # 本机看样子用，CI 不设
    check('默认停在「我安排的」：这个页签没有红数（0 件不出）；「我的团队的」页签上红数 3，指出等他的在哪', pg.locator('[data-testid=work-items-view-decide-mine]').count() == 0 and pg.locator('[data-testid=work-items-view-decide-team]').inner_text().strip() == '3')
    reds = [int(x) for x in pg.locator('[data-testid^=work-items-view-decide-]').all_inner_texts()]
    nav = pg.locator('[data-testid=nav-pending]').inner_text().strip()
    check('同一个计数：侧栏角标 3，等于各视角红数里的那 3 件（这里只有一个视角有，去重后就是它）；左下角是登录着的人', nav == '3' and max(reds) == 3 and pg.locator('[data-testid=wm-me-name]').inner_text().strip() == '合成负责人', (nav, reds))
    ctx.close()

    # 每行的期限（#733 列表行带 due / overdue）：不限期的不显示；快到了、过期了用现有的提醒色（warning / error），没结束的才提醒
    import datetime
    d = lambda n: (datetime.date.today() + datetime.timedelta(days=n)).isoformat()
    due_rows = [dict(item(1), title='合成：过期的', due=d(-2), overdue=True), dict(item(2), title='合成：后天到期', due=d(2), overdue=False),
                dict(item(3), title='合成：还早', due=d(30), overdue=False), dict(item(4), title='合成：不限期', due=None, overdue=False),
                dict(item(5, 'done'), title='合成：做完了的', due=d(-5), overdue=False), dict(item(6), title='合成：今天到期', due=d(0), overdue=False),
                item(7)]  # 旧服务端：没有 due 这个键
    handler, seen = serve(V(mine=7), {'mine': due_rows}, 'mine')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.route(LIST, handler)
    pg.goto(M + '/work-items'); wait_view(pg, 'mine'); pg.wait_for_selector('[data-testid=work-item-row-due]')
    def due_of(title):
        row = pg.locator('[data-testid=work-item-row]', has_text=title).first
        t = row.locator('[data-testid=work-item-row-due]')
        return (t.inner_text().strip(), t.get_attribute('data-tone'), t.get_attribute('class') or '') if t.count() else None
    od, soon, far, none, done, today, old = (due_of(t) for t in ('合成：过期的', '合成：后天到期', '合成：还早', '合成：不限期', '合成：做完了的', '合成：今天到期', '合成事项 7'))
    check('过期的：写日期和「已过期 2 天」，用 error 提醒色', od and od[0] == f'{d(-2)} · 已过期 2 天' and od[1] == 'error' and 'ant-tag-error' in od[2], od)
    check('快到了（还剩 2 天）、今天到期：用 warning 提醒色', soon and soon[0] == f'{d(2)} · 还剩 2 天' and soon[1] == 'warning' and 'ant-tag-warning' in soon[2] and today and today[0] == f'{d(0)} · 今天到期' and today[1] == 'warning', (soon, today))
    check('还早（还剩 30 天）：写还剩几天，不上提醒色', far and far[0] == f'{d(30)} · 还剩 30 天' and far[1] == '' and 'ant-tag-error' not in far[2] and 'ant-tag-warning' not in far[2], far)
    check('不限期的、旧服务端没给期限的：不显示期限', none is None and old is None, (none, old))
    check('已经结束的：只写期限日期，不提醒过期', done and done[0] == f'期限 {d(-5)}' and done[1] == '', done)
    # 提醒色对齐设计稿（DESIGN.md 的 tag-warning / tag-danger：*-bg 打底、*-text 写字），不是 antd 默认的 #faad14 那一套
    tok = json.loads(re.search(r'export const DESIGN_TOKENS = (\{.*\n\}) as const;', open('web/src/design-tokens.ts').read(), re.S).group(1))['colors']
    rgb = lambda h: 'rgb(%d, %d, %d)' % tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
    def look(title):
        return pg.locator('[data-testid=work-item-row]', has_text=title).first.locator('[data-testid=work-item-row-due]').evaluate('e => { const c = getComputedStyle(e); return [c.color, c.backgroundColor]; }')
    check('快到期的黄标签：字是 warning-text、底是 warning-bg（设计稿的值，不是 antd 默认黄）', look('合成：后天到期') == [rgb(tok['warning-text']), rgb(tok['warning-bg'])], (look('合成：后天到期'), tok['warning-text'], tok['warning-bg']))
    check('过期的红标签：字是 danger-text、底是 danger-bg', look('合成：过期的') == [rgb(tok['danger-text']), rgb(tok['danger-bg'])], look('合成：过期的'))
    if os.environ.get('WM_SHOT_DUE'): pg.wait_for_timeout(300); pg.screenshot(path=os.environ['WM_SHOT_DUE'])  # 本机看样子用，CI 不设
    ctx.close()
    b.close()

print(f'work-items-views-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
