"""「谁能做什么」（照原型 3fbfd0b 重做的 /access）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
授予和主体两份列表用合成的应答（经 page.route 截下）；角色和矩阵用实例真的。核准、不给两个写请求也截下，核对发了什么。
  · 没有口令、没登录：授予读不到（401），说「请先登录」，不弹口令框；
  · 认出了人但不是管理员：「人和权限」显示「你的权限」（取 /api/auth/me 的本人角色），下面一句别人的权限谁能看；四个管理读接口不去问（网络里没有）；
  · 有口令：三个页签（人和权限、账号、角色预设；没有「以某人的身份看」）；待核准卡片、按人排的表（状态最左），统一判定还不认范围的生效中授予标「尚未生效」；矩阵里「范围内」的格子同样标；
  · 核准发对了请求；不给要写理由，理由空着确认按钮不能点，写了才发、带着理由；被拒时说服务端给的说法；
  · 账号（P4）：普通员工不去问、说只有管理员；管理员建人显示一次临时密码、重置要确认且给新密码、停用恢复要写理由；待核准的卡片核准、拒绝发对请求，被拒照服务端的句子说；
  · 改密码（用户卡）：站内账号登录的人才有；两次不一致、原密码不对都提示；改好要重新登录，旧会话注销、只有新密码能用；
  · 角色预设：每个角色一张卡、选中的角色有各大块（服务端的 BLOCKS，现在八块）× 四类的矩阵，格子是「全部 / 范围内 / 部分 / 只限自己 / 不能 / —」之一。"""
import json, re, sys, urllib.request
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
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
def soft(fn):
    """等条件成立；等不到不在这里抛错，照常往下，由后面原来的断言报（带着当时的值）"""
    try: fn()
    except PWTimeout: pass
def until(pg, pred, timeout=10000):
    """等测试这边记下的状态（请求日志）满足 pred：每 20 毫秒看一次，期间照常处理截下的请求；到点就停，不抛错"""
    for _ in range(timeout // 20):
        if pred(): return
        pg.wait_for_timeout(20)
def painted(pg):
    """等页面再画两帧"""
    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
# 用户卡、口令框都收起来了：页面上没有还看得见的弹出层
NO_POPOVER = """() => ![...document.querySelectorAll('.ant-popover')].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.classList.contains('ant-popover-hidden'); })"""
def settled(pg, sel, timeout=10000): pg.wait_for_function(SETTLED, arg=sel, timeout=timeout)
def set_token(pg):
    pg.locator('[data-testid=wm-me]').click()
    pg.locator('[data-testid=wm-me][aria-expanded=true]').wait_for(); settled(pg, '.wm-me-pop')
    pg.locator('.wm-me-pop button', has_text='口令').click()
    pg.locator('.ant-popover input[type=password]').last.wait_for(); settled(pg, '.ant-popover input[type=password]')
    pg.locator('.ant-popover input[type=password]').last.fill(TOK)
    pg.locator('.ant-popover button', has_text='保').last.click()
    pg.wait_for_selector('[data-testid=nav-admin]', timeout=10000)
    pg.keyboard.press('Escape'); pg.mouse.click(800, 26)
    soft(lambda: pg.wait_for_function(NO_POPOVER, timeout=10000))

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
    # 服务端给了 scope_name、scope_effect 的（grant-scope-view.ts）：领域范围的负责人只标「生效中」；部门范围标「生效中」再补一句只在哪里起作用
    {**grant(8, 'user:bing', 'area-lead', 'area:syn-fin', 'active', appr='cli'), 'scope_name': '合成利润核算', 'scope_effect': 'area'},
    {**grant(9, 'user:jia', 'dept-lead', 'dept:syn-sales', 'active', appr='cli'), 'scope_name': '合成销售部', 'scope_effect': 'dept'},
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
    check('没有口令、没登录：授予读不到（401），说请先登录；不弹口令框', pg.locator('.ant-alert', has_text='请先登录').count() == 1 and pg.locator('.ant-modal').count() == 0 and pg.locator('[data-testid=acc-mine]').count() == 0)
    tabs = [t.strip() for t in pg.locator('.wm-acc-tab').all_inner_texts()]
    check('三个页签：人和权限、账号、角色预设（以某人的身份看还没有）', tabs == ['人和权限', '账号', '角色预设'], tabs)
    check('顶栏标题是导航名「谁能做什么」', pg.locator('.wm-top-title').inner_text().strip() == '谁能做什么')

    # 认出了人但不是管理员：浏览器没带会话，授予是 401（实例真的），/api/auth/me 截下来换成带本人角色的
    ME = {'gate': 'off', 'authenticated': True, 'via': 'session', 'login': 'bing', 'principal': 'user:bing', 'display_name': '丙',
          'roles': [{'id': 'member', 'name': '普通员工', 'scope': '*', 'preset': True, 'expires_at': None, 'source': 'manual', 'approved_by': 'odoo:jia'},
                    {'id': 'dept-lead', 'name': '部门负责人', 'scope': 'domain:work', 'preset': True, 'expires_at': NOW, 'source': 'manual', 'approved_by': 'odoo:jia'}]}
    pg.route('**/api/auth/me', lambda r: fake(r, ME))
    asked = []
    ADMIN_READS = re.compile(r'/api/(principals|roles|roles/matrix)$')
    def on_req(req):
        if ADMIN_READS.search(req.url.split('?')[0]): asked.append(req.url)
    errors = []
    pg.on('request', on_req); pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    # 授予：L19（#659）起登录的人读得到自己能放行的那些——这里照它的应答截下：先是空列表
    grants_seen = []
    def on_grants_mine(r):
        grants_seen.append(r.request.url); fake(r, MY_GRANTS)
    MY_GRANTS = {'grants': []}
    pg.route('**/api/grants', on_grants_mine)
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-mine]'); pg.wait_for_load_state('networkidle')
    check('普通员工打开此页：网络里没有主体、角色、矩阵三个请求，控制台没有 403；授予照常问（只拿到自己能放行的）', asked == [] and len(grants_seen) == 1 and not any('403' in e for e in errors), (asked, grants_seen, errors))
    check('没有能放行的：只有「你的权限」，没有待核准卡片', pg.locator('[data-testid=acc-pending]').count() == 0)
    pg.locator('[data-testid=acc-tab-roles]').click()
    # 证明「不发请求」：主体、角色、矩阵问不问在打开页面时就定了（limited）。等「只有管理员能看」那句画出来、再等两帧（切页签以后要发的话这时已经发出），再看
    soft(lambda: pg.locator('.ant-alert', has_text='只有管理员能看').first.wait_for(timeout=10000)); painted(pg)
    check('普通员工切到角色预设：照旧说只有管理员能看，也不发请求', asked == [] and pg.locator('.ant-alert', has_text='只有管理员能看').count() == 1, (asked, pg.locator('.ant-alert').all_inner_texts()))
    # 管理层那样的人：有一条轮到他放行的（带业务写的第二档），卡片在「你的权限」上面；角色读不到也写名字、不露标识
    MY_GRANTS = {'grants': [dict(grant(8, 'user:jia', 'management', '*', 'pending', by='odoo:bing', reason='合成'), can_approve=True, approve_denied=None, approve_denied_text=None)]}
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-pending]'); pg.wait_for_load_state('networkidle')
    card = pg.locator('[data-testid=acc-pending]').inner_text()
    check('不是管理员但有轮到他放行的：待核准卡片在「你的权限」里、上面；角色写「管理层」不写标识；还是不问那三个', pg.locator('[data-testid=acc-mine] [data-testid=acc-pending]').count() == 1 and '管理层' in card and 'management' not in card and asked == [], (card, asked))
    # 账号页签：明知不是管理员，不去问 /api/local-accounts，直接说只有管理员能看
    acct_asked = []
    pg.on('request', lambda req: acct_asked.append(req.url) if '/api/local-accounts' in req.url else None)
    pg.goto(M + '/access?tab=accounts'); pg.wait_for_selector('[data-testid=acct-limited]'); pg.wait_for_load_state('networkidle')
    check('普通员工打开账号页签：说只有管理员能看、能管，不发 /api/local-accounts', acct_asked == [] and pg.locator('[data-testid=acct-tab]').count() == 0, acct_asked)
    pg.unroute('**/api/grants')
    pg.remove_listener('request', on_req)
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-mine]')
    mine = pg.locator('[data-testid=acc-mine]').inner_text()
    roles_shown = [''.join(t.split()) for t in pg.locator('[data-testid=acc-mine-role]').all_inner_texts()]
    check('非管理员：显示你的权限，两项角色、范围用块名、按范围的标尚未生效', len(roles_shown) == 2 and roles_shown[0].startswith('普通员工全部长期') and '「事项与对话」这一块' in roles_shown[1] and roles_shown[1].endswith('尚未生效') and '尚未生效' not in roles_shown[0], roles_shown)
    check('非管理员：下面一句别人的权限现在只有管理员能看', '别人的权限现在只有管理员能看' in mine and pg.locator('.ant-alert').count() == 0, mine)
    # 部门范围不露标识：服务端没带 scope_name 写「一个部门」，带了写名字
    DEPT = dict(ME, roles=[dict(ME['roles'][1], scope='dept:syn-dept-1'), dict(ME['roles'][1], id='member', name='普通员工', scope='dept:syn-dept-2', scope_name='合成部')])
    pg.unroute('**/api/auth/me'); pg.route('**/api/auth/me', lambda r: fake(r, DEPT))
    pg.goto(M + '/access'); pg.wait_for_selector('[data-testid=acc-mine-role]')
    dept = [''.join(t.split()) for t in pg.locator('[data-testid=acc-mine-role]').all_inner_texts()]
    check('部门范围：没有显示名写「一个部门」、有的写名字，不露 dept: 标识', len(dept) == 2 and '一个部门' in dept[0] and '「合成部」这个部门' in dept[1] and not any('dept:' in d or 'syn-dept' in d for d in dept), dept)
    pg.unroute('**/api/auth/me')

    pg.route('**/api/grants', lambda r: fake(r, GRANTS))
    # 要谁放行（身份线 #618 在 GET /api/roles 加的 approval_text）：取实例真的角色，补上合成的说法
    APPROVAL = {'management': '只有属主能放行', 'member': '管理员即可放行'}
    served = {}  # 页面实际拿到的每个角色的 approval_text（实例真的，加上上面两处改动）
    def on_roles(r):
        body = r.fetch().json()
        for x in body.get('roles', []):
            if x.get('id') in APPROVAL: x['approval_text'] = APPROVAL[x['id']]
            if x.get('id') == 'guest': x.pop('approval_text', None)  # 夹具：一个接口里不带 approval_text 的角色，验「没有说法的不标」
        served.clear(); served.update({x['id']: x.get('approval_text') for x in body.get('roles', [])})
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
    check('表：AI 员工按工作台给的权限标「尚未生效」（服务端没带 scope_effect 时按「* 才算」），全部、领域、部门范围的不标；表上方一句说明原因', body.count('尚未生效') == 1 and '工作台 3' in body and '统一判定还不认' in pg.locator('[data-testid=acc-pending-cap]').inner_text(), body)
    st = lambda t: ''.join(pg.locator('.wm-acc-table tbody tr', has_text=t).locator('[data-testid=acc-grant-status]').inner_text().split())
    area_row = pg.locator('.wm-acc-table tbody tr', has_text='合成利润核算').inner_text()
    check('已生效的领域负责人（area-lead）：状态只标「生效中」，不再同时标「尚未生效」；范围写「「合成利润核算」这个领域」，不露 area: 标识',
          st('合成利润核算') == '生效中' and '「合成利润核算」这个领域' in area_row and 'area:' not in body, (st('合成利润核算'), area_row))
    check('部门范围：标「生效中」，后面补一句只在数据视图和经验库里起作用（一个状态，不标尚未生效）', st('合成销售部') == '生效中只在数据视图和经验库里起作用', st('合成销售部'))
    check('工作台范围（统一判定还不认）：状态只标「尚未生效」，不同时标「生效中」', st('工作台 3') == '尚未生效', st('工作台 3'))
    check('表：负责人——AI 员工写它挂在谁名下', '甲经理' in pg.locator('.wm-acc-table tbody tr', has_text='小算').inner_text())

    # 核准按钮照服务端的 can_approve：3 号说不能 → 置灰、写短说法；4 号没这个字段 → 照旧可点
    n_before = len(posted)
    check('服务端说放行不了（3 号）：核准置灰，旁边写服务端的说法；不给照旧能点', cards.nth(1).locator('[data-testid=acc-approve]').is_disabled() and cards.nth(1).locator('[data-testid=acc-approve-denied]').inner_text().strip() == '起草的人不能自己放行，要另一位放行' and cards.nth(1).locator('[data-testid=acc-decline]').is_enabled(), cards.nth(1).inner_text())
    # 证明「不发请求」：核准的请求是在点击的处理函数里同步发的，点下去以后再等两帧，要发的话已经截下了
    cards.nth(1).locator('[data-testid=acc-approve]').click(force=True); painted(pg)
    check('置灰的核准硬点也不发请求', len(posted) == n_before, posted)
    check('服务端没给 can_approve（4 号）：核准照旧可点、不写说法', cards.nth(0).locator('[data-testid=acc-approve]').is_enabled() and cards.nth(0).locator('[data-testid=acc-approve-denied]').count() == 0)
    # 核准：管理员级的被拒，说服务端的说法
    n = len(posted); cards.nth(0).locator('[data-testid=acc-approve]').click()
    until(pg, lambda: len(posted) > n)  # 等截下核准；再等卡片上写出服务端的说法
    soft(lambda: cards.nth(0).filter(has_text='只有属主能放行').wait_for(timeout=10000))
    check('核准被拒（管理员级只有属主能放行）：卡片上说服务端的说法', '只有属主能放行' in cards.nth(0).inner_text() and posted and posted[-1][0] == 'approve', posted)
    # 不给：理由空着不能确认；写了才发、带理由
    cards.nth(1).locator('[data-testid=acc-decline]').click()
    confirm = cards.nth(1).locator('[data-testid=acc-decline-confirm]')
    check('不给：理由空着，确认按钮不能点', confirm.is_disabled())
    cards.nth(1).locator('[data-testid=acc-decline-reason]').fill('  还没定岗  ')
    n = len(posted); confirm.click()
    until(pg, lambda: len(posted) > n)  # 等截下撤销
    last = posted[-1] if posted else None
    check('不给：发的是撤销这条授予，带着去掉空白的理由', last and last[0] == 'revoke' and last[1].startswith('3/') and json.loads(last[2] or '{}').get('reason') == '还没定岗', last)

    # ---- 账号页签（站内账号 P4）：先用实例真的接口——建人、重置、停用、恢复 ----
    pg.locator('[data-testid=acc-tab-accounts]').click(); pg.wait_for_selector('[data-testid=acct-tab]')
    check('切到账号：地址带 ?tab=accounts', 'tab=accounts' in pg.url, pg.url)
    pg.locator('[data-testid=acct-new-username]').fill('Bad Name')
    check('用户名不合规：按钮不能点，旁边说写法', pg.locator('[data-testid=acct-new-submit]').is_disabled() and pg.locator('[data-testid=acct-new-hint]').count() == 1)
    pg.locator('[data-testid=acct-new-username]').fill('synth-acct')
    pg.locator('[data-testid=acct-new-name]').fill('合成账号')
    pg.locator('[data-testid=acct-new-submit]').click(); pg.wait_for_selector('[data-testid=acct-temp]')
    temp1 = pg.locator('[data-testid=acct-temp-password]').inner_text().strip()
    check('建人：临时密码只显示这一次（16 位），说清楚要对方先改', re.fullmatch(r'[a-z2-9]{16}', temp1) is not None and '只显示这一次' in pg.locator('[data-testid=acct-temp]').inner_text(), temp1)
    row = pg.locator('.wm-acc-table tbody tr', has_text='synth-acct')
    row.wait_for()
    check('新账号进了全部账号：标「要改密码」、谁建的写管理员（口令）', '要改密码' in row.inner_text() and '管理员（口令）' in row.inner_text(), row.inner_text())
    row.locator('[data-testid=acct-reset]').click()
    pg.locator('.ant-popconfirm .ant-btn-primary', has_text='重置').click()
    pg.wait_for_function("(t) => { const e = document.querySelector('[data-testid=acct-temp-password]'); return e && e.textContent.trim() !== t; }", arg=temp1)
    temp2 = pg.locator('[data-testid=acct-temp-password]').inner_text().strip()
    check('重置密码：要先确认，然后显示新的临时密码（和上一次不同）', re.fullmatch(r'[a-z2-9]{16}', temp2) is not None and temp2 != temp1 and '重置密码' in pg.locator('[data-testid=acct-temp]').inner_text())
    row = pg.locator('.wm-acc-table tbody tr', has_text='synth-acct')
    row.locator('[data-testid=acct-disable]').click()
    check('停用：要写理由，空着确认按钮不能点', row.locator('[data-testid=acct-status-confirm]').is_disabled())
    row.locator('[data-testid=acct-status-reason]').fill('合成：试停用')
    row.locator('[data-testid=acct-status-confirm]').click()
    pg.locator('.wm-acc-table tbody tr', has_text='synth-acct').locator('[data-testid=acct-restore]').wait_for()
    check('停用之后：标「已停用」，按钮换成恢复', '已停用' in pg.locator('.wm-acc-table tbody tr', has_text='synth-acct').inner_text())
    row = pg.locator('.wm-acc-table tbody tr', has_text='synth-acct')
    row.locator('[data-testid=acct-restore]').click(); row.locator('[data-testid=acct-status-reason]').fill('合成：恢复'); row.locator('[data-testid=acct-status-confirm]').click()
    pg.locator('.wm-acc-table tbody tr', has_text='synth-acct').locator('[data-testid=acct-disable]').wait_for()
    check('恢复之后：不再标已停用', '已停用' not in pg.locator('.wm-acc-table tbody tr', has_text='synth-acct').inner_text())
    # 待核准：列表截成带一个自己注册的账号；核准、拒绝截下来核对发了什么
    LIST = {'accounts': [
        {'username': 'zoe', 'display_name': '合成注册者', 'must_change': False, 'locked': False, 'locked_until': None, 'created_at': NOW, 'created_by': 'signup', 'updated_at': NOW, 'last_login_at': None, 'principal': None, 'principal_status': None, 'pending': True},
        {'username': 'yan', 'display_name': '', 'must_change': False, 'locked': True, 'locked_until': NOW, 'created_at': NOW, 'created_by': 'user:jia', 'updated_at': NOW, 'last_login_at': NOW, 'principal': 'user:yan', 'principal_status': 'active', 'pending': False},
    ]}
    acct_posts = []
    def on_acct(r):
        if r.request.method == 'GET': return fake(r, LIST)
        acct_posts.append((r.request.method, r.request.url.split('/api/local-accounts')[1]))
        if r.request.url.endswith('/reject'): return fake(r, {'ok': True})
        if r.request.url.endswith('/approve'): return fake(r, {'error': '这个用户名不能用（和已有的人重名或等价），请拒绝后让对方换一个用户名注册'}, 409)
        fake(r, {'account': {}})
    pg.route('**/api/local-accounts**', on_acct)
    pg.goto(M + '/access?tab=accounts'); set_token(pg); pg.wait_for_selector('[data-testid=acct-pending]')
    card = pg.locator('[data-testid=acct-pending]')
    check('待核准的注册：一张卡，写显示名、用户名、自己注册；不进全部账号的表', card.count() == 1 and '合成注册者' in card.inner_text() and '自己注册' in card.inner_text() and pg.locator('.wm-acc-table tbody tr', has_text='zoe').count() == 0)
    check('锁着的账号才有解锁按钮', pg.locator('.wm-acc-table tbody tr', has_text='yan').locator('[data-testid=acct-unlock]').count() == 1)
    card.locator('[data-testid=acct-approve]').click(); pg.wait_for_selector('[data-testid=acct-err]')
    check('核准被拒（撞名）：发的是 /zoe/approve，页面照服务端的句子说', acct_posts[-1:] == [('POST', '/zoe/approve')] and '请拒绝后让对方换一个用户名' in pg.locator('[data-testid=acct-err]').inner_text(), acct_posts)
    card.locator('[data-testid=acct-reject]').click()
    n = len(acct_posts)
    pg.locator('.ant-popconfirm .ant-btn-dangerous', has_text='拒绝').click()
    # 证明「只发一次」：拒绝在一次处理（act）里发完才收起按钮的加载状态。等截下拒绝、再等按钮不在加载（或者卡片已经没了），再数
    until(pg, lambda: len(acct_posts) > n)
    soft(lambda: pg.wait_for_function("() => !document.querySelector('[data-testid=acct-reject].ant-btn-loading')", timeout=10000)); painted(pg)
    check('拒绝：先确认，然后发 /zoe/reject', len(acct_posts) == n + 1 and acct_posts[-1] == ('POST', '/zoe/reject'), acct_posts)
    pg.unroute('**/api/local-accounts**')

    # 角色预设：用实例真的角色和矩阵
    pg.locator('[data-testid=acc-tab-roles]').click(); pg.wait_for_selector('[data-testid=acc-matrix]')
    check('切到角色预设：地址带 ?tab=roles', 'tab=roles' in pg.url, pg.url)
    with urllib.request.urlopen(urllib.request.Request(M + '/api/roles/matrix', headers={'x-admin-token': TOK})) as r: mx = json.load(r)
    ra = {pg.locator('[data-testid=acc-role]').nth(i).get_attribute('data-id'): pg.locator('[data-testid=acc-role]').nth(i).locator('[data-testid=acc-role-approval]') for i in range(pg.locator('[data-testid=acc-role]').count())}
    got = {k: (v.inner_text().strip() if v.count() else None) for k, v in ra.items()}
    want = {k: (served.get(k).strip() if isinstance(served.get(k), str) and served.get(k).strip() else None) for k in ra}
    check('角色卡标要谁放行：带 approval_text 的角色都标、文案和接口给的逐个一致', got == want and got['management'] == '只有属主能放行' and got['member'] == '管理员即可放行' and sum(1 for v in got.values() if v) >= 2, (got, want))
    check('没有说法的不标：接口里不带 approval_text 的角色（夹具：访客）卡上没有这一行', 'guest' in ra and served.get('guest') is None and ra['guest'].count() == 0, (served.get('guest'), ra['guest'].count() if 'guest' in ra else None))
    check('每个角色一张卡', pg.locator('[data-testid=acc-role]').count() == len(mx['roles']), (pg.locator('[data-testid=acc-role]').count(), len(mx['roles'])))
    rows = pg.locator('[data-testid=acc-matrix] tbody tr')
    check('矩阵：服务端给几块就几行（含经验库）、四类一列一类', rows.count() == len(mx['blocks']) >= 8 and any(b.get('key') == 'knowledge' for b in mx['blocks']) and pg.locator('[data-testid=acc-matrix] thead th').count() == 1 + len(mx['kinds']), (rows.count(), [b.get('key') for b in mx['blocks']]))
    pg.locator('[data-testid=acc-role][data-id=dept-lead]').click()
    soft(lambda: pg.locator('[data-testid=acc-matrix] tbody .wm-acc-cell', has_text='范围内').first.wait_for(timeout=10000))  # 等矩阵换成部门负责人的格子
    tds = [''.join(t.split()) for t in pg.locator('[data-testid=acc-matrix] tbody td:not(:first-child)').all_inner_texts()]
    scoped_titles = pg.locator('[data-testid=acc-matrix] tbody .wm-acc-cell', has_text='范围内').evaluate_all('els => els.map(e => e.title)')
    check('「范围内」的格子不再一律标尚未生效（起不起作用看授予选的范围）；悬停说明领域、部门、台各自怎样', any(tds) and not any('尚未生效' in t for t in tds)
          and scoped_titles and all('领域范围在这个领域里起作用' in x and '部门范围只在数据视图和经验库里' in x for x in scoped_titles), (tds, scoped_titles))
    cells = set(t.strip() for t in pg.locator('[data-testid=acc-matrix] tbody .wm-acc-cell').all_inner_texts())
    check('选部门负责人：格子都在说法里，有「范围内」', cells <= {'全部', '范围内', '部分', '只限自己', '不能', '—'} and '范围内' in cells, cells)
    want = mx['roles'][[r['id'] for r in mx['roles']].index('dept-lead')]['cells']['work']['read']
    shown = pg.locator('[data-testid=acc-matrix] tbody tr', has_text='事项与对话').locator('.wm-acc-cell').first.inner_text().strip()
    check('格子和接口算的一致（部门负责人 · 事项与对话 · 看）', {'all': '全部', 'scoped': '范围内', 'some': '部分', 'self': '只限自己', 'none': '不能', 'na': '—'}[want] == shown, (want, shown))

    # ---- 用户卡里的「改密码」：站内账号登录的人才有；改好要重新登录，只有新密码能用 ----
    req = urllib.request.Request(M + '/api/local-accounts', data=json.dumps({'username': 'synth-pw', 'display_name': '合成改密'}).encode(), method='POST', headers={'x-admin-token': TOK, 'content-type': 'application/json'})
    with urllib.request.urlopen(req) as r: temp = json.load(r)['temp_password']
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); up = ctx.new_page(); up.set_default_timeout(10000)
    def local_login(pw, first_new=None):
        up.goto(M + '/login/local?next=/'); up.wait_for_selector('input[name=username]')
        up.fill('input[name=username]', 'synth-pw'); up.fill('input[name=password]', pw); up.click('button[type=submit]')
        if first_new:
            up.wait_for_selector('input[name=next]'); up.fill('input[name=next]', first_new); up.fill('input[name=confirm]', first_new); up.click('button[type=submit]')
        up.wait_for_load_state('networkidle')
    local_login(temp, 'Synth-pw-00001')
    up.goto(M + '/'); up.wait_for_selector('[data-testid=wm-me]')
    up.locator('[data-testid=wm-me]').click(); up.locator('[data-testid=pw-open]').wait_for()
    before = up.evaluate("fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json())")
    check('站内账号登录的人：/api/auth/me 认出是他（市场会话）、有站内账号；用户卡里有「改密码」', before.get('principal') == 'user:synth-pw' and before.get('local_account') is True and up.locator('[data-testid=pw-open]').count() == 1, before)
    up.locator('[data-testid=pw-open]').click(); up.locator('[data-testid=pw-current]').wait_for()
    up.fill('[data-testid=pw-current]', 'Synth-pw-00001'); up.fill('[data-testid=pw-next]', 'Synth-pw-00002'); up.fill('[data-testid=pw-confirm]', 'Synth-pw-00003')
    check('两次新密码不一样：提示、改好按钮不能点', up.locator('[data-testid=pw-problem]').count() == 1 and up.locator('[data-testid=pw-submit]').is_disabled())
    up.fill('[data-testid=pw-current]', 'Wrong-pass-0001'); up.fill('[data-testid=pw-confirm]', 'Synth-pw-00002')
    up.locator('[data-testid=pw-submit]').click(); up.wait_for_selector('[data-testid=pw-problem]')
    check('原密码不对：照服务端的说法提示，不关框', '原密码不对' in up.locator('[data-testid=pw-problem]').inner_text() and up.locator('[data-testid=pw-done]').count() == 0, up.locator('[data-testid=pw-problem]').inner_text())
    up.fill('[data-testid=pw-current]', 'Synth-pw-00001')
    up.locator('[data-testid=pw-submit]').click(); up.wait_for_selector('[data-testid=pw-done]')
    check('改好：说已退出、要用新密码重新登录', '重新登录' in up.locator('[data-testid=pw-done]').inner_text())
    up.locator('[data-testid=pw-relogin]').click(); up.wait_for_url('**/login**')
    # 从页面里问（带着浏览器的 cookie 和标记；回环直连、不带浏览器标记的会被当成本机命令行，测不出会话）
    after = up.evaluate("fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json())")
    check('改好之后：原来的会话已经注销（/api/auth/me 认不出这个人）', after.get('via') != 'cli' and after.get('principal') != 'user:synth-pw', after)
    local_login('Synth-pw-00001')
    check('旧密码登不进', up.locator('p.err').count() == 1, up.url)
    local_login('Synth-pw-00002')
    up.goto(M + '/'); up.wait_for_selector('[data-testid=wm-me]')
    me2 = up.evaluate("fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json())")
    check('新密码登得进', me2.get('principal') == 'user:synth-pw' and me2.get('local_account') is True, me2)
    # 不是站内账号的（口令管理员）：用户卡里没有「改密码」
    # 证明「没有改密码」：「改密码」看 /api/auth/me 是不是站内账号（用户卡里自己去取，共享缓存只留 2 秒，可能另发一次）。
    # 请求和应答都记下来：用户卡开好、应答数追上请求数、页面画完，再判一次追上（防住缓存过期后补发的那一次），再看
    me_req, me_resp = [], []
    is_me = lambda u: u.split('?')[0].endswith('/api/auth/me')
    pg.on('request', lambda r: me_req.append(r.url) if is_me(r.url) else None)
    pg.on('response', lambda r: me_resp.append(r.url) if is_me(r.url) else None)
    pg.goto(M + '/'); set_token(pg); pg.locator('[data-testid=wm-me]').click()
    soft(lambda: settled(pg, '.wm-me-pop'))
    until(pg, lambda: me_req and len(me_resp) >= len(me_req)); painted(pg)
    until(pg, lambda: len(me_resp) >= len(me_req)); painted(pg)
    check('没有站内账号的（口令管理员）：用户卡里没有「改密码」', pg.locator('[data-testid=pw-open]').count() == 0)
    ctx.close()
    b.close()

print(f'access-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
