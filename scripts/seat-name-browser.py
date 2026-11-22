"""席位不露句柄（协调 2026-11-12）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
全景的卡片、事项列表、事项详情（摘要、时间线）用合成的应答（page.route 截下），里面的席位、说话人全是句柄（<区>/<编号>）、名册里查不到：
  · 整页文字里没有 dsh/… 这类句柄；
  · 查不到名字的席位写「一位 AI 员工」；名字 · 句柄的只写名字。数据全是合成的。"""
import json, re, sys
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def soft(fn):
    """等条件成立；等不到不在这里抛错，照常往下，由后面原来的断言报（带着当时的值）"""
    try: fn()
    except PWTimeout: pass
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
HANDLE = re.compile(r'\b[A-Za-z0-9_-]+/[0-9a-f]{6,}\b')
STATES = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked', 'done', 'failed', 'dropped', 'cancelled']

ITEM = {'id': 'wi-syn-1', 'title': '合成：核对一批到货', 'state': 'progress', 'created_by': 'user:syn-a', 'creator_principal': 'user:syn-a', 'created_at': '2026-11-10 08:00:00', 'updated_at': '2026-11-12 08:00:00',
        'source_kind': 'arrange', 'source_ref': '', 'target_team': 'dsh/canvas/合成团队', 'seat': 'dsh/5eed0a17', 'eval': 'accept', 'eval_reason': '', 'progress_summary': '', 'receipt_outcome': '', 'object': '', 'phase': '', 'open_asks': '', 'outputs': '', 'evidence': ''}
LOG = [
    {'seq': 1, 'fact': 'create', 'fact_source': 'arrange', 'fact_id': '', 'from_state': '', 'to_state': 'draft', 'actor': 'user:syn-a', 'detail': '{}', 'at': '2026-11-12 01:00:00', 'rejected': ''},
    {'seq': 2, 'fact': 'receipt', 'fact_source': 'a2a', 'fact_id': '', 'from_state': 'delivered', 'to_state': 'accepted', 'actor': 'receiver:dsh', 'detail': json.dumps({'by': {'seat': 'dsh/1a2b3c4d'}}), 'at': '2026-11-12 02:00:00', 'rejected': ''},
    {'seq': 3, 'fact': 'progress', 'fact_source': 'a2a', 'fact_id': '', 'from_state': 'accepted', 'to_state': 'progress', 'actor': 'seat:dsh/5e6f7a8b', 'detail': json.dumps({'text': '在做'}), 'at': '2026-11-12 03:00:00', 'rejected': ''},
]
DETAIL = {'item': ITEM, 'log': LOG, 'messages': [], 'unread': 0, 'progress': None, 'can': {}, 'turn': {}, 'creator': {'principal': 'user:syn-a', 'display_name': '合成甲'}}
ROW = {'id': 'wi-syn-1', 'title': '合成：核对一批到货', 'state': 'progress', 'object': None, 'phase': None, 'seat': 'dsh/5eed0a17',
       'last_progress': {'actor': 'receiver:dsh', 'fact': 'progress', 'text': '在做', 'at': '2026-11-12T03:00:00Z'}, 'updated_at': '2026-11-12T03:00:00Z'}
LIST = {'view': 'mine', 'views': {'mine': {'available': True, 'count': 1}}, 'items': [ROW], 'counts': {**{s: 0 for s in STATES}, 'progress': 1}, 'total': 1, 'next_cursor': None}
ATT = {'items': [{'source': 'work-items', 'source_id': 'wi-syn-2', 'category': 'accept', 'title': '合成：等验收的一件', 'waiting_for': 'dsh/5eed0a17', 'since': '2026-11-12T00:00:00Z',
                  'answers': ['verify', 'return'], 'object': '', 'phase': '', 'link': '/work-items/wi-syn-2', 'mine': True, 'creator': {'principal': 'user:syn-a', 'display_name': '合成甲'}}],
       'counts': {'total': 1, 'by_category': {'ask': 0, 'review': 0, 'accept': 1, 'glance': 0, 'grant': 0}}, 'sources': {}}

def text_of(pg): return pg.locator('main, .wm-page').first.inner_text()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    J = lambda body: (lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(body)))
    pg.route(re.compile(r'/api/attention(\?|$)'), J(ATT))
    pg.route(re.compile(r'/api/work-items/wi-syn-1$'), J(DETAIL))
    pg.route(re.compile(r'/api/work-items(\?|$)'), J(LIST))
    pg.goto(M + '/'); pg.wait_for_selector('[data-testid=decision-card]')
    # 等席位名字画出来：卡片上出现「一位 AI 员工」（名字是另取名册后才换上的），再看有没有露句柄
    soft(lambda: pg.wait_for_function("() => document.querySelector('[data-testid=decision-card]')?.innerText.includes('一位 AI 员工')", timeout=10000))
    home = pg.locator('[data-testid=decision-card]').first.inner_text()
    check('全景的卡片：等谁是查不到名字的席位，写「一位 AI 员工」、不露句柄', not HANDLE.search(home) and '一位 AI 员工' in home, home)
    pg.goto(M + '/work-items'); pg.wait_for_selector('[data-testid=work-item-row]')
    # 等列表里的席位名字画出来：页面上出现「一位 AI 员工」
    soft(lambda: pg.wait_for_function("() => document.body.innerText.includes('一位 AI 员工')", timeout=10000))
    lst = text_of(pg)
    check('事项列表：整页没有 dsh/… 句柄，席位写「一位 AI 员工」', not HANDLE.search(lst) and '一位 AI 员工' in lst, HANDLE.findall(lst))
    pg.goto(M + '/work-items/wi-syn-1'); pg.wait_for_selector('[data-testid=work-item-summary]')
    # 等时间线画出来（句柄最可能出现在时间线里）：有了 timeline-row（日志各条是同一次应答一起画的），再看整页有没有露句柄
    soft(lambda: pg.locator('[data-testid=timeline-row]').first.wait_for(timeout=10000))
    # 再等摘要里的承接名字画出来：出现「一位 AI 员工」（名字是名册取回以后才换上的），再做后面的断言
    soft(lambda: pg.wait_for_function("() => document.querySelector('[data-testid=work-item-summary]')?.innerText.includes('一位 AI 员工')", timeout=10000))
    det = text_of(pg)
    check('事项详情（摘要、时间线）：整页没有 dsh/… 句柄', not HANDLE.search(det), HANDLE.findall(det))
    check('事项详情：承接写「一位 AI 员工」', '一位 AI 员工' in pg.locator('[data-testid=work-item-summary]').inner_text())
    b.close()

print(f'seat-name-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
