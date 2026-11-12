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
    others = pg.locator('[data-testid=work-items-group-others]')
    ohead = ''.join(others.locator('.ant-card-head-title').inner_text().split())
    tags = [t.strip() for t in others.locator('[data-testid=work-item-turn]').all_inner_texts()]
    check('别人的另成「等别人处理」，中性色、不标红，每行写清等谁（不露标识）', ohead == '等别人处理3' and others.locator('.ant-badge').count() == 0 and tags == ['等 合成建立人 验收', '等 合成建立人 验收', '等管理员放行'], (ohead, tags))
    pg.locator('[data-testid=work-items-view-mine]').click(); wait_view(pg, 'mine')
    head = ''.join(pg.locator('[data-testid=work-items-group-decide] .ant-card-head-title').inner_text().split())
    check('「我安排的」视角：建立人自己的验收照旧轮到他、计入红色数；没有「等别人处理」', head == '等你拍板1' and pg.locator('[data-testid=work-items-group-others]').count() == 0, head)
    ctx.close()
    b.close()

print(f'work-items-views-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
