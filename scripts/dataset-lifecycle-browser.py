"""#1015 数据集退役与恢复页的浏览器回归；由 scripts/dataset-lifecycle-browser.mjs 起真实后端后调用，参数为配置 JSON 路径。业务接口不截。
  · 没授予的 beta：只看到要什么授予的说法，没有清单、没有按钮；
  · alpha（管理层·全部）：在用、已退役两张表；被视图引用的 used_orders 退役预检列出视图和块，不出确认；
  · 退役 old_orders：名字复述错或没理由时确认不可点；对了才能点；成功后移到已退役，行数照旧；
  · 恢复预检拿到票之后视图被改（修订推进）：确认 409、说要重新预检、旧票不再出确认；重新预检后恢复成功，回到在用清单。
环境变量 DATASET_SHOTS 指一个目录时（经配置传入），存 1440 宽的截图。"""
import json, os, sys
from playwright.sync_api import sync_playwright, expect

cfg = json.load(open(sys.argv[1]))
B, BENCH = cfg['base'], cfg['bench']
URL = f"{B}/bench-datasets/{BENCH}"
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def shot(pg, name):
    if cfg.get('shots'):
        os.makedirs(cfg['shots'], exist_ok=True)
        pg.screenshot(path=os.path.join(cfg['shots'], name + '.png'), full_page=True, animations='disabled')

with sync_playwright() as p:
    b = p.chromium.launch()
    def page_as(session):
        ctx = b.new_context(viewport={'width': 1440, 'height': 900})
        ctx.add_cookies([{'name': 'session_id', 'value': session, 'url': B}])
        return ctx, ctx.new_page()

    print('一、没授予的人')
    ctx, pg = page_as(cfg['session_beta'])
    pg.goto(URL)
    err = pg.get_by_test_id('datasets-error')
    expect(err).to_be_visible()
    check('没授予：说要范围「全部」的专用授予；没有清单、没有退役恢复按钮', '专用授予' in err.inner_text()
          and pg.get_by_test_id('datasets-active').count() == 0 and pg.get_by_test_id('dataset-retire').count() == 0, err.inner_text())
    ctx.close()

    print('二、管理层看清单、被引用的阻断')
    ctx, pg = page_as(cfg['session_alpha'])
    pg.goto(URL)
    active = pg.get_by_test_id('datasets-active'); retired = pg.get_by_test_id('datasets-retired')
    expect(active.get_by_test_id('dataset-retire')).to_have_count(2)
    check('两张表：在用有两个，已退役为空', retired.get_by_test_id('dataset-restore').count() == 0 and '没有已退役的数据集' in retired.inner_text())
    shot(pg, 'list-1440')
    active.locator('[data-testid=dataset-retire][data-name=used_orders]').click()
    dlg = pg.get_by_role('dialog')
    expect(dlg.get_by_test_id('lifecycle-blockers')).to_be_visible()
    items = dlg.get_by_test_id('lifecycle-blocker').all_inner_texts()
    check('被视图引用：列出视图「v」第 1 个块，写下一步；不出确认，只有重新预检', len(items) == 1 and '视图「v」第 1 个块' in items[0]
          and dlg.get_by_test_id('lifecycle-confirm').count() == 0 and dlg.get_by_test_id('lifecycle-recheck').count() == 1, items)
    shot(pg, 'blocked-1440')
    dlg.get_by_role('button', name='取消').click()
    expect(pg.get_by_role('dialog')).to_have_count(0)

    print('三、退役：复述名字和理由')
    active.locator('[data-testid=dataset-retire][data-name=old_orders]').click()
    dlg = pg.get_by_role('dialog')
    confirm = dlg.get_by_test_id('lifecycle-confirm')
    expect(confirm).to_be_visible()
    check('预检通过：行数 2、凭据剩余时间可见', dlg.get_by_test_id('lifecycle-rows').inner_text() == '2' and '后失效' in dlg.get_by_test_id('lifecycle-ticket-left').inner_text())
    check('没复述名字、没理由：确认不可点', confirm.is_disabled())
    dlg.get_by_test_id('lifecycle-confirm-name').fill('Old_orders')
    dlg.get_by_test_id('lifecycle-reason').fill('合成：已废弃的旧表')
    check('名字大小写不对：确认仍不可点，提示一字不差', confirm.is_disabled() and '一字不差' in dlg.get_by_test_id('lifecycle-problem').inner_text())
    dlg.get_by_test_id('lifecycle-confirm-name').fill('old_orders')
    expect(confirm).to_be_enabled()
    shot(pg, 'confirm-1440')
    confirm.click()
    expect(pg.get_by_role('dialog')).to_have_count(0)
    expect(retired.get_by_test_id('dataset-restore')).to_have_count(1)
    check('退役成功：old_orders 移到已退役，行数照旧；在用只剩 used_orders', active.locator('[data-name=old_orders]').count() == 0
          and active.get_by_test_id('dataset-retire').count() == 1 and '2' in retired.locator('tr', has_text='old_orders').inner_text())

    print('四、恢复：预检后视图变了要重新预检')
    retired.locator('[data-testid=dataset-restore][data-name=old_orders]').click()
    dlg = pg.get_by_role('dialog')
    confirm = dlg.get_by_test_id('lifecycle-confirm')
    expect(confirm).to_be_visible()
    # 在别处改视图（推进视图修订），旧凭据就对不上了
    bumped = pg.evaluate("""async () => {
      const cur = await (await fetch('/api/bench-views/%s/view', { credentials: 'same-origin' })).json();
      const r = await fetch('/api/bench-views/%s/view', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: cur.view.version, note: '合成：别处改了视图', doc: { ...cur.view.content, title: '台（改过）' } }) });
      return r.status; }""" % (BENCH, BENCH))
    dlg.get_by_test_id('lifecycle-confirm-name').fill('old_orders')
    dlg.get_by_test_id('lifecycle-reason').fill('合成：误退役，恢复')
    confirm.click()
    expect(dlg.get_by_test_id('lifecycle-error')).to_be_visible()
    check('预检之后视图被改：确认 409，照服务端说要重新预检；旧凭据不再出确认', bumped == 200 and '重新预检' in dlg.get_by_test_id('lifecycle-error').inner_text()
          and dlg.get_by_test_id('lifecycle-confirm').count() == 0 and dlg.get_by_test_id('lifecycle-recheck').count() == 1, [bumped, dlg.inner_text()[:300]])
    dlg.get_by_test_id('lifecycle-recheck').click()
    confirm = dlg.get_by_test_id('lifecycle-confirm')
    expect(confirm).to_be_visible()
    dlg.get_by_test_id('lifecycle-confirm-name').fill('old_orders')
    dlg.get_by_test_id('lifecycle-reason').fill('合成：误退役，恢复')
    confirm.click()
    expect(pg.get_by_role('dialog')).to_have_count(0)
    expect(active.get_by_test_id('dataset-retire')).to_have_count(2)
    check('重新预检后恢复成功：回到在用清单，已退役为空', retired.get_by_test_id('dataset-restore').count() == 0)
    shot(pg, 'restored-1440')
    check('1440 宽：页面不横向溢出', pg.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth'))
    ctx.close()
    b.close()

print(f'dataset-lifecycle-browser: {ok} 过 / {fail} 败')
sys.exit(1 if fail else 0)
