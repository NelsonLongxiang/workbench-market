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
  # Hold actual READY before the host sees it; mutate only synthetic browser events.
  probe=b.new_page();probe.set_default_timeout(5000)
  probe.route('http://127.0.0.1:21916/**',lambda r:r.fulfill(status=200,content_type='text/html',body=Path(cfg['html']).read_text(encoding='utf8')))
  probe.add_init_script("""(() => {if(window!==top)return;window.__holdReady=true;window.__ports=[];const Original=MessageChannel;window.MessageChannel=class extends Original{constructor(){super();window.__ports.push(this.port1)}};window.addEventListener('message',e=>{if(window.__holdReady && e.data?.type==='READY'){window.__held={data:e.data,source:e.source,origin:e.origin};e.stopImmediatePropagation()}},true)})()""")
  def held():
   probe.goto(cfg['url'],wait_until='load',timeout=7000)
   probe.wait_for_function('() => !!window.__held',timeout=5000)
   expect(probe.locator('#channel-state')).to_have_attribute('data-state','handshake')
  held()
  old=probe.evaluate('() => window.__held.data')
  probe.evaluate("() => {const h=window.__held;window.__holdReady=false;window.dispatchEvent(new MessageEvent('message',{data:h.data,source:window,origin:'null'}))}")
  assert probe.evaluate('() => window.__ports.length')==0
  expect(probe.locator('#channel-state')).to_have_attribute('data-state','handshake')
  probe.evaluate("() => {const h=window.__held;window.dispatchEvent(new MessageEvent('message',h))}")
  expect(probe.locator('#channel-state')).to_have_attribute('data-state','ready')
  rows.append({'case':'fake-null-origin-valid-binding-wrong-window-no-transfer','pass':True})
  for key,value in [('targetId',9),('step','release'),('version',9),('field_keys',['admin'])]:
   held()
   probe.evaluate("p => {const h=window.__held;window.__holdReady=false;window.dispatchEvent(new MessageEvent('message',{...h,data:{...h.data,[p.key]:p.value}}))}",{'key':key,'value':value})
   expect(probe.locator('#channel-state')).to_have_attribute('data-state','rejected')
   assert probe.evaluate('() => window.__ports.length')==0
   rows.append({'case':'READY-cross-binding-'+key,'pass':True})
  held()
  probe.evaluate("old => {const h=window.__held;window.__holdReady=false;window.dispatchEvent(new MessageEvent('message',{...h,data:old}))}",old)
  expect(probe.locator('#channel-state')).to_have_attribute('data-state','rejected')
  rows.append({'case':'previous-frame-READY-replay-rejected','pass':True})
  held()
  probe.evaluate("() => {const h=window.__held;window.__holdReady=false;window.dispatchEvent(new MessageEvent('message',h))}")
  expect(probe.locator('#channel-state')).to_have_attribute('data-state','ready')
  probe.evaluate("() => {const f=document.getElementById('body-frame');const copy=f.cloneNode();f.replaceWith(copy);const m={...window.__held.data,type:'ACK',seq:0};delete m.field_keys;window.__ports[0].onmessage({data:m})}")
  expect(probe.locator('#channel-state')).to_have_attribute('data-state','rejected')
  rows.append({'case':'replace-frame-old-port-ACK-rejected','pass':True})
  probe.close()
  seed_page=b.new_page();seed_page.route('http://127.0.0.1:21916/**',lambda r:r.fulfill(status=200,content_type='text/html',body=Path(cfg['seedHtml']).read_text(encoding='utf8')))
  seed_page.goto(cfg['url'],wait_until='load',timeout=7000);expect(seed_page.locator('#channel-state')).to_have_attribute('data-state','ready')
  sf=seed_page.frames[1];assert sf.locator('[data-field="配件数"]').input_value()=='6';assert sf.locator('[data-field="外观"]').input_value()=='无';assert sf.locator('input,select').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
  rows.append({'case':'real-seed-versioned-candidate-unicode-fields-finished-readonly','pass':True});seed_page.close()
  assert not errors,errors
 except Exception as e:
  Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors,'console':console,'failure':str(e)},ensure_ascii=False,indent=2),encoding='utf8')
  raise
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors},ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
