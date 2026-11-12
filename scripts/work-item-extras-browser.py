"""事项的期限和附件浏览器回归（接口照阶段七 claude/stage7-arrange-due-attach）；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
事项详情、改期限、传附件、安排都用合成的应答（page.route 截下）：
  · 详情：有期限写日期和离今天多远；过期照服务端的 overdue 标「已过期」；期限是 null 写「不限」；没有 due 这个键（旧服务端）不画这一行；
  · 附件：右栏「附件 N」，文件名取回、写大小；外链不出现；
  · 改期限：照服务端的 can.due 给「改」；保存发 POST /due { due }，清掉发 { due: null }；结束了的事项、不是建立人都没有「改」；被拒说服务端的说法；
  · 安排一件事：选文件就传（PUT /api/work-items/attachments/<名字>，原始字节、带摘要头），传上的写大小、没传上的写原因、能去掉；安排时带 attachments:[id]。
数据全是合成的。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

def item(i, state='progress', can_due=True, **extra):
    base = {'id': f'wi-syn-{i}', 'title': f'合成事项 {i}', 'state': state, 'created_by': 'user:syn-a', 'creator_principal': 'user:syn-a', 'created_at': '2026-11-10 08:00:00', 'updated_at': '2026-11-12 08:00:00',
            'source_kind': 'arrange', 'source_ref': '', 'target_team': '', 'seat': '', 'eval': '', 'eval_reason': '', 'progress_summary': '', 'receipt_outcome': '', 'object': '', 'phase': '', 'open_asks': '', 'outputs': '', 'evidence': ''}
    base.update(extra)
    return {'item': base, 'log': [], 'messages': [], 'unread': 0, 'progress': None, 'can': {'release': False, 'answer': False, 'verify': False, 'due': can_due and state not in ('done', 'failed', 'dropped', 'cancelled')}, 'turn': {'release': False, 'answer': False, 'verify': False}, 'creator': {'principal': 'user:syn-a', 'display_name': '合成甲'}}
ATT = [{'id': 'a1', 'name': '合成报价单.xlsx', 'size': 23456, 'mime': 'application/vnd.ms-excel', 'sha256': 'ab', 'url': '/api/work-items/wi-syn-1/attachments/a1'},
       {'id': 'a2', 'name': '合成外链.pdf', 'size': 10, 'mime': 'application/pdf', 'sha256': 'cd', 'url': 'https://example.invalid/a.pdf'},
       {'id': 'a3', 'name': '合成图片.png', 'size': None, 'mime': 'image/png', 'sha256': 'ef', 'url': '/api/work-items/wi-syn-1/attachments/a3'}]
DETAILS = {'1': item(1, due='2099-12-31', overdue=False, attachments=ATT), '2': item(2, can_due=False), '3': item(3, due='2026-01-02', overdue=True),
           '4': item(4, due=None, overdue=False), '5': item(5, state='done', due='2026-01-02', overdue=False), '6': item(6, can_due=False, due='2099-12-31', overdue=False)}
DETAIL = re.compile(r'/api/work-items/wi-syn-(\d+)$')
due_posts = []
def on_due(route):
    body = json.loads(route.request.post_data or '{}'); due_posts.append(body)
    if DETAIL.search(route.request.url.replace('/due', '')) and route.request.url.endswith('wi-syn-4/due'):
        return route.fulfill(status=404, content_type='application/json', body=json.dumps({'error': 'work_item_not_found'}))
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'item_id': 'wi-syn-1', 'due': body.get('due'), 'overdue': False, 'notified': 1}))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route(DETAIL, lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(DETAILS[DETAIL.search(r.request.url).group(1)])))
    pg.route(re.compile(r'/api/work-items/wi-syn-\d+/due$'), on_due)
    def open_item(i):
        pg.goto(M + f'/work-items/wi-syn-{i}'); pg.wait_for_selector('[data-testid=work-item-summary]'); pg.wait_for_timeout(300)
    open_item(1)
    due = pg.locator('[data-testid=work-item-due]')
    check('有期限：摘要里「期限」一行，日期加离今天多远；没过期不标', due.inner_text().startswith('2099-12-31（还有') and pg.locator('[data-testid=work-item-overdue]').count() == 0, due.all_inner_texts())
    card = pg.locator('[data-testid=work-item-attachments]')
    names = card.locator('a').all_inner_texts() if card.count() else []
    check('附件：「附件 2」，只列本站链接的两个，外链那个不出现；有大小的写大小', card.count() == 1 and card.locator('.ant-card-head-title').inner_text().strip() == '附件 2' and names == ['合成报价单.xlsx', '合成图片.png'] and '23 KB' in card.inner_text(), names)
    check('附件链接是服务端给的 /api/work-items/<事项>/attachments/<附件>', [card.locator('a').nth(i).get_attribute('href') for i in range(card.locator('a').count())] == ['/api/work-items/wi-syn-1/attachments/a1', '/api/work-items/wi-syn-1/attachments/a3'])
    # 建立人改期限
    edit = pg.locator('[data-testid=work-item-due-edit]')
    check('建立人：期限后面有「改」', edit.count() == 1 and edit.inner_text().strip() == '改')
    edit.click(); pg.wait_for_selector('[data-testid=work-item-due-editor]')
    inp = pg.locator('[data-testid=work-item-due-editor] input'); inp.click(); inp.fill('2099-12-01'); inp.press('Enter'); pg.wait_for_timeout(200)
    pg.locator('[data-testid=work-item-due-save]').click(); pg.wait_for_timeout(500)
    check('保存：发 POST /due { due: 新日期 }，提示里说已告诉在办的席位', due_posts[-1:] == [{'due': '2099-12-01'}] and pg.locator('.ant-message-notice', has_text='已告诉在办的席位').count() >= 1, due_posts)
    edit.click(); pg.wait_for_selector('[data-testid=work-item-due-clear]'); pg.locator('[data-testid=work-item-due-clear]').click(); pg.wait_for_timeout(500)
    check('清掉期限：发 { due: null }', due_posts[-1:] == [{'due': None}], due_posts)
    open_item(3)
    check('过期了：照服务端的 overdue 标「已过期」', pg.locator('[data-testid=work-item-overdue]').inner_text().strip() == '已过期')
    open_item(4)
    check('期限是 null：写「不限」，建立人能「加一个」', pg.locator('[data-testid=work-item-due]').inner_text().strip() == '不限' and pg.locator('[data-testid=work-item-due-edit]').inner_text().strip() == '加一个')
    pg.locator('[data-testid=work-item-due-edit]').click(); inp = pg.locator('[data-testid=work-item-due-editor] input'); inp.click(); inp.fill('2099-01-01'); inp.press('Enter'); pg.wait_for_timeout(200)
    pg.locator('[data-testid=work-item-due-save]').click(); pg.wait_for_timeout(500)
    check('改期限被拒（404）：说只有建立人能改', pg.locator('.ant-message-notice', has_text='只有建立人能改期限').count() >= 1)
    open_item(5)
    check('事项结束了：期限照写，没有「改」', pg.locator('[data-testid=work-item-due]').count() == 1 and pg.locator('[data-testid=work-item-due-edit]').count() == 0)
    open_item(6)
    check('服务端说不能改（can.due 为假：不是建立人，或管理员）：期限照写，没有「改」', pg.locator('[data-testid=work-item-due]').count() == 1 and pg.locator('[data-testid=work-item-due-edit]').count() == 0)
    open_item(2)
    summary = pg.locator('[data-testid=work-item-summary]').inner_text()
    check('旧服务端（没有 due 这个键）：不画期限、不写「不限」，没有附件卡片', pg.locator('[data-testid=work-item-due]').count() == 0 and '期限' not in summary and '不限' not in summary and pg.locator('[data-testid=work-item-attachments]').count() == 0, summary)

    # 安排一件事：传附件、带着 id 安排
    uploads, posted = [], []
    def on_upload(route):
        name = route.request.url.rsplit('/', 1)[1]
        h = route.request.headers
        uploads.append((name, h.get('content-type', ''), h.get('x-content-sha256', ''), len(route.request.post_data_buffer or b'')))
        if 'big' in name: return route.fulfill(status=413, content_type='application/json', body=json.dumps({'error': 'too_large'}))
        route.fulfill(status=201, content_type='application/json', body=json.dumps({'id': 'att-' + str(len(uploads)), 'name': name, 'size': 5, 'mime': 'text/plain', 'sha256': 'x', 'integrity': 'ok'}))
    pg.route(re.compile(r'/api/work-items/attachments/[^/]+$'), on_upload)
    pg.route(re.compile(r'/api/work-items/teams$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'teams': [{'team': 'syn/canvas/syn-team', 'name': '合成团队'}]})))
    def on_post(route):
        if route.request.method != 'POST': return route.continue_()
        posted.append(json.loads(route.request.post_data or '{}'))
        route.fulfill(status=201, content_type='application/json', body=json.dumps({'item_id': 'wi-syn-1', 'event_id': 'e1', 'state': 'held'}))
    pg.route(re.compile(r'/api/work-items$'), on_post)
    pg.goto(M + '/'); pg.wait_for_load_state('networkidle'); pg.locator('[data-testid=arrange-open]').first.evaluate('e => e.click()')
    pg.wait_for_selector('[data-testid=arrange-attachments]')
    files = pg.locator('[data-testid=arrange-attachments] input[type=file]')
    files.set_input_files([{'name': '合成说明.txt', 'mimeType': 'text/plain', 'buffer': b'hello'}, {'name': 'big.bin', 'mimeType': 'application/octet-stream', 'buffer': b'12345'}])
    pg.wait_for_function("() => [...document.querySelectorAll('[data-testid=arrange-attach]')].every(e => e.dataset.state !== 'uploading') && document.querySelectorAll('[data-testid=arrange-attach]').length === 2")
    rows = pg.locator('[data-testid=arrange-attach]')
    states = [rows.nth(i).get_attribute('data-state') for i in range(rows.count())]
    up = [u for u in uploads if 'txt' in u[0] or '%' in u[0]]
    check('选了就传：PUT 到 /attachments/<文件名（编码过）>，原始字节、带 64 位十六进制摘要头', len(uploads) == 2 and any(u[1] == 'text/plain' and re.fullmatch(r'[0-9a-f]{64}', u[2] or '') and u[3] == 5 for u in uploads), uploads)
    check('传上的写大小、没传上的写原因（413 说 100 MB）', sorted(states) == ['done', 'error'] and '100 MB' in rows.filter(has_text='big.bin').inner_text(), (states, rows.all_inner_texts()))
    rows.filter(has_text='big.bin').get_by_role('button', name=re.compile('去掉')).click()
    check('没传上的能去掉', pg.locator('[data-testid=arrange-attach]').count() == 1)
    pg.locator('[data-testid=arrange-form] .ant-select').first.click(); pg.locator('.ant-select-item-option', has_text='合成团队').click()
    pg.get_by_placeholder('一句话说清是什么事').fill('合成：带附件的一件事')
    pg.locator('[data-testid=arrange-form] textarea').nth(0).fill('合成：要做什么')
    pg.locator('[data-testid=arrange-form] textarea').nth(1).fill('合成：交什么')
    pg.locator('[data-testid=arrange-submit]').evaluate('e => e.click()'); pg.wait_for_timeout(800)
    check('安排：请求体带 attachments:[传上的那个 id]，没传上的不带', posted and posted[-1].get('attachments') == ['att-1'], posted)
    b.close()

print(f'work-item-extras-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
