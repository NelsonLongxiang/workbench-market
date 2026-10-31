import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));rows=[];requests=[];errors=[];revision=0;conflict=False
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  page=b.new_page();page.set_default_timeout(5000);page.on('pageerror',lambda e:errors.append(str(e)))
  def route(r):
   global revision,conflict
   if r.request.url.endswith('/api/sop/field-channel/save'):
    body=r.request.post_data_json;headers=r.request.all_headers();requests.append(body)
    assert headers.get('x-sop-run-capability')==cfg['capability'];assert r.request.frame==page.main_frame
    assert set(body)=={'runId','targetId','step','version','expected_revision','values'}
    assert body['runId']==12 and body['targetId']==4 and body['step']=='inspect' and body['version']==3
    outgoing=dict(body)
    if conflict:outgoing['expected_revision']=0
    print('BRIDGE '+json.dumps({'body':outgoing,'capability':headers.get('x-sop-run-capability')}),flush=True)
    response=json.loads(sys.stdin.readline())
    if response['status']==200:revision=response['body']['revision']
    r.fulfill(status=response['status'],content_type='application/json',body=json.dumps(response['body']))
   else:r.fulfill(status=200,content_type='text/html',body=Path(cfg['html']).read_text(encoding='utf8'))
  page.route('http://127.0.0.1:21916/**',route)
  page.goto('http://127.0.0.1:21916/preview',wait_until='load');expect(page.locator('#channel-state')).to_have_attribute('data-state','ready');frame=page.frames[1]
  assert frame.locator('[data-field=note]').input_value()=='saved text';assert frame.locator('[data-field=note]').is_enabled()
  assert frame.evaluate('() => window.untrustedScriptRan===undefined')
  assert frame.evaluate('() => {try{void parent.document;return false}catch{return true}}')
  assert frame.evaluate('() => {try{void parent.localStorage;return false}catch{return true}}')
  assert frame.evaluate('() => !document.documentElement.outerHTML.includes("'+cfg['capability']+'")')
  rows.append({'case':'opaque-editable-init-no-capability','pass':True})
  frame.locator('[data-field=note]').fill('changed');expect(page.locator('#channel-state')).to_have_attribute('data-state','saved');assert requests[-1]['values']['note']=='changed';assert revision==1
  expect(frame.locator('html')).to_have_attribute('data-validation','saved');rows.append({'case':'CHANGE-trusted-shell-fixed-save-VALIDATE','pass':True})
  frame.locator('[data-field=note]').evaluate('e => e.value="collected without change event"')
  page.locator('#collect').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','saved');assert requests[-1]['values']['note']=='collected without change event';assert revision==2
  rows.append({'case':'COLLECT-current-values-request-bound','pass':True})
  assert all('capability' not in x and 'url' not in x and 'method' not in x for x in requests)
  conflict=True;frame.locator('[data-field=note]').fill('conflicting');expect(page.locator('#channel-state')).to_have_attribute('data-state','conflict');assert page.locator('#body-frame').count()==0;assert revision==2
  rows.append({'case':'409-conflict-no-fake-saved','pass':True})
  print('BRIDGE '+json.dumps({'reset':True}),flush=True);assert json.loads(sys.stdin.readline())['status']==200
  conflict=False;revision=0;page.goto('http://127.0.0.1:21916/preview',wait_until='load');expect(page.locator('#channel-state')).to_have_attribute('data-state','ready');frame=page.frames[1]
  page.locator('#lock').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','locked');assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(e=>e.disabled)');rows.append({'case':'LOCK-ACK-all-controls-disabled','pass':True})
  page.screenshot(path=cfg['screenshot'],full_page=True);page.locator('#teardown').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','closed');assert page.locator('iframe').count()==0;rows.append({'case':'TEARDOWN-frame-removed','pass':True})
  assert not errors,errors
 except Exception as e:
  Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors,'failure':str(e)},ensure_ascii=False,indent=2),encoding='utf8');raise
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'rows':rows,'errors':errors,'save_requests':len(requests),'scope':'Chromium intercepted responses; actual MessageChannel/CSP; real save service+SQLite bridged over owned stdio; no real HTTP transport'},ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
