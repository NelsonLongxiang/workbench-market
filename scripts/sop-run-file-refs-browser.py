"""#437② 执行页多选逐个上传：在隔离实例上打开 SOP 执行页，同时选一个正常文件和一个可执行文件，核逐个状态与剩余配额。"""
import json
import sys

from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    slug = cfg['slug']
    # 恢复这条 run：本机存档里放 run id、读能力与上传令牌（与执行页自己写的格式相同）
    pg.goto(cfg['base'] + '/sop/' + slug + '/')
    pg.evaluate("""(c) => {
      const LS = 'wm.sop.run.' + c.slug;
      localStorage.setItem(LS, JSON.stringify({ id: c.run, status: 'running' }));
      localStorage.setItem(LS + '.rcap', JSON.stringify({ id: c.run, c: c.read_capability }));
      localStorage.setItem(LS + '.tok', JSON.stringify({ id: c.run, t: c.upload_token }));
    }""", cfg)
    pg.reload()
    pg.wait_for_selector('#upload-btn:not([disabled])')
    pg.set_input_files('#upload-input', [cfg['good'], cfg['bad']])
    pg.click('#upload-btn')
    pg.wait_for_function("document.querySelectorAll('#upload-status li').length === 2 && ![...document.querySelectorAll('#upload-status li')].some(li => /待传|上传中/.test(li.textContent))", timeout=20000)
    rows = pg.eval_on_selector_all('#upload-status li', 'els => els.map(e => e.textContent)')
    quota = pg.inner_text('#upload-quota')
    b.close()
print(json.dumps({'rows': rows, 'quota': quota, 'errors': errors}, ensure_ascii=False))
sys.exit(1 if errors else 0)
