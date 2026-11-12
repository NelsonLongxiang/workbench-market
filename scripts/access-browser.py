"""「谁能做什么」（照原型 3fbfd0b 重做的 /access）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
授予和主体两份列表用合成的应答（经 page.route 截下）；角色和矩阵用实例真的。核准、不给两个写请求也截下，核对发了什么。
  · 没有口令、没登录：授予读不到，说「现在只有管理员能看」，不弹口令框；
  · 认出了人但不是管理员：「人和权限」显示「你的权限」（取 /api/auth/me 的本人角色），下面一句别人的权限谁能看；
  · 有口令：两个页签（没有「以某人的身份看」）；待核准卡片、按人排的表（状态最左），范围不是全部的生效中授予标「尚未生效」；矩阵里「范围内」的格子同样标；
  · 核准发对了请求；不给要写理由，理由空着确认按钮不能点，写了才发、带着理由；被拒时说服务端给的说法；
  · 角色预设：每个角色一张卡、选中的角色有七块 × 四类的矩阵，格子是「全部 / 范围内 / 部分 / 只限自己 / 不能 / —」之一。"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M, TOK = cfg['base'], cfg['token']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

SETTLED = """(sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect();
  const host = e.closest('.ant-popover, .ant-dropdown'); if (!host || r.width === 0 || r.height === 0) return false;
  return ![...host.classList].some(c => /-(appear|enter|leave)(-|$)/.test(c)) && !host.classList.contains('ant-popover-hidden') && !host.classList.contains('ant-dropdown-hidden'); }"""
def settled(pg, sel, timeout=10000): pg.wait_for_function(SETTLED, arg=sel, timeout=timeout)
def set_token(pg):
    pg.locator('[data-testid=wm-me]').click()
    pg.locator('[data-testid=wm-me][aria-expanded=true]').wait_for(); settled(pg, '.wm-me-pop')
    pg.locator('.wm-me-pop button', has_text='口令').click()
    pg.locator('.ant-popover input[type=password]').last.wait_for(); settled(pg, '.ant-popover input[type=password]')
    pg.locator('.ant-popover input[type=password]').last.fill(TOK)
    pg.locator('.ant-popover button', has_text='保').last.click()
    pg.wait_for_selector('[data-testid=nav-admin]', timeout=10000)
    pg.keyboard.press('Escape'); pg.mouse.click(800, 26); pg.wait_for_timeout(300)

NOW = 1_800_000_000_000
PRINCIPALS = {'principals': [
    {'id': 'user:jia', 'kind': 'person', 'display_name': '甲经理', 'owner': '', 'status': 'active', 'identities': [{'provider': 'odoo', 'external_id': 'jia'}]},
    {'id': 'user:bing', 'kind': 'person', 'display_name': '丙', 'owner': '', 'status': 'active', 'identities': []},
    {'id': 'seat:xiaosuan', 'kind': 'seat', 'display_name': '小算', 'owner': 'user:jia', 'status': 'active', 'identities': []},
]}
def grant(i, pid, role, scope, status, by='odoo:jia', appr=None, exp=None, reason='合成'):
    return {'id': i, 'principal_id': pid, 'role': role, 'scope': scope, 'expires_at': exp, 'reason': reason, 'status': status, 'created_by': by, 'approved_by': appr, 'created_at': NOW - i, 'updated_at': NOW - i, 'source': 'manual'}
GRANTS = {'grants': [
    grant(1, 'user:jia', 'owner', '*', 'active', by='cli', appr='cli'),
    grant(2, 'seat:xiaosuan', 'ai-staff', 'bench:3', 'active', appr='odoo:jia'),
    grant(3, 'user:bing', 'member', '*', 'pending', reason='新入职，先给只读'),
    grant(4, 'user:bing', 'management', '*', 'pending', reason='临时代管'),
    grant(5, 'user:bing', 'guest', '*', 'draft', reason='还在起草'),
    grant(6, 'user:jia', 'member', '*', 'revoked', appr='odoo:jia'),
    grant(7, 'user:bing', 'ai-staff', '*', 'expired', exp=NOW - 1),
]}
# 服务端（身份线 #618）在授予上给出当前的人能不能放行：3 号说不能；4 号不带这个字段（服务端还没给时的样子）
GRANTS['grants'][2].update({'can_approve': False, 'approve_denied': 'drafter_cannot_approve', 'approve_denied_text': '起草的人不能自己放行，要另一位放行'})
posted = []
def fake(route, body, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.goto(M + '/access'); pg.wait_for_selector('.wm-acc-tabs')
    pg.wait_for_selector('.ant-alert', timeout=10000)
    check('没有口令、没登录：授予读不到，说现在只有管理员能看；不弹口令框', pg.locator('.ant-alert', has_text='现在只有管理员能看').count() == 1 and pg.locator('.ant-modal').count() == 0 and pg.locator('[data-testid=acc-mine]').count() == 0)
    tabs = [t.strip() for t in pg.locator('.wm-acc-tab').all_inner_texts()]
    check('两个页签：人和权限、角色预设（以某人的身份看还没有）', tabs == ['人和权限', '角色预设'], tabs)
    check('顶栏标题是导航名「谁能做什么」', pg.locator('.wm-top-title').inner_text().strip() == '谁能做什么')

    # 认出了人但不是管理员：授予仍是 403（实例真的），/api/auth/me 截下来换成带本人角色的
    ME = {'gate': 'off', 'authenticated': True, 'via': 'odoo', 'login': 'bing', 'principal': 'user:bing', 'display_name': '丙',
          'roles': [{'id': 'member', 'name': '普通员工', 'scope': '*', 'preset': True, 'expires_at': None, 'source': 'manual', 'approved_by': 'odoo:jia'},
                    {'id': 'dept-lead', 'name': '部门负责人', 'scope': 'domain:work', 'preset': True, 'expires_at': NOW, 'source': 'manual', 'approved_by': 'odoo:jia'}]}
    pg.route('**/api/auth/me', lambda r: fake(r, ME))
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-mine]')
    mine = pg.locator('[data-testid=acc-mine]').inner_text()
    roles_shown = [''.join(t.split()) for t in pg.locator('[data-testid=acc-mine-role]').all_inner_texts()]
    check('非管理员：显示你的权限，两项角色、范围用块名、按范围的标尚未生效', len(roles_shown) == 2 and roles_shown[0].startswith('普通员工全部长期') and '「事项与对话」这一块' in roles_shown[1] and roles_shown[1].endswith('尚未生效') and '尚未生效' not in roles_shown[0], roles_shown)
    check('非管理员：下面一句别人的权限现在只有管理员能看', '别人的权限现在只有管理员能看' in mine and pg.locator('.ant-alert').count() == 0, mine)
    pg.unroute('**/api/auth/me')

    pg.route('**/api/grants', lambda r: fake(r, GRANTS))
    # 要谁放行（身份线 #618 在 GET /api/roles 加的 approval_text）：取实例真的角色，补上合成的说法
    APPROVAL = {'management': '只有属主能放行', 'member': '管理员即可放行'}
    def on_roles(r):
        body = r.fetch().json()
        for x in body.get('roles', []):
            if x.get('id') in APPROVAL: x['approval_text'] = APPROVAL[x['id']]
        fake(r, body)
    pg.route('**/api/roles', on_roles)
    pg.route('**/api/principals', lambda r: fake(r, PRINCIPALS))
    def on_approve(r):
        posted.append(('approve', r.request.url.split('/api/grants/')[1], r.request.post_data))
        if '/api/grants/4/' in r.request.url: fake(r, {'error': 'owner_required', 'message': '角色 management 是管理员级的，只有属主能放行'}, 403)
        else: fake(r, {'grant': {}})
    def on_revoke(r):
        posted.append(('revoke', r.request.url.split('/api/grants/')[1], r.request.post_data)); fake(r, {'grant': {}})
    pg.route('**/api/grants/*/approve', on_approve)
    pg.route('**/api/grants/*/revoke', on_revoke)
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-pending]')
    set_token(pg)  # 口令只存在本页：设在加载之后（整页刷新会清掉），设了页面会重新取数
    pg.wait_for_selector('[data-testid=acc-pending]')
    cards = pg.locator('[data-testid=acc-pending]')
    ids = [cards.nth(i).get_attribute('data-id') for i in range(cards.count())]
    check('待核准：只有两条待核准的进卡片（草稿 5、生效中、已收回 6、已过期 7 都不进），先提交的在前', ids == ['4', '3'], ids)
    check('卡片标题：管理员登录对到人，用名字（甲经理 想给 丙 加一项权限）', '甲经理 想给 丙 加一项权限' in cards.nth(1).inner_text())
    check('卡片写明这一项要谁放行（照服务端的说法），核准按钮不置灰', cards.nth(0).locator('[data-testid=acc-approval]').inner_text().strip() == '这一项只有属主能放行' and cards.nth(1).locator('[data-testid=acc-approval]').inner_text().strip() == '这一项管理员即可放行' and cards.nth(0).locator('[data-testid=acc-approve]').is_enabled(), [cards.nth(i).inner_text() for i in range(cards.count())])
    heads = [t.strip() for t in pg.locator('.wm-acc-table thead th').all_inner_texts() if t.strip()]
    check('表：状态最左、谁第二', heads[:2] == ['状态', '谁'], heads)
    body = pg.locator('.wm-acc-table tbody').inner_text()
    check('表：AI 员工按工作台给的权限标「尚未生效」，全部范围的不标；表上方一句说明原因', body.count('尚未生效') == 1 and '工作台 3' in body and '要等对象范围接进判定' in pg.locator('.wm-acc-pending-cap').inner_text(), body)
    check('表：负责人——AI 员工写它挂在谁名下', '甲经理' in pg.locator('.wm-acc-table tbody tr', has_text='小算').inner_text())

    # 核准按钮照服务端的 can_approve：3 号说不能 → 置灰、写短说法；4 号没这个字段 → 照旧可点
    n_before = len(posted)
    check('服务端说放行不了（3 号）：核准置灰，旁边写服务端的说法；不给照旧能点', cards.nth(1).locator('[data-testid=acc-approve]').is_disabled() and cards.nth(1).locator('[data-testid=acc-approve-denied]').inner_text().strip() == '起草的人不能自己放行，要另一位放行' and cards.nth(1).locator('[data-testid=acc-decline]').is_enabled(), cards.nth(1).inner_text())
    cards.nth(1).locator('[data-testid=acc-approve]').click(force=True); pg.wait_for_timeout(300)
    check('置灰的核准硬点也不发请求', len(posted) == n_before, posted)
    check('服务端没给 can_approve（4 号）：核准照旧可点、不写说法', cards.nth(0).locator('[data-testid=acc-approve]').is_enabled() and cards.nth(0).locator('[data-testid=acc-approve-denied]').count() == 0)
    # 核准：管理员级的被拒，说服务端的说法
    cards.nth(0).locator('[data-testid=acc-approve]').click(); pg.wait_for_timeout(500)
    check('核准被拒（管理员级只有属主能放行）：卡片上说服务端的说法', '只有属主能放行' in cards.nth(0).inner_text() and posted and posted[-1][0] == 'approve', posted)
    # 不给：理由空着不能确认；写了才发、带理由
    cards.nth(1).locator('[data-testid=acc-decline]').click()
    confirm = cards.nth(1).locator('[data-testid=acc-decline-confirm]')
    check('不给：理由空着，确认按钮不能点', confirm.is_disabled())
    cards.nth(1).locator('[data-testid=acc-decline-reason]').fill('  还没定岗  ')
    confirm.click(); pg.wait_for_timeout(500)
    last = posted[-1] if posted else None
    check('不给：发的是撤销这条授予，带着去掉空白的理由', last and last[0] == 'revoke' and last[1].startswith('3/') and json.loads(last[2] or '{}').get('reason') == '还没定岗', last)

    # 角色预设：用实例真的角色和矩阵
    pg.locator('[data-testid=acc-tab-roles]').click(); pg.wait_for_selector('[data-testid=acc-matrix]')
    check('切到角色预设：地址带 ?tab=roles', 'tab=roles' in pg.url, pg.url)
    with urllib.request.urlopen(urllib.request.Request(M + '/api/roles/matrix', headers={'x-admin-token': TOK})) as r: mx = json.load(r)
    ra = {pg.locator('[data-testid=acc-role]').nth(i).get_attribute('data-id'): pg.locator('[data-testid=acc-role]').nth(i).locator('[data-testid=acc-role-approval]') for i in range(pg.locator('[data-testid=acc-role]').count())}
    check('角色卡标要谁放行：有说法的角色标，没有说法的不标', ra['management'].inner_text().strip() == '只有属主能放行' and ra['member'].inner_text().strip() == '管理员即可放行' and ra['owner'].count() == 0, {k: v.count() for k, v in ra.items()})
    check('每个角色一张卡', pg.locator('[data-testid=acc-role]').count() == len(mx['roles']), (pg.locator('[data-testid=acc-role]').count(), len(mx['roles'])))
    rows = pg.locator('[data-testid=acc-matrix] tbody tr')
    check('矩阵：七大块一行一块、四类一列一类', rows.count() == len(mx['blocks']) == 7 and pg.locator('[data-testid=acc-matrix] thead th').count() == 1 + len(mx['kinds']))
    pg.locator('[data-testid=acc-role][data-id=dept-lead]').click(); pg.wait_for_timeout(200)
    tds = [''.join(t.split()) for t in pg.locator('[data-testid=acc-matrix] tbody td:not(:first-child)').all_inner_texts()]
    check('「范围内」的格子都标尚未生效、别的格子不标', any(tds) and all((t == '范围内尚未生效') == t.startswith('范围内') and (t == '范围内尚未生效' or '尚未生效' not in t) for t in tds), tds)
    cells = set(t.strip() for t in pg.locator('[data-testid=acc-matrix] tbody .wm-acc-cell').all_inner_texts())
    check('选部门负责人：格子都在说法里，有「范围内」', cells <= {'全部', '范围内', '部分', '只限自己', '不能', '—'} and '范围内' in cells, cells)
    want = mx['roles'][[r['id'] for r in mx['roles']].index('dept-lead')]['cells']['work']['read']
    shown = pg.locator('[data-testid=acc-matrix] tbody tr', has_text='事项与对话').locator('.wm-acc-cell').first.inner_text().strip()
    check('格子和接口算的一致（部门负责人 · 事项与对话 · 看）', {'all': '全部', 'scoped': '范围内', 'some': '部分', 'self': '只限自己', 'none': '不能', 'na': '—'}[want] == shown, (want, shown))
    b.close()

print(f'access-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
