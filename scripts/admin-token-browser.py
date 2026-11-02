"""Admin-token browser probes (synthetic token, loopback only). Called by admin-token-browser.mjs.
属主 2026-11-02 撤销 #292 M1：业务面凭口令即可做管理写；#292 M4 止血（持口令时不内嵌 /go/、离开页面抹口令）保留。"""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
base, wid, tok = cfg['base'], cfg['wid'], cfg['token']
passed = failed = 0
def ok(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1; print('  ✓', name)
    else: failed += 1; print('  ✗', name, extra)

def go_frames(page):
    return page.locator(f'iframe[src="/go/{wid}/"]').count()

def set_token(page):
    page.get_by_role('button', name='口令').click()
    page.get_by_placeholder('ADMIN_TOKEN').fill(tok)
    page.get_by_role('button', name=re.compile(r'^保\s*存$')).click()  # antd 两字按钮会插空格
    page.get_by_role('button', name='口令已设').wait_for()

WRITE = '''async ([t]) => { const r = await fetch("/api/workbenches", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": t }, body: JSON.stringify({ name: "from-page", url: "http://127.0.0.1:9/", type: "web" }) }); return { status: r.status, body: await r.json().catch(() => null) }; }'''
VIEWER = {'ok': True, 'viewer': {'login': 'pm-a', 'uid': 7, 'sub': 'user:pm-a', 'name': '测试 PM-A', 'kind': '人'}, 'roles': None}
ANON = json.dumps({'ok': False, 'auth_required': True, 'login_url': f'/go/{wid}/'})

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        print('业务面管理（属主 2026-11-02：口令即可，不再限控制面）')
        c = b.new_context()
        page = c.new_page()
        page.goto(base + f'/use/{wid}'); page.wait_for_timeout(1200)
        ok('未设口令：使用页照常内嵌 /go/', go_frames(page) == 1)
        page.goto(base + f'/cockpit/{cfg["cockpit"]}'); page.wait_for_timeout(1200)
        ok('未设口令：驾驶舱照常内嵌 /go/、只读（没有新建/加面板）', go_frames(page) == 1 and page.get_by_text('驾驶舱在这里只能查看').count() >= 1)
        page.goto(base + '/market'); page.wait_for_timeout(800)
        ok('业务面顶栏有口令输入，没有「管理控制面」链接', page.get_by_role('button', name=re.compile(r'口\s*令$')).count() == 1 and page.get_by_role('link', name=re.compile('管理控制面')).count() == 0)
        set_token(page)
        r = page.evaluate(WRITE, [tok])
        ok('业务面页面带对口令发管理写 → 201', r['status'] == 201, str(r))
        r = page.evaluate(WRITE, ['wrong-token'])
        ok('业务面页面带错口令 → 403', r['status'] == 403, str(r))
        for v in ('/API/workbenches', '/Api/Workbenches'):
            rv = page.evaluate(WRITE.replace('"/api/workbenches"', json.dumps(v)), [''])
            ok(f'业务面页面 fetch 大写变体 {v}（不带口令）→ 403', rv['status'] == 403, str(rv))
        ok('设口令后管理菜单组出现', page.get_by_text('管理', exact=True).count() >= 1)
        page.evaluate(f'history.pushState(null, "", "/cockpit/{cfg["cockpit"]}"); dispatchEvent(new PopStateEvent("popstate"))'); page.wait_for_timeout(1200)
        ok('持口令：驾驶舱可编辑（不再显示只读提示）', page.get_by_text('驾驶舱在这里只能查看').count() == 0, page.url)
        ok('持口令：驾驶舱不内嵌 /go/（#292 M4 止血保留）', go_frames(page) == 0)
        page.evaluate(f'history.pushState(null, "", "/use/{wid}"); dispatchEvent(new PopStateEvent("popstate"))'); page.wait_for_timeout(1200)
        ok('持口令：使用页不内嵌 /go/，给出「清除口令并内嵌」', go_frames(page) == 0 and page.get_by_role('button', name='清除口令并内嵌').count() == 1)
        page.get_by_role('button', name='清除口令并内嵌').click(); page.wait_for_timeout(1500)
        ok('清除口令后才内嵌 /go/，存储为空', go_frames(page) == 1 and page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        pr = page.frames[-1].evaluate('window.__probe')
        ok('内嵌的上游页读自己和父页都没有口令', pr.get('own') is None and pr.get('parent') is None, str(pr))
        c.close()

        print('同标签页离开市场页面即抹掉口令（#292 M4）')
        c = b.new_context(); page = c.new_page()
        page.goto(base + '/market'); page.wait_for_timeout(600); set_token(page)
        page.goto(base + f'/go/{wid}/'); page.wait_for_timeout(1200)
        ok('同一标签页跳到 /go/ 后，新文档读不到口令', page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        c.close()

        print('业务面登录弹窗（M4 残余）')
        for label, path, scope, btn, auto in (
            ('顶栏 chip', '/market', None, re.compile(r'^登\s*录$'), False),
            ('/lifecycle', '/lifecycle', '.ant-result', '在弹窗登录 Odoo', True),
            ('统一待办', '/tasks', None, '在弹窗登录 Odoo 查看生命周期待办', False),
        ):
            c = b.new_context(); opened = []
            c.on('page', lambda pg: opened.append(pg))
            q = c.new_page(); who = {'s': 'anon'}
            q.route('**/api/lifecycle/whoami', lambda r: r.fulfill(status=401, content_type='application/json', body=ANON) if who['s'] == 'anon' else r.fulfill(status=200, content_type='application/json', body=json.dumps(VIEWER)))
            q.route('**/api/lifecycle/board*', lambda r: r.fulfill(status=401, content_type='application/json', body=ANON))
            def tasks_route(route):
                # #324: anonymous identity is rejected before any private source fetch.
                if who['s'] == 'anon':
                    route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': 'tasks_auth_required', 'login_url': f'/go/{wid}/'}))
                else:
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'tasks': [], 'sources': {'market': {'ok': False, 'count': 0, 'latency_ms': 0, 'error': 'source_not_authorized'}, 'ygl-trees': {'ok': False, 'count': 0, 'latency_ms': 0, 'error': 'source_not_authorized'}}, 'generated_at': '2026-01-01T00:00:00Z'}))
            q.route('**/api/tasks', tasks_route)
            q.goto(base + path)
            loc = (q.locator(scope) if scope else q).get_by_role('button', name=btn)
            loc.first.wait_for(timeout=8000); q.wait_for_timeout(1500)
            pre = len(opened) - 1
            ok(f'{label}：点之前{"自动开 1 个" if auto else "没有"}登录窗', pre == (1 if auto else 0), f'已开 {pre} 个')
            loc.first.click(); q.wait_for_timeout(2500)
            total = len(opened) - 1
            ok(f'{label}：点之后总共只有 1 个登录窗', total == 1, f'共 {total} 个')
            pops = [pg for pg in opened[1:] if not pg.is_closed()]
            if pops:
                pops[0].wait_for_function('window.__probe !== undefined', timeout=8000)
                ok(f'{label}：登录窗没有 opener、没有口令', pops[0].evaluate('window.__probe') .get('opener') == 'no-opener' and pops[0].evaluate('window.__probe').get('own') is None, str(pops[0].evaluate('window.__probe')))
            who['s'] = 'ok'; q.wait_for_timeout(4000)
            ok(f'{label}：登录成功后没有遗留的登录窗', all(pg.is_closed() for pg in opened[1:]))
            c.close()

        c = b.new_context(); q = c.new_page(); who = {'s': 'anon'}
        q.route('**/api/lifecycle/whoami', lambda r: r.fulfill(status=401, content_type='application/json', body=ANON) if who['s'] == 'anon' else r.fulfill(status=200, content_type='application/json', body=json.dumps(VIEWER)))
        q.goto(base + '/market'); q.get_by_text('未登录 Odoo').wait_for()
        with c.expect_page() as pp:
            q.get_by_role('button', name=re.compile(r'^登\s*录$')).click()
        pp.value.close(); q.wait_for_timeout(500); who['s'] = 'ok'  # 模拟 COOP 断开 / 先关弹窗，随后才登录成功
        q.get_by_text('测试 PM-A（pm-a）· 人').wait_for(timeout=8000)
        ok('弹窗先关、随后才登录成功：轮询补查照常收尾', True)
        c.close()
    finally:
        b.close()
print(f'admin-token-browser: {passed} passed / {failed} failed')
sys.exit(1 if failed else 0)
