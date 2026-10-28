// Tests test fixtures with raw network/sqlite only; does not pretend to be SSO.
import assert from 'node:assert/strict';
import {upstream,wsHandshake,digest} from './fixtures.mjs';
import {DatabaseSync,backup} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const t=await upstream();
let passed=0;
try {
 const r=await fetch(t.base+'/echo',{method:'POST',body:'fixture-body'});assert.equal(r.status,200);assert.equal(t.requests.at(-1).body,'fixture-body');passed++;
 const ws=await wsHandshake(t.base,'/ws');try{assert.equal(ws.status,101);await ws.frames();assert.equal(t.requests.filter(r=>r.method==='UPGRADE').length,1);passed++;}finally{ws.close();}
 assert.equal((await fetch(t.base+'/unauthorized')).status,401);assert.equal((await fetch(t.base+'/forbidden')).status,403);passed++;
}finally{await t.close();}
const source=new DatabaseSync(':memory:');source.exec("CREATE TABLE audit(id INTEGER PRIMARY KEY, action TEXT,outcome TEXT);INSERT INTO audit VALUES(1,'service-action','deny');CREATE TRIGGER no_u BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'append-only');END;CREATE TRIGGER no_d BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append-only');END;");
try{
 await backup(source,join(root,'fixture-audit-copy.sqlite'));
 const copy=new DatabaseSync(join(root,'fixture-audit-copy.sqlite'));
 try{const before=JSON.stringify(copy.prepare('SELECT * FROM audit').all());for(const sql of ["UPDATE audit SET outcome='allow' WHERE id=1",'DELETE FROM audit WHERE id=1']){let code;try{copy.exec(sql);}catch(e){code=e.errcode;}assert.equal(code,1811,'must be SQLITE_CONSTRAINT_TRIGGER, not readonly/locking error');passed++;}assert.equal(JSON.stringify(copy.prepare('SELECT * FROM audit').all()),before);passed++;}finally{copy.close();}
}finally{source.close();}
console.log(JSON.stringify({fixture_only:true,passed,product_pass:false}));
