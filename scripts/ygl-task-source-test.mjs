/** Regression: PG task-source identity, explicit secrets and no SQLite fallback. Usage: node scripts/ygl-task-source-test.mjs */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveYglTaskSource, yglPgTargetHash } from '../server/src/ygl-task-source.ts';
const root=resolve('.'),tmp=join(root,'tmp'); mkdirSync(tmp,{recursive:true});
assert.equal(realpathSync(tmp),tmp);assert(!lstatSync(tmp).isSymbolicLink());
const dir=mkdtempSync(join(tmp,'ygl-task-source-')),home=join(dir,'home'),secret=join(dir,'url'); mkdirSync(home);
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
try {
 const pg='postgres://reader:synthetic-one@localhost/ygl';
 check('PG home need not contain a SQLite database',()=>{const x=resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:pg});assert(x.ok);assert.equal(x.source.backend,'pg');assert(!existsSync(join(home,'ygl-trees.db')));});
 const key=resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:pg}).source.workspaceKey;
 check('credential and default-port normalization retain grants',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:'postgresql://new:synthetic-two@LOCALHOST:5432/ygl'}).source.workspaceKey,key));
 check('different database and host never reuse grants',()=>{for(const u of ['postgres://localhost/other','postgres://otherhost/ygl'])assert.notEqual(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:u}).source.workspaceKey,key);});
 check('PG target hash matches YGL canonical identity',()=>assert.equal(yglPgTargetHash(pg),'sha256:'+createHash('sha256').update(JSON.stringify(['localhost','5432','ygl'])).digest('hex')));
 check('bad target and query destination overrides fail closed safely',()=>{for(const u of ['notpg','sqlite:///a','postgres://localhost','postgres://localhost/ygl?options=-csearch_path=x','postgres://localhost/ygl?host=other','postgres://localhost/ygl?dbname=other']){const x=resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:u});assert.deepEqual(x,{ok:false,error:'ygl_source_config_invalid'});}});
 writeFileSync(secret,pg);
 check('explicit URL secret file is supported',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL_FILE:secret}).source.workspaceKey,key));
 check('valid secret file takes precedence over empty env URL',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL_FILE:secret,YGL_DB_URL:''}).source.workspaceKey,key));
 writeFileSync(secret,'');
 check('empty secret file cannot fall back to env URL',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL_FILE:secret,YGL_DB_URL:pg}).ok,false));
 check('missing secret cannot fall back to env URL',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL_FILE:join(dir,'absent'),YGL_DB_URL:pg}).ok,false));
 check('explicit empty URL without SQLite fails closed',()=>assert.deepEqual(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:''}),{ok:false,error:'ygl_source_config_invalid'}));
 check('explicit empty URL file cannot fall back to env',()=>assert.deepEqual(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL_FILE:'',YGL_DB_URL:pg}),{ok:false,error:'ygl_source_config_invalid'}));
 writeFileSync(join(home,'pg-binding.json'),JSON.stringify({mode:'pg',url_hash:yglPgTargetHash(pg)}));
 check('matching engine binding accepted; wrong target refused',()=>{assert(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:pg}).ok);assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:'postgres://otherhost/ygl'}).ok,false);});
 check('removing PG config from bound home cannot create/open SQLite',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home}).ok,false));
 writeFileSync(join(home,'ygl-trees.db'),'synthetic SQLite marker');
 check('mixed SQLite file and PG target refuse, not pick priority',()=>assert.equal(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:pg}).ok,false));
 const binding=join(home,'pg-binding.json');assert.equal(realpathSync(binding),binding);rmSync(binding);
 check('explicit empty URL never falls back to existing SQLite',()=>assert.deepEqual(resolveYglTaskSource({YGL_HOME:home,YGL_DB_URL:''}),{ok:false,error:'ygl_source_config_invalid'}));
 check('legacy SQLite key unchanged and separate from PG grants',()=>{const x=resolveYglTaskSource({YGL_HOME:home});assert(x.ok);assert.equal(x.source.backend,'sqlite');assert.notEqual(x.source.workspaceKey,key);assert.equal(x.source.workspaceKey,createHash('sha256').update(join(home,'ygl-trees.db')).digest('hex'));});
 check('missing/relative home never uses personal default',()=>{assert.equal(resolveYglTaskSource({YGL_DB_URL:pg}).ok,false);assert.equal(resolveYglTaskSource({YGL_HOME:'.',YGL_DB_URL:pg}).ok,false);});
 console.log(JSON.stringify({checks,production_requests:0}));
} finally {assert.equal(realpathSync(dir),dir);assert(dir.startsWith(tmp+sep)&&!lstatSync(dir).isSymbolicLink());rmSync(dir,{recursive:true,force:true});}
