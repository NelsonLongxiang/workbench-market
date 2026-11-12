"""Real built SPA, controlled metadata/API responses, no production writes or credentials."""
import http.server, threading, pathlib, json, sys, re
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parent.parent
DIST=ROOT/'web'/'dist'
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*a,**k): super().__init__(*a,directory=str(DIST),**k)
 def log_message(self,*a): pass
 def do_GET(self):
  if self.path.split('?')[0] in ['/','/tasks','/reviews']:
   body=(DIST/'index.html').read_bytes(); self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(body)
  else: super().do_GET()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
checks=[]
def check(name,ok):
 checks.append({'name':name,'ok':bool(ok)});print(('PASS ' if ok else 'FAIL ')+name)
 if not ok: raise AssertionError(name)
row={'id':1,'kind':'app','op':'rollback','slug':'synthetic-finance','target_version':83,'status':'pending','reason':'SYNTHETIC scoped rollback','requested_by':'synthetic-agent','reviewed_by':'','created_at':'2026-11-02 00:00:00'}
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  def context(surface,control=None,processed=False,fail=False):
   ctx=browser.new_context();requests=[];writes=[];ctx.on('page',lambda pg:pg.on('pageerror',lambda error:None if fail and str(error)=='synthetic apply failed' else (_ for _ in ()).throw(AssertionError('built SPA runtime error: '+str(error)))));state={'status':'approved' if processed else 'pending'}
   def route(r):
    req=r.request;path=req.url.split(base)[-1].split('?')[0]
    if path in ['/','/tasks','/reviews']:
     html=(DIST/'index.html').read_text(encoding='utf8');meta='<meta name="wm-surface" content="'+surface+'"><meta name="wm-control-url" content="'+(control or '')+'">';r.fulfill(status=200,content_type='text/html',body=html.replace('<head>','<head>'+meta));return
    if path.startswith('/api/'):
     requests.append({'path':path,'method':req.method,'token_present':bool(req.headers.get('x-admin-token'))})
     if path=='/api/admin/whoami':tok=bool(req.headers.get('x-admin-token'));r.fulfill(json={'admin':tok,'via':'token' if tok else None,'login':None});return # 口令保存前要先核对（#424）
     if path=='/api/tasks':r.fulfill(json={'tasks':[{'id':'change-request:1','source':'market','title':'SYNTHETIC review','status':'todo','due':None,'link':'/api/change-requests','project':'review-gate'}],'sources':{'market':{'ok':True,'count':1,'latency_ms':1},'ygl-trees':{'ok':True,'count':0,'latency_ms':1}},'generated_at':'synthetic'});return
     if path=='/api/change-requests':
      if not req.headers.get('x-admin-token'):r.fulfill(status=403,json={'error':'token required'});return
      r.fulfill(json=[{**row,'status':state['status']}]);return
     if path=='/api/change-requests/1/approve':
      writes.append(req.post_data_json)
      if fail:r.fulfill(status=500,json={'error':'synthetic apply failed'});return
      state['status']='approved';r.fulfill(json={'ok':True,'id':1,'status':'approved'});return
     if path=='/api/change-requests/1/reject':writes.append(req.post_data_json);state['status']='rejected';r.fulfill(json={'ok':True,'id':1,'status':'rejected'});return
     r.fulfill(json=[]);return
    r.continue_()
   ctx.route('**/*',route);return ctx,requests,writes
  ctx,requests,writes=context('market');page=ctx.new_page();page.goto(base+'/tasks');go=page.get_by_role('link',name='去处理').first;go.wait_for();check('legacy review envelope opens UI not protected JSON',go.get_attribute('href')=='/reviews?request=1');
  with page.expect_popup() as opened: go.click()
  review=opened.value;review.wait_for_load_state();review.get_by_text('请先确认管理员身份',exact=False).last.wait_for();check('market without admin identity shows actionable explanation',review.get_by_text('请先确认管理员身份',exact=False).last.is_visible());check('market review page without admin never queries privileged API',not any(x['path']=='/api/change-requests' for x in requests));check('market review performs no writes',not writes);ctx.close()
  ctx,requests,writes=context('market');page=ctx.new_page();page.add_init_script("sessionStorage.setItem('wm-admin-token','synthetic-admin')");page.goto(base+'/reviews?request=1');page.get_by_text('synthetic-finance',exact=False).first.wait_for();check('market with admin token reads review data (owner 2026-11-02: token is enough)',any(x['path']=='/api/change-requests' and x['token_present'] for x in requests));check('market page has no control-surface handoff link',page.get_by_role('link',name='前往管理控制面').count()==0);check('market opening page performs no writes',not writes);ctx.close()
  ctx,requests,writes=context('control');page=ctx.new_page();page.goto(base+'/reviews?request=1');page.get_by_text('请先确认管理员身份',exact=False).wait_for();check('control without token makes no privileged query',not any(x['path']=='/api/change-requests' for x in requests));page.locator('[data-testid=wm-me]').click();page.locator('.wm-me-pop button').filter(has_text='口令').first.click();page.get_by_placeholder('ADMIN_TOKEN（仅本页；刷新或在本标签页跳出后需重输）').fill('synthetic-browser-admin');page.get_by_role('button',name=re.compile('保[ ]*存')).click();page.get_by_text('synthetic-finance',exact=False).first.wait_for();check('control uses authenticated API fetch',any(x['path']=='/api/change-requests' and x['token_present'] for x in requests));check('no auto approval on opening page',not writes);(ROOT/'tmp'/'review-gate-evidence').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'tmp'/'review-gate-evidence'/'review-control.png'),full_page=True);page.get_by_label('审核人').fill('synthetic-human');page.get_by_role('button',name='批准并执行',exact=True).click();page.locator('.ant-modal-confirm-title').filter(has_text='确认执行该变更').wait_for();check('confirmation does not mutate before explicit submit',not writes);page.get_by_role('button',name='确认执行',exact=True).click();page.get_by_text('已批准',exact=False).first.wait_for();check('explicit approval writes exact request with human reviewer',writes==[{'reviewed_by':'synthetic-human'}]);check('processed request cannot be reapproved',page.get_by_role('button',name='批准并执行',exact=True).count()==0);ctx.close()
  ctx,requests,writes=context('control',processed=True);page=ctx.new_page();page.add_init_script("sessionStorage.setItem('wm-admin-token','synthetic-admin')");page.goto(base+'/reviews?request=1');page.get_by_text('已批准',exact=False).first.wait_for();check('stale task opens actual completed state',page.get_by_role('button',name='批准并执行',exact=True).count()==0 and not writes);ctx.close()
  ctx,requests,writes=context('control');page=ctx.new_page();page.add_init_script("sessionStorage.setItem('wm-admin-token','synthetic-admin')");page.goto(base+'/reviews?request=1');page.get_by_role('button',name='批准并执行',exact=True).wait_for();page.get_by_role('button',name='批准并执行',exact=True).click();page.get_by_text('请填写审核人',exact=True).wait_for();check('missing human reviewer blocks decision',not writes and page.locator('.ant-modal-confirm-title').count()==0);page.get_by_label('审核人').fill('synthetic-human');page.get_by_role('button',name='批准并执行',exact=True).click();page.locator('.ant-modal-confirm-title').wait_for();page.get_by_role('button',name=re.compile('取[ ]*消')).click();check('cancel confirmation performs no write',not writes);page.get_by_role('button',name='拒绝申请',exact=True).click();page.locator('.ant-modal-confirm-title').filter(has_text='确认拒绝该变更').wait_for();page.get_by_role('button',name='确认拒绝',exact=True).click();page.get_by_text('已拒绝',exact=True).first.wait_for();check('explicit rejection uses reviewer and cannot execute approval',writes==[{'reviewed_by':'synthetic-human'}] and not any(x['path'].endswith('/approve') for x in requests));ctx.close()
  ctx,requests,writes=context('control',fail=True);page=ctx.new_page();page.add_init_script("sessionStorage.setItem('wm-admin-token','synthetic-admin')");page.goto(base+'/reviews?request=1');page.get_by_label('审核人').wait_for();page.get_by_label('审核人').fill('synthetic-human');page.get_by_role('button',name='批准并执行',exact=True).click();page.locator('.ant-modal-confirm-title').wait_for();page.get_by_role('button',name='确认执行',exact=True).click();page.get_by_text('synthetic apply failed',exact=True).first.wait_for();check('backend rejection is not shown as approved',len(writes)==1 and page.get_by_text('已批准',exact=True).count()==0 and page.get_by_role('button',name='批准并执行',exact=True).count()==1);ctx.close();browser.close()
 print(json.dumps({'checks':len(checks),'failed':0,'scope':'real built SPA, synthetic intercepted APIs, no production writes'}))
finally:server.shutdown();server.server_close()
