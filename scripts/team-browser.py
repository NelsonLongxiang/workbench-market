"""「团队」页（规范 14；骨架照原型 3fbfd0b 的 #/team）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
团队的读接口（GET /api/teams）用合成的应答（经 page.route 截下：名册要节点报上来，实例里造不出）；部门、人用实例真的，建部门真的写进实例。
认领、指定负责人两个写请求也截下，核对发了什么。
  · 没登录：说请先登录，不弹口令框；
  · 管理员、还没有部门：说「还没有部门，先建部门」，给建部门的入口；建部门的校验（标识写错不能建），建好之后部门真的有了；
  · 待认领的团队：只有管理员的视图里有；挂到部门，发对了请求；
  · 关系确认制（#638）：口令管理员（系统管理员，不是管理层）认领只记成提议（202）——页面说「已提出，等〈谁〉确认」、那张卡标「待确认」，
    不出现部门分块（关系没生效）；管理层确认之后（截下的应答换成认领了的）才按部门分块；
  · 认领按钮照 can：系统管理员只能提议，按钮写「提议认领」；选了负责人又只是提议时，提示补一句负责人等认领确认后再指定；
  · 待确认的关系（GET /api/relations/proposals，截下来换成合成的）：等你确认、你提的、别的三组，按钮照 can_approve / can_reject，
    自己提的写「撤回」、不出确认；确认、撤回发对了请求，办完卡片没了，并广播「等你拍板」刷新；
  · 认领之后：按部门分块，团队头卡写状态、负责人（部门负责人标出来）、总工、成员数和在办；成员卡写在办几件、分配给谁或团队公用；
  · 不是管理员的视图（应答里没有待认领这一栏）：没有建部门、没有待认领；也没有分配、收回（接口还没给能不能做）。"""
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
def pick(pg, testid, text):
    pg.locator(f'[data-testid={testid}]').first.click()
    pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', has_text=text).first.click()

def seat(seat, name='', role='worker', online=True, active=0, to=None):
    return {'seat': seat, 'seat_id': '', 'name': name, 'role': role, 'online': online, 'router': role == 'router', 'assigned_to': to, 'active_items': active}
HOST = 'a1b2c3d4'
ROUTER = seat('ops/a1b2c3d4', '合成总工', role='router', active=2)
UNCLAIMED = {'host': HOST, 'team': 'ops/canvas/合成运营', 'name': '合成运营', 'status': 'unclaimed', 'in_roster': True, 'department': None, 'leads': [], 'router': ROUTER,
             'members': [seat('ops/00000001', '小算', active=3), seat('ops/00000002', '小审')]}
def claimed(dept_name):
    return {**UNCLAIMED, 'status': 'active', 'node_name': '合成节点', 'roster_received_at': '2020-01-01 00:00:00', 'department': {'id': 'synthetic-ops', 'name': dept_name},
            'leads': [{'principal': 'user:jia', 'display_name': '甲经理', 'source': 'department'}, {'principal': 'user:yi', 'display_name': '乙主管', 'source': 'explicit'}],
            'members': [seat('ops/00000001', '小算', active=3, to={'principal': 'user:bing', 'display_name': '丙'}), seat('ops/00000002', '小审', online=False)]}
# 口令管理员是系统管理员、不是管理层：认领、指定负责人只能提议（服务端的 can）
CAN_ADMIN = {'claim': False, 'propose_claim': True, 'release': True, 'add_lead': False, 'propose_lead': True, 'manage_leads': True, 'manage_departments': True}
CONFIRM_BY = '管理层或接收部门的负责人'
state = {'teams': {'can': CAN_ADMIN, 'departments': [], 'unclaimed': [UNCLAIMED]}}
posted = []
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
def on_teams(r): fake(r, state['teams'])
def on_write(r):
    posted.append((r.request.url.split('/api/teams/')[1], json.loads(r.request.post_data or '{}'))); fake(r, {'ok': True, 'changed': True})

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.goto(M + '/team'); pg.wait_for_selector('.wm-team-intro')
    pg.wait_for_selector('.ant-alert', timeout=10000)
    check('没登录：说请先登录；不弹口令框；没有建部门', pg.locator('.ant-alert', has_text='请先登录').count() == 1 and pg.locator('.ant-modal').count() == 0 and pg.locator('[data-testid=team-newdept-open]').count() == 0)
    check('顶栏标题是导航名「团队」', pg.locator('.wm-top-title').inner_text().strip() == '团队')

    pg.route('**/api/teams', on_teams)
    pg.route('**/api/teams/claim', on_write)
    pg.route('**/api/teams/leads', on_write)
    # 人（只有管理员读得到）：截下来换成一个合成的启用的人，指定负责人时有得选
    pg.route('**/api/principals', lambda r: fake(r, {'principals': [{'id': 'user:yi', 'kind': 'person', 'status': 'active', 'display_name': '乙主管'}]}))
    props = {'list': []}
    pg.route('**/api/relations/proposals', lambda r: fake(r, {'proposals': props['list']}))
    def on_prop(r):
        tail = r.request.url.split('/api/relations/proposals/')[1]
        pid, verb = int(tail.split('/')[0]), tail.split('/')[1]
        posted.append((verb, pid, json.loads(r.request.post_data or '{}')))
        props['list'] = [p for p in props['list'] if p['id'] != pid]
        fake(r, {'proposal': {'id': pid, 'status': 'approved' if verb == 'approve' else 'rejected'}})
    pg.route('**/api/relations/proposals/*/*', on_prop)
    pg.goto(M + '/team'); pg.wait_for_selector('.wm-team-intro')
    set_token(pg)
    pg.wait_for_selector('[data-testid=team-empty]')
    check('管理员、还没有部门：说先建部门，给建部门的入口', '还没有部门' in pg.locator('[data-testid=team-empty]').inner_text() and pg.locator('[data-testid=team-newdept-cta]').count() == 1)
    un = pg.locator('[data-testid=team-unclaimed]')
    check('待认领的团队：管理员看得到；没有部门时说先建部门、没有认领按钮', un.count() == 1 and '先建部门' in un.inner_text() and pg.locator('[data-testid=team-claim]').count() == 0, un.all_inner_texts())
    check('待认领卡：节点没有名字就不写「来自」这一项，节点标识、团队和席位句柄都不出现', '来自' not in un.inner_text() and not any(x in pg.locator('body').inner_text() for x in [HOST, 'ops/', '/canvas/']), un.inner_text())

    # 建部门：标识写错不能建；写对了真的建进实例
    pg.locator('[data-testid=team-newdept-cta]').click(); pg.wait_for_selector('[data-testid=team-newdept]')
    pg.locator('[data-testid=team-newdept-name]').fill('合成运营部'); pg.locator('[data-testid=team-newdept-id]').fill('Ops')
    save = pg.locator('[data-testid=team-newdept-save]')
    check('建部门：标识写错（大写）不能建，说出原因', save.is_disabled() and '小写字母开头' in pg.locator('.wm-team-newdept').inner_text())
    pg.locator('[data-testid=team-newdept-id]').fill('synthetic-ops')
    check('建部门：写对了能建', save.is_enabled())
    save.click(); pg.wait_for_selector('[data-testid=team-newdept]', state='detached')
    with urllib.request.urlopen(urllib.request.Request(M + '/api/departments', headers={'x-admin-token': TOK})) as r: real = json.load(r)
    check('建部门：实例里真的有了这个部门', [d['id'] for d in real['departments']] == ['synthetic-ops'], real)
    pg.wait_for_selector('[data-testid=team-claim]')
    check('建好部门：空的说法没了，待认领的团队可以挂到部门', pg.locator('[data-testid=team-empty]').count() == 0 and pg.locator('[data-testid=team-claim]').is_disabled())

    # 认领：挂到部门、顺带指定负责人
    pick(pg, 'team-claim-dept', '合成运营部')
    check('选了部门才能认领', pg.locator('[data-testid=team-claim]').is_enabled())
    check('系统管理员只能提议：按钮写「提议认领」，不写「认领」', pg.locator('[data-testid=team-claim]').inner_text().replace(' ', '') == '提议认领', pg.locator('[data-testid=team-claim]').inner_text())
    pick(pg, 'team-claim-lead', '乙主管')
    def on_claim(r):
        posted.append(('claim', json.loads(r.request.post_data or '{}')))
        pend = {'id': 1, 'principal': None, 'department': 'synthetic-ops', 'confirm_by_text': CONFIRM_BY}
        state['teams'] = {'can': CAN_ADMIN, 'departments': [], 'unclaimed': [{**UNCLAIMED, 'pending_claim': pend}]}
        fake(r, {'ok': True, 'proposed': True, 'proposal': {'id': 1, 'status': 'pending', 'confirm_by_text': CONFIRM_BY}}, 202)
    pg.unroute('**/api/teams/claim', on_write); pg.route('**/api/teams/claim', on_claim)
    pg.locator('[data-testid=team-claim]').click(); pg.wait_for_selector('[data-testid=team-notice]')
    check('认领发对了请求：团队的节点和名字、部门', posted and posted[0] == ('claim', {'host': HOST, 'team': 'ops/canvas/合成运营', 'department': 'synthetic-ops'}), posted)
    notice = pg.locator('[data-testid=team-notice]').inner_text()
    pg.wait_for_selector('[data-testid=team-claim-pending]')
    check('系统管理员认领只是提议：说「已提出，等管理层或接收部门的负责人确认」，不说认领成功', f'已提出，等{CONFIRM_BY}确认' in notice and '成功' not in notice, notice)
    check('提议期间：卡上标「待确认」、写挂到哪个部门等谁确认，没有认领按钮；没有部门分块（关系没生效）',
          pg.locator('[data-testid=team-claim-state]').inner_text().strip() == '待确认' and '合成运营部' in pg.locator('[data-testid=team-claim-pending]').inner_text()
          and pg.locator('[data-testid=team-claim]').count() == 0 and pg.locator('[data-testid=team-dept]').count() == 0, pg.locator('[data-testid=team-unclaimed]').inner_text())
    check('认领只是提议时不接着指定负责人（团队还没挂上）', all(x[0] == 'claim' for x in posted), posted)
    check('选了的负责人被跳过时，提示补一句「负责人等认领确认后再指定」', '负责人等认领确认后再指定' in notice, notice)

    # 管理层确认之后：关系生效，按部门分块（截下的应答换成认领了的）
    state['teams'] = {'can': CAN_ADMIN, 'departments': [{'id': 'synthetic-ops', 'name': '合成运营部', 'lead': {'principal': 'user:jia', 'display_name': '甲经理'}, 'teams': [claimed('合成运营部')]}], 'unclaimed': []}
    pg.reload(); pg.wait_for_selector('[data-testid=team-dept]')

    # 认领之后的样子
    dept = pg.locator('[data-testid=team-dept]')
    head = pg.locator('[data-testid=team-team] .wm-team-head').inner_text()
    check('按部门分块：部门名、部门负责人、几个团队', dept.count() == 1 and '合成运营部' in dept.inner_text() and '负责人 甲经理' in dept.inner_text() and '1 个团队' in dept.inner_text())
    check('团队头卡：团队名、状态、负责人（部门负责人标出来）、总工、成员数和在办（含总工）', all(s in head for s in ['合成运营', '正常', '甲经理（部门负责人）、乙主管', '总工：合成总工', '2 个成员 · 在办 5 件']), head)
    mems = pg.locator('[data-testid=team-member]')
    m1, m2 = mems.nth(0).inner_text(), mems.nth(1).inner_text()
    check('成员卡：名字（不带句柄）、在办几件、分配给谁 / 团队公用', mems.count() == 2 and m1.split('\n')[0].strip() == '小算' and '在办 3 件' in m1 and '分配给 丙' in m1 and '团队公用' in m2 and '手上没有在办的' in m2, [m1, m2])
    check('总工单独一张卡，写「只对负责人」', '只对负责人' in pg.locator('[data-testid=team-router]').inner_text())
    check('名册很久没更新：头卡上用提醒色写一句（合成的收到时刻在很久以前）', '名册已' in pg.locator('[data-testid=team-roster-stale]').inner_text() and '没更新' in pg.locator('[data-testid=team-roster-stale]').inner_text())
    check('在线、不在线用点区分', mems.nth(0).locator('.wm-team-dot.on').count() == 1 and mems.nth(1).locator('.wm-team-dot.on').count() == 0)
    check('待认领清空了就不显示这一块', pg.locator('.wm-team-unclaimed').count() == 0)
    check('整页不露代号：节点标识、团队和席位句柄都不出现', not any(x in pg.locator('body').inner_text() for x in [HOST, 'ops/', '/canvas/']), pg.locator('body').inner_text()[:300])
    check('没有放分配、收回（接口还没给能不能做）；没有工作方式、通过率、招 AI 员工', all(pg.locator('body').inner_text().count(s) == 0 for s in ['收回', '分配给…', '工作方式', '通过率', '招一个']))

    # 不是管理员的视图：应答里没有待认领这一栏
    # 待确认的关系：三组、按钮照服务端的字段；办完卡片没了、广播「等你拍板」刷新
    def P(i, kind, **more):
        base = {'id': i, 'kind': kind, 'status': 'pending', 'department_id': 'synthetic-ops', 'host': HOST, 'team': 'ops/canvas/合成运营', 'principal_id': 'user:yi',
                'proposed_by': 'admin-token', 'proposed_by_principal': None, 'proposed_at': 1_800_000_000_000, 'confirm_by_text': CONFIRM_BY,
                'can_approve': False, 'approve_denied': None, 'approve_denied_text': None, 'can_reject': False}
        base.update(more); return base
    props['list'] = [
        P(11, 'team-claim', can_approve=True, can_reject=True, proposed_by_name='丙'),
        P(12, 'team-lead', mine=True, can_reject=True, confirm_by_text='属主', approve_denied='proposer_cannot_confirm', approve_denied_text='提议的人不能自己确认，要另一位确认'),
        P(13, 'dept-lead', confirm_by_text='属主', approve_denied='owner_required', approve_denied_text='只有属主能放行', can_reject=True),
    ]
    pg.reload(); set_token(pg); pg.wait_for_selector('[data-testid=team-proposals-for-me]')
    pg.evaluate("window.__att = 0; window.addEventListener('wm-attention-changed', () => { window.__att++; })")
    fm, mi, ot = pg.locator('[data-testid=team-proposals-for-me]'), pg.locator('[data-testid=team-proposals-mine]'), pg.locator('[data-testid=team-proposals-others]')
    check('三组：等你确认 1、你提的 1、还在等别人确认 1', fm.locator('[data-testid=team-proposal]').count() == 1 and mi.locator('[data-testid=team-proposal]').count() == 1 and ot.locator('[data-testid=team-proposal]').count() == 1)
    t_fm = fm.inner_text()
    check('等你确认：写清楚是什么（团队挂到哪个部门）、谁提的、等谁确认；有「确认」「驳回」', '把「合成运营」挂到「合成运营部」' in t_fm and '丙 提的' in t_fm and f'等{CONFIRM_BY}确认' in t_fm
          and fm.locator('[data-testid=team-proposal-approve]').count() == 1 and fm.locator('[data-testid=team-proposal-reject]').inner_text().replace(' ', '') == '驳回', t_fm)
    check('你提的：写「你提的」，按钮是「撤回」，没有「确认」（自己不能确认自己的）', '你提的' in mi.inner_text() and mi.locator('[data-testid=team-proposal-approve]').count() == 0
          and mi.locator('[data-testid=team-proposal-reject]').inner_text().replace(' ', '') == '撤回' and '让 乙主管 做「合成运营」的负责人' in mi.inner_text(), mi.inner_text())
    check('别的：写服务端给的不能确认的说法，没有「确认」；管理员能驳回', '只有属主能放行' in ot.inner_text() and ot.locator('[data-testid=team-proposal-approve]').count() == 0
          and ot.locator('[data-testid=team-proposal-reject]').count() == 1 and '管理员 提的' in ot.inner_text(), ot.inner_text())
    check('两字按钮不自动插空格：「确认」「驳回」「撤回」', fm.locator('[data-testid=team-proposal-approve]').inner_text() == '确认' and fm.locator('[data-testid=team-proposal-reject]').inner_text() == '驳回' and mi.locator('[data-testid=team-proposal-reject]').inner_text() == '撤回',
          [fm.locator('[data-testid=team-proposal-approve]').inner_text(), mi.locator('[data-testid=team-proposal-reject]').inner_text()])
    check('提议卡上不露标识（团队句柄、节点标识、主体标识）', not any(x in pg.locator('.wm-team-props').first.inner_text() for x in [HOST, 'ops/', 'user:', 'admin-token']))
    n0 = len(posted)
    fm.locator('[data-testid=team-proposal-approve]').click(); pg.wait_for_function("document.querySelectorAll('[data-testid=team-proposals-for-me]').length === 0")
    check('确认发对了请求（这一条的 id），办完「等你确认」那一组没了，并广播「等你拍板」刷新', posted[n0][0] == 'approve' and posted[n0][1] == 11 and pg.evaluate('window.__att') >= 1, (posted[n0:], pg.evaluate('window.__att')))
    mi.locator('[data-testid=team-proposal-reject]').click()
    pg.locator('[data-testid=team-proposal-reason]').fill('  想错了  ')
    pg.locator('[data-testid=team-proposal-reject-confirm]').click(); pg.wait_for_function("document.querySelectorAll('[data-testid=team-proposals-mine]').length === 0")
    last = posted[-1]
    check('撤回发的是驳回这一条，带着去掉空白的理由；办完「你提的」那一组没了', last[0] == 'reject' and last[1] == 12 and last[2].get('reason') == '想错了', last)
    props['list'] = []

    state['teams'] = {'departments': state['teams']['departments']}
    pg.reload(); pg.wait_for_selector('[data-testid=team-dept]')
    check('不是管理员的视图：没有建部门、没有待认领', pg.locator('[data-testid=team-newdept-open]').count() == 0 and pg.locator('.wm-team-unclaimed').count() == 0)
    b.close()

print(f'team-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
