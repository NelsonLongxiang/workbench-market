import json,re,sys,mimetypes
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));dist=Path(cfg['dist']);results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 try:
  for mode in ['intake','legacy']:
   page=browser.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(7000);uploads=[];published=[];errors=[];page.on('pageerror',lambda e:errors.append(str(e)));token='SYNTHETIC_CREATION_TOKEN_'+mode
   def route(r):
    path=r.request.url.split('http://tasks.synthetic.invalid',1)[1].split('?',1)[0]
    if path=='/api/tasks':r.fulfill(content_type='application/json',body=json.dumps({'tasks':[],'sources':{'market':{'ok':True,'count':0}},'generated_at':'2026-11-01T00:45:00Z'}))
    elif path=='/api/sops':r.fulfill(content_type='application/json',body=json.dumps([{'slug':'synthetic-sop','title':'Synthetic SOP'}]))
    elif path=='/api/sop/runs' and r.request.method=='POST':r.fulfill(status=201,content_type='application/json',body=json.dumps({'id':12,'upload_token':token}))
    elif path=='/api/sop/runs/12/files':
     supplied=r.request.headers.get('x-run-upload-token');uploads.append(supplied==token);r.fulfill(status=201 if supplied==token else 403,content_type='application/json',body='{"ok":true}')
    elif path=='/api/task-center/tasks':published.append(True);r.fulfill(status=201,content_type='application/json',body='{"id":1,"ok":true}')
    elif path.startswith('/api/sop/runs/12'):r.fulfill(content_type='application/json',body='{"ok":true}')
    elif path.startswith('/api/'):r.fulfill(content_type='application/json',body='{}')
    else:
     f=dist/path.lstrip('/') if path.startswith('/assets/') else dist/'index.html';r.fulfill(content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream',body=f.read_bytes())
   page.route('http://tasks.synthetic.invalid/**',route);page.goto('http://tasks.synthetic.invalid/tasks',wait_until='load');page.locator('button').filter(has_text='发布任务').click()
   if mode=='legacy':page.get_by_text('直接开 SOP run',exact=False).click();page.get_by_text('我自己做',exact=True).click()
   page.wait_for_function('() => {const e=document.querySelector(".ant-drawer-content-wrapper"); if(!e)return false;const r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1}')
   page.locator('.ant-drawer .ant-select-selector').click();page.get_by_title('Synthetic SOP (synthetic-sop)',exact=True).click();page.get_by_placeholder('如：核对十月物流对账差异').fill('Synthetic task');page.locator('input[type=file]').set_input_files({'name':'synthetic.txt','mimeType':'text/plain','buffer':b'synthetic attachment'})
   page.locator('.ant-drawer').get_by_role('button',name=re.compile(r'^发\s*布$')).click();expect(page.get_by_text('任务已发布',exact=False).first).to_be_visible();assert uploads==[True],uploads;assert len(published)==(1 if mode=='intake' else 0);assert not errors,errors
   page.wait_for_function('() => {const e=document.querySelector(".ant-drawer-content-wrapper");return !e||e.getBoundingClientRect().left>=innerWidth}')
   page.screenshot(path=str(Path(cfg['out'])/(mode+'.png')),full_page=True);results.append({'mode':mode,'uploads_with_creation_token':len(uploads),'publication_calls':len(published),'page_errors':errors});page.close()
 finally:
  if 'page' in locals() and not page.is_closed():
   Path(cfg['out'],'diagnostic.json').write_text(json.dumps({'url':page.url,'body':page.locator('body').inner_text(),'errors':errors},ensure_ascii=False,indent=2),encoding='utf8')
  browser.close()
Path(cfg['out'],'tasks-browser.json').write_text(json.dumps({'results':results,'scope':'actual built React/antd forms with intercepted strict-token HTTP contract; not real backend authentication proof'},indent=2),encoding='utf8');print('2 actual Tasks browser paths passed')
