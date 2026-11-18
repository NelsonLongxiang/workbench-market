"""「我的助理」页（/settings/assistant，一人一助理第 1 期，接口见 docs/assistant-phase1.md 第六节）浏览器回归；
由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。/api/assistant* 用 page.route 截成合成的应答，记下页面发了什么：
  一、状态：没登录 → 去登录；管理员口令、令牌（403 session_only）→ 只认本人；服务端还没上线（404）→ 说没上线；出错 → 再试一次；
      部署方没开（enabled_by_deployment 为假）→ 说本站没开放、取令牌按钮置灰，以前的记录照常列；
  二、正常：状态、接入地址、令牌那一行、等你确认件数、近 30 天件数；不露助理的主体标识和确认编号；
  三、取令牌：原文只显示一次（点「我已复制」就没了）；重置要先确认；停用要先确认、说清作废几件；停用后能启用；
  四、它替你办过的事：每条写工具的中文说法、描述、你的回答、状态；站外链接不给；「再往前看」带游标翻页；
  五、这一页发出的请求都不带管理员口令头、不带 Authorization（带了服务端一律 403）；入口在左下角用户卡里。
数据全是合成的。"""
import json, os, re, sys
SHOT = os.environ.get('WM_SHOT_ASSISTANT')  # 本机看样子用，CI 不设
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def fake(route, body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

INFO = {'assistant': 'assistant:syn-a', 'status': 'active', 'enabled_by_deployment': True, 'has_token': False, 'token_created_at': None, 'token_last_used_at': None,
        'mcp_url': 'https://market.example.invalid/mcp', 'actions_30d': 3, 'pending_confirms': 1}
PAGE1 = {'items': [
    {'id': 'c-syn-1', 'at': '2026-11-18T09:00:00Z', 'tool': 'work_item_set_due', 'tool_label': '改期限', 'description': '把「合成事项甲」的期限改成 11 月 20 日', 'answer': 'confirm', 'status': 'done', 'result': {}, 'link': '/work-items/wi-syn-1'},
    {'id': 'c-syn-2', 'at': '2026-11-18T08:30:00Z', 'tool': 'attention_answer', 'tool_label': '拍板', 'description': '对「合成申请乙」选「不给」', 'answer': 'decline', 'status': 'declined', 'result': {}, 'link': 'https://evil.example.invalid/x'},
], 'next_cursor': 'cur-syn-2'}
PAGE2 = {'items': [
    {'id': 'c-syn-3', 'at': '2026-11-17T08:00:00Z', 'tool': 'work_item_arrange', 'tool_label': '安排一件事', 'description': '安排「合成事项丙」', 'answer': 'timeout', 'status': 'expired', 'result': {}, 'link': ''},
], 'next_cursor': None}

state = {}
sent = []
def setup(ctx):
    def rec(r):
        h = r.request.headers
        sent.append({'method': r.request.method, 'path': re.sub(r'^https?://[^/]+', '', r.request.url), 'token': 'x-admin-token' in h, 'auth': 'authorization' in h})
    def assistant(r):
        rec(r)
        code = state.get('get', 200)
        if code != 200: return fake(r, {'error': state.get('get_err', 'x')}, code)
        fake(r, state['info'])
    def actions(r):
        rec(r)
        fake(r, PAGE2 if 'cursor=cur-syn-2' in r.request.url else PAGE1)
    def token(r):
        rec(r)
        if state.get('token_code', 200) != 200: return fake(r, {'error': 'not_found'}, state['token_code'])
        state['info'] = {**state['info'], 'has_token': True, 'token_created_at': '2026-11-18T10:00:00Z'}
        fake(r, {'token': 'wma_SYNTHETICtoken0000000000000000000000', 'created_at': '2026-11-18T10:00:00Z'})
    def disable(r):
        rec(r); state['info'] = {**state['info'], 'status': 'disabled', 'pending_confirms': 0}; fake(r, {'status': 'disabled', 'cancelled': 1})
    def enable(r):
        rec(r); state['info'] = {**state['info'], 'status': 'active'}; fake(r, {'status': 'active'})
    ctx.route(re.compile(r'/api/assistant$'), assistant)
    ctx.route(re.compile(r'/api/assistant/actions(\?|$)'), actions)
    ctx.route(re.compile(r'/api/assistant/token$'), token)
    ctx.route(re.compile(r'/api/assistant/disable$'), disable)
    ctx.route(re.compile(r'/api/assistant/enable$'), enable)

def open_page(b, **st):
    state.clear(); state.update({'info': dict(INFO)}, **st); sent.clear()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); setup(ctx)
    pg = ctx.new_page(); pg.set_default_timeout(10000)
    pg.goto(M + '/settings/assistant'); pg.wait_for_selector('[data-testid=assistant-intro]'); pg.wait_for_timeout(500)
    return ctx, pg

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        print('一、各种状态')
        for code, err, tid, words in ((401, 'not_signed_in', 'assistant-login', '请先登录'), (403, 'session_only', 'assistant-session-only', '管理员口令'),
                                      (404, 'not_found', 'assistant-missing', '本站还没有上线助理'), (500, 'x', 'assistant-error', '读不到你的助理')):
            ctx, pg = open_page(b, get=code, get_err=err)
            el = pg.locator(f'[data-testid={tid}]')
            check(f'{code}：{words}', el.count() == 1 and words in el.inner_text(), pg.locator('main').inner_text()[:160])
            if code == 401: check('401：「去登录」回到这一页', pg.get_by_role('link', name=re.compile('去登录')).get_attribute('href') == '/login?next=%2Fsettings%2Fassistant')
            if code == 500:
                state['get'] = 200; pg.get_by_role('button', name=re.compile('再试一次')).click(); pg.wait_for_selector('[data-testid=assistant-card]')
                check('出错后点「再试一次」：读到了就显示助理', True)
            ctx.close()

        ctx, pg = open_page(b, info={**INFO, 'enabled_by_deployment': False})
        check('部署方没开：说「本站还没开放助理」，取令牌按钮置灰', pg.locator('[data-testid=assistant-not-open]').count() == 1 and pg.locator('[data-testid=assistant-token-new]').is_disabled())
        check('部署方没开：以前的记录照常列', pg.locator('[data-testid=assistant-action]').count() == 2)
        ctx.close()

        print('二、正常')
        ctx, pg = open_page(b)
        card = pg.locator('[data-testid=assistant-card]').inner_text()
        check('状态「启用中」、接入地址、令牌没取过、等你确认 1 件、近 30 天替你办过 3 件',
              '启用中' in card and 'market.example.invalid/mcp' in card and '还没取过令牌' in card and pg.locator('[data-testid=assistant-pending]').inner_text() == '1 件' and '替你办过 3 件' in card, card)
        body = pg.locator('main').inner_text()
        check('不露助理的主体标识（assistant:…）和确认编号（c-syn-…）', 'assistant:' not in body and 'c-syn-' not in body)
        check('怎么接入写三步，第三步说在已登录的市场页面上打「确认」', '打「确认」' in pg.locator('[data-testid=assistant-howto]').inner_text())
        if SHOT: pg.screenshot(path=SHOT)

        print('三、令牌、停用、启用')
        pg.locator('[data-testid=assistant-token-new]').click(); pg.wait_for_selector('[data-testid=assistant-token]')
        check('取令牌：发 POST /api/assistant/token，原文显示出来，说只显示这一次',
              any(x['method'] == 'POST' and x['path'] == '/api/assistant/token' for x in sent) and pg.locator('[data-testid=assistant-token-text]').inner_text().startswith('wma_') and '只显示这一次' in pg.locator('[data-testid=assistant-token]').inner_text())
        check('取完：令牌那一行变成「已经取过一枚」，按钮变成「重置令牌」', '已经取过一枚' in pg.locator('[data-testid=assistant-token-line]').inner_text() and pg.locator('[data-testid=assistant-token-reset]').count() == 1)
        pg.get_by_role('button', name='我已复制').click(); pg.wait_for_timeout(200)
        check('点「我已复制」：原文从页面上没了', pg.locator('[data-testid=assistant-token]').count() == 0 and 'wma_' not in pg.locator('main').inner_text())
        n = len([x for x in sent if x['path'] == '/api/assistant/token'])
        pg.locator('[data-testid=assistant-token-reset]').click(); pg.wait_for_timeout(300)
        check('重置要先确认：只点按钮不发请求，弹出的说明写清旧令牌作废', len([x for x in sent if x['path'] == '/api/assistant/token']) == n and '旧令牌立刻作废' in pg.locator('.ant-popover').last.inner_text())
        pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^重\s*置$')).click(); pg.wait_for_selector('[data-testid=assistant-token]')
        check('确认重置：再发一次，新原文显示一次', len([x for x in sent if x['path'] == '/api/assistant/token']) == n + 1)
        pg.locator('[data-testid=assistant-disable]').click(); pg.wait_for_timeout(300)
        pop = pg.locator('.ant-popover').last.inner_text()
        check('停用要先确认：说连接立刻断开、等你确认的 1 件一并作废', '连接立刻断开' in pop and '1 件一并作废' in pop, pop)
        pg.locator('.ant-popover').last.get_by_role('button', name=re.compile(r'^停\s*用$')).click(); pg.wait_for_selector('[data-testid=assistant-enable]')
        check('停用以后：状态「已停用」，令牌原文从页面上清掉，取令牌置灰，给「启用」',
              pg.locator('[data-testid=assistant-status]').inner_text() == '已停用' and pg.locator('[data-testid=assistant-token]').count() == 0 and pg.locator('[data-testid=assistant-token-reset]').is_disabled())
        check('停用的提示写清作废了几件', pg.locator('.ant-message', has_text='一并作废').count() >= 1)
        pg.locator('[data-testid=assistant-enable]').click(); pg.wait_for_selector('[data-testid=assistant-disable]')
        check('启用：发 POST /api/assistant/enable，状态回到「启用中」', any(x['path'] == '/api/assistant/enable' for x in sent) and pg.locator('[data-testid=assistant-status]').inner_text() == '启用中')

        print('四、它替你办过的事')
        rows = pg.locator('[data-testid=assistant-action]')
        first, second = rows.nth(0).inner_text(), rows.nth(1).inner_text()
        check('一条写工具的中文说法、描述、你的回答、状态', '改期限' in first and '期限改成 11 月 20 日' in first and '你确认了' in first and '已办' in first, first)
        check('不露工具代号', 'work_item' not in pg.locator('[data-testid=assistant-actions]').inner_text())
        check('站内链接给「去看结果」，站外的不给', rows.nth(0).get_by_role('link', name=re.compile('去看结果')).get_attribute('href') == '/work-items/wi-syn-1' and rows.nth(1).get_by_role('link').count() == 0)
        pg.locator('[data-testid=assistant-more]').click(); pg.wait_for_timeout(500)
        check('「再往前看」：带游标翻页，接在后面；没有下一页了按钮就收起', any('cursor=cur-syn-2' in x['path'] for x in sent) and rows.count() == 3 and '超时没确认' in rows.nth(2).inner_text() and pg.locator('[data-testid=assistant-more]').count() == 0)

        print('五、请求和入口')
        check('这一页发出的请求都不带管理员口令头、不带 Authorization', sent and not any(x['token'] or x['auth'] for x in sent), [x for x in sent if x['token'] or x['auth']])
        ctx.close()
        ctx, pg = open_page(b)
        pg.goto(M + '/'); pg.locator('[data-testid=wm-me]').click(); pg.locator('[data-testid=me-assistant]').click(); pg.wait_for_url('**/settings/assistant'); pg.wait_for_selector('[data-testid=assistant-card]')
        check('左下角用户卡里有「我的助理」，点进来就是这一页；顶栏写「我的助理」', pg.locator('[data-testid=assistant-card]').count() == 1 and '我的助理' in pg.locator('[data-testid=wm-top]').first.inner_text(), (pg.url, pg.locator('[data-testid=assistant-card]').count(), pg.locator('[data-testid=wm-top]').first.inner_text()[:80]))
        ctx.close()
    finally:
        b.close()

print(f'assistant-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
