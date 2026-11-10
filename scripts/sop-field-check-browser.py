"""#471 字段间数值关系 data-check：真实 Chromium 里执行页的结论与服务端完成校验逐字一致（合成页面，不连网络）。"""
import json
import sys

from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
html = open(cfg['html'], encoding='utf-8').read()
ORIGIN = 'http://sop.synthetic.test'
checks = []


def check(name, ok, detail=''):
    checks.append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('  ✓ ' if ok else '  ✗ ') + name + ('' if ok else ' ' + json.dumps(detail, ensure_ascii=False)))


def route(r):
    if r.request.url.startswith(ORIGIN + '/sop/'):
        return r.fulfill(status=200, content_type='text/html; charset=utf-8', body=html)
    return r.abort()


# 填一组值，逐个触发 change（执行页在 change 时重算依赖字段），再读每个 data-check 字段的自定义违约提示
FILL = """(arg) => {
  const set = (step, field, v) => { const el = document.querySelector('[data-step="' + step + '"] [data-field="' + field + '"]'); el.value = v; };
  for (const [step, fs] of Object.entries(arg.fields)) for (const f of fs) set(step, f, (arg.data[step] || {})[f] ?? '');
  for (const [step, fs] of Object.entries(arg.fields)) for (const f of fs) document.querySelector('[data-step="' + step + '"] [data-field="' + f + '"]').dispatchEvent(new Event('change', { bubbles: true }));
}"""
READ = """(checkFields) => Object.fromEntries(checkFields.map(f => {
  const el = document.querySelector('[data-step="' + f.step + '"] [data-field="' + f.field + '"]');
  return [f.step + '.' + f.field, el.validity.customError ? el.validationMessage : ''];
}))"""
MSG = """(sel) => { const el = document.querySelector(sel); const m = el.nextElementSibling; return m && m.classList.contains('fv-msg') ? m.textContent : ''; }"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.goto(ORIGIN + '/sop/check-sop/')
    pg.wait_for_selector('#finish:not([disabled])')

    for i, c in enumerate(cfg['cases']):
        pg.evaluate(FILL, {'fields': cfg['fields'], 'data': c['data']})
        got = pg.evaluate(READ, cfg['checkFields'])
        check(f'K1 用例 {i + 1}：页面与服务端结论一致', got == c['expect'], {'page': got, 'server': c['expect'], 'data': c['data']})
    check('K1 用例覆盖了违约与通过两种结论', any(any(v for v in c['expect'].values()) for c in cfg['cases']) and any(not any(c['expect'].values()) for c in cfg['cases']))

    count = '[data-step="samples"] [data-field="count"]'
    pg.evaluate(FILL, {'fields': cfg['fields'], 'data': {'samples': {'count': '101', 'target': '100'}}})
    check('K2 违约时控件后面显示关系提示', pg.evaluate(MSG, count) == '须满足 实际条数 ≤ 应取条数（现为 101 与 100）', pg.evaluate(MSG, count))
    pg.fill('[data-step="samples"] [data-field="target"]', '120')
    pg.dispatch_event('[data-step="samples"] [data-field="target"]', 'change')
    check('K2 改被引用的字段后，依赖它的字段立即恢复', pg.evaluate(MSG, count) == '' and pg.evaluate("document.querySelector('" + count + "').getAttribute('aria-invalid')") == 'false')
    pg.fill('[data-step="samples"] [data-field="ratio"]', '5')
    pg.dispatch_event('[data-step="samples"] [data-field="ratio"]', 'change')
    check('K2 写错的表达式当作没有这条规则', pg.evaluate("document.querySelector('[data-field=ratio]').validity.valid"))

    pg.evaluate(FILL, {'fields': cfg['fields'], 'data': {'samples': {'count': '100', 'target': '100', 'overlap': '40', 'only': '61'}}})
    pg.click('#finish')
    texts = pg.locator('#fv-summary li a').all_inner_texts()
    check('K3 完成被拦时汇总列出关系违约（用 data-check-error）', any(t == '交集：交集＋独有应等于实际条数' for t in texts), texts)
    check('页面无脚本错误', not errors, errors)
    b.close()

json.dump({'checks': checks, 'scope': 'synthetic runner page, all network aborted'}, open(cfg['result'], 'w', encoding='utf-8'), ensure_ascii=False)
failed = [c for c in checks if not c['ok']]
print(f'sop-field-check-browser: {len(checks) - len(failed)} passed / {len(failed)} failed')
sys.exit(1 if failed else 0)
