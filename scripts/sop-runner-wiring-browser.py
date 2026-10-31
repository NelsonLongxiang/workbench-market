import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));rows=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  context=b.new_context();context.add_cookies([{'name':'session_id','value':cfg['cookie'].split('=',1)[1],'url':cfg['url'].split('/sop/')[0]}]);page=context.new_page();page.set_default_timeout(5000)
  response=page.goto(cfg['url'],wait_until='load',timeout=7000);assert response.status==200;expect(page.locator('#channel-state')).to_have_attribute('data-state','ready')
  frame=page.frames[1];assert frame.locator('[data-field=note]').input_value()=='SAVED_OWNER_VALUE';assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(e=>e.disabled)');rows.append('real-index-pinned-run-readonly-values')
  assert frame.evaluate('() => {try{void parent.document;return false}catch{return true}}');assert frame.evaluate('() => {try{void document.cookie;return false}catch{return true}}');assert frame.evaluate('() => window.untrustedScriptRan===undefined');rows.append('opaque-boundary-and-script-blocked')
  frame.locator('[data-field=note]').evaluate('e=>e.value="local-only"');page.locator('#hydrate').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','ready');assert frame.locator('[data-field=note]').input_value()=='SAVED_OWNER_VALUE';rows.append('real-HTTP-HYDRATE')
  page.screenshot(path=cfg['screenshot'],full_page=True);page.locator('#teardown').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','closed');assert page.locator('iframe').count()==0;rows.append('TEARDOWN')
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'cases':rows,'scope':'real HTTP full index/fake Odoo/synthetic store; not real users or production'},indent=2),encoding='utf8');print(json.dumps(rows))
