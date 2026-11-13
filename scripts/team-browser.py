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
  · 成员分配（规范 14 第二节）：团队上 can_assign 为真时（负责人、管理层），团队公用的成员出「分配给…」，已分配的出「改派」「收回」；
    总工没有；选人只从 assignable 里选，改派时不列现在的人；分配、改派（一步：POST /api/teams/reassign，不再先收回）、收回发对了请求，卡片原地更新、不闪骨架；
    被拒时写服务端的说法、卡片不变（改派被拒也不变：不会停在团队公用）；回 202 时照提议说；
    选人和收回的确认在弹窗里，收回照实写后果；办成了是轻提示（antd message），202 是提示色；
    can_assign 不是真（系统管理员、普通员工）：一个按钮都没有；系统管理员的头卡上写一句分配归谁；
    名册停不停推只照服务端的 roster_stale，停了多久照 roster_stale_for_minutes：停推的标「名册过期」（不同时写「正常」），待认领的卡上也写；
    收到时刻再旧、服务端说没停推就标「正常」；
    部门负责人待属主放行（grant=missing）、团队的 lead_pending_grant：写「（待属主放行权限）」，不当成负责人；
    看的人由截下的 /api/auth/me 给，左下角不是「未登录」。
    环境变量 TEAM_SHOTS 指一个目录时，存 1440 截图（分配前、选人弹窗、分配后、收回确认、普通员工只读）；
  · 不是管理员的视图（应答里没有待认领这一栏）：没有建部门、没有待认领。"""
import json, os, sys, urllib.request
from datetime import datetime, timedelta, timezone
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
# 名册收到的时刻：库里的写法（UTC、不带时区、中间空格）。默认是三分钟前（新的）；过期的另造三小时前的
def sql_time(ago): return (datetime.now(timezone.utc) - ago).strftime('%Y-%m-%d %H:%M:%S')
def claimed(dept_name):
    return {**UNCLAIMED, 'status': 'active', 'node_name': '合成节点', 'roster_received_at': sql_time(timedelta(minutes=3)), 'department': {'id': 'synthetic-ops', 'name': dept_name},
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

    check('待认领卡：名册没停推不写', un.locator('[data-testid=team-roster-stale]').count() == 0)
    # 待认领的团队也带名册停推（服务端给的）：卡上照写
    state['teams']['unclaimed'] = [{**UNCLAIMED, 'roster_stale': True, 'roster_stale_for_minutes': 3000}]
    pg.reload(); pg.wait_for_selector('[data-testid=team-unclaimed] [data-testid=team-roster-stale]')
    check('待认领卡：名册停推（服务端说停了 3000 分钟）写「名册已 2 天没更新」', un.locator('[data-testid=team-roster-stale]').inner_text() == '名册已 2 天没更新', un.inner_text())
    state['teams']['unclaimed'] = [UNCLAIMED]
    pg.reload(); pg.wait_for_selector('[data-testid=team-empty]')

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
    nbg = pg.locator('[data-testid=team-notice]').evaluate('e => getComputedStyle(e).backgroundColor')
    check('「已提出，等谁确认」的提示是浅底（和身份服务那条一样轻），带关闭，不是深灰的整条', nbg == 'rgb(238, 242, 247)' and pg.locator('[data-testid=team-notice] .ant-alert-close-icon').count() == 1, nbg)
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
    check('名册是新的（三分钟前）：标「正常」，不写没更新', pg.locator('[data-testid=team-roster-stale]').count() == 0 and pg.locator('.wm-team-st', has_text='正常').count() == 1)
    check('系统管理员的视图（团队上 can_assign 为假）：头卡上写「成员分配由团队负责人或管理层做」', pg.locator('[data-testid=team-assign-by]').inner_text() == '成员分配由团队负责人或管理层做')
    check('在线、不在线用点区分', mems.nth(0).locator('.wm-team-dot.on').count() == 1 and mems.nth(1).locator('.wm-team-dot.on').count() == 0)
    check('待认领清空了就不显示这一块', pg.locator('.wm-team-unclaimed').count() == 0)
    check('整页不露代号：节点标识、团队和席位句柄都不出现', not any(x in pg.locator('body').inner_text() for x in [HOST, 'ops/', '/canvas/']), pg.locator('body').inner_text()[:300])
    check('系统管理员的视图里团队没给 can_assign（不代办）：没有分配、改派、收回；也没有工作方式、通过率、招 AI 员工', all(pg.locator('body').inner_text().count(s) == 0 for s in ['收回', '改派', '分配给…', '工作方式', '通过率', '招一个']))

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
        # 自己提的、已经失效的（#645 的 outcome）：标「失效」、写原因、没有按钮
        P(14, 'team-claim', status='rejected', outcome='expired', outcome_reason='超过 14 天没人处理', mine=True, decided_by_name='系统', team_name='合成巡检', department_name='合成运营部'),
    ]
    pg.reload(); set_token(pg); pg.wait_for_selector('[data-testid=team-proposals-for-me]')
    pg.evaluate("window.__att = 0; window.addEventListener('wm-attention-changed', () => { window.__att++; })")
    fm, mi, ot = pg.locator('[data-testid=team-proposals-for-me]'), pg.locator('[data-testid=team-proposals-mine]'), pg.locator('[data-testid=team-proposals-others]')
    check('三组：等你确认 1、你提的 2（一条待确认、一条失效）、还在等别人确认 1', fm.locator('[data-testid=team-proposal]').count() == 1 and mi.locator('[data-testid=team-proposal]').count() == 2 and ot.locator('[data-testid=team-proposal]').count() == 1)
    ex = mi.locator('[data-testid=team-proposal]').nth(1)
    check('你提的里失效的那条：标「失效」（不叫驳回）、写原因、不写等谁确认、没有按钮', ex.locator('[data-testid=team-proposal-outcome]').inner_text().strip() == '失效' and '原因：超过 14 天没人处理' in ex.inner_text()
          and '等' not in ex.locator('.wm-team-head-meta').inner_text().replace('等你', '') and ex.locator('button').count() == 0 and '驳回' not in ex.inner_text(), ex.inner_text())
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
    mi.locator('[data-testid=team-proposal-reject]').first.click()
    pg.locator('[data-testid=team-proposal-reason]').fill('  想错了  ')
    pg.locator('[data-testid=team-proposal-reject-confirm]').click(); pg.wait_for_function("document.querySelectorAll('[data-testid=team-proposals-mine] [data-testid=team-proposal]').length === 1")
    last = posted[-1]
    check('撤回发的是驳回这一条，带着去掉空白的理由；办完待确认的那条没了，失效的那条还在', last[0] == 'reject' and last[1] == 12 and last[2].get('reason') == '想错了' and pg.locator('[data-testid=team-proposals-mine] [data-testid=team-proposal]').count() == 1, last)
    props['list'] = []

    # ---------- 成员分配：负责人的视图（团队上 can_assign 为真，带 assignable） ----------
    SHOTS = os.environ.get('TEAM_SHOTS')
    def shot(name):
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, name), full_page=False)
    PEOPLE = [{'principal': 'user:bing', 'display_name': '丙'}, {'principal': 'user:ding', 'display_name': '丁'}, {'principal': 'user:wu', 'display_name': '戊'}]
    lead_team = {**claimed('合成运营部'), 'can_assign': True, 'assign_denied_text': None, 'assignable': PEOPLE,
                 'members': [seat('ops/00000001', '小算', active=3, to={'principal': 'user:bing', 'display_name': '丙'}), seat('ops/00000002', '小审', online=False)]}
    state['teams'] = {'departments': [{'id': 'synthetic-ops', 'name': '合成运营部', 'lead': {'principal': 'user:jia', 'display_name': '甲经理'}, 'teams': [lead_team]}]}
    assign = {'next': None}  # 下一次分配要回什么：None 照常 201；或者 (status, body)
    def member_of(seat_):
        return next(m for m in lead_team['members'] if m['seat'] == seat_)
    def on_assign(r):
        b_ = json.loads(r.request.post_data or '{}'); posted.append(('assign', b_))
        if assign['next']: st, body_ = assign['next']; assign['next'] = None; return fake(r, body_, st)
        who = next(x for x in PEOPLE if x['principal'] == b_['principal'])
        member_of(b_['seat'])['assigned_to'] = who; fake(r, {'ok': True, 'id': len(posted)}, 201)
    def on_unassign(r):
        b_ = json.loads(r.request.post_data or '{}'); posted.append(('unassign', b_))
        m_ = member_of(b_['seat']); had = m_['assigned_to'] is not None; m_['assigned_to'] = None
        fake(r, {'ok': True, 'removed': had})
    reassign = {'next': None}  # 下一次改派要回什么：None 照常 200；或者 (status, body)
    def on_reassign(r):
        b_ = json.loads(r.request.post_data or '{}'); posted.append(('reassign', b_))
        if reassign['next']: st, body_ = reassign['next']; reassign['next'] = None; return fake(r, body_, st)
        m_ = member_of(b_['seat']); was = m_['assigned_to']
        m_['assigned_to'] = next(x for x in PEOPLE if x['principal'] == b_['principal'])
        fake(r, {'ok': True, 'changed': True, 'id': len(posted), 'from': was['principal'] if was else None})
    pg.route('**/api/teams/assign', on_assign)
    pg.route('**/api/teams/unassign', on_unassign)
    pg.route('**/api/teams/reassign', on_reassign)
    # 看的人：负责人甲经理（/api/auth/me 截下来，左下角写他，不是「未登录」）
    def me(login, name): return {'gate': 'off', 'authenticated': True, 'via': 'odoo', 'login': login, 'principal': f'user:{login}', 'display_name': name, 'roles': []}
    who = {'me': me('jia', '甲经理')}
    pg.route('**/api/auth/me', lambda r: fake(r, who['me']))
    pg.reload(); pg.wait_for_selector('[data-testid=team-member]')
    card = lambda name: pg.locator('[data-testid=team-member]', has_text=name)
    modal = lambda: pg.locator('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')
    def toast(text):
        pg.wait_for_function("(t) => [...document.querySelectorAll('.ant-message-notice')].some(e => e.innerText.includes(t))", arg=text)
        return pg.locator('.ant-message-notice', has_text=text).first
    def pick_in_modal(text):
        modal().locator('[data-testid=team-assign-to]').click()
        pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', has_text=text).first.click()
    def modal_gone(): pg.wait_for_function("document.querySelectorAll('.ant-modal-wrap:not([style*=\"display: none\"]) .ant-modal').length === 0")
    # 用户卡写显示名（#655 起不写登录名）：截下的 /api/auth/me 里登录名 jia、显示名甲经理
    check('左下角是看的人（截下的 /api/auth/me），写显示名「甲经理」，不是「未登录」', pg.get_by_text('未登录', exact=True).count() == 0 and pg.locator('[data-testid=wm-me-name]').inner_text().strip() == '甲经理', pg.locator('[data-testid=wm-me-name]').inner_text())
    shot('team-lead-before-assign-1440.png')
    check('负责人：团队公用的成员出「分配给…」，已分配的出「改派」「收回」（收回是危险色）；总工卡上没有；负责人视图不写「分配由谁做」',
          card('小审').locator('[data-testid=team-assign-open]').count() == 1 and card('小审').locator('[data-testid=team-reassign-open]').count() == 0
          and card('小算').locator('[data-testid=team-reassign-open]').count() == 1 and card('小算').locator('[data-testid=team-unassign-open].ant-btn-dangerous').count() == 1 and card('小算').locator('[data-testid=team-assign-open]').count() == 0
          and pg.locator('[data-testid=team-router] button').count() == 0 and pg.locator('[data-testid=team-assign-by]').count() == 0)
    check('两字按钮不自动插空格：「改派」「收回」', card('小算').locator('[data-testid=team-reassign-open]').inner_text() == '改派' and card('小算').locator('[data-testid=team-unassign-open]').inner_text() == '收回')

    # 分配：弹窗里选人，只从 assignable 里选
    n0 = len(posted)
    card('小审').locator('[data-testid=team-assign-open]').click(); modal().wait_for()
    check('分配：弹窗标题写把谁分给谁；没选人之前不能点', '把「小审」分配给谁' in modal().inner_text() and modal().locator('[data-testid=team-assign-confirm]').is_disabled())
    modal().locator('[data-testid=team-assign-to]').click()
    opts = pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').all_inner_texts()
    check('分配：可选的人就是服务端给的 assignable（只写名字，不露标识）', sorted(opts) == sorted(['丙', '丁', '戊']), opts)
    pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', has_text='丁').first.click()
    pg.wait_for_timeout(400); shot('team-lead-assign-modal-1440.png')
    modal().locator('[data-testid=team-assign-confirm]').click(); modal_gone()
    pg.wait_for_function("[...document.querySelectorAll('[data-testid=team-member]')].some(e => e.innerText.includes('小审') && e.innerText.includes('分配给 丁'))")
    check('分配：发的是这个席位、分给丁；办完卡片当场写「分配给 丁」，按钮换成改派、收回', posted[n0:] == [('assign', {'host': HOST, 'team': 'ops/canvas/合成运营', 'seat': 'ops/00000002', 'seat_id': '', 'principal': 'user:ding'})]
          and card('小审').locator('[data-testid=team-reassign-open]').count() == 1, posted[n0:])
    t_ok = toast('「小审」已分配给 丁')
    check('分配：成功是轻提示（几秒自动消失的成功消息），不是页面上方的横幅', t_ok.locator('.ant-message-success').count() == 1 and pg.locator('[data-testid=team-notice]').count() == 0)
    check('分配：重读不闪骨架（部门分块一直在）', pg.locator('.ant-skeleton').count() == 0 and pg.locator('[data-testid=team-dept]').count() == 1)

    # 改派：弹窗里写现在归谁，不列现在的人；一步办完（一个请求）
    n0 = len(posted)
    card('小算').locator('[data-testid=team-reassign-open]').click(); modal().wait_for()
    hint = modal().locator('[data-testid=team-reassign-hint]').inner_text()
    check('改派：弹窗写现在分给丙、改派一步办完、分给丙期间接手的事丙照样看得到；不再说先收回', '现在分给 丙' in hint and '一步办完' in hint and '丙 照样看得到' in hint and '先收回' not in modal().inner_text(), modal().inner_text())
    modal().locator('[data-testid=team-assign-to]').click()
    opts = pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').all_inner_texts()
    check('改派：不列现在归的那个人', sorted(opts) == sorted(['丁', '戊']), opts)
    pg.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', has_text='戊').first.click()
    modal().locator('[data-testid=team-assign-confirm]').click(); modal_gone()
    pg.wait_for_function("[...document.querySelectorAll('[data-testid=team-member]')].some(e => e.innerText.includes('小算') && e.innerText.includes('分配给 戊'))")
    check('改派：只发一个改派请求（这个席位、分给戊），不发收回、分配；卡片当场写「分配给 戊」', posted[n0:] == [('reassign', {'host': HOST, 'team': 'ops/canvas/合成运营', 'seat': 'ops/00000001', 'seat_id': '', 'principal': 'user:wu'})], posted[n0:])
    toast('「小算」已改派给 戊')
    pg.wait_for_timeout(300); shot('team-lead-after-assign-1440.png')

    # 收回：二次确认，照实写后果
    n0 = len(posted)
    card('小审').locator('[data-testid=team-unassign-open]').click(); modal().wait_for()
    body_ = modal().inner_text()
    check('收回：先弹确认，照实写变成团队公用、分给丁期间接手的事丁照样看得到、之后的不算丁的；还没发请求',
          '收回「小审」？' in body_ and '变成团队公用' in body_ and '丁 照样看得到' in body_ and '不再算 丁 的' in body_ and posted[n0:] == [], body_)
    pg.wait_for_timeout(400); shot('team-lead-unassign-confirm-1440.png')
    modal().locator('button', has_text='算了').click(); modal_gone()
    check('收回：点「算了」什么都不发，归属不变', posted[n0:] == [] and '分配给 丁' in card('小审').inner_text())
    card('小审').locator('[data-testid=team-unassign-open]').click(); modal().wait_for()
    modal().locator('[data-testid=team-unassign-confirm]').click(); modal_gone()
    pg.wait_for_function("[...document.querySelectorAll('[data-testid=team-member]')].some(e => e.innerText.includes('小审') && e.innerText.includes('团队公用'))")
    check('收回：确认之后发的是这个席位；卡片当场写「团队公用」，按钮回到「分配给…」', posted[n0:] == [('unassign', {'host': HOST, 'team': 'ops/canvas/合成运营', 'seat': 'ops/00000002', 'seat_id': ''})]
          and card('小审').locator('[data-testid=team-assign-open]').count() == 1, posted[n0:])

    # 被拒：弹窗里写服务端的说法，卡片不变
    assign['next'] = (409, {'error': 'seat_assigned', 'message': '这个成员已经分给 丙，先收回再分'})
    card('小审').locator('[data-testid=team-assign-open]').click(); modal().wait_for(); pick_in_modal('丙')
    modal().locator('[data-testid=team-assign-confirm]').click(); modal().locator('[data-testid=team-assign-err]').wait_for()
    check('分配被拒：弹窗里写服务端的说法，归属不变', '先收回再分' in modal().locator('[data-testid=team-assign-err]').inner_text() and '团队公用' in card('小审').locator('[data-testid=team-assigned]').inner_text())
    modal().locator('button', has_text='算了').click(); modal_gone()

    # 回 202（分配只是提议）：照提议说，不当成已生效
    assign['next'] = (202, {'ok': True, 'proposed': True, 'proposal': {'id': 77, 'status': 'pending', 'confirm_by_text': '管理层'}})
    card('小审').locator('[data-testid=team-assign-open]').click(); modal().wait_for(); pick_in_modal('丙')
    modal().locator('[data-testid=team-assign-confirm]').click(); modal_gone()
    t_info = toast('等管理层确认')
    check('分配回 202：提示「已提出，等管理层确认」（提示色，不是成功），卡片仍是团队公用', '「小审」分配给 丙：已提出，等管理层确认' in t_info.inner_text() and t_info.locator('.ant-message-info').count() == 1 and '团队公用' in card('小审').locator('[data-testid=team-assigned]').inner_text())

    # 改派被拒：弹窗里写服务端的说法；一步办完的接口不会停在团队公用，卡片仍写原来的人
    n0 = len(posted)
    reassign['next'] = (422, {'error': 'assignee_not_person', 'message': '只分给启用的人，user:ding 不是'})
    card('小算').locator('[data-testid=team-reassign-open]').click(); modal().wait_for(); pick_in_modal('丁')
    modal().locator('[data-testid=team-assign-confirm]').click(); modal().locator('[data-testid=team-assign-err]').wait_for()
    check('改派被拒：弹窗里写服务端的说法；只发了改派、没发收回；归属不变（仍分配给 戊），没有「已收回」的提示',
          '只分给启用的人' in modal().locator('[data-testid=team-assign-err]').inner_text() and [x[0] for x in posted[n0:]] == ['reassign'] and '分配给 戊' in card('小算').locator('[data-testid=team-assigned]').inner_text()
          and pg.locator('.ant-message-notice', has_text='已收回').count() == 0, posted[n0:])
    modal().locator('button', has_text='算了').click(); modal_gone()

    # 普通员工（can_assign 不是真）：只读
    who['me'] = me('geng', '庚')
    state['teams'] = {'departments': [{'id': 'synthetic-ops', 'name': '合成运营部', 'lead': {'principal': 'user:jia', 'display_name': '甲经理'},
        'teams': [{**lead_team, 'can_assign': False, 'assign_denied_text': '只有这个团队的负责人或管理层能分配、收回成员', 'assignable': PEOPLE}]}]}
    pg.reload(); pg.wait_for_selector('[data-testid=team-member]')
    check('页面结构里不挂席位句柄（属性里也没有）', 'ops/0000' not in pg.content(), [a for a in pg.content().split('"') if 'ops/0000' in a][:3])
    check('普通员工（can_assign 不是真）：成员卡上一个分配、改派、收回都没有（服务端多给了 assignable 也不出）；不是管理员也不写「分配由谁做」',
          pg.locator('.wm-team-member-ops').count() == 0 and pg.locator('[data-testid=team-member] button').count() == 0 and pg.locator('[data-testid=team-assign-by]').count() == 0)
    shot('team-member-readonly-1440.png')

    # 名册停推：只照服务端的 roster_stale；停了多久照 roster_stale_for_minutes（收到时刻故意写成三分钟前，看页面不自己算）
    t0 = state['teams']['departments'][0]['teams'][0]
    t0.update({'roster_received_at': sql_time(timedelta(minutes=3)), 'roster_stale': True, 'roster_stale_for_minutes': 185})
    pg.reload(); pg.wait_for_selector('[data-testid=team-roster-stale]')
    check('名册停推（服务端说停了 185 分钟）：头卡写「名册已 3 小时没更新」，状态标「名册过期」，不写「正常」',
          pg.locator('[data-testid=team-roster-stale]').inner_text() == '名册已 3 小时没更新' and pg.locator('.wm-team-st', has_text='名册过期').count() == 1 and pg.locator('.wm-team-st', has_text='正常').count() == 0,
          pg.locator('[data-testid=team-team] .wm-team-head').inner_text())
    # 服务端说没停推：收到时刻再旧（三天前）也标「正常」，页面不按阈值自己算
    t0.update({'roster_received_at': sql_time(timedelta(days=3)), 'roster_stale': False, 'roster_stale_for_minutes': None})
    pg.reload(); pg.wait_for_selector('[data-testid=team-member]')
    check('服务端说没停推：收到时刻三天前也标「正常」、不写没更新', pg.locator('[data-testid=team-roster-stale]').count() == 0 and pg.locator('.wm-team-st', has_text='正常').count() == 1)
    del t0['roster_stale']; del t0['roster_stale_for_minutes']

    # 部门负责人待属主放行：部门头写「（待属主放行权限）」；团队上 lead_pending_grant 补一句，不当成负责人
    state['teams']['departments'][0]['lead'] = {'principal': 'user:jia', 'display_name': '甲经理', 'grant': 'missing'}
    t0.update({'leads': [{'principal': 'user:yi', 'display_name': '乙主管', 'source': 'explicit'}], 'lead_pending_grant': {'principal': 'user:jia', 'display_name': '甲经理'}})
    pg.reload(); pg.wait_for_selector('[data-testid=team-lead-pending-grant]')
    head = pg.locator('[data-testid=team-team] .wm-team-head').inner_text()
    check('部门负责人待属主放行：部门头写「负责人 甲经理（待属主放行权限）」；团队头卡负责人只写乙主管，另补「部门负责人 甲经理（待属主放行权限）」',
          pg.locator('[data-testid=team-dept-lead]').inner_text() == '负责人 甲经理（待属主放行权限）' and '负责人：乙主管' in head and '甲经理（部门负责人）' not in head
          and pg.locator('[data-testid=team-lead-pending-grant]').inner_text() == '部门负责人 甲经理（待属主放行权限）', head)
    shot('team-lead-pending-grant-1440.png')
    state['teams']['departments'][0]['lead'] = {'principal': 'user:jia', 'display_name': '甲经理', 'grant': 'active'}
    t0.update({'lead_pending_grant': None})
    pg.reload(); pg.wait_for_selector('[data-testid=team-member]')
    check('部门负责人已放行（grant=active）：照常写「负责人 甲经理」，团队上没有待放行那一句', pg.locator('[data-testid=team-dept-lead]').inner_text() == '负责人 甲经理' and pg.locator('[data-testid=team-lead-pending-grant]').count() == 0)
    pg.unroute('**/api/auth/me')

    state['teams'] = {'departments': state['teams']['departments']}
    pg.reload(); pg.wait_for_selector('[data-testid=team-dept]')
    check('不是管理员的视图：没有建部门、没有待认领', pg.locator('[data-testid=team-newdept-open]').count() == 0 and pg.locator('.wm-team-unclaimed').count() == 0)
    b.close()

print(f'team-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
