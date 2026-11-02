"""#324: real TasksView with intercepted synthetic API; no HTTP listener."""
import json, sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
checks=[]; seen=[]; errors=[]; mode={'value':'anonymous'}; held=[]
def passed(name): checks.append(name); print('PASS '+name,flush=True)
def payload(title):
 return {'tasks':[{'id':'market:task-1','source':'market','title':title,'status':'todo','due':None,'link':None,'project':'synthetic'}], 'sources':{'ygl-trees':{'ok':False,'count':0,'latency_ms':0,'error':'source_not_authorized'},'market':{'ok':True,'count':1,'latency_ms':0}},'generated_at':'2026-01-01T00:00:00Z'}
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  ctx=b.new_context(viewport={'width':1280,'height':850});page=ctx.new_page();page.set_default_timeout(7000);page.on('pageerror',lambda e:errors.append(str(e)))
  def route(r):
   path=r.request.url.split('http://tasks.synthetic.invalid',1)[-1].split('?',1)[0]
   if path=='/api/tasks':
    headers=r.request.headers;seen.append({'has_admin':headers.get('x-admin-token')=='synthetic-admin','mode':mode['value']})
    if mode['value']=='held':held.append(r);return
    if mode['value']=='admin':assert headers.get('x-admin-token')=='synthetic-admin';r.fulfill(content_type='application/json',body=json.dumps(payload('ADMIN_PRIVATE_TASK')))
    elif mode['value']=='viewer':r.fulfill(content_type='application/json',body=json.dumps(payload('VIEWER_SCOPED_TASK')))
    elif mode['value']=='failed':r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'tasks_identity_unavailable','private':'DO_NOT_RENDER_PRIVATE_ERROR'}))
    else:r.fulfill(status=401,content_type='application/json',body=json.dumps({'error':'tasks_auth_required','login_url':None}))
   elif path=='/fixture.js':r.fulfill(content_type='text/javascript',body=Path(cfg['bundle']).read_bytes())
   elif path.startswith('/api/'):r.fulfill(content_type='application/json',body='{}')
   else:r.fulfill(content_type='text/html',body='<!doctype html><html><head></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  page.route('**/*',route);page.goto('http://tasks.synthetic.invalid/tasks',wait_until='networkidle')
  expect(page.get_by_role('alert')).to_contain_text('获授权');expect(page.get_by_text('未显示私有任务',exact=True)).to_be_visible();passed('anonymous UI explains authentication instead of reporting business empty')
  mode['value']='admin';page.get_by_role('button',name='test admin',exact=True).click();expect(page.get_by_text('ADMIN_PRIVATE_TASK',exact=True)).to_be_visible();assert seen[-1]['has_admin'];passed('admin credential change fetches authorized task without page reload')
  expect(page.get_by_text('ygl-trees：未获来源授权',exact=True)).to_be_visible();passed('source authorization denial is explicit not silent')
  mode['value']='held';page.get_by_role('button',name='test clear',exact=True).click();expect(page.get_by_text('ADMIN_PRIVATE_TASK',exact=True)).to_have_count(0);page.wait_for_function('() => document.querySelectorAll(".ant-skeleton").length > 0');passed('identity clearing removes old private rows before new response')
  page.wait_for_function('() => true');assert held and not seen[-1]['has_admin'];mode['value']='viewer';page.evaluate('window.dispatchEvent(new Event("wm:odoo-session-confirmed"))');expect(page.get_by_text('VIEWER_SCOPED_TASK',exact=True)).to_be_visible();passed('Odoo session hint revalidates scoped task source')
  for old in held:
   try:old.fulfill(content_type='application/json',body=json.dumps(payload('STALE_ADMIN_TASK')))
   except Exception:pass
  page.wait_for_timeout(200);expect(page.get_by_text('STALE_ADMIN_TASK',exact=True)).to_have_count(0);passed('late aborted identity response never repopulates private rows')
  mode['value']='failed';page.locator('button').filter(has_text=re.compile(r'刷\s*新')).click();expect(page.get_by_role('alert')).to_contain_text('读取失败');expect(page.get_by_text('VIEWER_SCOPED_TASK',exact=True)).to_have_count(0);assert 'DO_NOT_RENDER_PRIVATE_ERROR' not in page.locator('body').inner_text();passed('identity backend failure clears rows and renders safe error')
  mode['value']='anonymous';page.evaluate('window.dispatchEvent(new Event("focus"))');expect(page.get_by_role('alert')).to_contain_text('获授权');passed('focus revalidates revoked session and does not reuse old payload')
  assert not errors,errors;page.screenshot(path=cfg['screenshot'],full_page=True)
 except Exception as error:
  print('BROWSER ASSERTION: '+repr(error),flush=True);raise
 finally:
  Path(cfg['result']).write_text(json.dumps({'checks':checks,'page_errors':errors,'task_requests':seen,'scope':'real React/antd TasksView and poll hook; browser request interception; no production HTTP or private workspace'},ensure_ascii=False,indent=2),encoding='utf8')
  print('teardown: unroute',flush=True);page.unroute('**/*',route)
  print('teardown: context close',flush=True);ctx.close()
  print('teardown: browser close',flush=True);b.close()
  print('teardown: done',flush=True)
print(str(len(checks))+' tasks UI checks passed',flush=True)
