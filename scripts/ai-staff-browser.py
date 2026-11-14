"""驾驶舱「AI 员工」页签的浏览器回归；由 scripts/ai-staff-browser.mjs 起合成实例、建好驾驶舱后调用，参数为配置 JSON 路径（之后可带两张截图的路径）。
团队数据用页面里截下来的合成夹具（名册要节点上报，接口造不出来）。
普通员工：只有「分给你的 AI 员工」一组，卡上写「手上在办 N 件」（不叫「你的」），点一个去事项列表「我的 AI 员工手上的」视角按席位筛；没有分给他的写「还没有分给你的 AI 员工」并链到团队页。
负责人：多一组「我负责的团队：…」，已经分给他的成员不重复；普通员工不去读 /api/teams。两种都有一行「列的是全部，还没按这个驾驶舱筛」。"""
import json, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']; CID = cfg['cockpit']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def member(seat, name, seat_id='', active=0, online=True):
    return {'seat': seat, 'seat_id': seat_id, 'name': name, 'role': 'member', 'online': online, 'router': False, 'assigned_to': None, 'active_items': active}
EMP = {'principal': 'person:synthetic-alpha', 'teams': [], 'members': [
    {'host': '0a1b2c3d', 'team': 'zone/canvas/team-a', 'team_name': '合成一组', 'status': 'active', **member('zone/0a1b2c3d', '合成采购员', 's-1', 3)},
    {'host': '0a1b2c3d', 'team': 'zone/canvas/team-b', 'team_name': '合成二组', 'status': 'active', **member('zone/0e0e0e0e', '合成跟单员', '', 0, False)},
]}
LEAD_MINE = {'principal': 'person:synthetic-alpha', 'members': EMP['members'][:1], 'teams': [{'host': '0a1b2c3d', 'team': 'zone/canvas/team-a', 'name': '合成一组', 'status': 'active', 'router': None}]}
LEAD_TEAMS = {'can': {}, 'departments': [{'id': 'd-synthetic', 'name': '合成部', 'lead': None, 'teams': [
    {'host': '0a1b2c3d', 'team': 'zone/canvas/team-a', 'name': '合成一组', 'status': 'active', 'leads': [{'principal': 'person:synthetic-alpha', 'display_name': 'Synthetic alpha', 'source': 'explicit'}],
     'members': [member('zone/0a1b2c3d', '合成采购员', 's-1', 3), member('zone/11111111', '合成核价员', 's-2', 1), member('zone/22222222', '合成质检员', 's-3', 0, False)]},
]}]}
json_body = lambda b: {'status': 200, 'content_type': 'application/json', 'body': json.dumps(b)}

def open_staff(b, mine, teams, reads):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    ctx.route('**/api/teams/mine', lambda r: r.fulfill(**json_body(mine)))
    def all_teams(r):
        reads.append(1)
        r.fulfill(**json_body(teams if teams is not None else {'can': {}, 'departments': []}))
    ctx.route('**/api/teams', all_teams)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + f'/cockpit/{CID}')
    pg.locator('[data-testid=ck-tab-items-staff]').click()
    pg.wait_for_selector('[data-testid=ck-staff-pane]')
    pg.wait_for_timeout(500)
    return ctx, pg

with sync_playwright() as p:
    b = p.chromium.launch()
    # 普通员工
    reads = []
    ctx, pg = open_staff(b, EMP, None, reads)
    pane = pg.locator('[data-testid=ck-staff-pane]')
    check('栏头下一行写明列的是全部、还没按驾驶舱筛', '列的是全部，还没按这个驾驶舱筛' in pane.inner_text())
    cards = pg.locator('[data-testid=ck-staff-mine] [data-testid=ck-staff]')
    texts = cards.all_inner_texts()
    check(f'普通员工：「分给你的 AI 员工」两张卡（{len(texts)}）', len(texts) == 2 and '合成采购员' in texts[0] and '合成一组' in texts[0], texts)
    check('卡上写「手上在办 N 件」/「手上没有在办的」，不叫「你的」', '手上在办 3 件' in texts[0] and '手上没有在办的' in texts[1] and all('你的' not in t for t in texts), texts)
    check('首字头像、在不在线', pg.locator('[data-testid=ck-staff-mine] .wm-avatar').first.inner_text().strip() == '合' and '在线' in texts[0] and '不在线' in texts[1])
    check('普通员工没有「我负责的团队」那一组，也不去读 /api/teams', pg.locator('[data-testid=ck-staff-led]').count() == 0 and not reads, reads)
    if len(sys.argv) > 2: pg.screenshot(path=sys.argv[2])
    href = cards.first.locator('a').get_attribute('href')
    check('点一个去事项列表「我的 AI 员工手上的」视角、按席位筛', href == '/work-items?view=seats&seat=s-1', href)
    ctx.close()
    # 没有分给他的
    ctx, pg = open_staff(b, {'principal': 'person:synthetic-alpha', 'members': [], 'teams': []}, None, [])
    none = pg.locator('[data-testid=ck-staff-none]')
    check('没有分给他的：写「还没有分给你的 AI 员工」并链到团队页', none.count() == 1 and '还没有分给你的 AI 员工' in none.inner_text() and none.locator('a').get_attribute('href') == '/team')
    ctx.close()
    # 负责人
    reads = []
    ctx, pg = open_staff(b, LEAD_MINE, LEAD_TEAMS, reads)
    pg.wait_for_selector('[data-testid=ck-staff-led]')
    led = pg.locator('[data-testid=ck-staff-led]')
    lt = led.inner_text()
    check('负责人：多一组「我负责的团队：合成一组」', led.count() == 1 and '我负责的团队：合成一组' in lt, lt)
    check('已经分给他的成员不在那一组里重复；另外两个成员在', '合成核价员' in lt and '合成质检员' in lt and '合成采购员' not in lt, lt)
    check('负责人才读 /api/teams', len(reads) >= 1)
    if len(sys.argv) > 3: pg.screenshot(path=sys.argv[3])
    ctx.close(); b.close()
print(f'ai-staff-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
