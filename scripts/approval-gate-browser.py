"""核准类请求的门；由 scripts/approval-gate-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
(a) 没有核准资格的人（合成员工 alpha）打开全景、「等你拍板」：先用实例真数据看一遍，再把一条不带 answer_via 的变更申请塞进他的「关注」应答
    （模拟服务端多给了）——页面不给答法、不发往核准类接口的读写、不带管理员口令头。
    带 answer_via 的条目（AI 会话申请工具）只列给办得了的人，由服务端守（scripts/bench-mcp-test.mjs「管理口令、普通员工、有做没有拍板的角色、
    没有授予的管理员、本机命令行：清单里都没有这类条目」和「他们来答：和直接调那条路由一样被拒」），这里不再塞给没资格的人。
(b) 有资格的人（合成管理员）在卡片上点：变更申请「通过并回滚」「不通过」（带理由）走统一答复入口 POST /api/attention/answer；
    AI 会话申请工具「批准」「不给」（带理由）按条目的 answer_via 发到它自己的地址。断言每个请求的路径、方法、请求体。
(d) 申请写的是还没开台库的卡片（detail.bench_registered=false，属主 11-18 踩到的那种）：卡片写明批准会顺带开台库、链到这张卡片；
    侧栏「全景」的计数算上它；批准后应答带 opened_bench，提示说开了哪个台库。MCP 网关的「权限申请」没有待批时指去「等你拍板」。
(e) 团队的决策卡（T8，来源 a2a-decisions，只展示）：带宿主拍板地址的进全景「等你拍板」和侧栏计数，按钮「去宿主拍板 →」新标签打开、不带来源页；
    地址是空串或 javascript: 的归「要到别处处理」、不计数、不给链接；没有这个来源（非属主）时什么也不显示、不计数。"""
import json, re, sys
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1])); M = cfg['base']
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
    """等页面再画两帧"""
    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
APPROVAL = re.compile(r'/api/(change-requests|attention/answer|bench-views/[^/]+/mcp-requests|mcp/access|admin/(?!whoami))')  # whoami 是「我是谁」，不是核准类
def change(sid, op='rollback'):
    return {'source': 'change-requests', 'source_id': sid, 'category': 'review', 'title': '合成：变更申请', 'waiting_for': 'person:x', 'since': '2026-11-12T00:00:00Z',
            'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True,
            'detail': {'kind': 'app', 'op': op, 'slug': f'synthetic-app-{sid}', 'title': f'合成台 {sid}', 'exists': True, 'current_version': 5, 'target_version': 3,
                       'target_changelog': '合成改动', 'requested_by': 'person:x', 'reason': '合成理由', 'created_at': '2026-11-12T00:00:00Z'}}
VIA = {'method': 'POST', 'path': '/api/bench-views/synthetic-bench/mcp-requests/7', 'answers': {
    'approve': {'body': {'approve': True}, 'input': {'note': {'to': 'note', 'max': 500}}},
    'reject': {'body': {'approve': False}, 'input': {'note': {'to': 'note', 'required': True, 'max': 500}}}}}
GRANT = {'source': 'bench-mcp', 'source_id': 'synthetic-bench:7', 'category': 'grant', 'kind': 'bench-mcp', 'title': '合成：申请工具', 'waiting_for': 'mcp:合成会话',
         'since': '2026-11-12T00:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '', 'mine': True, 'answer_via': VIA,
         'detail': {'session': '合成会话', 'bench': 'synthetic-bench', 'bench_title': '合成台', 'tools': [{'tool': 'list_rows', 'category': 'read'}], 'reason': '合成', 'created_at': 1}}

def ctx_for(b, session, items=None, sent=None):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
    if items is not None:
        ctx.route('**/api/attention', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'items': items, 'counts': {'total': len(items), 'by_category': {c: sum(1 for x in items if x['category'] == c) for c in ('ask', 'review', 'accept', 'glance', 'grant')}}, 'sources': {}})))
    if sent is not None:
        def record(r):
            req = r.request
            sent.append({'method': req.method, 'path': req.url.split(M)[-1], 'body': req.post_data_json if req.post_data else None})
            r.fulfill(status=200, content_type='application/json', body='{"ok":true}')
        ctx.route('**/api/attention/answer', record)
        ctx.route('**/api/bench-views/*/mcp-requests/*', record)
    return ctx
def watch(pg):
    seen = []
    pg.on('request', lambda r: seen.append((r.method, r.url.split(M)[-1], bool(r.headers.get('x-admin-token')))))
    return seen
def visit(pg, path):
    # 全景和「等你拍板」都照「关注」画卡片。等这次应答回来、网络静下来、页面画完：卡片挂上以后要发的请求（回归时）这时都已经发出，
    # (a)(c) 的「不发核准类请求」「开页不自动核准」以此为准
    def go():
        with pg.expect_response(lambda r: r.url.split('?')[0].endswith('/api/attention'), timeout=10000): pg.goto(M + path)
    soft(go); pg.wait_for_load_state('networkidle'); painted(pg)

with sync_playwright() as p:
    b = p.chromium.launch()
    # (a) 没有核准资格的人
    for label, items in (('实例真数据', None), ('「关注」里多给了一条不带 answer_via 的变更申请', [change('9101')])):
        ctx = ctx_for(b, cfg['alpha_session'], items)
        pg = ctx.new_page(); pg.set_default_timeout(10000); seen = watch(pg)
        for path in ('/', '/attention'): visit(pg, path)
        bad = [x for x in seen if APPROVAL.search(x[1]) or (x[0] != 'GET' and x[1].startswith('/api/'))]
        check(f'没有核准资格（{label}）：全景、「等你拍板」不发往核准类接口的读写，也不发别的写请求', not bad, bad)
        check(f'没有核准资格（{label}）：不带管理员口令头', not any(x[2] for x in seen), [x for x in seen if x[2]])
        if items:
            btns = pg.locator('[data-testid=decision-card]').get_by_role('button', name=re.compile(r'通\s*过|不\s*通\s*过|批\s*准|不\s*给'))
            check('没有核准资格：卡片上没有批准 / 不给 / 通过这类按钮', btns.count() == 0, btns.count())
        ctx.close()
    # (b) 有资格的人：变更申请走统一答复入口
    sent = []
    ctx = ctx_for(b, cfg['admin_session'], [change('9101'), change('9102'), GRANT], sent)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    # 卡片在全景上（「等你拍板」完整列表用的是同一张卡）
    visit(pg, '/')
    card = lambda t: pg.locator('[data-testid=decision-card]', has_text=t).first
    n = len(sent); card('合成台 9101').get_by_role('button', name=re.compile(r'通过并回滚')).click()
    until(pg, lambda: len(sent) > n)  # 等截下这一次答复
    check('变更申请「通过并回滚」：POST /api/attention/answer，带来源、编号、答法', any(x['method'] == 'POST' and x['path'] == '/api/attention/answer'
          and x['body'] == {'source': 'change-requests', 'source_id': '9101', 'answer': 'approve', 'input': {}} for x in sent), sent)
    c2 = card('合成台 9102'); c2.get_by_role('button', name=re.compile(r'不\s*通\s*过')).click(); c2.locator('textarea').wait_for()
    n = len(sent); c2.locator('textarea').fill('合成：先不回滚'); c2.get_by_role('button', name=re.compile('确定')).click()
    until(pg, lambda: len(sent) > n)
    check('变更申请「不通过」：要写理由，理由带在请求里', any(x['method'] == 'POST' and x['path'] == '/api/attention/answer'
          and x['body'] == {'source': 'change-requests', 'source_id': '9102', 'answer': 'reject', 'input': {'reason': '合成：先不回滚'}} for x in sent), sent)
    # 按 answer_via 走的
    g = card('合成会话'); g.get_by_role('button', name=re.compile(r'不\s*给')).click(); g.locator('textarea').wait_for()
    n = len(sent); g.locator('textarea').fill('合成：只给读'); g.get_by_role('button', name=re.compile('确定')).click()
    until(pg, lambda: len(sent) > n)
    check('AI 会话申请「不给」：按 answer_via 发到它自己的地址，请求体 = body + 理由', any(x['method'] == 'POST' and x['path'] == VIA['path']
          and x['body'] == {'approve': False, 'note': '合成：只给读'} for x in sent), sent)
    visit(pg, '/')
    # 「批准」有选填的理由框时先展开框，没有就直接发：等框出来，或者请求已经截下
    n = len(sent); g = card('合成会话'); g.get_by_role('button', name=re.compile(r'批\s*准')).click()
    until(pg, lambda: g.locator('textarea').count() > 0 or len(sent) > n)
    if g.locator('textarea').count(): g.get_by_role('button', name=re.compile('确定')).click()
    until(pg, lambda: len(sent) > n)
    check('AI 会话申请「批准」：按 answer_via 发，请求体 = body（选填的理由没填不带）', any(x['method'] == 'POST' and x['path'] == VIA['path']
          and x['body'] == {'approve': True} for x in sent), sent)
    check('页面没有报错', not errs, errs)
    check('有资格的人这几下没有走错地址（只发到统一答复入口和条目自己的地址）', all(x['path'] in ('/api/attention/answer', VIA['path']) for x in sent), sent)
    ctx.close()
    # (c) 有资格的人：开页不自动核准；确认框里取消不写；答复入口拒绝（409 / 500）不显示成办完了
    for status in (409, 500):
        sent2 = []
        ctx = b.new_context(viewport={'width': 1440, 'height': 900})
        ctx.add_cookies([{'name': 'session_id', 'value': cfg['admin_session'], 'url': M}])
        items = [change('9201', op='delete'), change('9202')]
        ctx.route('**/api/attention', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'items': items, 'counts': {'total': len(items), 'by_category': {'review': len(items)}}, 'sources': {}})))
        def make_refuse(code):
          def refuse(r, *_):
            status = code
            sent2.append({'method': r.request.method, 'path': r.request.url.split(M)[-1], 'body': r.request.post_data_json if r.request.post_data else None})
            r.fulfill(status=status, content_type='application/json', body=json.dumps({'error': 'conflict', 'message': '合成：这条已经有人定过了'} if status == 409 else {'error': 'internal'}))
          return refuse
        ctx.route('**/api/attention/answer', make_refuse(status))
        pg = ctx.new_page(); pg.set_default_timeout(10000)
        writes = []
        pg.on('request', lambda r: writes.append((r.method, r.url.split(M)[-1])) if r.method != 'GET' and '/api/' in r.url else None)
        for path in ('/', '/attention'): visit(pg, path)
        if status == 409:
            check('有资格的管理员打开全景、「等你拍板」：点之前不发任何写请求（开页不自动核准）', not writes, writes)
        visit(pg, '/')
        # 删除申请的「通过并删除」要先确认；在确认框里点「再想想」→ 不发请求
        card('合成台 9201').get_by_role('button', name=re.compile(r'通过并删除')).click()
        pg.get_by_role('button', name='再想想').click()  # 点之前会等确认框弹出来
        # 证明「不发请求」：点「再想想」以后确认框一定会收起。等它收起、再等两帧（取消时要发的话这时已经截下），再看
        soft(lambda: pg.get_by_role('button', name='再想想').wait_for(state='hidden', timeout=10000)); painted(pg)
        if status == 409:
            check('确认框里取消：不发任何请求', not sent2 and not [w for w in writes if '/api/' in w[1]], (sent2, writes))
        # 答复入口拒绝：卡片还在、按钮还能点、给出错误，不显示成办完了
        n2 = len(sent2); card('合成台 9202').get_by_role('button', name=re.compile(r'通过并回滚')).click()
        until(pg, lambda: len(sent2) > n2)  # 等截下这一次答复，再等错误提示出来
        soft(lambda: pg.locator('.ant-message-notice').first.wait_for(timeout=10000))
        msgs = ' '.join(pg.locator('.ant-message-notice').all_inner_texts())
        still = card('合成台 9202').count() == 1 and card('合成台 9202').get_by_role('button', name=re.compile(r'通过并回滚')).is_enabled()
        check(f'答复入口回 {status}：卡片还在、还能再试，给出错误、不说「办好了」', len(sent2) == 1 and still and '办好了' not in msgs and ('合成：这条已经有人定过了' in msgs if status == 409 else len(msgs) > 0), (sent2, msgs))
        ctx.close()
    # (d) 还没开台库的卡片
    VIA2 = {**VIA, 'path': '/api/bench-views/wb-1971/mcp-requests/8'}
    NEW = {**GRANT, 'source_id': 'wb-1971:8', 'answer_via': VIA2, 'detail': {'session': '合成会话乙', 'bench': 'wb-1971', 'bench_title': '合成卡片丙', 'tools': [{'tool': 'dataset_list', 'category': 'read'}],
           'reason': '合成', 'created_at': 1, 'bench_registered': False, 'workbench_id': 1971}}
    sent3 = []
    ctx = ctx_for(b, cfg['admin_session'], [NEW])
    def opened(r):
        sent3.append({'path': r.request.url.split(M)[-1], 'body': r.request.post_data_json if r.request.post_data else None})
        r.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'opened_bench': {'slug': 'wb-1971', 'title': '合成卡片丙'}}))
    ctx.route('**/api/bench-views/*/mcp-requests/*', opened)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    visit(pg, '/')
    g = card('合成会话乙')
    check('没开台库的卡片：全景「等你拍板」里有这一条，侧栏「全景」的计数算上它', g.count() == 1 and pg.locator('[data-testid=nav-pending]').inner_text().strip() == '1' and pg.locator('[data-testid=home-decide-n]').inner_text().strip() == '1')
    opens = g.locator('[data-testid=decision-grant-opens]'); link = g.locator('[data-testid=decision-grant-card]')
    opens_t = opens.inner_text() if opens.count() == 1 else ''
    check('卡片写明批准时会顺带为这张卡片开台库、不批不开；链到卡片详情', '批准时会顺带为「合成卡片丙」开一个' in opens_t and '不批就不开' in opens_t
          and link.count() == 1 and link.get_attribute('href') == '/market/wb/1971', g.inner_text() if g.count() else '')
    g.get_by_role('button', name=re.compile(r'批\s*准')).click()
    until(pg, lambda: g.locator('textarea').count() > 0 or len(sent3) > 0)
    if g.locator('textarea').count(): g.get_by_role('button', name=re.compile('确定')).click()
    until(pg, lambda: len(sent3) > 0)  # 等截下批准，再等「开了台库」那句提示
    soft(lambda: pg.locator('.ant-message-notice', has_text='开了台库').first.wait_for(timeout=10000))
    msgs = ' '.join(pg.locator('.ant-message-notice').all_inner_texts())
    check('批准：按 answer_via 发到这张卡片的地址；应答带 opened_bench 时提示开了哪个台库', len(sent3) == 1 and sent3[0]['path'] == VIA2['path'] and sent3[0]['body'] == {'approve': True} and '已为「合成卡片丙」开了台库' in msgs, (sent3, msgs))
    ctx.close()
    # MCP 网关的「权限申请」：没有待批的会话工具申请时，指去「等你拍板」
    ctx = ctx_for(b, cfg['admin_session'])
    ctx.route('**/api/mcp/access-requests*', lambda r: r.fulfill(status=200, content_type='application/json', body='[]'))
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    visit(pg, '/mcp-gateways'); pg.get_by_role('tab', name=re.compile('权限申请')).click()
    soft(lambda: pg.locator('[data-testid=mcp-requests-empty]').wait_for(timeout=10000))  # 等「没有待批」那块画出来
    empty, hint = pg.locator('[data-testid=mcp-requests-empty]'), pg.locator('[data-testid=mcp-bench-hint]')
    check('MCP 网关「权限申请」没有待批时：说台的工具授权在「等你拍板」里批，链到 /attention（不再只说「没有待批的申请」）',
          empty.count() == 1 and '台的工具授权在「等你拍板」里批' in empty.inner_text() and empty.get_by_role('link').count() == 1 and empty.get_by_role('link').get_attribute('href') == '/attention'
          and hint.count() == 1 and hint.get_by_role('link').get_attribute('href') == '/attention', pg.locator('main').inner_text()[:300])
    check('写明台的工具授权要用有管理层授予的账号来批（系统管理员、管理口令看不到）', '有管理层授予的账号' in hint.inner_text() and '管理口令' in hint.inner_text() and '有管理层授予的账号' in empty.inner_text())
    check('页头那句提示也指「等你拍板」，不再说「关注」', '「等你拍板」' in pg.locator('[data-testid=also-in-attention]').inner_text() and '「关注」' not in pg.locator('main').inner_text())
    ctx.close()
    # (e) 团队的决策卡
    def deccard(sid, decide_at, level='P1'):
        return {'source': 'a2a-decisions', 'source_id': sid, 'category': 'ask', 'kind': 'a2a-decision', 'title': f'[{level}] 观察者（合成团队）：合成问题 {sid}',
                'waiting_for': 'team:synthetic.example.invalid/team-a', 'since': '2026-11-20T08:00:00Z', 'answers': [], 'object': '', 'phase': '', 'link': '', 'mine': True,
                'detail': {'host': '合成宿主', 'team': 'team-a', 'proposer_kind': 'observer', 'level': level, 'question': f'合成：下周先上哪个？{sid}', 'options': ['甲方案', '乙方案'],
                           'recommended': '乙方案', 'reason': '合成理由', 'files': [{'name': 'a.pdf', 'size': 2048}], 'created_at': '2026-11-20T08:00:00Z', 'decide_at': decide_at}}
    HOST = 'https://host.example.invalid/decide/1'
    decs = [deccard('d1', HOST, 'P0'), deccard('d2', ''), deccard('d3', 'javascript:alert(1)')]
    ctx = ctx_for(b, cfg['admin_session'], decs)
    ctx.route('https://host.example.invalid/**', lambda r: r.fulfill(status=200, content_type='text/html', body='<title>合成宿主</title>合成宿主的拍板页'))
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    writes = []; pg.on('request', lambda r: writes.append((r.method, r.url.split(M)[-1])) if r.method != 'GET' and '/api/' in r.url else None)
    visit(pg, '/')
    d1 = card('下周先上哪个？d1')
    nowbox, elsebox = pg.locator('[data-testid=decisions-now]'), pg.locator('[data-testid=decisions-elsewhere]')
    check('带宿主地址的决策卡：进全景「等你拍板」那一组，侧栏「全景」计数 1；空串、javascript: 的两张在「要到别处处理的」那组，不计数',
          d1.count() == 1 and nowbox.locator('[data-testid=decision-card]', has_text='d1').count() == 1 and pg.locator('[data-testid=home-decide-n]').inner_text().strip() == '1'
          and pg.locator('[data-testid=nav-pending]').inner_text().strip() == '1' and nowbox.locator('[data-testid=decision-card]').count() == 1
          and elsebox.locator('[data-testid=decision-card]', has_text='d2').count() == 1 and elsebox.locator('[data-testid=decision-card]', has_text='d3').count() == 1
          and '2 件要到别处处理' in pg.locator('[data-testid=home-summary]').inner_text(), pg.locator('main').inner_text()[:400])
    txt = d1.inner_text() if d1.count() else ''
    check('卡片写清：团队的决策卡、P0、谁提的、问题、选项（标出建议）、理由、附件', all(w in txt for w in ('团队的决策卡', 'P0', '观察者（合成宿主', '合成：下周先上哪个？d1', '可选：甲方案 / 乙方案（建议）', '理由：合成理由', 'a.pdf（2 KB）')), txt)
    go = d1.locator('[data-testid=decision-host-go]')
    check('按钮「去宿主拍板 →」：链到宿主地址，新标签打开，rel 带 noopener noreferrer；卡片上没有批准、驳回之类的答法',
          go.count() == 1 and '去宿主拍板' in go.inner_text() and go.get_attribute('href') == HOST and go.get_attribute('target') == '_blank'
          and set((go.get_attribute('rel') or '').split()) >= {'noopener', 'noreferrer'} and d1.get_by_role('button', name=re.compile(r'批\s*准|不\s*给|通\s*过')).count() == 0)
    popup = None
    if go.count():
        try:
            with pg.expect_popup(timeout=5000) as pop: go.click()
            popup = pop.value; popup.wait_for_load_state()
        except Exception: popup = None
        if popup is None and pg.url.rstrip('/') != M.rstrip('/'): visit(pg, '/')  # 没新开标签、把本页带走了：回来接着测
    check('点「去宿主拍板 →」：新标签打开宿主的拍板页，市场这一页还在，没发任何写请求', popup is not None and popup.url == HOST and pg.url.rstrip('/') == M.rstrip('/') and not writes, (popup and popup.url, pg.url, writes))
    if popup: popup.close()
    visit(pg, '/attention')
    d2, d3 = card('下周先上哪个？d2'), card('下周先上哪个？d3')
    check('「等你拍板」完整列表：空串、javascript: 的两张在「要到别处处理」里，写到宿主上找这张卡，没有可点的链接',
          d2.count() == 1 and d3.count() == 1 and '到宿主上找这张卡' in d2.locator('[data-testid=decision-where]').inner_text()
          and d2.locator('a').count() == 0 and d3.locator('a').count() == 0 and d3.locator('[data-testid=decision-host-go]').count() == 0, pg.locator('main').inner_text()[:400])
    check('页面上哪儿都没有 javascript: 链接', pg.locator('a[href^="javascript:" i]').count() == 0)
    check('决策卡这几页没有报错', not errs, errs)
    ctx.close()
    # 非属主：服务端不列这个来源（sources 里 visible 为假），页面上什么也没有、不计数
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': cfg['alpha_session'], 'url': M}])
    ctx.route('**/api/attention', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'items': [], 'counts': {'total': 0, 'by_category': {}}, 'sources': {'a2a-decisions': {'label': '团队的决策卡', 'visible': False}}})))
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    visit(pg, '/')
    check('非属主（这个来源不可见）：全景「等你拍板」0 件，侧栏不出计数，没有决策卡', pg.locator('[data-testid=home-decide-n]').inner_text().strip() == '0' and pg.locator('[data-testid=nav-pending]').count() == 0 and pg.locator('[data-testid=decision-host-go]').count() == 0)
    ctx.close()
    b.close()
print(f'approval-gate-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
