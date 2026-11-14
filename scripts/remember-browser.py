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
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

# 走 /api/attention/answer 的两条（没有 answer_via，不是建立人自己的验收）：一条推得出部门，一条推不出
ITEMS = [
    {'source': 'mcp-access', 'source_id': '9101', 'category': 'grant', 'title': 'MCP 会话 合成会话 申请工具：list_rows', 'waiting_for': 'mcp:合成会话', 'since': '2026-11-14T00:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True},
    {'source': 'mcp-access', 'source_id': '9102', 'category': 'grant', 'title': 'MCP 会话 合成会话二 申请工具：put_rows', 'waiting_for': 'mcp:合成会话二', 'since': '2026-11-14T01:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True},
]
DEFAULTS = {'9101': {'default_visibility': 'department', 'department_name': '采购部'}, '9102': {'default_visibility': 'restricted', 'department_name': None}}
RECENT = {'items': [
    {'source': 'work-items', 'source_id': 'wi-syn-1', 'title': '合成：比价表', 'answer': 'release', 'answer_text': '放行', 'answered_at': '2026-11-14T06:00:00Z', 'remembered': None, 'default_visibility': 'department', 'department_name': '采购部'},
    {'source': 'mcp-access', 'source_id': '9001', 'title': None, 'answer': 'approve', 'answer_text': '批准', 'answered_at': '2026-11-14T05:00:00Z', 'remembered': 'written', 'default_visibility': 'restricted', 'department_name': None},
]}
state = {'can': True, 'answer_remember': {'status': 'written', 'duplicate': False, 'scope_label': '采购部'}, 'answer_status': 200, 'odoo_admin': True}
# 不是管理员时：建立人自己的验收（走 /api/work-items/:id/decision，答完紧接着补记）、和一条自带答复入口的放行（answer_via：不进答复账，不给勾选）
CREATOR = [
    {'source': 'work-items', 'source_id': 'wi-syn-acc', 'category': 'accept', 'title': '合成：比价表做完了', 'waiting_for': 'user:synthetic-boss', 'since': '2026-11-14T02:00:00Z', 'answers': ['verify', 'return'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-acc', 'mine': True},
    {'source': 'work-items', 'source_id': 'wi-syn-rel', 'category': 'glance', 'title': '合成：到货核对等放行', 'waiting_for': 'zone/canvas/team-a', 'since': '2026-11-14T03:00:00Z', 'answers': ['release'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-rel', 'mine': True,
     'answer_via': {'method': 'POST', 'path': '/api/work-items/wi-syn-rel/release', 'answers': {'release': {'body': {}}}}},
]
decisions = []
sent, later = [], []

def setup(ctx):
    ctx.route(re.compile(r'/api/auth/me$'), lambda r: fake(r, {'authenticated': True, 'via': 'cookie', 'login': 'synthetic-boss', 'display_name': '合成管理层', 'principal': 'user:synthetic-boss', 'roles': [], 'can': {'create_cockpit': True, 'remember_knowledge': state['can']}}))
    ctx.route(re.compile(r'/api/admin/whoami$'), lambda r: fake(r, {'via': 'odoo', 'login': 'synthetic-boss'} if state['odoo_admin'] else {'via': None, 'login': None}))
    ctx.route(re.compile(r'/api/attention(\?|$)'), lambda r: fake(r, {'items': ITEMS if state['odoo_admin'] else CREATOR, 'counts': {'total': 2}, 'sources': {}}))
    def decision(r):
        decisions.append(json.loads(r.request.post_data or '{}')); fake(r, {'duplicate': False, 'result': {}})
    ctx.route(re.compile(r'/api/work-items/[^/]+/decision$'), decision)
    def defaults(r):
        sid = re.search(r'source_id=([^&]+)', r.request.url).group(1)
        fake(r, DEFAULTS.get(sid, {'default_visibility': 'restricted', 'department_name': None}))
    ctx.route(re.compile(r'/api/knowledge/remember/defaults'), defaults)
    def answer(r):
        b = json.loads(r.request.post_data or '{}'); sent.append(b)
        if state['answer_status'] == 400: return fake(r, {'error': 'remember_invalid', 'message': 'lesson（以后遇到类似情况怎么办）必填，1～500 字'}, 400)
        fake(r, {'source': b['source'], 'source_id': b['source_id'], 'answer': b['answer'], 'duplicate': False, 'result': {}, **({'remember': state['answer_remember']} if 'remember' in b else {})})
    ctx.route(re.compile(r'/api/attention/answer$'), answer)
    ctx.route(re.compile(r'/api/knowledge/remember/recent$'), lambda r: fake(r, RECENT) if state['can'] else fake(r, {'error': 'remember_denied', 'message': 'x'}, 403))
    def remember_later(r):
        b = json.loads(r.request.post_data or '{}'); later.append(b)
        fake(r, {'status': 'written', 'duplicate': False, 'scope_label': '采购部'}, 201)
    ctx.route(re.compile(r'/api/knowledge/remember$'), remember_later)

def press(pg, btn):
    # 有的答法先弹确认框（批准 AI 会话的写工具）：弹了就点确定
    btn.click(); pg.wait_for_timeout(400)
    pop = pg.locator('.ant-popconfirm:not(.ant-popover-hidden) .ant-btn-primary')
    if pop.count(): pop.last.click()
def card(pg, sid): return pg.locator('[data-testid=decision-card]', has_text='合成会话二' if sid == '9102' else '申请工具：list_rows').first

with sync_playwright() as p:
    b = p.chromium.launch()
    print('一、能不能记')
    state['can'] = False
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-card]'); pg.wait_for_timeout(800)
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
    check('勾上展开三项；谁能看三个选项，本部门写部门名；缺省选中服务端推的「本部门（采购部）」，不是全公司', labels == ['本部门（采购部）', '全公司', '只给管理层'] and checked == '本部门（采购部）' and c1.locator('[data-testid=remember-lesson]').count() == 1 and c1.locator('[data-testid=remember-cue]').count() == 1, (labels, checked))
    if SHOT: c1.locator('[data-testid=remember-lesson]').fill('合成：只读工具直接批，写的工具先问清用途'); pg.wait_for_timeout(300); pg.screenshot(path=SHOT.replace('.png', '-答复卡.png')); c1.locator('[data-testid=remember-lesson]').fill('')
    approve = c1.get_by_role('button', name=re.compile('批\\s*准'))
    check('以后怎么办没填：答法按钮置灰，旁边说要先填', approve.is_disabled() and '先填' in c1.locator('[data-testid=decision-remember-block]').inner_text())
    c1.locator('[data-testid=remember-lesson]').fill('合成：只读工具直接批，写的工具先问清用途')
    check('填了以后答法按钮能点', approve.is_enabled())
    press(pg, approve)
    pg.wait_for_function("() => document.querySelector('.ant-message')?.textContent.includes('记成了经验')")
    check('一次办完：答复带着 remember 一起发，没改档就不传 visibility', sent[-1].get('source_id') == '9101' and sent[-1].get('remember') == {'lesson': '合成：只读工具直接批，写的工具先问清用途'}, sent[-1:])
    check('记上了：提示「办好了，也记成了经验（采购部）」', pg.locator('.ant-message', has_text='办好了，也记成了经验（采购部）').count() >= 1)

    c2 = card(pg, '9102')
    c2.locator('[data-testid=decision-remember-toggle]').click(); c2.locator('[data-testid=remember-visibility]').wait_for()
    dept = c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper').first
    checked = c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper-checked').inner_text()
    check('推不出部门：缺省落在「只给管理层」，不是全公司；本部门置灰', checked == '只给管理层' and 'ant-radio-wrapper-disabled' in (dept.get_attribute('class') or ''), checked)
    c2.locator('[data-testid=remember-visibility] .ant-radio-wrapper', has_text='全公司').click()
    c2.locator('[data-testid=remember-lesson]').fill('合成：写的工具一律先问用途'); c2.locator('[data-testid=remember-cue]').fill('合成会话要写表')
    state['answer_remember'] = {'status': 'refused', 'error': 'remember_denied', 'message': '你没有对经验库拍板的授予'}
    press(pg, c2.get_by_role('button', name=re.compile('批\\s*准')))
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].some(e => e.textContent.includes('经验没记上'))")
    check('人改成「全公司」才传 visibility；情况填了就带 cue', sent[-1].get('remember') == {'lesson': '合成：写的工具一律先问用途', 'cue': '合成会话要写表', 'visibility': 'company'}, sent[-1:])
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

    print('二之二、建立人自己的验收（不是管理员）')
    state['odoo_admin'] = False
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=decision-card]'); pg.wait_for_timeout(800)
    acc = pg.locator('[data-testid=decision-card]', has_text='比价表做完了').first
    rel = pg.locator('[data-testid=decision-card]', has_text='等放行').first
    check('自带答复入口的放行（answer_via）：不进答复账、记不上，不给勾选；建立人的验收有勾选', rel.locator('[data-testid=decision-remember]').count() == 0 and acc.locator('[data-testid=decision-remember-toggle]').count() == 1)
    acc.locator('[data-testid=decision-remember-toggle]').click(); acc.locator('[data-testid=remember-visibility]').wait_for()
    acc.locator('[data-testid=remember-lesson]').fill('合成：比价表看交期，不只看价')
    n = len(later)
    press(pg, acc.get_by_role('button', name=re.compile('验收')).first)
    pg.wait_for_function("() => [...document.querySelectorAll('.ant-message')].some(e => e.textContent.includes('记成了经验'))")
    check('验收走建立人的入口，答完紧接着补记：先发 decision，再 POST /api/knowledge/remember 带这一条', decisions[-1:] and decisions[-1].get('answer') == 'verify' and later[n:] == [{'source': 'work-items', 'source_id': 'wi-syn-acc', 'lesson': '合成：比价表看交期，不只看价'}], (decisions[-1:], later[n:]))
    check('提示「办好了，也记成了经验（采购部）」', pg.locator('.ant-message', has_text='办好了，也记成了经验（采购部）').count() >= 1)
    ctx.close()
    state['odoo_admin'] = True

    print('四、我处理过的')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000); pg.goto(M + '/attention'); pg.wait_for_selector('[data-testid=recent-row]')
    rows = pg.locator('[data-testid=recent-row]')
    titles = pg.locator('[data-testid=recent-title]').all_inner_texts()
    check('一行一条：有标题写标题，没标题写来源名（AI 会话申请工具）；答的是什么写出来', titles == ['合成：比价表', 'AI 会话申请工具'] and '放行' in rows.nth(0).inner_text() and '批准' in rows.nth(1).inner_text(), titles)
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
    check('交了：POST /api/knowledge/remember 带对的条目，没改档不传 visibility；这一行变成「已记成经验」', later[-1:] == [{'source': 'work-items', 'source_id': 'wi-syn-1', 'lesson': '合成：比价表先看交期再看价'}] and rows.nth(0).locator('[data-testid=recent-remembered]').inner_text() == '已记成经验', later)
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
    check('驾驶舱右栏：三项竖着排（「谁能看」在以后怎么办的下面）；不滚动，答法按钮就在右栏可见的那一块里、在一屏里', box is not None and box['y'] >= view[0] and box['y'] + box['height'] <= min(view[1], 900) and pane.locator('[data-testid=remember-visibility]').bounding_box()['y'] > field['y'], (box, view, field))
    ctx.close()
    b.close()

print(f'remember-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
