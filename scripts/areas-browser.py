"""领域页（/areas，侧栏一级入口；领域第 1 步只做列表）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
/api/areas*、/api/principals、/api/grants* 用 page.route 截成合成的应答（契约照后端领域第 1 步 PR2b、PR3a 给的），记下页面发了什么：
  一、读：没登录去登录（回到这一页）；403 看不了；出错再试一次；
  二、不是属主（can 都是假）：列出领域（名字、标识、状态、负责人含待放行），等负责人的写清不能安排事；没有建领域、迁移、指定负责人；
  三、属主：建一个领域（标识写错不能建，说为什么；被占了照服务端说）；发 { id, name }；
  四、指定负责人：可选的人不列已经是负责人的；起草 area-lead → 提交 → 放行三步；放行被拒时说停在哪一步、给去「谁能做什么」的链接；
  五、把部门迁成领域：先确认；结果写建了几个、起草了几条待放行，链到「谁能做什么」；跳过的说为什么；服务端还没有这个接口（404）照实说；
  六、侧栏：「领域」在「驾驶舱」和「团队」之间；页面上不露主体标识；请求不带 Authorization。
数据全是合成的。"""
import json, os, re, sys
SHOT = os.environ.get('WM_SHOT_AREAS')  # 本机看样子用（目录），CI 不设
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

def A(id, name, status, **kw):
    return {'id': id, 'name': name, 'status': status, 'spec_version': None, 'team_host': '', 'team': '', 'source': 'manual', 'created_at': 1, 'created_by': 'x', 'updated_at': 1, 'updated_by': 'x', **kw}
AREAS = [A('syn-fin', '合成利润核算', 'active', spec_version=2), A('syn-buy', '合成采购跟单', 'pending-lead', source='department'), A('syn-old', '合成旧领域', 'retired')]
LEADS = {'syn-fin': [{'grant': 11, 'principal': 'user:syn-a', 'display_name': '合成甲', 'status': 'active'}, {'grant': 12, 'principal': 'user:syn-b', 'display_name': '合成乙', 'status': 'pending'}],
         'syn-buy': [], 'syn-old': []}
PRINCIPALS = {'principals': [{'id': 'user:syn-a', 'kind': 'person', 'status': 'active', 'display_name': '合成甲'}, {'id': 'user:syn-b', 'kind': 'person', 'status': 'active', 'display_name': '合成乙'},
                             {'id': 'user:syn-c', 'kind': 'person', 'status': 'active', 'display_name': '合成丙'}, {'id': 'user:syn-d', 'kind': 'person', 'status': 'disabled', 'display_name': '合成丁'},
                             {'id': 'seat:syn-e', 'kind': 'seat', 'status': 'active', 'display_name': '合成席位'}]}
OWNER = {'create': True, 'migrate': True, 'assign_lead': True}
state, sent, all_sent = {}, [], []

def setup(ctx):
    def rec(r):
        h = r.request.headers; b = r.request.post_data
        sent.append({'method': r.request.method, 'path': re.sub(r'^https?://[^/]+', '', r.request.url), 'auth': 'authorization' in h, 'body': json.loads(b) if b else None}); all_sent.append(sent[-1])
    def areas(r):
        rec(r)
        if r.request.method == 'POST':
            code, res = state.get('create', (201, None))
            if code == 201:
                b = json.loads(r.request.post_data); a = A(b['id'], b['name'], 'pending-lead'); state['areas'] = state['areas'] + [a]; LEADS[b['id']] = []; res = {'area': a}
            return fake(r, res, code)
        code = state.get('list', 200)
        return fake(r, {'areas': state['areas'], 'can': state['can']} if code == 200 else {'error': 'x'}, code)
    def one(r):
        rec(r); aid = r.request.url.rstrip('/').split('/api/areas/')[1].split('?')[0]
        a = next((x for x in state['areas'] if x['id'] == aid), None)
        return fake(r, {'area': a, 'leads': LEADS.get(aid, [])} if a else {'error': 'area_missing'}, 200 if a else 404)
    def migrate(r):
        rec(r); code, res = state.get('migrate', (200, {'created': [], 'drafted': [], 'skipped': []})); fake(r, res, code)
    def principals(r): rec(r); fake(r, PRINCIPALS)
    def me(r): fake(r, {'gate': 'off', 'authenticated': True, 'via': 'session', 'login': 'syn-a', 'principal': 'user:syn-a', 'display_name': '合成甲', 'roles': ['owner']})
    def grants(r):
        rec(r); p = re.sub(r'^https?://[^/]+', '', r.request.url)
        if p == '/api/grants' and r.request.method == 'POST': return fake(r, {'grant': {'id': 77, 'status': 'draft'}}, 201)
        if p.endswith('/submit'): return fake(r, {'grant': {'id': 77, 'status': 'pending'}})
        if p.endswith('/approve'):
            code, res = state.get('approve', (200, {'grant': {'id': 77, 'status': 'active'}}))
            if code == 200:
                LEADS[state.get('assign_area', 'syn-buy')] = [{'grant': 77, 'principal': 'user:syn-c', 'display_name': '合成丙', 'status': 'active'}]
                state['areas'] = [{**x, 'status': 'active'} if x['id'] == state.get('assign_area', 'syn-buy') else x for x in state['areas']]
            return fake(r, res, code)
        return fake(r, {'grants': []})
    ctx.route(re.compile(r'/api/areas/migrate$'), migrate)
    ctx.route(re.compile(r'/api/areas$'), areas)
    ctx.route(re.compile(r'/api/areas/(?!migrate)[^/?]+$'), one)
    ctx.route(re.compile(r'/api/principals$'), principals)
    ctx.route(re.compile(r'/api/auth/me$'), me)
    ctx.route(re.compile(r'/api/grants(/\d+/(submit|approve))?$'), grants)

def soft(fn):
    """等条件成立；等不到不在这里抛错，照常往下，由后面原来的断言报（带着当时的值）"""
    try: fn()
    except PWTimeout: pass
def until(pg, pred, timeout_ms=10000):
    """等这边记下的请求（页面看不到）成立：每 20 毫秒看一次，期间照常处理截下的请求；到点返回，由后面的断言报"""
    for _ in range(max(1, timeout_ms // 20)):
        if pred(): return
        pg.wait_for_timeout(20)
def open_page(b, **st):
    state.clear(); state.update({'areas': [dict(a) for a in AREAS], 'can': OWNER}, **st); sent.clear()
    for k in list(LEADS): LEADS[k] = [dict(x) for x in LEADS[k]] if k == 'syn-fin' else []
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + '/areas'); pg.wait_for_selector('[data-testid=areas-list], [data-testid=areas-empty], [data-testid=areas-login], [data-testid=areas-forbidden], [data-testid=areas-error]')
    # 等页面的取数都回来了（网络空闲），后面点「指定负责人」时候选人已经取到
    soft(lambda: pg.wait_for_load_state('networkidle', timeout=10000))
    return ctx, pg
card = lambda pg, aid: pg.locator(f'[data-testid=area-card][data-area={aid}]')

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        print('一、读')
        for code, tid, words in ((401, 'areas-login', '请先登录'), (403, 'areas-forbidden', '看不了领域'), (500, 'areas-error', '读不到领域')):
            ctx, pg = open_page(b, list=code)
            el = pg.locator(f'[data-testid={tid}]')
            check(f'{code}：{words}', el.count() == 1 and words in el.inner_text(), pg.locator('main').inner_text()[:200])
            if code == 401: check('401：「去登录」登录完回到这一页', pg.get_by_role('link', name=re.compile('去登录')).get_attribute('href') == '/login?next=%2Fareas')
            if code == 500:
                state['list'] = 200; pg.get_by_role('button', name=re.compile('再试一次')).click()
                try: pg.wait_for_selector('[data-testid=areas-list]', timeout=5000)
                except Exception: pass
                check('出错后点「再试一次」：读到了就列出领域', pg.locator('[data-testid=area-card]').count() == 3)
            ctx.close()
        ctx, pg = open_page(b, areas=[], can=OWNER)
        check('还没有领域（属主）：说建一个或把部门迁成领域，工具照样在', '建一个，或者把部门迁成领域' in pg.locator('[data-testid=areas-empty]').inner_text() and pg.locator('[data-testid=areas-migrate]').count() == 1)
        ctx.close()
        # 不是属主、库里其实已经有领域（服务端只列他看得到的，这里列表是空的）：说中性的话，不说「还没有领域」「等属主来建」
        ctx, pg = open_page(b, areas=[], can={'create': False, 'migrate': False, 'assign_lead': False})
        t = pg.locator('[data-testid=areas-empty]').inner_text()
        check('不是属主、领域已经有了但他看不到（列表空）：说「还没有你能看到的领域」，不说「还没有领域」「等属主来建」，没有工具', '还没有你能看到的领域' in t and '还没有领域' not in t and '等属主' not in t and pg.locator('[data-testid=areas-tools]').count() == 0, t)
        ctx.close()

        print('二、不是属主')
        ctx, pg = open_page(b, can={'create': False, 'migrate': False, 'assign_lead': False})
        fin, buy, old = card(pg, 'syn-fin'), card(pg, 'syn-buy'), card(pg, 'syn-old')
        check('列出三个领域：等负责人的在前，再在用的，已撤的最后', pg.locator('[data-testid=area-card]').evaluate_all('els => els.map(e => e.dataset.area).join()') == 'syn-buy,syn-fin,syn-old')
        check('一张卡写名字、标识、状态；由部门迁来的标出来', '合成利润核算' in fin.inner_text() and 'syn-fin' in fin.inner_text() and fin.locator('[data-testid=area-status]').inner_text() == '在用'
              and buy.locator('[data-testid=area-status]').inner_text() == '等负责人' and buy.locator('[data-testid=area-from-dept]').count() == 1 and old.locator('[data-testid=area-status]').inner_text() == '已撤')
        check('负责人：生效的写名字，待放行的标出来；没有的写「还没有」', fin.locator('[data-testid=area-leads]').inner_text().endswith('合成甲、合成乙（待放行）') and buy.locator('[data-testid=area-leads]').inner_text().endswith('还没有'), fin.locator('[data-testid=area-leads]').inner_text())
        check('等负责人的领域：写清还不能安排事、验收', '不能在这个领域安排事' in buy.locator('[data-testid=area-pending-hint]').inner_text() and fin.locator('[data-testid=area-pending-hint]').count() == 0)
        check('不是属主：没有建领域、迁移、指定负责人', all(pg.locator(f'[data-testid={t}]').count() == 0 for t in ('areas-tools', 'area-new-open', 'areas-migrate', 'area-lead-open')))
        check('页面上不露主体标识（user:…）', 'user:' not in pg.locator('main').inner_text())
        check('不是属主：不去读主体清单', not any(x['path'] == '/api/principals' for x in sent))
        side = pg.locator('[data-testid=wm-side]').inner_text()
        check('侧栏：「领域」在「驾驶舱」和「团队」之间，当前页高亮在「领域」', side.index('驾驶舱') < side.index('领域') < side.index('团队') and '领域' in pg.locator('[data-testid=wm-top]').inner_text(), side[:200])
        ctx.close()

        print('三、属主：建一个领域')
        ctx, pg = open_page(b)
        if SHOT: os.makedirs(SHOT, exist_ok=True); pg.screenshot(path=f'{SHOT}/areas-owner.png')
        check('属主：有「建一个领域」「把部门迁成领域」，在用和等负责人的领域有「指定负责人」，已撤的没有',
              pg.locator('[data-testid=area-new-open]').count() == 1 and pg.locator('[data-testid=areas-migrate]').count() == 1
              and card(pg, 'syn-fin').locator('[data-testid=area-lead-open]').count() == 1 and card(pg, 'syn-buy').locator('[data-testid=area-lead-open]').count() == 1 and card(pg, 'syn-old').locator('[data-testid=area-lead-open]').count() == 0)
        pg.locator('[data-testid=area-new-open]').click()
        save, hint = pg.locator('[data-testid=area-new-save]'), pg.locator('[data-testid=area-new-hint]')
        pg.locator('[data-testid=area-new-name]').fill('合成物流对账'); pg.locator('[data-testid=area-new-id]').fill('Logi')
        check('标识写错（大写）不能建，说为什么', save.is_disabled() and '小写字母开头' in hint.inner_text())
        pg.locator('[data-testid=area-new-id]').fill('syn-old')
        check('标识和已撤的领域重了：不能建，说撤了的也占着', save.is_disabled() and '撤了的领域也占着' in hint.inner_text())
        pg.locator('[data-testid=area-new-id]').fill('syn-logi')
        state['create'] = (409, {'error': 'area_exists', 'message': '领域 syn-logi 已经有了'})
        save.click(); pg.wait_for_selector('[data-testid=area-new-err]')
        check('服务端说标识被占（409 area_exists）：照说、表单还在', '撤了的领域也占着' in pg.locator('[data-testid=area-new-err]').inner_text() and pg.locator('[data-testid=area-new]').count() == 1)
        state['create'] = (201, None)
        save.click(); pg.wait_for_selector('[data-testid=area-new]', state='detached'); pg.wait_for_selector('[data-testid=area-card][data-area=syn-logi]')
        posts = [x for x in sent if x['method'] == 'POST' and x['path'] == '/api/areas']
        check('建好：发 POST /api/areas { id, name }；新领域出现在列表里，是「等负责人」', posts[-1]['body'] == {'id': 'syn-logi', 'name': '合成物流对账'} and card(pg, 'syn-logi').locator('[data-testid=area-status]').inner_text() == '等负责人', posts)
        ctx.close()

        print('四、属主：指定负责人')
        ctx, pg = open_page(b)
        buy = card(pg, 'syn-buy')
        buy.locator('[data-testid=area-lead-open]').click()
        buy.locator('[data-testid=area-lead-pick]').click()
        soft(lambda: pg.locator('.ant-select-dropdown:visible .ant-select-item-option').first.wait_for(timeout=10000))  # 等候选人的下拉选项出来
        opts = pg.locator('.ant-select-dropdown:visible .ant-select-item-option').all_inner_texts()
        check('可选的人：在用的人列出来（这个领域还没有负责人），自己（合成甲，属主本人）、停用的和席位不列', sorted(opts) == sorted(['合成乙', '合成丙']), opts)
        pg.locator('.ant-select-dropdown:visible .ant-select-item-option', has_text='合成丙').click()
        sent.clear(); buy.locator('[data-testid=area-lead-save]').click()
        # 等三步都发出去了（起草 → 提交 → 放行，放行那一条记下来了），再等「已放行」的提示和重读后的「在用」
        until(pg, lambda: any(x['path'].endswith('/approve') for x in sent))
        soft(lambda: pg.wait_for_function("() => [...document.querySelectorAll('.ant-message-notice')].some((e) => e.innerText.includes('已放行'))", timeout=10000))
        soft(lambda: pg.wait_for_function("() => document.querySelector('[data-testid=area-card][data-area=syn-buy] [data-testid=area-status]')?.innerText === '在用'", timeout=10000))
        g = [x for x in sent if x['path'].startswith('/api/grants')]
        check('指定：起草 area-lead（principal、role、scope、写了理由）→ 提交 → 放行，三步按顺序',
              [x['path'] for x in g] == ['/api/grants', '/api/grants/77/submit', '/api/grants/77/approve'] and g[0]['body']['principal'] == 'user:syn-c'
              and g[0]['body']['role'] == 'area-lead' and g[0]['body']['scope'] == 'area:syn-buy' and g[0]['body']['reason'].strip() != '', g)
        check('放行后：提示已放行；重读后这个领域是「在用」，负责人是合成丙', '已放行' in ' '.join(pg.locator('.ant-message-notice').all_inner_texts())
              and buy.locator('[data-testid=area-status]').inner_text() == '在用' and buy.locator('[data-testid=area-leads]').inner_text().endswith('合成丙'))
        fin = card(pg, 'syn-fin')
        fin.locator('[data-testid=area-lead-open]').click(); fin.locator('[data-testid=area-lead-pick]').click()
        soft(lambda: pg.locator('.ant-select-dropdown:visible .ant-select-item-option').first.wait_for(timeout=10000))  # 等候选人的下拉选项出来
        opts = pg.locator('.ant-select-dropdown:visible .ant-select-item-option').all_inner_texts()
        check('已经有负责人（生效、待放行）的领域：这两个人不再列', opts == ['合成丙'], opts)
        ctx.close()
        ctx, pg = open_page(b, approve=(409, {'error': 'credentials_set_by_system_admin', 'message': 'x'}))
        buy = card(pg, 'syn-buy')
        buy.locator('[data-testid=area-lead-open]').click(); buy.locator('[data-testid=area-lead-pick]').click()
        soft(lambda: pg.locator('.ant-select-dropdown:visible .ant-select-item-option').first.wait_for(timeout=10000))  # 等候选人的下拉选项出来
        pg.locator('.ant-select-dropdown:visible .ant-select-item-option', has_text='合成丙').click()
        buy.locator('[data-testid=area-lead-save]').click(); pg.wait_for_selector('[data-testid=area-lead-err]')
        err = buy.locator('[data-testid=area-lead-err]')
        check('放行被拒（凭据是系统管理员设的）：说已起草并提交、放行没成、为什么，给去「谁能做什么」的链接', '已起草并提交，但放行没成' in err.inner_text() and '系统管理员设的' in err.inner_text()
              and err.get_by_role('link').get_attribute('href') == '/access', err.inner_text())
        ctx.close()

        print('五、属主：把部门迁成领域')
        ctx, pg = open_page(b, migrate=(200, {'created': [{'id': 'syn-ops', 'name': '合成运营'}, {'id': 'syn-pd', 'name': '合成新品'}], 'drafted': [{'department': 'syn-ops', 'grant': 31, 'principal': 'user:syn-a'}],
                                              'skipped': [{'department': 'syn-x', 'reason': 'lead_without_grant'}]}))
        sent.clear(); pg.locator('[data-testid=areas-migrate]').click()
        # 等确认气泡出来（点按钮先弹确认）；出来了还没发迁移请求，才说明「只点按钮不发请求」
        soft(lambda: pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^迁\s*移$')).wait_for(timeout=10000))
        check('迁移要先确认：只点按钮不发请求，说明写清会起草负责人授予、旧部门原样留着', not any(x['path'] == '/api/areas/migrate' for x in sent) and '旧部门原样留着' in pg.locator('.ant-popover').last.inner_text())
        pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^迁\s*移$')).click(); pg.wait_for_selector('[data-testid=areas-migrated]')
        res = pg.locator('[data-testid=areas-migrated]')
        check('迁移：发 POST /api/areas/migrate {}；结果写「建了 2 个领域，起草了 1 条负责人授予待你放行」', any(x['method'] == 'POST' and x['path'] == '/api/areas/migrate' and x['body'] == {} for x in sent)
              and '建了 2 个领域，起草了 1 条负责人授予待你放行' in res.inner_text(), res.inner_text())
        check('迁移结果：给去「谁能做什么」放行的链接；跳过的部门说为什么', res.locator('[data-testid=areas-migrated-approve]').get_attribute('href') == '/access' and '部门 syn-x：部门负责人只写了名字' in res.inner_text())
        if SHOT: pg.screenshot(path=f'{SHOT}/areas-migrated.png')
        ctx.close()
        ctx, pg = open_page(b, migrate=(404, {'error': 'not_found'}))
        pg.locator('[data-testid=areas-migrate]').click()
        soft(lambda: pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^迁\s*移$')).wait_for(timeout=10000))  # 等确认气泡出来再点
        pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^迁\s*移$')).click(); pg.wait_for_selector('[data-testid=areas-migrate-err]')
        check('服务端还没有迁移接口（404）：说没迁成、还没有这个接口', '还没有这个接口' in pg.locator('[data-testid=areas-migrate-err]').inner_text())
        ctx.close()

        print('六、请求')
        check(f'整个测试里这一页发出的请求（{len(all_sent)} 个）都不带 Authorization', len(all_sent) >= 20 and not any(x['auth'] for x in all_sent))
    finally:
        b.close()

print(f'areas-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
