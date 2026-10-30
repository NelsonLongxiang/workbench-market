"""Targeted browser test: real ViewerChip + shared login hook, synthetic HTTP only.
Run after bundling scripts/viewer-refresh-fixture.tsx to a caller-supplied JS path.
Popup closed flag simulates COOP severance; independent TEST covers real COOP.
"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
bundle=Path(sys.argv[1]).read_text(encoding='utf-8')
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch()
    try:
        for mode in ['success','unauthorized','bad-json','missing-viewer','failed','expired']:
            ctx=browser.new_context()
            page=ctx.new_page()
            state={'phase':False,'calls':0}
            def route(r):
                if '/api/lifecycle/whoami' in r.request.url:
                    state['calls']+=1
                    code=401; body={'ok':False,'login_url':'/login'}
                    if state['phase']:
                        code={'unauthorized':401,'failed':503}.get(mode,200)
                        body={'ok':True,'viewer':{'login':'fixture-a','uid':7,'sub':'user:fixture-a','name':'Fixture A','kind':'human'}} if mode=='success' else {'ok':False}
                    if state['phase'] and mode=='missing-viewer': body={'ok':True}
                    if state['phase'] and mode=='bad-json':
                        r.fulfill(status=200,body='not-json',content_type='application/json')
                    else:r.fulfill(status=code,body=json.dumps(body),content_type='application/json')
                elif r.request.url.endswith('/bundle.js'):r.fulfill(body=bundle,content_type='text/javascript')
                else:r.fulfill(body='<div id="root"></div><script src="/bundle.js"></script>',content_type='text/html')
            page.route('**/*',route)
            page.add_init_script("window.open=()=>({closed:true,close(){}})")
            page.goto('http://fixture.test/')
            expect(page.get_by_text('未登录 Odoo',exact=True)).to_be_visible()
            page.get_by_role('button',name='Page login',exact=True).click()
            if mode=='expired':
                page.evaluate('Date.now = () => ' + str(page.evaluate('Date.now()') + 601000))
            state['phase']=True
            if mode=='success':
                expect(page.get_by_test_id('done')).to_have_text('1',timeout=5000)
                expect(page.get_by_text('Fixture A（fixture-a）· human',exact=True)).to_be_visible(timeout=5000)
                before=state['calls']
                page.evaluate("for(let i=0;i<10;i++)window.dispatchEvent(new Event('focus'))")
                page.wait_for_timeout(300)
                assert state['calls']==before, 'repeated focus started new requests after completion'
                expect(page.get_by_test_id('done')).to_have_text('1')
            else:
                page.wait_for_timeout(1800)
                expect(page.get_by_test_id('done')).to_have_text('0')
                assert page.get_by_text('Fixture A（fixture-a）· human',exact=True).count()==0
            results.append({'scenario':mode,'pass':True,'whoami_calls':state['calls']})
            ctx.close()
    finally:browser.close()
print(json.dumps(results,ensure_ascii=False))
