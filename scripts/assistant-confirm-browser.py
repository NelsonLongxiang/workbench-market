"""「待你确认」页（/assistant/confirm/<id>，一人一助理第 1 期，接口见 docs/assistant-phase1.md 第三节第 3、5 条）浏览器回归；
由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。/api/assistant/confirms/<id> 用 page.route 截成合成的应答，记下页面发了什么：
  一、读：没登录去登录（回到这一条）；不是你的（403，不存在也一样）；口令、令牌（403 session_only）；服务端没上线（404）；出错再试；
  二、待确认：写谁的助理、市场写的描述（标明不是助理写的）、还剩多久；打的字不对按钮不能点，不修剪空格；
      「确认，去办」发 { answer: confirm, typed: 确认 }；办好了只显示结果和站内结果链接，不再给提交框；
  三、「不办」发 { answer: decline }，不带 typed；409（已经过期）照当前状态说；422 打的字不对，还能再交；
  四、时钟走到时限：当已过期，不再给提交框；
  五、这一页发出的请求都不带管理员口令头、不带 Authorization；不露确认编号和助理的主体标识；不进侧栏。
数据全是合成的。"""
import json, os, re, sys, datetime
SHOT = os.environ.get('WM_SHOT_CONFIRM')  # 本机看样子用，CI 不设
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
iso = lambda dt: dt.strftime('%Y-%m-%dT%H:%M:%SZ')
NOW = datetime.datetime.now(datetime.timezone.utc)

def item(**kw):
    base = {'id': 'c-syn-1', 'description': '把「合成事项甲」的期限改成 11 月 20 日', 'assistant': 'assistant:syn-a', 'assistant_label': '合成甲的助理',
            'created_at': iso(NOW - datetime.timedelta(minutes=1)), 'expires_at': iso(NOW + datetime.timedelta(minutes=4)), 'status': 'pending', 'result': {}, 'link': ''}
    base.update(kw); return base

state = {}
sent = []
all_sent = []  # 整个测试里这一页发出的全部请求（每开一页 sent 会清）
def setup(ctx):
    def confirms(r):
        h = r.request.headers
        body = r.request.post_data
        sent.append({'method': r.request.method, 'path': re.sub(r'^https?://[^/]+', '', r.request.url), 'token': 'x-admin-token' in h, 'auth': 'authorization' in h, 'body': json.loads(body) if body else None})
        all_sent.append(sent[-1])
        if r.request.method == 'GET':
            code = state.get('get', 200)
            return fake(r, state.get('get_body', {'error': 'x'}), code) if code != 200 else fake(r, state['item'])
        code, res = state.get('post', (200, {'status': 'done', 'result': {}, 'link': '/work-items/wi-syn-1'}))
        fake(r, res, code)
    ctx.route(re.compile(r'/api/assistant/confirms/[^/?]+$'), confirms)

def open_page(b, cid='c-syn-1', **st):
    state.clear(); state.update({'item': item()}, **st); sent.clear()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + f'/assistant/confirm/{cid}'); pg.wait_for_selector('[data-testid=confirm-foot]'); pg.wait_for_timeout(400)
    return ctx, pg

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        print('一、读')
        for code, err, tid, words in ((401, 'not_signed_in', 'confirm-login', '请先登录'), (403, 'not_yours', 'confirm-not-yours', '这一条不是给你的'),
                                      (403, 'session_only', 'confirm-session-only', '管理员口令'), (404, 'not_found', 'confirm-missing', '本站还没有上线助理'), (500, 'x', 'confirm-error', '读不到这一条')):
            ctx, pg = open_page(b, get=code, get_body={'error': err})
            el = pg.locator(f'[data-testid={tid}]')
            check(f'{code} {err}：{words}', el.count() == 1 and words in el.inner_text(), pg.locator('main').inner_text()[:160])
            if code == 401: check('401：「去登录」登录完回到这一条', pg.get_by_role('link', name=re.compile('去登录')).get_attribute('href') == '/login?next=%2Fassistant%2Fconfirm%2Fc-syn-1')
            if code == 403 and err == 'not_yours': check('不是你的：页面上没有提交框，也没有描述', pg.locator('[data-testid=confirm-input]').count() == 0 and '合成事项甲' not in pg.locator('main').inner_text())
            ctx.close()

        print('二、待确认 → 确认')
        ctx, pg = open_page(b)
        main = pg.locator('main').inner_text()
        check('写谁的助理、市场写的描述（标明不是助理写的）、还剩多久', '合成甲的助理' in pg.locator('[data-testid=confirm-who]').inner_text() and '由市场写，不是助理写的' in pg.locator('[data-testid=confirm-desc]').inner_text()
              and '11 月 20 日' in main and re.search(r'还剩 \d 分', pg.locator('[data-testid=confirm-left]').inner_text()))
        check('不露确认编号和助理的主体标识', 'c-syn-1' not in main and 'assistant:' not in main)
        check('不进侧栏：侧栏里没有「待你确认」；顶栏写「待你确认」', pg.locator('[data-testid=wm-side]').inner_text().count('待你确认') == 0 and '待你确认' in pg.locator('[data-testid=wm-top]').inner_text())
        if SHOT: pg.screenshot(path=SHOT)
        inp, okb = pg.locator('[data-testid=confirm-input]'), pg.locator('[data-testid=confirm-ok]')
        check('没打字：「确认，去办」不能点', okb.is_disabled())
        inp.fill('好的'); check('打的不是「确认」：不能点，提示要恰好两个字', okb.is_disabled() and '不带空格' in pg.locator('[data-testid=confirm-hint]').inner_text())
        inp.fill('确认 '); check('「确认」后面带空格：也不能点（前端不替人修剪）', okb.is_disabled())
        inp.fill('确认'); check('恰好打「确认」：能点', okb.is_enabled())
        okb.click(); pg.wait_for_selector('[data-testid=confirm-outcome]')
        posts = [x for x in sent if x['method'] == 'POST']
        check('确认：POST 这一条，请求体 { answer: confirm, typed: 确认 }（原样）', posts and posts[-1]['path'] == '/api/assistant/confirms/c-syn-1' and posts[-1]['body'] == {'answer': 'confirm', 'typed': '确认'}, posts)
        out = pg.locator('[data-testid=confirm-outcome]').inner_text()
        check('办好了：只显示结果（已办 + 一句话）和站内结果链接，提交框没了', '已办' in out and '重新判过' in out and pg.locator('[data-testid=confirm-result-link]').get_attribute('href') == '/work-items/wi-syn-1' and pg.locator('[data-testid=confirm-input]').count() == 0)
        ctx.close()

        print('三、不办、409、422')
        ctx, pg = open_page(b, post=(200, {'status': 'declined'}))
        pg.locator('[data-testid=confirm-decline]').click(); pg.wait_for_selector('[data-testid=confirm-outcome]')
        posts = [x for x in sent if x['method'] == 'POST']
        check('不办：发 { answer: decline }，不带 typed；显示「你没办」、什么也没改', posts[-1]['body'] == {'answer': 'decline'} and '你没办' in pg.locator('[data-testid=confirm-outcome]').inner_text() and '什么也没改' in pg.locator('[data-testid=confirm-outcome]').inner_text(), posts)
        ctx.close()
        ctx, pg = open_page(b, post=(409, {'status': 'expired'}))
        pg.locator('[data-testid=confirm-input]').fill('确认'); pg.locator('[data-testid=confirm-ok]').click(); pg.wait_for_selector('[data-testid=confirm-outcome]')
        check('409 已经过期：照当前状态显示「已过期」，提交框没了', '已过期' in pg.locator('[data-testid=confirm-outcome]').inner_text() and pg.locator('[data-testid=confirm-input]').count() == 0)
        ctx.close()
        ctx, pg = open_page(b, post=(422, {'error': 'typed_mismatch'}))
        pg.locator('[data-testid=confirm-input]').fill('确认'); pg.locator('[data-testid=confirm-ok]').click(); pg.wait_for_selector('[data-testid=confirm-problem]')
        check('422 打的字不对：说要恰好两个字，提交框还在，可以再交', '不带空格' in pg.locator('[data-testid=confirm-problem]').inner_text() and pg.locator('[data-testid=confirm-input]').count() == 1)
        ctx.close()
        for st, words in (('stale', '相关的数据变了'), ('denied', '已经没有办这件事的权限'), ('cancelled', '已作废'), ('failed', '没办成')):
            ctx, pg = open_page(b, item=item(status=st))
            check(f'打开时已经是 {st}：只显示结果（{words}），没有提交框', words in pg.locator('[data-testid=confirm-outcome]').inner_text() and pg.locator('[data-testid=confirm-input]').count() == 0)
            ctx.close()

        print('四、时钟走到时限')
        ctx, pg = open_page(b, item=item(expires_at=iso(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=3))))
        check('快到时限：还给提交框', pg.locator('[data-testid=confirm-input]').count() == 1)
        pg.wait_for_selector('[data-testid=confirm-outcome]', timeout=8000)
        check('走到时限：当已过期，提交框没了，不用刷新', '已过期' in pg.locator('[data-testid=confirm-outcome]').inner_text() and pg.locator('[data-testid=confirm-input]').count() == 0)
        ctx.close()

        print('五、请求')
        check(f'这一页发出的请求（整个测试里 {len(all_sent)} 个，含确认和不办）都不带管理员口令头、不带 Authorization', len(all_sent) >= 10 and any(x['method'] == 'POST' for x in all_sent) and not any(x['token'] or x['auth'] for x in all_sent), [x for x in all_sent if x['token'] or x['auth']])
    finally:
        b.close()

print(f'assistant-confirm-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
