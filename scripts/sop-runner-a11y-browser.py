"""#436 SOP 执行页可访问性：真实 Chromium 核名称、说明关联、错误汇总与条件必填切换（合成页面，不连网络）。"""
import json
import sys

from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
html = open(cfg['html'], encoding='utf-8').read()
ORIGIN = 'http://sop.synthetic.test'
checks = []


def check(name, ok, detail=''):
    checks.append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('  ✓ ' if ok else '  ✗ ') + name + ('' if ok else ' ' + str(detail)))


def route(r):
    if r.request.url.startswith(ORIGIN + '/sop/'):
        return r.fulfill(status=200, content_type='text/html; charset=utf-8', body=html)
    return r.abort()


STATE = """() => [...document.querySelectorAll('[data-field]')].map(el => {
  const name = (el.labels && el.labels.length ? [...el.labels].map(l => l.textContent.trim()).join(' ') : '') || el.getAttribute('aria-label') || '';
  const desc = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).map(id => { const d = document.getElementById(id); return d ? d.textContent.trim() : null; });
  return { field: el.getAttribute('data-field'), id: el.id, name, desc, required: el.required };
})"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.goto(ORIGIN + '/sop/a11y-sop/')
    pg.wait_for_selector('#finish:not([disabled])')

    s = {x['field']: x for x in pg.evaluate(STATE)}
    ids = [x['id'] for x in s.values()]
    check('A1 每个字段都有可访问名称', all(x['name'] for x in s.values()), s)
    check('A1 id 唯一且非空', all(ids) and len(set(ids)) == len(ids), ids)
    check('A1 名称来源：data-label / 前置文字 / <label>', s['task_type']['name'] == '任务类型' and s['product']['name'] == '本次商品' and s['note']['name'] == '备注', {k: s[k]['name'] for k in s})
    check('A1 跨步字段没有文字时退回字段名', s['period']['name'] == 'period', s['period'])
    check('A2 隔着 <br> 的 <small> 说明关联到 aria-describedby', '选了类型，下面的字段按类型必填' in s['task_type']['desc'] and 'B0 开头 10 位' in s['anchor']['desc'], {k: s[k]['desc'] for k in s})

    pg.fill('[data-field="anchor"]', 'x')
    pg.click('#finish')
    summary = pg.locator('#fv-summary')
    check('A3 被拦时出现错误汇总并获得焦点', summary.is_visible() and pg.evaluate("document.activeElement && document.activeElement.id") == 'fv-summary')
    check('A3 汇总不重复播报：不设 role=alert，以标题命名', summary.get_attribute('role') is None and pg.evaluate("document.getElementById('fv-summary').getAttribute('aria-labelledby')") == 'fv-summary-title' and pg.locator('#fv-summary-title').inner_text().startswith('有 2 项'))
    items = summary.locator('li a')
    texts = items.all_inner_texts()
    check('A3 汇总逐项列字段名和原因', len(texts) == 2 and any(t.startswith('任务类型：') for t in texts) and any('锚 ASIN：ASIN 为 B0 开头' in t for t in texts), texts)
    s = {x['field']: x for x in pg.evaluate(STATE)}
    check('A2 错误提示也关联到 aria-describedby（说明不丢）', 'ASIN 为 B0 开头的 10 位' in s['anchor']['desc'] and 'B0 开头 10 位' in s['anchor']['desc'], s['anchor']['desc'])
    items.nth(next(i for i, t in enumerate(texts) if t.startswith('锚 ASIN'))).click()
    check('A3 点汇总里的一项跳到对应控件', pg.evaluate("document.activeElement && document.activeElement.getAttribute('data-field')") == 'anchor')

    pg.select_option('[data-field="task_type"]', '单商品研究')
    pg.fill('[data-field="anchor"]', 'B0TEST0001')
    pg.click('#finish')
    texts = pg.locator('#fv-summary li a').all_inner_texts()
    check('A4 条件成立后，条件必填项（含跨步）进入汇总', len(texts) == 2 and any(t.startswith('本次商品：') for t in texts) and any(t.startswith('period：') for t in texts), texts)
    s = {x['field']: x for x in pg.evaluate(STATE)}
    check('A4 条件切换后错误提示关联存在', '必填' in s['product']['desc'] and s['product']['required'], s['product'])
    pg.select_option('[data-field="task_type"]', '跨任务分类')
    s = {x['field']: x for x in pg.evaluate(STATE)}
    check('A4 条件不成立后不再必填，名称与关联仍在', (not s['product']['required']) and s['product']['name'] == '本次商品' and any(d is not None for d in s['product']['desc']), s['product'])
    check('页面无脚本错误', not errors, errors)
    b.close()

json.dump({'checks': checks, 'scope': 'synthetic runner page, all network aborted'}, open(cfg['result'], 'w', encoding='utf-8'), ensure_ascii=False)
failed = [c for c in checks if not c['ok']]
print(f'sop-runner-a11y-browser: {len(checks) - len(failed)} passed / {len(failed)} failed')
sys.exit(1 if failed else 0)
