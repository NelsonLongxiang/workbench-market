"""#318 SOP 交付空间浏览器回归；由 scripts/sop-space-browser.mjs 起合成实例后调用，参数为配置 JSON 路径。
业务面（无读授权）：交付空间执行记录只给元数据（复用 #309 assert_metadata_history）、定义不带步骤正文、交付物与单次记录不出现私有值和附件名、
单次记录不请求附件接口、详情与单次记录刷新不丢；控制面（管理员口令）：填写值按文本显示（不解释 HTML）、未填步骤标「未填写」、附件可下载。"""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(Path(__file__).parent))
from sop_history_assertions import assert_metadata_history

cfg = json.load(open(sys.argv[1]))
M, C, SLUG, RID, PRIV = cfg['base'], cfg['control'], cfg['slug'], cfg['run'], cfg['private']
ok = fail = 0
def check(n, c, x=''):
    global ok, fail
    if c: ok += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, x)
def crumbs(pg):
    return [t.strip() for t in pg.locator('.ant-page-header .ant-breadcrumb li:not(.ant-breadcrumb-separator)').all_inner_texts()]
def no_private(text):
    return [v for v in PRIV if v in text]

with sync_playwright() as p:
    b = p.chromium.launch()
    # ── 业务面：无读授权 ──
    pg = b.new_page(viewport={'width': 1280, 'height': 800}); pg.set_default_timeout(10000)
    reqs = []; pg.on('request', lambda r: reqs.append(r.url))
    with pg.expect_response(lambda r: '/api/sop/runs?' in r.url and f'slug={SLUG}' in r.url) as resp:
        pg.goto(M + f'/sops/{SLUG}')
    history_rows = resp.value.json()
    pg.wait_for_selector('.wm-sop-runs .ant-table-row')
    check('交付空间面包屑 = 交付 / SOP 交付空间 / SOP 名', crumbs(pg) == ['交付', 'SOP 交付空间', '机柜验收'], crumbs(pg))
    btn = pg.locator('.ant-page-header-heading-extra a.ant-btn-primary', has_text=re.compile(r'开始执行'))
    check('头部主操作「开始执行」指向 Runner', btn.count() == 1 and (btn.get_attribute('href') or '').endswith(f'/sop/{SLUG}/'))
    try:
        assert_metadata_history(pg.locator('.wm-sop-runs'), '合成·张工', 2, reqs, history_rows, tuple(PRIV))
        check('执行记录只给元数据（#309 断言：步骤数=2、无展开、无私有值、不请求单 run）', True)
    except AssertionError as e:
        check('执行记录只给元数据（#309 断言）', False, str(e))
    pg.goto(M + f'/sops/{SLUG}?tab=definition')
    pg.wait_for_selector('.ant-tabs-tabpane-active .ant-table-row')
    txt = pg.locator('.ant-tabs-tabpane-active').first.inner_text()
    check('刷新后仍停在「定义」标签（?tab=definition）', pg.locator('.ant-tabs-tab-active').first.inner_text().strip() == '定义')
    check('定义列出 3 个步骤且不含步骤正文 HTML', all(t in txt for t in ['机位确认', '扭矩复核', '通电自检']) and cfg['step_body'] not in pg.content(), txt[:200])
    pg.locator('.ant-tabs-tab', has_text='交付物').click()
    pg.wait_for_selector('.ant-tabs-tabpane-active .ant-table-row')
    txt = pg.locator('.ant-tabs-tabpane-active').first.inner_text()
    check('交付物：无读授权只显示「需要读授权」，不出现附件名', '需要读授权' in txt and not no_private(txt), txt[:200])
    reqs.clear()
    pg.locator('.ant-tabs-tab', has_text=re.compile('执行记录')).click()
    pg.locator('.wm-sop-runs .ant-table-row').first.click()
    pg.wait_for_url(M + f'/sops/{SLUG}/runs/{RID}')
    pg.wait_for_selector('.wm-run-private')
    body = pg.locator('body').inner_text()
    check('点行进入单次记录，面包屑带 SOP 名与记录号', crumbs(pg) == ['交付', 'SOP 交付空间', '机柜验收', f'记录 #{RID}'], crumbs(pg))
    check('单次记录（无读授权）只显示元数据与提示，不出现任何私有值/附件名', not no_private(body) and '需要读授权' in body, no_private(body))
    check('单次记录（无读授权）不请求附件接口、不渲染步骤', not any(re.search(rf'/api/sop/runs/{RID}/files', u) for u in reqs) and pg.locator('.wm-run-body, .ant-steps').count() == 0)
    pg.reload(); pg.wait_for_selector('.wm-run-private')
    check('单次记录刷新不丢（可分享链接）', pg.evaluate('location.pathname') == f'/sops/{SLUG}/runs/{RID}' and f'执行记录 #{RID}' in pg.locator('.ant-page-header-heading-title').inner_text())
    pg.goto(M + f'/sops/{SLUG}/runs/99999'); pg.wait_for_selector('.ant-result-404')
    check('不存在的记录 → 404 结果页', pg.locator('.ant-result-404').count() == 1)
    pg.goto(M + '/sops/no-such-sop'); pg.wait_for_selector('.ant-result-404')
    check('不存在的 SOP → 404 结果页', '没有这个 SOP' in pg.locator('body').inner_text())
    pg.goto(M + '/sops'); pg.wait_for_selector('.ant-table-row')
    check('列表页不再有执行记录抽屉', pg.locator('.ant-drawer').count() == 0)
    pg.locator('.ant-table-row', has_text='机柜验收').get_by_role('button', name=re.compile(r'记\s*录')).click()
    pg.wait_for_url(M + f'/sops/{SLUG}')
    check('列表「记录」按钮进入交付空间', True)
    # ── 控制面：管理员口令（输入后只走前端路由，刷新会按 #292 M4 抹口令）──
    cp = b.new_page(viewport={'width': 1280, 'height': 800}, accept_downloads=True); cp.set_default_timeout(10000)
    cp.goto(C + '/sops'); cp.wait_for_selector('.ant-pro-sider .ant-menu')
    cp.locator('.ant-pro-sider button', has_text='口令').first.click()
    cp.locator('.ant-popover input[type=password]').fill(cfg['token'])
    cp.locator('.ant-popover button', has_text='保').click(); cp.wait_for_timeout(300)
    cp.evaluate(f"history.pushState({{}}, '', '/sops/{SLUG}/runs/{RID}'); dispatchEvent(new PopStateEvent('popstate'))")
    cp.wait_for_selector('.wm-run-body .ant-steps')
    body = cp.locator('.wm-run-body').inner_text()
    check('控制面持口令：显示步骤填写值', 'A-12' in body and 'PRIVATE-TORQUE-42' in body, body[:300])
    check('填写值按文本显示（<b> 不被解释成元素）', '<b>SECRET-POS</b>' in body and cp.locator('.wm-run-body b').count() == 0)
    check('未填写的步骤标「未填写」', '通电自检' in body and '未填写' in body)
    cp.wait_for_selector('.wm-run-body .ant-table-row')
    with cp.expect_download() as dl:
        cp.locator('.wm-run-body .ant-table-row', has_text='report-private.txt').get_by_role('button', name=re.compile('下载')).click()
    d = dl.value; path = Path(cfg['downloads']) / d.suggested_filename; d.save_as(path)
    check('附件带口令下载成功（内容一致）', d.suggested_filename == 'report-private.txt' and path.read_text() == 'synthetic deliverable')
    cp.evaluate(f"history.pushState({{}}, '', '/sops/{SLUG}?tab=deliverables'); dispatchEvent(new PopStateEvent('popstate'))")
    cp.wait_for_selector('.ant-tabs-tabpane-active .ant-table-row')
    check('控制面交付物列出附件', 'report-private.txt' in cp.locator('.ant-tabs-tabpane-active').first.inner_text())
    b.close()
print(f'sop-space-browser: {ok} passed / {fail} failed'); sys.exit(1 if fail else 0)
