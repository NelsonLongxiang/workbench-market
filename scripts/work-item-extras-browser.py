"""事项的期限和附件（位置先画上）浏览器回归；由 scripts/sider-menu-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
事项详情用合成的应答（page.route 截下 GET /api/work-items/<id>）：
  · 带了期限和附件：摘要里有「期限」一行（日期 + 离今天多远），右栏有「附件 N」，文件名可取回、写大小；外链附件不出现；
  · 没带这两个字段（今天服务端的样子）：不画「期限」，也没有附件卡片——不写「不限」，不造东西；
「安排一件事」：期限照旧可填；附件那一格在、按钮不能点，点了也不发请求。数据全是合成的。"""
import json, re, sys
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1]))
M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)

def item(i, **extra):
    base = {'id': f'wi-syn-{i}', 'title': f'合成事项 {i}', 'state': 'progress', 'created_by': 'user:syn-a', 'creator_principal': 'user:syn-a', 'created_at': '2026-11-10 08:00:00', 'updated_at': '2026-11-12 08:00:00',
            'source_kind': 'arrange', 'source_ref': '', 'target_team': '', 'seat': '', 'eval': '', 'eval_reason': '', 'progress_summary': '', 'receipt_outcome': '', 'object': '', 'phase': '', 'open_asks': '', 'outputs': '', 'evidence': ''}
    base.update(extra)
    return {'item': base, 'log': [], 'messages': [], 'unread': 0, 'progress': None, 'can': {'release': False, 'answer': False, 'verify': False}, 'turn': {'release': False, 'answer': False, 'verify': False}, 'creator': None}

FULL = item(1, due='2099-12-31', attachments=[
    {'name': '合成报价单.xlsx', 'size': 23456, 'url': '/api/work-items/wi-syn-1/files/1'},
    {'name': '合成外链.pdf', 'size': 10, 'url': 'https://example.invalid/a.pdf'},
    {'name': '合成图片.png', 'size': None, 'url': '/api/work-items/wi-syn-1/files/3'}])
BARE = item(2)
DETAIL = re.compile(r'/api/work-items/wi-syn-(\d+)$')

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); pg.set_default_timeout(10000)
    pg.route(DETAIL, lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(FULL if DETAIL.search(r.request.url).group(1) == '1' else BARE)))
    pg.goto(M + '/work-items/wi-syn-1'); pg.wait_for_selector('[data-testid=work-item-summary]')
    due = pg.locator('[data-testid=work-item-due]')
    check('带了期限：摘要里有「期限」一行，日期加离今天多远', due.count() == 1 and due.inner_text().startswith('2099-12-31（还有'), due.all_inner_texts())
    card = pg.locator('[data-testid=work-item-attachments]')
    names = card.locator('a').all_inner_texts() if card.count() else []
    check('带了附件：右栏「附件 2」，只列本站链接的两个，外链那个不出现', card.count() == 1 and card.locator('.ant-card-head-title').inner_text().strip() == '附件 2' and names == ['合成报价单.xlsx', '合成图片.png'], names)
    hrefs = [card.locator('a').nth(i).get_attribute('href') for i in range(card.locator('a').count())] if card.count() else []
    check('文件名点了取回：链接是本站 /api/ 地址；有大小的写大小', hrefs == ['/api/work-items/wi-syn-1/files/1', '/api/work-items/wi-syn-1/files/3'] and '23 KB' in card.inner_text(), (hrefs, card.inner_text() if card.count() else ''))
    pg.goto(M + '/work-items/wi-syn-2'); pg.wait_for_selector('[data-testid=work-item-summary]')
    summary = pg.locator('[data-testid=work-item-summary]').inner_text()
    check('没带这两个字段（今天的样子）：不画期限、不写「不限」，没有附件卡片', pg.locator('[data-testid=work-item-due]').count() == 0 and '期限' not in summary and '不限' not in summary and pg.locator('[data-testid=work-item-attachments]').count() == 0, summary)

    # 「安排一件事」：附件那一格在、按钮不能点、点了不发请求
    posted = []
    pg.on('request', lambda r: posted.append(r.url) if r.method != 'GET' else None)
    # 可派的团队用合成的一个（表单要有团队才出现）
    pg.route(re.compile(r'/api/work-items/teams$'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'teams': [{'team': 'syn/canvas/syn-team', 'name': '合成团队'}]})))
    pg.goto(M + '/'); pg.wait_for_load_state('networkidle'); pg.locator('[data-testid=arrange-open]').first.evaluate('e => e.click()')
    pg.wait_for_selector('[data-testid=arrange-attachments]')
    slot = pg.locator('[data-testid=arrange-attachments]')
    btn = slot.get_by_role('button', name='加附件')
    check('安排一件事：期限照旧在，附件那一格在、写着现在还不能加', pg.get_by_text('期限（可不填）').count() == 1 and '附件现在还不能加' in slot.inner_text())
    btn.scroll_into_view_if_needed(); btn.evaluate('e => e.click()'); pg.wait_for_timeout(300)
    check('「加附件」不能点，硬点也不发请求', btn.is_disabled() and posted == [], posted)
    b.close()

print(f'work-item-extras-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
