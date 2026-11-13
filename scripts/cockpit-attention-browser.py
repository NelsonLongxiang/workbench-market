"""驾驶舱左栏「等你拍板」的紧凑行（照原型，协调定 (b)）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
「关注」和事项详情用合成的应答（page.route 截下），核对：
  · 一行一条：标题、等了多久、右边一个「等你做什么」的标签；左栏里没有按钮；1440×900 下露出八条以上；
  · 只列轮到你、能当场办的——行数和侧栏角标是同一个数（别人的事、你能代办的不进来）；
  · 点一行：这一行高亮，右栏切到「办理过程」，上面是它的答法（全景同一张卡）和「看详情 →」，下面是它挂的事项的时间线；
  · 挂的不是事项（授权这类）：只有答法和去处，没有时间线；
  · 在右栏办完一条：它从左栏消失，右栏回到没选的样子；
  · 没选的时候右栏说怎么选。数据全是合成的。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

def acc(i, mine=True, hours=1):
    return {'source': 'work-items', 'source_id': f'wi-syn-{i}', 'category': 'accept', 'title': f'合成事项 {i}：核对一批到货数量', 'waiting_for': 'person:syn-c', 'waiting_for_name': '合成建立人',
            'since': f'2026-11-12T0{hours % 10}:00:00Z', 'answers': ['verify', 'return'], 'object': '', 'phase': '', 'link': f'/work-items/wi-syn-{i}', 'mine': mine,
            'creator': {'principal': 'user:syn-c', 'display_name': '合成建立人'}}
GRANT = {'source': 'relation-proposals', 'source_id': '9001', 'category': 'grant', 'title': '合成：关系的提议', 'waiting_for': 'person:x', 'waiting_for_name': '合成同事甲',
         'since': '2026-11-12T00:00:00Z', 'answers': ['approve', 'reject'], 'object': '', 'phase': '', 'link': '/team', 'mine': True,
         'answer_via': {'method': 'POST', 'path': '/api/relations/proposals/9001/approve', 'answers': {'approve': {'body': {}}}}}
ITEMS = [acc(i, hours=i) for i in range(1, 10)] + [acc(20, mine=False), GRANT]
state = {'items': list(ITEMS)}
def attention(route):
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'items': state['items'], 'counts': {'total': len(state['items'])}, 'sources': {}}))
def detail(route):
    i = re.search(r'wi-syn-(\d+)$', route.request.url).group(1)
    body = {'item': {'id': f'wi-syn-{i}', 'title': f'合成事项 {i}：核对一批到货数量', 'state': 'ready', 'seat': ''},
            'log': [{'seq': 1, 'fact': 'create', 'fact_source': 'arrange', 'fact_id': '', 'from_state': '', 'to_state': 'draft', 'actor': 'user:syn-c', 'detail': '{}', 'at': '2026-11-12 01:00:00', 'rejected': ''},
                    {'seq': 2, 'fact': 'receipt', 'fact_source': 'a2a', 'fact_id': '', 'from_state': 'progress', 'to_state': 'ready', 'actor': 'receiver:syn', 'detail': '{}', 'at': '2026-11-12 02:00:00', 'rejected': ''}]}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
decided = []
def decision(route):
    i = re.search(r'wi-syn-(\d+)/decision$', route.request.url).group(1)
    decided.append((i, json.loads(route.request.post_data or '{}')))
    state['items'] = [x for x in state['items'] if x['source_id'] != f'wi-syn-{i}']
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True}))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route(re.compile(r'/api/attention(\?|$)'), attention)
    pg.route(re.compile(r'/api/work-items/wi-syn-\d+$'), detail)
    pg.route(re.compile(r'/api/work-items/wi-syn-\d+/decision$'), decision)
    pg.goto(M + f'/cockpit/{cfg["cockpit"]}'); pg.wait_for_selector('[data-testid=ck-row]')
    rows = pg.locator('[data-testid=ck-row]')
    nav = pg.locator('[data-testid=nav-pending]')
    check('只列轮到你、能当场办的：行数和侧栏角标同一个数（别人的事不进来）', rows.count() == 10 and nav.count() == 1 and nav.inner_text().strip() == '10' and pg.locator('[data-testid=ck-row][data-key="work-items:wi-syn-20"]').count() == 0, (rows.count(), nav.all_inner_texts()))
    first = ''.join(rows.first.inner_text().split())
    check('一行：标题、等了多久、右边「等你验收」标签', '合成事项' in first and '等了' in first and first.endswith('等你验收'), first)
    check('授权那一条的标签写「等你核准」', '等你核准' in pg.locator('[data-testid=ck-row][data-key="relation-proposals:9001"]').inner_text())
    check('左栏里没有按钮（答法在右栏）', pg.locator('[data-testid=ck-attention] .ant-btn').count() == 0)
    pane = pg.locator('[data-testid=ck-attention]').bounding_box()
    shown = pg.evaluate("(b) => [...document.querySelectorAll('[data-testid=ck-row]')].filter(e => { const r = e.getBoundingClientRect(); return r.top >= b.y && r.bottom <= b.y + b.height && r.bottom <= innerHeight; }).length", pane)
    check(f'1440×900 下左栏露出八条以上（{shown}）', shown >= 8, shown)
    check('没选的时候右栏说怎么选', '点一条' in pg.locator('.wm-ck').inner_text())

    target = pg.locator('[data-testid=ck-row][data-key="work-items:wi-syn-3"]')
    target.click(); pg.wait_for_selector('[data-testid=ck-process-timeline]')
    check('点一行：这一行高亮（aria-current），右栏切到「办理过程」', target.get_attribute('aria-current') == 'true' and pg.locator('[data-testid=ck-row][aria-current=true]').count() == 1)
    proc = pg.locator('[data-testid=ck-process]')
    check('右栏上面是「看详情 →」去这件事项，再下面是它的答法（验收通过 / 打回重做），最下面是时间线', proc.locator('[data-testid=ck-process-more]').get_attribute('href') == '/work-items/wi-syn-3'
          and proc.locator('[data-testid=ck-process-answer] [data-testid=decision-card]').count() == 1 and proc.get_by_role('button', name=re.compile('验收\\s*通过')).count() == 1
          and proc.locator('[data-testid=ck-process-timeline]').count() == 1 and proc.get_by_text('看详情').count() == 1, proc.inner_text()[:300])
    pg.locator('[data-testid=ck-row][data-key="relation-proposals:9001"]').click(); pg.wait_for_timeout(500)
    check('挂的不是事项（授权）：只有答法和去处，没有时间线', proc.locator('[data-testid=ck-process-timeline]').count() == 0 and proc.locator('[data-testid=decision-card]').count() == 1 and proc.locator('[data-testid=ck-process-more]').get_attribute('href') == '/team')
    # 在右栏办完一条：从左栏消失，右栏回到没选的样子
    target.click(); pg.wait_for_selector('[data-testid=ck-process-timeline]')
    proc.get_by_role('button', name=re.compile('验收\\s*通过')).click(); pg.wait_for_timeout(300)
    confirm = pg.locator('.ant-popconfirm .ant-btn-primary, [data-testid=decision-confirm]')
    if confirm.count(): confirm.first.click()
    pg.wait_for_function("() => !document.querySelector('[data-testid=ck-row][data-key=\"work-items:wi-syn-3\"]')", timeout=10000)
    pg.wait_for_timeout(400)
    check('在右栏验收：发到这件事项的决定入口；它从左栏消失，件数和角标一起少一', decided and decided[0][0] == '3' and rows.count() == 9 and nav.inner_text().strip() == '9', (decided, rows.count(), nav.all_inner_texts()))
    check('选中的那条办完了：右栏回到没选的样子', pg.locator('[data-testid=ck-process]').count() == 0 and '点一条' in pg.locator('.wm-ck').inner_text())
    b.close()

print(f'cockpit-attention-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
