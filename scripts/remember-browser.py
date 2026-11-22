"""「把这次的取舍记成经验」（经验库第 2 步，#745）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
接口用 page.route 截成合成的应答（身份的 can、「关注」、缺省档、答复、「我处理过的」、补记），记下页面发了什么：
  一、能不能记：can.remember_knowledge 为假的人卡片上没有勾选，也没有「我处理过的」；
  二、答复卡：勾选默认收着；勾上展开三项，谁能看缺省按服务端推的那一档（推不出部门落在只给管理层，本部门置灰），全公司从不当缺省；
      以后怎么办没填，答法按钮置灰；交的时候 remember 跟着答复一起发，没改档不传 visibility，改了才传；
      记上了 / 稍后重试 / 被拒各一句，被拒时答复照常算办完；remember 不合格（400 remember_invalid）说没办成；
  三、驾驶舱右栏窄：展开三项以后答法按钮还在一屏里；
  四、「我处理过的（48 小时内）」：一行一条，没标题写来源名；记过的标出来；补记展开同样三项，交了变成「已记成经验」，请求带对的条目。"""
import json, os, re, sys
SHOT = os.environ.get('WM_SHOT_REMEMBER')  # 本机看样子用，CI 不设
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
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
    """等页面再画两帧（应答到了以后 React 把它画出来）"""
    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

# 走 /api/attention/answer 的两条（没有 answer_via，不是建立人自己的验收）：一条推得出部门，一条推不出
ITEMS = [
    {'source': 'mcp-access', 'source_id': '9101', 'category': 'grant', 'title': 'MCP 会话 合成会话 申请工具：list_rows', 'waiting_for': 'mcp:合成会话', 'since': '2026-11-14T00:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True},
    {'source': 'mcp-access', 'source_id': '9102', 'category': 'grant', 'title': 'MCP 会话 合成会话二 申请工具：put_rows', 'waiting_for': 'mcp:合成会话二', 'since': '2026-11-14T01:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True},
]
DEFAULTS = {'9101': {'default_visibility': 'department', 'department_name': '采购部'}, '9102': {'default_visibility': 'restricted', 'department_name': None},
            '9103': {'default_visibility': 'department', 'department_name': None},
            'wi-syn-rel-noname': {'default_visibility': 'department', 'department_name': None}}   # 9104、wi-syn-rel-500：缺省档接口回 500
EXTRA = [dict(ITEMS[0], source_id=sid, title=t) for sid, t in (('9103', 'MCP 会话 合成会话三 申请工具：get_rows'), ('9104', 'MCP 会话 合成会话四 申请工具：del_rows'))]
RECENT = {'items': [
    {'source': 'work-items', 'source_id': 'wi-syn-1', 'title': '合成：比价表', 'answer': 'release', 'answer_text': '放行', 'answered_at': '2026-11-14T06:00:00Z', 'remembered': None, 'default_visibility': 'department', 'department_name': '采购部'},
    {'source': 'mcp-access', 'source_id': '9001', 'title': None, 'answer': 'approve', 'answer_text': '批准', 'answered_at': '2026-11-14T05:00:00Z', 'remembered': 'written', 'default_visibility': 'restricted', 'department_name': None},
    {'source': 'work-items', 'source_id': 'wi-syn-2', 'title': '合成：部门没名字的那件', 'answer': 'verify', 'answer_text': '验收', 'answered_at': '2026-11-14T04:00:00Z', 'remembered': None, 'default_visibility': 'department', 'department_name': None},
    {'source': 'work-items', 'source_id': 'wi-syn-3', 'title': '合成：缺省档没给的那件', 'answer': 'verify', 'answer_text': '验收', 'answered_at': '2026-11-14T03:00:00Z', 'remembered': None},
]}
state = {'can': True, 'answer_remember': {'status': 'written', 'duplicate': False, 'scope_label': '采购部'}, 'answer_status': 200, 'grant_admin': True}
# 不是管理员时：建立人自己的验收（走 /api/work-items/:id/decision，答完紧接着补记）、和一条自带答复入口的放行（answer_via：不进答复账，不给勾选）
CREATOR = [
    {'source': 'work-items', 'source_id': 'wi-syn-acc', 'category': 'accept', 'title': '合成：比价表做完了', 'waiting_for': 'user:synthetic-boss', 'since': '2026-11-14T02:00:00Z', 'answers': ['verify', 'return'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-acc', 'mine': True},
    {'source': 'work-items', 'source_id': 'wi-syn-rel', 'category': 'glance', 'title': '合成：到货核对等放行', 'waiting_for': 'zone/canvas/team-a', 'since': '2026-11-14T03:00:00Z', 'answers': ['release'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-rel', 'mine': True,
     'answer_via': {'method': 'POST', 'path': '/api/work-items/wi-syn-rel/release', 'answers': {'release': {'body': {'from_attention': True}}}}},
    # 放行卡片在缺省档读不准时：部门没名字、缺省档接口 500（统筹重点 2，answer_via 这条路也要守住）
    *[{'source': 'work-items', 'source_id': sid, 'category': 'glance', 'title': t, 'waiting_for': 'zone/canvas/team-a', 'since': '2026-11-14T03:10:00Z', 'answers': ['release'], 'object': '', 'phase': '', 'link': f'/work-items/{sid}', 'mine': True,
       'answer_via': {'method': 'POST', 'path': f'/api/work-items/{sid}/release', 'answers': {'release': {'body': {'from_attention': True}}}}}
      for sid, t in (('wi-syn-rel-noname', '合成：放行·部门没名字'), ('wi-syn-rel-500', '合成：放行·缺省档读不到'))],
    # 没带 from_attention 的老入口：不收 remember，不给勾选
    {'source': 'work-items', 'source_id': 'wi-syn-old', 'category': 'glance', 'title': '合成：老入口的放行', 'waiting_for': 'zone/canvas/team-a', 'since': '2026-11-14T03:30:00Z', 'answers': ['release'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-old', 'mine': True,
     'answer_via': {'method': 'POST', 'path': '/api/work-items/wi-syn-old/release', 'answers': {'release': {'body': {}}}}},
]
decisions = []
releases = []
sent, later = [], []

def setup(ctx):
    ctx.route(re.compile(r'/api/auth/me$'), lambda r: fake(r, {'authenticated': True, 'via': 'cookie', 'login': 'synthetic-boss', 'display_name': '合成管理层', 'principal': 'user:synthetic-boss', 'roles': [], 'can': {'create_cockpit': True, 'remember_knowledge': state['can']}}))
    ctx.route(re.compile(r'/api/admin/whoami$'), lambda r: fake(r, {'admin': True, 'via': 'grant', 'login': 'user:synthetic-boss'} if state['grant_admin'] else {'admin': False, 'via': None, 'login': None}))
    ctx.route(re.compile(r'/api/attention(\?|$)'), lambda r: fake(r, {'items': (ITEMS + (EXTRA if state.get('extra') else [])) if state['grant_admin'] else CREATOR, 'counts': {'total': 2}, 'sources': {}}))
    def decision(r):
        decisions.append(json.loads(r.request.post_data or '{}')); fake(r, {'duplicate': False, 'result': {}})
    ctx.route(re.compile(r'/api/work-items/[^/]+/decision$'), decision)
    def release(r):
        b = json.loads(r.request.post_data or '{}'); releases.append(b)
        sid = re.search(r'/work-items/([^/]+)/release', r.request.url).group(1)
        # 和服务端一样：放行的应答是来源路由自己的正文，remember 和它的字段平级（不包在 result 里）；记上了，「我处理过的」里这一条就是已记
        if 'remember' in b and sid == 'wi-syn-rel': state['recent_extra'] = [{'source': 'work-items', 'source_id': sid, 'title': '合成：到货核对等放行', 'answer': 'release', 'answer_text': '放行', 'answered_at': '2026-11-14T07:00:00Z', 'remembered': 'written', 'default_visibility': 'restricted', 'department_name': None}]
        fake(r, {'item_id': sid, 'duplicate': False, 'ok': True, **({'remember': {'status': 'written', 'duplicate': False, 'scope_label': '只给管理层'}} if 'remember' in b else {})})
    ctx.route(re.compile(r'/api/work-items/[^/]+/release$'), release)
    def defaults(r):
        sid = re.search(r'source_id=([^&]+)', r.request.url).group(1)
        if sid in ('9104', 'wi-syn-rel-500'): return fake(r, {'error': 'internal'}, 500)
        fake(r, DEFAULTS.get(sid, {'default_visibility': 'restricted', 'department_name': None}))
    ctx.route(re.compile(r'/api/knowledge/remember/defaults'), defaults)
    def answer(r):
        b = json.loads(r.request.post_data or '{}'); sent.append(b)
        if state['answer_status'] == 400: return fake(r, {'error': 'remember_invalid', 'message': 'lesson（以后遇到类似情况怎么办）必填，1～500 字'}, 400)
        fake(r, {'source': b['source'], 'source_id': b['source_id'], 'answer': b['answer'], 'duplicate': False, 'result': {}, **({'remember': state['answer_remember']} if 'remember' in b else {})})
    ctx.route(re.compile(r'/api/attention/answer$'), answer)
    ctx.route(re.compile(r'/api/knowledge/remember/recent$'), lambda r: fake(r, {'items': state.get('recent_extra', []) + RECENT['items']}) if state['can'] else fake(r, {'error': 'remember_denied', 'message': 'x'}, 403))
    def remember_later(r):
        b = json.loads(r.request.post_data or '{}'); later.append(b)
        fake(r, {'status': 'written', 'duplicate': False, 'scope_label': '采购部'}, 201)
    ctx.route(re.compile(r'/api/knowledge/remember$'), remember_later)

def press(pg, btn):
    # 有的答法先弹确认框（批准 AI 会话的写工具）：等到确认框弹出，或者（不弹的那种）答复请求已经发出；弹了就点确定
    n = len(sent) + len(decisions) + len(releases)
    pop = pg.locator('.ant-popconfirm:not(.ant-popover-hidden) .ant-btn-primary')
    btn.click()
    until(pg, lambda: pop.count() > 0 or len(sent) + len(decisions) + len(releases) > n)
    if pop.count(): pop.last.click()
def card(pg, sid): return pg.locator('[data-testid=decision-card]', has_text='合成会话二' if sid == '9102' else '申请工具：list_rows').first

with sync_playwright() as p:
    b = p.chromium.launch()
    print('一、能不能记')
    state['can'] = False
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    # 证明「没有」：卡片上的「记成经验」和「我处理过的」都按 /api/auth/me 的 can 画（页面只取一次）。
    # 先等这次应答回来、页面画完；要是还去取了「我处理过的」（回归），也等它的应答回来，再看两样都没有
    me, recent_req, recent_resp = [], [], []
    is_recent = lambda u: u.split('?')[0].endswith('/api/knowledge/remember/recent')
    pg.on('response', lambda r: me.append(r.url) if r.url.split('?')[0].endswith('/api/auth/me') else None)
    pg.on('request', lambda r: recent_req.append(r.url) if is_recent(r.url) else None)
    pg.on('response', lambda r: recent_resp.append(r.url) if is_recent(r.url) else None)
    pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-card]')
    until(pg, lambda: me); painted(pg)
    if recent_req: until(pg, lambda: len(recent_resp) >= len(recent_req)); painted(pg)
    check('不能记的人：卡片上没有「记成经验」，也没有「我处理过的」', pg.locator('[data-testid=decision-remember]').count() == 0 and pg.locator('[data-testid=recent-answers]').count() == 0)
    ctx.close()

    print('二、答复卡')
    state['can'] = True
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-remember]')
    c1 = card(pg, '9101')
    check('能记的人：卡片上有「把这次的取舍记成经验」，默认收着（三项不展开）', c1.locator('[data-testid=decision-remember-toggle]').count() == 1 and c1.locator('[data-testid=remember-fields]').count() == 0 and not c1.locator('[data-testid=decision-remember-toggle]').is_checked())
    c1.locator('[data-testid=decision-remember-toggle]').click()
    c1.locator('[data-testid=remember-visibility]').wait_for()
    radios = c1.locator('[data-testid=remember-visibility] .ant-radio-wrapper')
    labels = radios.all_inner_texts(); checked = c1.locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
    check('勾上展开三项；谁能看三个选项从窄到宽（只给管理层 / 本部门 / 全公司），本部门写部门名；缺省选中服务端推的「本部门（采购部）」，不是全公司', labels == ['只给管理层', '本部门（采购部）', '全公司'] and checked == '本部门（采购部）' and c1.locator('[data-testid=remember-lesson]').count() == 1 and c1.locator('[data-testid=remember-cue]').count() == 1, (labels, checked))
    if SHOT: c1.locator('[data-testid=remember-lesson]').fill('合成：只读工具直接批，写的工具先问清用途'); pg.wait_for_timeout(300); pg.screenshot(path=SHOT.replace('.png', '-答复卡.png')); c1.locator('[data-testid=remember-lesson]').fill('')
    approve = c1.get_by_role('button', name=re.compile('批\\s*准'))
    check('以后怎么办没填：答法按钮置灰，旁边说要先填', approve.is_disabled() and '先填' in c1.locator('[data-testid=decision-remember-block]').inner_text())
    c1.locator('[data-testid=remember-lesson]').fill('合成：只读工具直接批，写的工具先问清用途')
    check('填了以后答法按钮能点', approve.is_enabled())
    press(pg, approve)
    pg.wait_for_function("() => document.querySelector('.ant-message')?.textContent.includes('记成了经验')")
    check('一次办完：答复带着 remember 一起发，谁能看总是带上页面选中的那一档（这里是本部门）', sent[-1].get('source_id') == '9101' and sent[-1].get('remember') == {'lesson': '合成：只读工具直接批，写的工具先问清用途', 'visibility': 'department'}, sent[-1:])
    check('记上了：提示「办好了，也记成了经验（采购部）」', pg.locator('.ant-message', has_text='办好了，也记成了经验（采购部）').count() >= 1)

    c2 = card(pg, '9102')
    c2.locator('[data-testid=decision-remember-toggle]').click(); c2.locator('[data-testid=remember-visibility]').wait_for()
    dept = c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper', has_text='本部门').first
    checked = c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
    check('推不出部门：缺省落在「只给管理层」，不是全公司；本部门置灰', checked == '只给管理层' and 'ant-radio-wrapper-disabled' in (dept.get_attribute('class') or ''), checked)
    c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper', has_text='全公司').click()
    c2.locator('[data-testid=remember-lesson]').fill('合成：写的工具一律先问用途'); c2.locator('[data-testid=remember-cue]').fill('合成会话要写表')
    state['answer_remember'] = {'status': 'refused', 'error': 'remember_denied', 'message': '你没有对经验库拍板的授予'}
    press(pg, c2.get_by_role('button', name=re.compile('批\\s*准')))
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].some(e => e.textContent.includes('经验没记上'))")
    check('人改成「全公司」就传 company；情况填了就带 cue', sent[-1].get('remember') == {'lesson': '合成：写的工具一律先问用途', 'cue': '合成会话要写表', 'visibility': 'company'}, sent[-1:])
    check('经验被拒不拖住答复：「办好了；经验没记上：你没有对经验库拍板的授予」，不露代号', pg.locator('.ant-message', has_text='办好了；经验没记上：你没有对经验库拍板的授予').count() >= 1 and pg.locator('.ant-message', has_text='remember_denied').count() == 0)
    ctx.close()

    # remember 不合格：整个答复 400、答复没生效
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-remember]')
    state['answer_status'] = 400
    c1 = card(pg, '9101'); c1.locator('[data-testid=decision-remember-toggle]').click(); c1.locator('[data-testid=remember-visibility]').wait_for()
    c1.locator('[data-testid=remember-lesson]').fill('合成：随便一句')
    press(pg, c1.get_by_role('button', name=re.compile('批\\s*准')))
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].some(e => e.textContent.includes('没办成'))")
    check('remember 不合格（400）：说没办成、经验那几项填得不对；服务端那句带字段名的不原样给人看', pg.locator('.ant-message', has_text='「记成经验」那几项填得不对').count() >= 1 and pg.locator('.ant-message', has_text='lesson').count() == 0)
    state['answer_status'] = 200
    ctx.close()

    # 缺省档读不到（#766 验收退回）：部门没名字、缺省档接口 500——页面显示只给管理层，交出去的也必须是 restricted，不能让服务端按它自己的缺省记成本部门
    state['extra'] = True
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-remember]')
    for sid, what in (('9103', '部门没名字'), ('9104', '缺省档接口 500')):
        c = pg.locator('[data-testid=decision-card]', has_text='合成会话三' if sid == '9103' else '合成会话四').first
        c.locator('[data-testid=decision-remember-toggle]').click(); c.locator('[data-testid=remember-visibility]').wait_for()
        shown = c.locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
        c.locator('[data-testid=remember-lesson]').fill(f'合成：{what}的一句')
        n = len(sent); press(pg, c.get_by_role('button', name=re.compile('批\\s*准')))
        until(pg, lambda: len(sent) > n)  # 等截下这一次答复
        got = sent[n:][-1].get('remember') if sent[n:] else None
        check(f'答复卡·{what}：页面显示「只给管理层」，交出去的 visibility 也是 restricted', shown == '只给管理层' and got is not None and got.get('visibility') == 'restricted', (shown, got))
    state['extra'] = False
    ctx.close()

    print('二之二、建立人自己的验收（不是管理员）')
    state['grant_admin'] = False
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-card]')
    acc = pg.locator('[data-testid=decision-card]', has_text='比价表做完了').first
    rel = pg.locator('[data-testid=decision-card]', has_text='等放行').first
    old = pg.locator('[data-testid=decision-card]', has_text='老入口的放行').first
    # 等放行卡片上的勾选出来（can 到了）。老入口没有勾选，是同一份 can、同一份「关注」应答在同一次渲染里定的，再看它
    soft(lambda: rel.locator('[data-testid=decision-remember-toggle]').wait_for(timeout=10000))
    check('放行（answer_via 带 from_attention，#767）有勾选；没带标记的老入口不给勾选；建立人的验收有勾选', rel.locator('[data-testid=decision-remember-toggle]').count() == 1 and old.locator('[data-testid=decision-remember]').count() == 0 and acc.locator('[data-testid=decision-remember-toggle]').count() == 1)
    acc.locator('[data-testid=decision-remember-toggle]').click(); acc.locator('[data-testid=remember-visibility]').wait_for()
    acc.locator('[data-testid=remember-lesson]').fill('合成：比价表看交期，不只看价')
    n = len(later)
    press(pg, acc.get_by_role('button', name=re.compile('验收')).first)
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].some(e => e.textContent.includes('记成了经验'))")
    check('验收走建立人的入口，答完紧接着补记：先发 decision，再 POST /api/knowledge/remember 带这一条', decisions[-1:] and decisions[-1].get('answer') == 'verify' and later[n:] == [{'source': 'work-items', 'source_id': 'wi-syn-acc', 'lesson': '合成：比价表看交期，不只看价', 'visibility': 'restricted'}], (decisions[-1:], later[n:]))
    check('提示「办好了，也记成了经验（采购部）」', pg.locator('.ant-message', has_text='办好了，也记成了经验（采购部）').count() >= 1)
    # 放行：remember 和答复同一个请求，照 answer_via 的 body（带 from_attention）发，不再另外补记
    rel.locator('[data-testid=decision-remember-toggle]').click(); rel.locator('[data-testid=remember-visibility]').wait_for()
    rel.locator('[data-testid=remember-lesson]').fill('合成：到货核对先放行，数对不上再退')
    n = len(later)
    press(pg, rel.get_by_role('button', name=re.compile('派出去')).first)
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].filter(e => e.textContent.includes('记成了经验')).length >= 1")
    # 证明「没有另外补记」：放行办完以后页面一定会重读「我处理过的」。等重读画出这一条，补记要发的话（回归）早在这之前就发了，再看
    soft(lambda: pg.wait_for_function("() => [...document.querySelectorAll('[data-testid=recent-row]')].some(e => e.textContent.includes('到货核对等放行'))", timeout=10000))
    check('放行带着 remember 一起发：照 answer_via 的 body 带上 from_attention，再加 remember（含谁能看）；不另外补记', releases[-1:] == [{'from_attention': True, 'remember': {'lesson': '合成：到货核对先放行，数对不上再退', 'visibility': 'restricted'}}] and later[n:] == [], (releases[-1:], later[n:]))
    check('放行记上了：提示「办好了，也记成了经验（只给管理层）」（remember 在放行应答的顶层）', pg.locator('.ant-message', has_text='办好了，也记成了经验（只给管理层）').count() >= 1)
    pg.wait_for_function("() => [...document.querySelectorAll('[data-testid=recent-row]')].some(e => e.textContent.includes('到货核对等放行'))")
    row = pg.locator('[data-testid=recent-row]', has_text='到货核对等放行').first
    check('放行之后「我处理过的」跟着重读：这一条在最上面，标「已记成经验」，没有补记按钮', pg.locator('[data-testid=recent-title]').first.inner_text() == '合成：到货核对等放行' and row.locator('[data-testid=recent-remembered]').inner_text() == '已记成经验' and row.locator('[data-testid=recent-remember]').count() == 0)
    state.pop('recent_extra', None)
    for sid, t, what in (('wi-syn-rel-noname', '放行·部门没名字', '部门没名字'), ('wi-syn-rel-500', '放行·缺省档读不到', '缺省档接口 500')):
        c = pg.locator('[data-testid=decision-card]', has_text=t).first
        c.locator('[data-testid=decision-remember-toggle]').click(); c.locator('[data-testid=remember-visibility]').wait_for()  # 缺省档取回来之前这一项不出现
        shown = c.locator('.ant-radio-wrapper-checked').inner_text().strip()
        c.locator('[data-testid=remember-lesson]').fill('合成：' + what + '时只给管理层看')
        m = len(releases)
        press(pg, c.get_by_role('button', name=re.compile('派出去')).first)
        until(pg, lambda: len(releases) > m)  # 等截下这一次放行
        got = releases[m:][-1] if releases[m:] else {}
        check(f'放行卡片·{what}：页面显示「只给管理层」，release 请求体里 remember.visibility 也是 restricted', shown == '只给管理层' and got.get('from_attention') is True and (got.get('remember') or {}).get('visibility') == 'restricted', (shown, got))
    ctx.close()
    state['grant_admin'] = True

    print('四、我处理过的')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=recent-row]')
    rows = pg.locator('[data-testid=recent-row]')
    titles = pg.locator('[data-testid=recent-title]').all_inner_texts()
    check('一行一条：有标题写标题，没标题写来源名（AI 会话申请工具）；答的是什么写出来', titles[:2] == ['合成：比价表', 'AI 会话申请工具'] and '放行' in rows.nth(0).inner_text() and '批准' in rows.nth(1).inner_text(), titles)
    check('记过的标「已记成经验」、没有补记按钮；没记过的有「记成经验」', rows.nth(1).locator('[data-testid=recent-remembered]').inner_text() == '已记成经验' and rows.nth(1).locator('[data-testid=recent-remember]').count() == 0 and rows.nth(0).locator('[data-testid=recent-remember]').count() == 1)
    text = pg.locator('[data-testid=recent-answers]').inner_text()
    check('「我处理过的」不露来源代号和编号', not any(x in text for x in ('work-items', 'mcp-access', 'wi-syn-1', '9001')), text[:120])
    rows.nth(0).locator('[data-testid=recent-remember]').click(); rows.nth(0).locator('[data-testid=remember-fields]').wait_for()
    checked = rows.nth(0).locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
    check('补记展开同样三项，缺省按这一条带的那一档（本部门（采购部））；没填不能交', checked == '本部门（采购部）' and rows.nth(0).locator('[data-testid=recent-submit]').is_disabled(), checked)
    rows.nth(0).locator('[data-testid=remember-lesson]').fill('合成：比价表先看交期再看价')
    if SHOT: pg.locator('[data-testid=recent-answers]').scroll_into_view_if_needed(); pg.wait_for_timeout(300); pg.screenshot(path=SHOT.replace('.png', '-我处理过的.png'))
    rows.nth(0).locator('[data-testid=recent-submit]').click()
    rows.nth(0).locator('[data-testid=recent-remembered]').wait_for()
    check('补记放行这一条（#767 起「我处理过的」里会正当出现）：POST /api/knowledge/remember 带对的条目，谁能看带上选中的那一档（本部门）；这一行变成「已记成经验」', later[-1:] == [{'source': 'work-items', 'source_id': 'wi-syn-1', 'lesson': '合成：比价表先看交期再看价', 'visibility': 'department'}] and rows.nth(0).locator('[data-testid=recent-remembered]').inner_text() == '已记成经验', later)
    for i, what in ((2, '部门没名字'), (3, '缺省档没给')):
        row = pg.locator('[data-testid=recent-row]').nth(i)
        row.locator('[data-testid=recent-remember]').click(); row.locator('[data-testid=remember-fields]').wait_for()
        shown = row.locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
        hint = row.inner_text()
        row.locator('[data-testid=remember-lesson]').fill(f'合成：补记·{what}')
        n = len(later); row.locator('[data-testid=recent-submit]').click(); row.locator('[data-testid=recent-remembered]').wait_for()
        got = later[n:][-1] if later[n:] else {}
        check(f'补记·{what}：页面显示「只给管理层」，交出去的 visibility 也是 restricted', shown == '只给管理层' and got.get('visibility') == 'restricted', (shown, got))
        if i == 2: check('补记没填时的提示说「或者点「取消」」（那里是取消按钮，不是勾选）', '或者点「取消」' in hint and '取消勾选' not in hint, hint[-80:])
    ctx.close()

    print('三、驾驶舱右栏')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + f'/cockpit/{cfg["cockpit"]}'); pg.wait_for_selector('[data-testid=ck-row]')
    pg.locator('[data-testid=ck-row]').first.click(); pg.wait_for_selector('[data-testid=ck-process-answer] [data-testid=decision-remember-toggle]')
    pane = pg.locator('[data-testid=ck-process-answer]')
    pane.locator('[data-testid=decision-remember-toggle]').click(); pane.locator('[data-testid=remember-visibility]').wait_for()
    pane.locator('[data-testid=remember-lesson]').fill('合成：一句')
    btn = pane.locator('.wm-decision-actions .ant-btn').first
    if SHOT: pg.wait_for_timeout(300); pg.screenshot(path=SHOT.replace('.png', '-驾驶舱.png'))
    # 不滚动就量：展开以后答法按钮仍在右栏看得见的那一块里，也在 900 高的一屏里
    box = btn.bounding_box(); field = pane.locator('[data-testid=remember-lesson]').bounding_box()
    view = pg.evaluate("(() => { const b = document.querySelector('[data-testid=ck-process-answer]').closest('.wm-ck-pane-b'); const r = b ? b.getBoundingClientRect() : { top: 0, bottom: innerHeight }; return [r.top, r.bottom]; })()")
    ys = [round(e.bounding_box()['y']) for e in pane.locator('[data-testid=remember-visibility] .ant-radio-wrapper').all()]
    check('驾驶舱右栏：「谁能看」三个选项一行一个（竖排），不挤到第二行', len(ys) == 3 and ys[0] < ys[1] < ys[2], ys)
    check('驾驶舱右栏：三项竖着排（「谁能看」在以后怎么办的下面）；不滚动，答法按钮就在右栏可见的那一块里、在一屏里', box is not None and box['y'] >= view[0] and box['y'] + box['height'] <= min(view[1], 900) and pane.locator('[data-testid=remember-visibility]').bounding_box()['y'] > field['y'], (box, view, field))
    ctx.close()
    b.close()

print(f'remember-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
