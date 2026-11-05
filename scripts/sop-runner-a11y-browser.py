import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
html=Path(sys.argv[1]).resolve().as_uri();errors=[];fails=0
def ok(name,cond,extra=''):
 global fails
 print(('  ✓ ' if cond else '  ✗ ')+name+('' if cond else ' '+str(extra)));fails+=0 if cond else 1
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 try:
  page=b.new_page();page.set_default_timeout(5000);page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/api/**',lambda r:r.fulfill(status=200,content_type='application/json',body='{"id":1,"status":"running","data":{}}'))
  page.goto(html);page.wait_for_timeout(300)
  a=page.evaluate("""()=>{const fs=[...document.querySelectorAll('[data-field]')];const ids=fs.map(e=>e.id);
   const named=e=>!!(e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.closest('label')||document.querySelector('label[for="'+e.id+'"]'));
   return {n:fs.length,ids:ids,unique:new Set(ids).size,unnamed:fs.filter(e=>!named(e)).map(e=>e.getAttribute('data-field')),
     help:(document.querySelector('[data-field=product]').getAttribute('aria-describedby')||''),own:document.getElementById('own').getAttribute('aria-label'),
     wrapped:document.querySelector('[data-field=wrapped]').getAttribute('aria-label'),note:document.querySelector('[data-field=note]').getAttribute('aria-label')}}""")
  ok('每个控件都有 id 且唯一（同名字段跨步不撞）',a['unique']==a['n']==len([i for i in a['ids'] if i]),a)
  ok('每个控件都有可访问名称',a['unnamed']==[],a['unnamed'])
  ok('说明 <small> 关联到 aria-describedby',a['help'].endswith('-help'),a['help'])
  ok('作者自带 label 的不加 aria-label',a['own'] is None and a['wrapped'] is None,(a['own'],a['wrapped']))
  ok('没有 data-label 时用字段名',a['note']=='note',a['note'])
  page.evaluate("()=>{const f=document.getElementById('finish');f.disabled=false;f.click()}");page.wait_for_timeout(200)
  s=page.evaluate("""()=>{const box=document.getElementById('fv-summary');const inv=[...document.querySelectorAll('[aria-invalid=true]')];
   return {hidden:box.hidden,focused:document.activeElement===box,items:box.querySelectorAll('li').length,invalid:inv.length,
     linked:inv.every(e=>(e.getAttribute('aria-describedby')||'').split(' ').includes(e.id+'-err')),first:(box.querySelector('li')||{}).textContent}}""")
  ok('完成被拦：汇总出现、获焦、条目数等于不合格字段数',(not s['hidden']) and s['focused'] and s['items']==s['invalid']==5,s)
  ok('错误提示关联到 aria-describedby',s['linked'],s)
  ok('汇总条目写字段名和原因',s['first']=='商品：必填',s['first'])
  target=page.evaluate("()=>{const a=document.querySelector('#fv-summary a');a.click();return a.getAttribute('href').slice(1)}")
  ok('点汇总条目跳到对应控件',page.evaluate('()=>document.activeElement.id')==target,target)
  for f,v in [('product','支架'),('period','2026-09'),('own','x'),('wrapped','y')]:
   page.evaluate("([f,v])=>{const el=document.querySelector('[data-step=scope] [data-field='+f+']');el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}",[f,v])
  mid=page.evaluate("()=>({items:document.querySelectorAll('#fv-summary li').length,err:(document.querySelector('[data-field=product]').getAttribute('aria-describedby')||'')})")
  ok('边改边刷新汇总；改好的字段解除错误关联',mid['items']==1 and '-err' not in mid['err'],mid)
  page.evaluate("()=>{const el=document.querySelector('[data-step=deliver] [data-field=product]');el.value='z';el.dispatchEvent(new Event('input',{bubbles:true}))}")
  ok('全部改好后汇总收起',page.evaluate("()=>document.getElementById('fv-summary').hidden"))
  ok('页面无脚本错误',errors==[],errors)
 finally:
  b.close()
print(('全部通过' if not fails else f'{fails} 项失败'))
sys.exit(1 if fails else 0)
