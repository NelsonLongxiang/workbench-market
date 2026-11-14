"""核准类请求的门；由 scripts/approval-gate-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
(a) 没有核准资格的人（合成员工 alpha）打开全景、「等你拍板」：先用实例真数据看一遍，再把一条不带 answer_via 的变更申请塞进他的「关注」应答
    （模拟服务端多给了）——页面不给答法、不发往核准类接口的读写、不带管理员口令头。
    带 answer_via 的条目（AI 会话申请工具）只列给办得了的人，由服务端守（scripts/bench-mcp-test.mjs「管理口令、普通员工、有做没有拍板的角色、
    没有授予的管理员、本机命令行：清单里都没有这类条目」和「他们来答：和直接调那条路由一样被拒」），这里不再塞给没资格的人。
(b) 有资格的人（合成管理员）在卡片上点：变更申请「通过并回滚」「不通过」（带理由）走统一答复入口 POST /api/attention/answer；
    AI 会话申请工具「批准」「不给」（带理由）按条目的 answer_via 发到它自己的地址。断言每个请求的路径、方法、请求体。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
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
    pg.goto(M + path); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(500)

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
    card('合成台 9101').get_by_role('button', name=re.compile(r'通过并回滚')).click(); pg.wait_for_timeout(600)
    check('变更申请「通过并回滚」：POST /api/attention/answer，带来源、编号、答法', any(x['method'] == 'POST' and x['path'] == '/api/attention/answer'
          and x['body'] == {'source': 'change-requests', 'source_id': '9101', 'answer': 'approve', 'input': {}} for x in sent), sent)
    c2 = card('合成台 9102'); c2.get_by_role('button', name=re.compile(r'不\s*通\s*过')).click(); pg.wait_for_timeout(300)
    c2.locator('textarea').fill('合成：先不回滚'); c2.get_by_role('button', name=re.compile('确定')).click(); pg.wait_for_timeout(600)
    check('变更申请「不通过」：要写理由，理由带在请求里', any(x['method'] == 'POST' and x['path'] == '/api/attention/answer'
          and x['body'] == {'source': 'change-requests', 'source_id': '9102', 'answer': 'reject', 'input': {'reason': '合成：先不回滚'}} for x in sent), sent)
    # 按 answer_via 走的
    g = card('合成会话'); g.get_by_role('button', name=re.compile(r'不\s*给')).click(); pg.wait_for_timeout(300)
    g.locator('textarea').fill('合成：只给读'); g.get_by_role('button', name=re.compile('确定')).click(); pg.wait_for_timeout(600)
    check('AI 会话申请「不给」：按 answer_via 发到它自己的地址，请求体 = body + 理由', any(x['method'] == 'POST' and x['path'] == VIA['path']
          and x['body'] == {'approve': False, 'note': '合成：只给读'} for x in sent), sent)
    visit(pg, '/')
    g = card('合成会话'); g.get_by_role('button', name=re.compile(r'批\s*准')).click(); pg.wait_for_timeout(300)
    if g.locator('textarea').count(): g.get_by_role('button', name=re.compile('确定')).click(); pg.wait_for_timeout(600)
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
        card('合成台 9201').get_by_role('button', name=re.compile(r'通过并删除')).click(); pg.wait_for_timeout(300)
        pg.get_by_role('button', name='再想想').click(); pg.wait_for_timeout(500)
        if status == 409:
            check('确认框里取消：不发任何请求', not sent2 and not [w for w in writes if '/api/' in w[1]], (sent2, writes))
        # 答复入口拒绝：卡片还在、按钮还能点、给出错误，不显示成办完了
        card('合成台 9202').get_by_role('button', name=re.compile(r'通过并回滚')).click(); pg.wait_for_timeout(800)
        msgs = ' '.join(pg.locator('.ant-message-notice').all_inner_texts())
        still = card('合成台 9202').count() == 1 and card('合成台 9202').get_by_role('button', name=re.compile(r'通过并回滚')).is_enabled()
        check(f'答复入口回 {status}：卡片还在、还能再试，给出错误、不说「办好了」', len(sent2) == 1 and still and '办好了' not in msgs and ('合成：这条已经有人定过了' in msgs if status == 409 else len(msgs) > 0), (sent2, msgs))
        ctx.close()
    b.close()
print(f'approval-gate-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
