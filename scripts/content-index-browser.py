import json,sys,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));rows=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-proxy-server','--host-resolver-rules=MAP w-2-test.internal 127.0.0.1'])
 try:
  c=b.new_context();c.add_cookies([{'name':'session_id','value':'synthetic1234567890','url':cfg['market'],'httpOnly':True,'sameSite':'Lax'}]);page=c.new_page()
  r=page.goto(cfg['market']+'/content/open/2');assert r.status==200
  requests=[];c.on('request',lambda r:requests.append({'url':r.url,'method':r.method,'origin':r.headers.get('origin'),'ctype':r.headers.get('content-type')}))
  with c.expect_page() as opened:page.get_by_role('button',name='打开工作台').click()
  target=opened.value
  try:target.wait_for_url('**/go/2/',timeout=8000);target.wait_for_load_state('networkidle')
  except Exception:
   Path(cfg['result']+'.failure.json').write_text(json.dumps({'requests':requests,'url':target.url,'text':target.locator('body').inner_text(),'html':target.content()},ensure_ascii=False),encoding='utf8');raise
  assert target.locator('h1').inner_text()=='content-ok';assert target.evaluate('window.opener===null')
  rows.append({'case':'full-index-cross-site-launch','status':200,'opener_null':True})
  target.evaluate("""()=>{window.wsState={messages:0,closed:false};window.liveSocket=new WebSocket(location.origin.replace('http','ws')+'/go/2/socket');liveSocket.onmessage=()=>wsState.messages++;liveSocket.onclose=()=>{wsState.closed=true};liveSocket.onerror=()=>{};}""")
  target.wait_for_function('wsState.messages>0');target.evaluate("liveSocket.send('before-revocation')")
  urllib.request.urlopen(cfg['odoo']+'/revoke').read()
  import time
  started=time.monotonic();target.wait_for_function('wsState.closed',timeout=12000);elapsed_ms=(time.monotonic()-started)*1000
  assert elapsed_ms<11000,elapsed_ms
  observed=target.evaluate('wsState.messages');target.wait_for_timeout(150);assert target.evaluate('wsState.messages')==observed
  assert target.evaluate('liveSocket.readyState')==3
  rows.append({'case':'open-browser-websocket-revoked','closed':True,'disconnect_ms':round(elapsed_ms),'no_messages_after_close':True})
  # Run fetch from the original upstream document; the expired static page itself has connect-src none.
  result=target.evaluate("""async()=>{const r=await fetch('/go/2/resource',{method:'POST',body:'do-not-replay'});return {status:r.status,body:await r.json()}}""")
  assert result=={'status':401,'body':{'error':'content_context_expired'}};rows.append({'case':'revoked-fetch-no-replay',**result})
  r=target.reload();target.wait_for_load_state('networkidle');assert r.status==401
  a=target.get_by_role('link',name='重新打开此工作台');assert a.get_attribute('href')==cfg['market']+'/content/open/2'
  assert target.locator('a').count()==1;assert target.locator('script').count()==0
  rows.append({'case':'fresh-odoo-revoked-navigation','status':401,'same_target_only':True})
  c.close()
 finally:b.close()
Path(cfg['result']).write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(rows,ensure_ascii=False))
