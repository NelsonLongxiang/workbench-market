"""#437① 执行页文件清单编辑器：恢复一条已上传文件的 run，在表格里加一行、选文件和角色，再点「完成执行」。"""
import json
import sys

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(cfg['base'] + '/sop/' + cfg['slug'] + '/')
    pg.evaluate("""(c) => {
      const LS = 'wm.sop.run.' + c.slug;
      localStorage.setItem(LS, JSON.stringify({ id: c.run, status: 'running' }));
      localStorage.setItem(LS + '.rcap', JSON.stringify({ id: c.run, c: c.read_capability }));
      localStorage.setItem(LS + '.tok', JSON.stringify({ id: c.run, t: c.upload_token }));
    }""", cfg)
    pg.reload()
    pg.wait_for_function("(id) => [...document.querySelectorAll('.fl-editor')].length === 1 && document.querySelector('.fl-editor') && !/先在下方交付区/.test(document.querySelector('.fl-editor').textContent)", arg=cfg['file_id'], timeout=20000)
    pg.click('.fl-editor >> text=加一行')
    pg.select_option('.fl-editor tr:nth-child(2) td:nth-child(1) select', str(cfg['file_id']))
    # 草稿去抖 800ms 后 PUT /api/sop/runs/<id> 落盘：等最后一次改动之后的那个 PUT 应答回来（#954 批 E）
    try:
        with pg.expect_response(lambda r: '/api/sop/runs/' in r.url and r.request.method == 'PUT', timeout=10000):
            pg.select_option('.fl-editor tr:nth-child(2) td:nth-child(2) select', '交付件')
    except PWTimeout: pass
    val = json.loads(pg.eval_on_selector('[data-field="files"]', 'el => el.value'))
    pg.click('#finish')
    pg.wait_for_function("/执行完成|未完成|字段未填/.test(document.getElementById('state').textContent)", timeout=20000)
    state = pg.inner_text('#state')
    b.close()
print(json.dumps({'sha': val[0].get('sha256'), 'state': state, 'errors': errors}, ensure_ascii=False))
sys.exit(1 if errors else 0)
