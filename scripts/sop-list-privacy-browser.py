import json,sys,mimetypes,re
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from sop_history_assertions import assert_metadata_history
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));dist=Path(cfg['dist']);seen=[];errors=[];history_rows=[];surface=cfg.get('surface','control')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  page=b.new_page(viewport={'width':1440,'height':900});page.set_default_timeout(7000);page.on('pageerror',lambda e:errors.append(str(e)))
  app={'id':1,'slug':'synthetic-sop','title':'Synthetic SOP','description':'','created_by':'synthetic','active_version':1,'status':'published','kind':'sop','code':'SYN-1','created_at':'2026-01-01 00:00:00','updated_at':'2026-01-01 00:00:00','versions':[{'version':1}],'workbench_id':1}
  run={'id':12,'sop_slug':'synthetic-sop','sop_version':1,'status':'running','started_by':'synthetic','steps':2,'started_at':'2026-01-01 00:00:00','updated_at':'2026-01-01 00:00:00','finished_at':''}
  def route(r):
   path=r.request.url.split('http://privacy.synthetic.invalid',1)[1].split('?',1)[0];seen.append(path)
   if path=='/api/sops':r.fulfill(content_type='application/json',body=json.dumps([app]))
   elif path=='/api/sop/runs':r.fulfill(content_type='application/json',body=json.dumps([] if 'dispatched=1' in r.request.url else [run]))
   elif path.startswith('/api/') or path=='/health':r.fulfill(content_type='application/json',body='{}')
   else:
    f=dist/path.lstrip('/') if path.startswith('/assets/') else dist/'index.html'
    content=f.read_bytes()
    if f.name=='index.html':content=content.replace(b'<head>',('<head><meta name="wm-surface" content="'+surface+'">').encode())
    r.fulfill(content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream',body=content)
  page.route('http://privacy.synthetic.invalid/**',route);page.goto('http://privacy.synthetic.invalid/sops',wait_until='load')
  with page.expect_response(lambda r:'/api/sop/runs?' in r.url and 'slug=synthetic-sop' in r.url) as response:
   page.get_by_role('button',name=re.compile(r'记\s*录')).click()
  history_rows=response.value.json();expect(page.get_by_text('执行记录',exact=True)).to_be_visible()
  assert_metadata_history(page.locator('.ant-drawer-content'),'synthetic',2,seen,history_rows,('PRIVATE_STEP_VALUE','PRIVATE_UPLOAD_TOKEN'))
  for bad_rows,bad_requests in [([{**history_rows[0],'data':'PRIVATE_STEP_VALUE'}],seen),([{**history_rows[0],'upload_token':'PRIVATE_UPLOAD_TOKEN'}],seen),(history_rows,seen+['/api/sop/runs/12'])]:
   try:assert_metadata_history(page.locator('.ant-drawer-content'),'synthetic',2,bad_requests,bad_rows,('PRIVATE_STEP_VALUE','PRIVATE_UPLOAD_TOKEN'))
   except AssertionError:pass
   else:raise AssertionError('privacy negative control not detected')
  assert not errors,errors
  page.wait_for_function('() => {const e=document.querySelector(".ant-drawer-content-wrapper"); if(!e)return false;const r=e.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth+1}')
  page.screenshot(path=cfg['screenshot'],full_page=True)
 finally:
  Path(cfg['result']).write_text(json.dumps({'requests':seen,'errors':errors,'body':page.locator('body').inner_text()[:1000]},ensure_ascii=False,indent=2),encoding='utf8');b.close()
Path(cfg['result']).write_text(json.dumps({'cases':['metadata-only-list-render','server-step-count','no-expand-private-data','no-single-run-fallback-fetch'],'page_errors':errors,'scope':'actual built React/antd page with intercepted synthetic API; no production HTTP'},indent=2),encoding='utf8');print('4 UI checks passed')
