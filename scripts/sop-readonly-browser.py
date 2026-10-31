import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8')); rows=[];errors=[];console=[]
print('stage:start',flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,timeout=15000)
 print('stage:browser',flush=True)
 try:
  page=b.new_page();page.set_default_timeout(7000);page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:console.append(m.text));print('stage:page',flush=True);page.goto(cfg['url'],timeout=10000);print('stage:navigated',flush=True);page.wait_for_load_state('networkidle',timeout=10000);print('stage:loaded',flush=True);print(json.dumps({'console':console,'errors':errors}),flush=True)
  print('stage:state='+str(page.locator('#channel-state').get_attribute('data-state')),flush=True)
  page.wait_for_function("document.querySelector('#channel-state').dataset.state==='ready'",timeout=5000)
  frame=page.frames[1]
  assert frame.locator('[data-field=note]').input_value()=='saved text'
  assert frame.locator('[data-field=count]').input_value()=='4'
  assert frame.locator('[data-field=ok]').is_checked()
  assert frame.locator('[data-field=tags]').evaluate('(e)=>[...e.selectedOptions].map(o=>o.value)')==['a']
  assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
  rows.append({'case':'typed-hydration-readonly','pass':True})
  assert frame.evaluate('window.untrustedScriptRan===undefined')
  assert frame.evaluate("(()=>{try{void parent.document;return false}catch{return true}})()")
  assert frame.evaluate("(()=>{try{void parent.localStorage;return false}catch{return true}})()")
  assert frame.evaluate("(()=>{try{void document.cookie;return false}catch{return true}})()")
  rows.append({'case':'opaque-storage-and-parent-boundary-script-blocked','pass':True})
  frame.locator('[data-field=note]').evaluate("e=>e.value='local modification'")
  page.locator('#hydrate').click();page.wait_for_function("document.querySelector('#channel-state').dataset.state==='ready'")
  assert frame.locator('[data-field=note]').input_value()=='saved text';rows.append({'case':'HYDRATE-over-port','pass':True})
  page.locator('#lock').click();page.wait_for_function("document.querySelector('#channel-state').dataset.state==='ready'")
  assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(x=>x.disabled)');rows.append({'case':'LOCK-ACK','pass':True})
  page.evaluate("window.postMessage({type:'READY',protocol:1,nonce:'wrong'},'*')")
  assert page.locator('#channel-state').get_attribute('data-state')=='ready';rows.append({'case':'wrong-window-global-message-ignored','pass':True})
  page.screenshot(path=cfg['screenshot'],full_page=True)
  page.locator('#teardown').click();assert page.locator('iframe').count()==0;assert page.locator('#channel-state').get_attribute('data-state')=='closed'
  page.evaluate("window.postMessage({type:'ACK',seq:0},'*')");assert page.locator('#channel-state').get_attribute('data-state')=='closed';rows.append({'case':'TEARDOWN-drops-old-window','pass':True})
  assert not errors,errors
 except Exception as e:
  Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors,'console':console,'failure':str(e)},ensure_ascii=False,indent=2),encoding='utf8')
  raise
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors},ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
