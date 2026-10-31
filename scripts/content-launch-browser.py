"""Synthetic cross-site Strict-cookie redirect-chain regression; no real DNS/credentials."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));rows=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-proxy-server','--host-resolver-rules=MAP w-1-test.internal 127.0.0.1'])
 try:
  for mode,status in [('303',403),('200',200)]:
   c=b.new_context();page=c.new_page();page.goto(cfg['market']+'/?mode='+mode)
   with c.expect_page() as opened:page.get_by_role('button',name='Open').click()
   popup=opened.value;popup.wait_for_url('**/go/1/');popup.wait_for_load_state()
   body=json.loads(popup.locator('body').inner_text());assert body['status']==status,body
   assert body['cookie_sent']==(mode=='200'),body
   assert popup.evaluate('window.opener===null')
   rows.append({'mode':mode,'status':body['status'],'cookie_sent':body['cookie_sent'],'opener_null':True})
   c.close()
 finally:b.close()
Path(cfg['result']).write_text(json.dumps(rows,indent=2),encoding='utf-8');print(json.dumps(rows))
