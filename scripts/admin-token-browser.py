"""#292 M1 (+M4 残余) browser probes (synthetic token, loopback only). Called by admin-token-browser.mjs.
业务面（market）不输口令、不做管理写；控制面（control）只做管理、不跑不可信内容；两面互读不到。"""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
base, ctl, wid, tok = cfg['base'], cfg['control'], cfg['wid'], cfg['token']
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
        print('业务面')
        c = b.new_context()
        c.add_init_script('try { if (location.pathname === "/market" && !sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem("wm-admin-token", "leftover-from-before-m1"); } } catch (e) {}')
        page = c.new_page()
        page.goto(base + '/market'); page.wait_for_timeout(800)
        link = page.get_by_role('link', name=re.compile('管理控制面'))
        ok('业务面没有口令输入，只有「管理控制面」链接（同 path）', page.get_by_placeholder('ADMIN_TOKEN').count() == 0 and page.get_by_role('button', name=re.compile(r'口\s*令$')).count() == 0 and link.count() >= 1 and link.first.get_attribute('href') == ctl + '/market', str(link.first.get_attribute('href') if link.count() else None))
        ok('业务面启动时清掉 M1 之前留下的口令', page.evaluate('sessionStorage.getItem("wm-admin-token")') is None)
        r = page.evaluate(WRITE, [tok])
        ok('业务面页面带对口令发管理写 → 403 指向控制面（偷到口令也用不了）', r['status'] == 403 and (r['body'] or {}).get('control_surface_required') is True, str(r))
        for v in ('/API/workbenches', '/Api/Workbenches'):
            for t in ('', tok):
                rv = page.evaluate(WRITE.replace('"/api/workbenches"', json.dumps(v)), [t])
                ok(f'业务面页面 fetch 大写变体 {v}（{"带" if t else "不带"}口令）→ 403', rv['status'] == 403, str(rv))
        page.goto(base + f'/use/{wid}'); page.wait_for_timeout(1200)
        ok('业务面使用页照常内嵌 /go/', go_frames(page) == 1)
        page.goto(base + f'/cockpit/{cfg["cockpit"]}'); page.wait_for_timeout(1200)
        ok('业务面驾驶舱照常内嵌 /go/', go_frames(page) == 1)
        c.close()

        print('控制面')
        c = b.new_context(); cp = c.new_page()
        resp = cp.goto(ctl + '/market'); cp.wait_for_timeout(800)
        ok('控制面页面带 frame-ancestors none 与 X-Frame-Options DENY', "frame-ancestors 'none'" in resp.headers.get('content-security-policy', '') and resp.headers.get('x-frame-options') == 'DENY', str(resp.headers))
        set_token(cp)
        r = cp.evaluate(WRITE, [tok])
        ok('控制面页面带口令发管理写 → 201', r['status'] == 201, str(r))
        r = cp.evaluate(WRITE, ['wrong-token'])
        ok('控制面错口令 → 403', r['status'] == 403, str(r))
        ok('控制面不显示当前用户 chip（不走 Odoo 登录）', cp.get_by_text('未登录 Odoo').count() == 0)
        for path in (f'/use/{wid}', f'/cockpit/{cfg["cockpit"]}', '/lifecycle', '/tasks'):
            cp2 = c.new_page(); cp2.goto(ctl + path); cp2.wait_for_url(base + path + '*', timeout=8000)
            ok(f'控制面 {path} 跳回业务面同 path，控制面上不出现 /go/ iframe', cp2.url.startswith(base + path), cp2.url)
            cp2.close()
        for path in (f'/go/{wid}/', '/sop/x/', '/apps/x/'):
            rr = cp.request.get(ctl + path)
            ok(f'控制面 {path} → 404', rr.status == 404, str(rr.status))

        print('两面隔离')
        mp = c.new_page(); mp.goto(base + f'/use/{wid}'); mp.wait_for_timeout(1200)
        pr = mp.frames[-1].evaluate('window.__probe')
        ok('同一浏览器里控制面已设口令；业务面内嵌的上游页读自己和父页都没有口令', pr.get('own') is None and pr.get('parent') is None, str(pr))
        got = mp.evaluate('''async (u) => { const w = window.open(u + "/market"); await new Promise(r => setTimeout(r, 1500)); let v; try { v = w.sessionStorage.getItem("wm-admin-token"); } catch (e) { v = "blocked"; } try { w.close(); } catch (e) {} return v; }''', ctl)
        ok('业务面页面 window.open 控制面后读不到它的存储（跨源）', got == 'blocked', str(got))
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
