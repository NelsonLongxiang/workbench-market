import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8')); rows=[];errors=[];console=[]
print('stage:start',flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,timeout=15000)
 print('stage:browser',flush=True)
 try:
  page=b.new_page();page.route('http://127.0.0.1:21916/**',lambda route:route.fulfill(status=200,content_type='text/html; charset=utf-8',body=Path(cfg['html']).read_text(encoding='utf8') if route.request.url.endswith('/preview') else '<!doctype html><h1>control-ok</h1>'));page.set_default_timeout(5000);page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:(console.append(m.text),print('console:'+m.text,flush=True)));page.on('requestfailed',lambda r:print('request-failed:'+str(r.failure),flush=True));print('stage:page',flush=True)
  page.goto(cfg['url'].replace('/preview','/control'),timeout=5000);assert page.locator('h1').inner_text()=='control-ok';print('stage:control-ok',flush=True)
  page.goto(cfg['url'],wait_until='commit',timeout=7000);print('stage:navigated',flush=True);page.wait_for_load_state('networkidle',timeout=7000);print('stage:loaded',flush=True);print(json.dumps({'console':console,'errors':errors}),flush=True)
  print('stage:state='+str(page.locator('#channel-state').get_attribute('data-state')),flush=True)
  expect(page.locator('#channel-state')).to_have_attribute('data-state','ready',timeout=5000)
  print('stage:ready',flush=True)
  frame=page.frames[1]
  print('stage:fields='+str(frame.locator('[data-field]').count()),flush=True)
  assert frame.locator('[data-field=note]').input_value()=='saved text'
  assert frame.locator('[data-field=count]').input_value()=='4'
  assert frame.locator('[data-field=ok]').is_checked()
  assert frame.locator('[data-field=tags]').evaluate('(e)=>[...e.selectedOptions].map(o=>o.value)')==['a']
  assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
  rows.append({'case':'typed-hydration-readonly','pass':True});print('stage:hydrated',flush=True)
  print('stage:isolation-script',flush=True)
  assert frame.evaluate('() => window.untrustedScriptRan===undefined')
  print('stage:isolation-parent',flush=True)
  assert frame.evaluate("() => {try{void parent.document;return false}catch{return true}}")
  print("stage:isolation-storage",flush=True)
  assert frame.evaluate("() => {try{void parent.localStorage;return false}catch{return true}}")
  print("stage:isolation-cookie",flush=True)
  assert frame.evaluate("() => {try{void document.cookie;return false}catch{return true}}")
  rows.append({'case':'opaque-storage-and-parent-boundary-script-blocked','pass':True});print('stage:isolation-complete',flush=True)
  frame.locator('[data-field=note]').evaluate("e=>e.value='local modification'");print('stage:modified',flush=True)
  print('stage:hydrate-click',flush=True);page.locator('#hydrate').click(timeout=3000,no_wait_after=True);print('stage:hydrate-sent',flush=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','ready',timeout=5000)
  assert frame.locator('[data-field=note]').input_value()=='saved text';rows.append({'case':'HYDRATE-over-port','pass':True})
  print('stage:lock-click',flush=True);page.locator('#lock').click(timeout=3000,no_wait_after=True);print('stage:lock-sent',flush=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','ready',timeout=5000)
  assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(x=>x.disabled)');rows.append({'case':'LOCK-ACK','pass':True})
  page.evaluate("() => window.postMessage({type:'READY',protocol:1,nonce:'wrong'},'*')")
  assert page.locator('#channel-state').get_attribute('data-state')=='ready';rows.append({'case':'wrong-window-global-message-ignored','pass':True})
  page.screenshot(path=cfg['screenshot'],full_page=True)
  page.locator('#teardown').click();assert page.locator('iframe').count()==0;assert page.locator('#channel-state').get_attribute('data-state')=='closed'
  page.evaluate("() => window.postMessage({type:'ACK',seq:0},'*')");assert page.locator('#channel-state').get_attribute('data-state')=='closed';rows.append({'case':'TEARDOWN-drops-old-window','pass':True})
  assert not errors,errors
 except Exception as e:
  Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors,'console':console,'failure':str(e)},ensure_ascii=False,indent=2),encoding='utf8')
  raise
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors},ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
