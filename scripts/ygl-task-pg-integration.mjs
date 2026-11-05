/** Live PG-only integration of YGL task CLI and Workbench collector. Usage: YGL_TEST_BIN=<candidate bin.cjs> B8_TEST_PG_ADMIN_URL=<disposable PG> node scripts/ygl-task-pg-integration.mjs */
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,existsSync,rmSync,realpathSync,lstatSync } from 'node:fs';
import { resolve,join,dirname,sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { collectTasks,taskWorkspaceKey } from '../server/src/tasks.ts';
const root=resolve('.'),bin=process.env.YGL_TEST_BIN,adminUrl=process.env.B8_TEST_PG_ADMIN_URL;
assert(bin&&adminUrl,'explicit candidate CLI and isolated PG admin URL required; no skip');
const u=new URL(adminUrl);assert(u.hostname==='127.0.0.1'||u.hostname==='[::1]'||u.hostname===process.env.B8_TEST_PG_HOST,'explicit disposable test PG endpoint required');
const {Client}=createRequire(join(resolve(dirname(bin),'../..'),'package.json'))('pg');
const tmp=join(root,'tmp');mkdirSync(tmp,{recursive:true});assert.equal(realpathSync(tmp),tmp);assert(!lstatSync(tmp).isSymbolicLink());const dir=mkdtempSync(join(tmp,'ygl-task-pg-')),home=join(dir,'pg-home'),secret=join(dir,'pg-url');
const name='wm_task_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);u.pathname='/'+name;const target=u.toString();
const admin=new Client({connectionString:adminUrl}),client=new Client({connectionString:target});
const saved={...process.env};const clean={...process.env};for(const k of ['YGL_DB_URL','YGL_DB_URL_FILE','YGL_PG_URL','YGL_PROJECT','YGL_TREE','YGL_HOME','YGL_SESSION','DSH_SESSION_ID','NODE_OPTIONS'])delete clean[k];
const cli=(args,extra={})=>{const x=spawnSync(process.execPath,[bin,...args,'--json'],{cwd:dir,env:{...clean,YGL_HOME:home,YGL_DB_URL:target,YGL_SESSION:'wm-integration',YGL_NO_UPDATE_CHECK:'1',...extra},encoding:'utf8',timeout:20000});assert.equal(x.status,0,'isolated YGL CLI failed');return JSON.parse(x.stdout);};
let dbCreated=false,connected=false,checks=0;const check=(label,ok)=>{assert(ok,label);checks++;console.log('PASS '+label);};
try{
 await admin.connect();await admin.query('CREATE DATABASE "'+name+'"');dbCreated=true;
 const seed=join(dir,'seed');cli(['db','init'],{YGL_DB_URL:'',YGL_HOME:seed});cli(['db','migrate','pg'],{YGL_DB_URL:'',YGL_PG_URL:target,YGL_HOME:seed});
 cli(['project','new','alpha']);cli(['project','new','beta']);
 const a=cli(['task','add','ALPHA_PG_PRIVATE','-p','alpha']),b=cli(['task','add','BETA_PG_PRIVATE','-p','beta']);cli(['task','doing',a.id,'-p','alpha']);
 await client.connect();connected=true;writeFileSync(secret,target,{mode:0o600});
 Object.assign(process.env,{YGL_BIN:bin,YGL_HOME:home,YGL_DB_URL_FILE:secret,YGL_DB_URL:'invalid-should-not-be-used',YGL_SESSION:'workbench-task-reader',YGL_NO_UPDATE_CHECK:'1'});
 const key=taskWorkspaceKey();check('PG grants have configured source identity without SQLite file',!!key&&!existsSync(join(home,'ygl-trees.db')));
 const sop={runsDispatchedAll:()=>[],runsRunning:()=>[]};const scope={subject:'synthetic',admin:false,yglProjects:['alpha'],yglWorkspaceKey:key,marketRunIds:[],a2a:false};
 const before=(await client.query("SELECT key,value FROM meta WHERE key LIKE 'current_project%' ORDER BY key")).rows;
 const p=await collectTasks(sop,scope);check('scoped collector reads actual alpha PG task/status only',p.sources['ygl-trees'].ok&&p.tasks.length===1&&p.tasks[0].title==='ALPHA_PG_PRIVATE'&&p.tasks[0].status==='doing'&&p.tasks[0].project==='alpha'&&!JSON.stringify(p).includes('BETA_PG_PRIVATE'));
 const all=await collectTasks(sop,{...scope,subject:'admin',admin:true,yglProjects:'all'});check('admin collector enumerates both actual PG projects',all.sources['ygl-trees'].ok&&all.tasks.some(t=>t.id==='ygl-trees:'+a.id)&&all.tasks.some(t=>t.id==='ygl-trees:'+b.id));
 const wrong=await collectTasks(sop,{...scope,yglWorkspaceKey:'0'.repeat(64)});check('old or different target grants cannot authorize PG tasks',wrong.tasks.length===0&&wrong.sources['ygl-trees'].error==='source_not_authorized');
 const denied=await collectTasks(sop,{...scope,yglProjects:[]});check('ungranted caller sees no PG task',denied.tasks.length===0&&denied.sources['ygl-trees'].error==='source_not_authorized');
 const after=(await client.query("SELECT key,value FROM meta WHERE key LIKE 'current_project%' ORDER BY key")).rows;check('collector never changes YGL session selection',JSON.stringify(before)===JSON.stringify(after));
 writeFileSync(secret,'postgres://synthetic:redacted@127.0.0.1:1/unreachable');
 const down=await collectTasks(sop,{...scope,subject:'admin',admin:true,yglProjects:'all'});check('PG failure returns stable error and no stale data or URL',!down.sources['ygl-trees'].ok&&down.tasks.length===0&&!JSON.stringify(down).includes('redacted')&&!JSON.stringify(down).includes(home));
 check('PG-only integration never creates SQLite business file',!existsSync(join(home,'ygl-trees.db')));
 console.log(JSON.stringify({checks,isolated_database:name,production_requests:0}));
}finally{
 for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 if(connected)await client.end();if(dbCreated){assert(/^wm_task_[0-9]+_[a-z0-9]{1,6}$/.test(name));await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');}await admin.end();assert.equal(realpathSync(dir),dir);assert(dir.startsWith(tmp+sep)&&!lstatSync(dir).isSymbolicLink());rmSync(dir,{recursive:true,force:true});
}
