"""「等你拍板」三处同数的浏览器回归；由 scripts/home-count-browser.mjs 起合成实例、造好数据后调用，参数为配置 JSON 路径。
phase=lead（team-a 的负责人，也是会话登录的管理员、没有管理层授予）：两件交给 team-a、等他放行的事项 → 侧栏角标、总结句、卡片区件数都是 2；
  要到别处处理的不进这三处，单列一组；没有「可以代办」那一组。不刷新页面，当场放行一件 → 三处一起变成 1；
  再放行一件 → 角标消失、总结句不再说有等你拍板的、卡片区为 0。建立人 alpha：这两件等的是负责人放行，不轮到他 → 三处都是 0。
phase=proxy（只有管理层授予）：两件交给没有负责人的 team-b → 在「可以代办」那一组，不进角标、不算进总结句的等你拍板数，三处都是 0。"""
import json, re, sys, urllib.request
from playwright.sync_api import sync_playwright
cfg = json.load(open(sys.argv[1])); M = cfg['base']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def attention(session):
    req = urllib.request.Request(M + '/api/attention', headers={'cookie': f'session_id={session}', 'sec-fetch-site': 'same-origin'})
    return json.load(urllib.request.urlopen(req)).get('items', [])
def three(pg):
    """页面上的三个数：角标、总结句里的数、「等你拍板」标题旁的数"""
    badge = pg.locator('[data-testid=nav-pending]')
    summary = pg.locator('[data-testid=home-summary]').inner_text()
    m = re.search(r'有 (\d+) 件等你拍板', summary)
    head = pg.locator('.wm-sec-h .wm-sec-n').first.inner_text().strip()
    return (int(badge.inner_text()) if badge.count() else 0, int(m.group(1)) if m else 0, int(head), summary)
def open_home(b, session):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'session_id', 'value': session, 'url': M}])
    pg = ctx.new_page(); pg.goto(M + '/')
    pg.wait_for_selector('[data-testid=home-summary]')
    pg.wait_for_function("document.querySelector('.wm-sec-h .wm-sec-n') && !document.querySelector('.wm-home .ant-skeleton')")
    pg.wait_for_timeout(800)
    return ctx, pg

with sync_playwright() as p:
    b = p.chromium.launch()
    if cfg['phase'] == 'proxy':
        items = attention(cfg['mgmt_session'])
        proxy = [x for x in items if x.get('answers') and x.get('mine') is False]
        now_ = [x for x in items if x.get('answers') and x.get('mine') is not False]
        check('造出来的数据：管理层（只有管理层授予）有 2 件可以代办（mine 为假）、0 件轮到他', sorted(x.get('source_id') for x in proxy) == sorted(cfg['items']) and not now_, (len(proxy), len(now_)))
        ctx, pg = open_home(b, cfg['mgmt_session'])
        badge, in_sum, head, summary = three(pg)
        check(f'管理层：没有轮到他的，角标、总结句、卡片区三处同数，都是 0（{badge} / {in_sum} / {head}）', badge == 0 and in_sum == 0 and head == 0, summary)
        px = pg.locator('[data-testid=decisions-proxy] [data-testid=decision-card]')
        texts = ' '.join(px.all_inner_texts())
        check(f'那两件在「可以代办」那一组（{px.count()} 张），总结句说「另有 2 件别人的事你可以代办」、不算进等你拍板', px.count() == 2 and all(t in texts for t in cfg['titles']) and '另有 2 件别人的事你可以代办' in summary and '件等你拍板' not in summary, (texts, summary))
        check('「等你拍板」里没有卡片', pg.locator('[data-testid=decisions-now] [data-testid=decision-card]').count() == 0)
        ctx.close(); b.close()
        print(f'home-count-browser（管理层代办）: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
    items = attention(cfg['lead_session'])
    mine_now = [x for x in items if x.get('answers') and x.get('mine') is not False]
    elsewhere = [x for x in items if not x.get('answers')]
    check(f'造出来的数据：负责人有 2 件轮到他能当场办的、{len(elsewhere)} 件要到别处处理的', sorted(x.get('source_id') for x in mine_now) == sorted(cfg['items']) and len(elsewhere) >= 3, (len(mine_now), len(elsewhere)))
    ctx, pg = open_home(b, cfg['lead_session'])
    badge, in_sum, head, summary = three(pg)
    check(f'负责人：角标、总结句、卡片区件数三处同数，都是 2（{badge} / {in_sum} / {head}）', badge == 2 and in_sum == 2 and head == 2, summary)
    now = pg.locator('[data-testid=decisions-now] [data-testid=decision-card]')
    texts = ' '.join(now.all_inner_texts())
    check('「等你拍板」里就是那两件，都带「派出去」', now.count() == 2 and all(t in texts for t in cfg['titles']) and texts.count('派出去') == 2, texts)
    other = pg.locator('[data-testid=decisions-elsewhere] [data-testid=decision-card]')
    check(f'要到别处处理的单列一组（{other.count()} 张），总结句另说一句、不算进等你拍板', other.count() == len(elsewhere) and f'{len(elsewhere)} 件要到别处处理' in summary, summary)
    check('负责人这一视角没有「可以代办」那一组', pg.locator('[data-testid=decisions-proxy]').count() == 0)
    # 当场放行一件（不刷新页面）：三处一起从 2 变成 1。角标不能直接没了
    now.first.get_by_role('button', name=re.compile('派出去')).click()
    pg.wait_for_function("document.querySelectorAll('[data-testid=decisions-now] [data-testid=decision-card]').length === 1", timeout=10000)
    pg.wait_for_timeout(1500)
    badge, in_sum, head, summary = three(pg)
    check(f'办完一件，三处一起从 2 变成 1（{badge} / {in_sum} / {head}）', badge == 1 and in_sum == 1 and head == 1, summary)
    # 再放行一件：三处都是 0
    pg.locator('[data-testid=decisions-now] [data-testid=decision-card]').first.get_by_role('button', name=re.compile('派出去')).click()
    pg.wait_for_function("!document.querySelector('[data-testid=nav-pending]')", timeout=10000)
    pg.wait_for_timeout(600)
    badge, in_sum, head, summary = three(pg)
    check(f'都放行之后三处一起变成 0（{badge} / {in_sum} / {head}），总结句不再说有等你拍板的', badge == 0 and in_sum == 0 and head == 0 and '眼下没有要你当场拍板的' in summary, summary)
    ctx.close()
    # 建立人：这件事（已派出去）不轮到他
    ctx, pg = open_home(b, cfg['alpha_session'])
    badge, in_sum, head, summary = three(pg)
    check(f'建立人 alpha：没有轮到他的，三处都是 0（{badge} / {in_sum} / {head}）', badge == 0 and in_sum == 0 and head == 0, summary)
    # 外壳两处：用户卡写显示名（不是登录名），头像取显示名首字；两个字的按钮不插空格（全站一处设）
    me_name = pg.locator('[data-testid=wm-me-name]').inner_text().strip()
    me_av = pg.locator('[data-testid=wm-me-avatar]').inner_text().strip()
    check(f'用户卡写显示名、头像取显示名首字（{me_name} / {me_av}）', me_name == 'Synthetic alpha' and me_av == 'S', (me_name, me_av))
    pg.goto(M + '/work-items'); pg.wait_for_selector('[data-testid=work-items-views]')
    btn = pg.get_by_role('button', name='刷新').first
    check('两个字的按钮不在字中间插空格（「刷新」不是「刷 新」）', btn.inner_text().strip() == '刷新', btn.inner_text())
    # 地址里带视角和席位（驾驶舱「AI 员工」点卡过来的）：页面认得；这个视角还不能用时退回能看的、告诉一声，不报错
    pg.goto(M + '/work-items?view=seats&seat=s-synthetic'); pg.wait_for_selector('[data-testid=work-items-views]'); pg.wait_for_timeout(800)
    shown = pg.locator('[data-testid=work-items-url-filter], [data-testid=work-items-url-filter-note]')
    check('事项列表认地址里的 view / seat：要么按它筛着，要么说清这个视角还看不了', shown.count() >= 1 and pg.locator('.ant-alert-error').count() == 0, shown.all_inner_texts())
    ctx.close(); b.close()
print(f'home-count-browser（负责人）: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
