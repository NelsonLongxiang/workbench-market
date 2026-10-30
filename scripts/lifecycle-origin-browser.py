"""Browser-only synthetic origin probes; never targets production or real Odoo."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
rows=[]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    try:
        for surface in cfg['surfaces']:
            ctx=b.new_context()
            ctx.add_cookies([{'name':'session_id','value':'SYNTHETIC_ORIGIN_SESSION_123456789','url':cfg['base'],'httpOnly':True,'sameSite':'Lax'}])
            page=ctx.new_page();events=[]
            cdp=ctx.new_cdp_session(page);cdp.send('Network.enable')
            sent={};raw=[]
            cdp.on('Network.requestWillBeSent',lambda e:sent.__setitem__(e['requestId'],{'url':e['request']['url'],'method':e['request']['method']}))
            cdp.on('Network.responseReceivedExtraInfo',lambda e:raw.append({'request_id':e['requestId'],'status':e['statusCode']}))
            def response(r):
                if '/api/lifecycle/approve' not in r.url and '/api/lifecycle/grant' not in r.url:return
                if r.request.method!='POST':return
                h=r.request.all_headers()
                events.append({'path':r.url.split('/api/lifecycle/')[-1],'status':r.status,'origin':h.get('origin'),'fetch_site':h.get('sec-fetch-site'),'cookie_present':'session_id=' in h.get('cookie',''),'mode':h.get('x-origin-probe','simple'),'body':r.text()[:200]})
            page.on('response',response)
            resp=page.goto(surface['url']);page.wait_for_timeout(1200)
            csp=resp.headers.get('content-security-policy','')
            done=page.evaluate('window.__originAudit || null')
            assert done is not None and len(done)==4, 'fixture script did not execute: '+surface['name']
            for e in events:
                assert e['status']>=400, 'unexpected lifecycle write success: '+str(e)
                if e['path']=='approve':assert e['status']==503 and 'LC_APPROVAL_READ_ONLY' in e['body']
                if e['path']=='grant':assert e['status']==404
            wire=[{**e,**sent.get(e['request_id'],{})} for e in raw if '/api/lifecycle/' in sent.get(e['request_id'],{}).get('url','')]
            assert all(e['status']>=400 for e in wire), 'wire-level write was not rejected'
            if surface['opaque']:
                assert 'sandbox' in csp and 'allow-same-origin' not in csp
                assert not any(e['mode']=='json' for e in events), 'opaque JSON POST bypassed preflight'
            else:
                assert len([e for e in events if e['mode']=='json'])==2
                assert all(e['cookie_present'] and e['fetch_site']=='same-origin' for e in events if e['mode']=='json')
            rows.append({'surface':surface['name'],'pass':True,'csp':csp,'browser_results':done,'observed_posts':events,'wire_responses':wire})
            ctx.close()
    finally:b.close()
Path(cfg['result']).write_text(json.dumps({'base':cfg['base'],'scope':'synthetic browser requests; current hard-disable only, NOT proof of future write isolation','rows':rows},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'surfaces':len(rows),'passed':len(rows)},ensure_ascii=False))
