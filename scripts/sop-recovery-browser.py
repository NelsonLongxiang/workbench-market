import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));rows=[];captured={}
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  context=b.new_context();context.add_cookies([{'name':'session_id','value':cfg['cookie'].split('=',1)[1],'url':cfg['url'].split('/sop/')[0]}]);page=context.new_page();page.set_default_timeout(6000);page.add_init_script("(() => {if(window!==top)return;window.__channelTrace=[];const Native=MessageChannel;window.MessageChannel=class extends Native{constructor(){super();this.port1.addEventListener('message',e=>window.__channelTrace.push({type:e.data.type,field:e.data.field,value:e.data.value,request:e.data.request_id}));}}})()")
  def capture(request):
   if request.url.endswith('/api/sop/field-channel/save'):captured['save']=request.all_headers().get('x-sop-run-capability')
   if request.url.endswith('/api/sop/field-channel/recover'):captured['recover']=request.all_headers().get('x-sop-recovery-capability')
  page.on('request',capture);response=page.goto(cfg['url'],wait_until='load',timeout=10000);assert response.status==200;expect(page.locator('#channel-state')).to_have_attribute('data-state','ready');frame=page.frames[1]
  frame.locator('[data-field=note]').fill('persisted HTTP');expect(page.locator('#channel-state')).to_have_attribute('data-state','saved');rows.append('actual-http-save')
  frame.locator('[data-field=evidence]').set_input_files({'name':'../../sample.txt','mimeType':'text/plain','buffer':b'hello'});expect(frame.locator('html')).to_have_attribute('data-upload','uploaded');rows.append('actual-http-upload')
  page.reload(wait_until='load');expect(page.locator('#channel-state')).to_have_attribute('data-state','ready');frame=page.frames[1];assert frame.locator('[data-field=note]').input_value()=='persisted HTTP';rows.append('reload-fresh-authorized-values')
  other=context.new_page();other.set_default_timeout(6000);other.goto(cfg['url'],wait_until='load');expect(other.locator('#channel-state')).to_have_attribute('data-state','ready');other.frames[1].locator('[data-field=note]').fill('other server revision');expect(other.locator('#channel-state')).to_have_attribute('data-state','saved')
  page.locator('#recover').click(no_wait_after=True);expect(page.locator('#channel-state')).to_have_attribute('data-state','server_revision_applied');assert frame.locator('[data-field=note]').input_value()=='other server revision';assert '服务端版本' in page.locator('#recovery-notice').inner_text();rows.append('revision-mismatch-announced-and-HYDRATE')
  for value in captured.values():assert frame.evaluate('(cap)=>!document.documentElement.outerHTML.includes(cap)',value)
  frame.locator('[data-field=note]').fill('after recovery');expect(page.locator('#channel-state')).to_have_attribute('data-state','saved');rows.append('write-uses-recovered-revision')
  # Explicit recovery request capability is not interchangeable with the save capability.
  r=context.request.post(cfg['origin']+'/api/sop/field-channel/recover',headers={'Origin':cfg['origin'],'X-Sop-Recovery-Capability':captured['save']},data={'runId':12,'targetId':4,'step':'inspect'});assert r.status==403;rows.append('save-cap-not-recovery-cap')
  page.locator('#finish').click(no_wait_after=True)
  try:expect(page.locator('#channel-state')).to_have_attribute('data-state','finished')
  except Exception:
   print('FINISH_TRACE '+json.dumps(page.evaluate('() => window.__channelTrace')),flush=True);raise
  rows.append('actual-http-finish-and-lock')
  page.reload(wait_until='load');expect(page.locator('#channel-state')).to_have_attribute('data-state','finished');frame=page.frames[1];assert frame.locator('[data-field=note]').input_value()=='after recovery';assert frame.locator('input,select,button').evaluate_all('(xs)=>xs.every(e=>e.disabled)');rows.append('completed-run-reload-readonly-no-unlock')
  page.screenshot(path=cfg['screenshot'],full_page=True);other.close()
 finally:b.close()
Path(cfg['result']).write_text(json.dumps({'cases':rows,'scope':'real index/HTTP/Chromium with synthetic SQLite/fake Odoo, no production Redis'},ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
