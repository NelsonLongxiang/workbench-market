// Real adapter functions + in-memory SQLite; no native ID uniqueness assumption.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const src=readFileSync('deploy/layerfs-svc.mjs','utf8');
const schema=src.slice(src.indexOf("sidecar.exec('CREATE TABLE"),src.indexOf('process.env.LAYERFS_STORE_PATH ='));
const functions=src.slice(src.indexOf('const refusal ='),src.indexOf('async function publishTo'));
const db=new DatabaseSync(':memory:');
const ctx=vm.createContext({sidecar:db});
try {
 vm.runInContext(schema+'\n'+functions,ctx);
 const save=(p,b,id,text)=>ctx.saveHead(p,b,b,{head:id},[{path:'a',content:text}],'fixture');
 save('alpha','release','shared-native-id','alpha');
 save('beta','release','shared-native-id','beta');
 assert.equal(JSON.parse(db.prepare('SELECT files FROM commits WHERE project=? AND id=?').get('beta','shared-native-id')?.files ?? '[]')[0]?.content,'beta');
 console.log('PASS equal native IDs in different projects remain independently readable');
 save('alpha','taken','taken-head','taken');
 const before=db.prepare('SELECT * FROM branches ORDER BY project,branch').all();
 assert.throws(()=>ctx.renameBranch('alpha','release','taken'),e=>e.code==='NameTaken');
 assert.deepEqual(db.prepare('SELECT * FROM branches ORDER BY project,branch').all(),before);
 save('alpha','release','after-rejection','next');
 ctx.renameBranch('alpha','release','renamed');
 assert.equal(db.prepare('SELECT head FROM branches WHERE project=? AND branch=?').get('alpha','renamed').head,'after-rejection');
 console.log('PASS existing-target refusal preserves heads and allows subsequent save/rename');
 db.exec("CREATE TRIGGER fail_rename BEFORE INSERT ON branches WHEN NEW.branch='fault' BEGIN SELECT RAISE(ABORT,'injected rename failure'); END");
 assert.throws(()=>ctx.renameBranch('alpha','renamed','fault'),/injected rename failure/);
 db.exec('BEGIN');db.exec('ROLLBACK');
 assert.equal(db.prepare('SELECT head FROM branches WHERE project=? AND branch=?').get('alpha','renamed').head,'after-rejection');
 ctx.renameBranch('alpha','renamed','after-fault');
 console.log('PASS transaction exception rolls back without poisoning next BEGIN');
 db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON branches WHEN NEW.branch='save-fault' BEGIN SELECT RAISE(ABORT,'injected save failure'); END");
 assert.throws(()=>save('alpha','save-fault','orphan','bad'),/injected save failure/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM commits WHERE id=?').get('orphan').n,0);
 save('alpha','after-fault','final','ok');
 console.log('PASS failed save is atomic and later publish works');
} finally { db.close(); }
