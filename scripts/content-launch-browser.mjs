/** #296 browser fixture only: demonstrates 303 Strict-cookie red and 200 bounce green. */
import {createServer} from 'node:http';import{spawn}from'node:child_process';import{mkdirSync,writeFileSync}from'node:fs';import{resolve,join}from'node:path';import{randomUUID}from'node:crypto';
import{createContentAccess,contentLaunchPage}from'../server/src/content-access.ts';
const out=resolve('tmp/content-launch-browser',randomUUID());mkdirSync(out,{recursive:true});let access,market,content;let mode='200';
const server=createServer(async(q,s)=>{
 try{
  if(q.headers.host?.startsWith('127.0.0.1:')){
   mode=new URL(q.url,market).searchParams.get('mode')??'200';const ticket=access.issueLaunch(1,{subject:'user:fixture',internal:true,epoch:'fixture'});
   s.setHeader('content-type','text/html');s.end('<form method="post" target="_blank" rel="noopener" action="'+content+'/__wm/launch"><input type="hidden" name="ticket" value="'+ticket+'"><button>Open</button></form>');return;
  }
  if(q.url==='/__wm/launch'){
   let body='';for await(const chunk of q){body+=chunk;if(body.length>4096){s.writeHead(413);s.end();return}}
   const result=access.exchange(q,new URLSearchParams(body).get('ticket')??'');if(!result){s.writeHead(403);s.end('Denied');return}
   if(mode==='303'){s.writeHead(303,{'Set-Cookie':result.cookie,Location:result.bouncePath});s.end();return}
   const page=contentLaunchPage(result.bouncePath);s.writeHead(page.status,{...page.headers,'Set-Cookie':result.cookie});s.end(page.html);return;
  }
  const pass=!!access.admit(q);s.writeHead(pass?200:403,{'content-type':'application/json'});s.end(JSON.stringify({status:pass?200:403,cookie_sent:typeof q.headers.cookie==='string'&&q.headers.cookie.includes('wm_content_context=')}));
 }catch{ s.writeHead(500);s.end('Fixture error') }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;market='http://127.0.0.1:'+port;content='http://w-1-test.internal:'+port;access=createContentAccess([{id:1,origin:content}],market,()=> 'fixture');
const cfg=join(out,'config.json');writeFileSync(cfg,JSON.stringify({market,result:join(out,'result.json')}));let code=1;
try{const p=spawn(process.env.PYTHON||'python3',['scripts/content-launch-browser.py',cfg],{stdio:'inherit'});code=await new Promise((r,j)=>{p.on('exit',r);p.on('error',j)})}finally{await new Promise(r=>server.close(r))}
console.log(JSON.stringify({evidence:out,code}));process.exitCode=code??1;
