// Predicate-engine fixtures only, never product success observations.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import assert from 'node:assert/strict';
const root=dirname(fileURLToPath(import.meta.url));
const coverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'));
const proof=[];
for(const mode of ['good','bad','empty']){
 const path=join(root,'checker-'+mode+'.sqlite');const db=new DatabaseSync(path);
 try{for(const u of coverage.units){const table='sso2_eval_'+u.id;db.exec('DROP TABLE IF EXISTS '+table+';CREATE TABLE '+table+'(probe_id TEXT PRIMARY KEY,value INTEGER)');if(mode!=='empty'&&!u.id.startsWith('deferred_'))db.prepare('INSERT INTO '+table+' VALUES(?,?)').run(u.id,mode==='good'?1:0);const n=db.prepare('SELECT count(*) AS n FROM '+table).get().n;const violations=db.prepare('SELECT * FROM '+table+' WHERE value != 1').all().length;assert.equal(n,mode==='empty'||u.id.startsWith('deferred_')?0:1);assert.equal(violations,mode==='bad'&&!u.id.startsWith('deferred_')?1:0);proof.push({fixture:mode,probe_id:u.id,scope_rows:n,violation_rows:violations,expected_engine:!n?'NEEDS-MATERIAL':violations?'FAIL':'PASS'});}}finally{db.close();}
}
writeFileSync(join(root,'checker-fixtures-proof.json'),JSON.stringify({engine_run:false,fixture_only:true,proof},null,2));
console.log('Three predicate fixtures created: good47/deferred2empty, bad47/deferred2empty, empty49; engine empty-scope guard NOT yet independently run');
