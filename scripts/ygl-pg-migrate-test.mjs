/** Disposable real-PG migration/restore safeguards. Usage: YGL_ENGINE_ROOT=<built-ygl> YGL_TEST_PG_ADMIN_URL=<isolated PG URL> YGL_TEST_PG_HOST=<explicit test host> node scripts/ygl-pg-migrate-test.mjs */
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,statSync,realpathSync,lstatSync } from 'node:fs';
import { resolve,join,sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadEngine,createSnapshot,migrateSnapshot,rowsDigest,MigrationRefusal } from './ygl-pg-migrate.mjs';
const root=resolve('.'),engine=loadEngine(process.env.YGL_ENGINE_ROOT),url=process.env.YGL_TEST_PG_ADMIN_URL;
assert(url,'explicit isolated PG URL required, no skip');const u=new URL(url);
assert(['127.0.0.1','[::1]',process.env.YGL_TEST_PG_HOST].filter(Boolean).includes(u.hostname),'isolated PG host required');
const tmp=join(root,'tmp');mkdirSync(tmp,{recursive:true});assert.equal(realpathSync(tmp),tmp);assert(!lstatSync(tmp).isSymbolicLink());const dir=mkdtempSync(join(tmp,'pg-migrate-test-')),seedHome=join(dir,'seed'),snap=join(dir,'snapshot');mkdirSync(seedHome);
const bin=join(process.env.YGL_ENGINE_ROOT,'dist/bundle/bin.cjs');
const clean={...process.env};for(const k of ['YGL_DB_URL','YGL_PG_URL','YGL_MIGRATION_PG_URL','YGL_MIGRATION_PG_URL_FILE','YGL_PROJECT','YGL_SESSION','DSH_SESSION_ID','NODE_OPTIONS'])delete clean[k];
const init=spawnSync(process.execPath,[bin,'db','init','--json'],{env:{...clean,YGL_HOME:seedHome,YGL_SESSION:'migration-test',YGL_NO_UPDATE_CHECK:'1'},encoding:'utf8',timeout:20000});assert.equal(init.status,0,'isolated YGL seed initialization failed');
const source=join(seedHome,'ygl-trees.db'),admin=new engine.Client({connectionString:url});let db,checks=0,names=[],reports=0;
const h=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const before=()=>[h(source),existsSync(source+'-wal')?h(source+'-wal'):null];
const check=(label,ok)=>{assert(ok,label);checks++;console.log('PASS '+label);};
const report=()=>join(dir,'report-'+(++reports)+'.json');
const verifyCli=(targetHash,targetEnv)=>spawnSync(process.execPath,[join(root,'scripts/ygl-pg-migrate.mjs'),'verify','--engine-root',process.env.YGL_ENGINE_ROOT,'--snapshot',snap,'--target-hash',targetHash,'--report',report()],{cwd:root,env:{...clean,...targetEnv},encoding:'utf8',timeout:30000});
const fresh=async()=>{const n='migrate_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);await admin.query('CREATE DATABASE "'+n+'"');names.push(n);const x=new URL(url);x.pathname='/'+n;return x.toString();};
const refusals=async(label,fn,code)=>{await assert.rejects(fn,e=>e instanceof MigrationRefusal&&e.code===code);checks++;console.log('PASS '+label);};
try{
 await admin.connect();db=new engine.Native(source);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');
 const ts='2026-11-04T00:00:00.000Z';
 db.prepare("INSERT INTO projects(id,name,question,status,created,updated) VALUES('p','snapshot-project','WAL fixture','active',?,?)").run(ts,ts);
 db.prepare("INSERT INTO artifacts(id,project_id,kind,title,format,content,version,created,meta) VALUES('t','p','task','WAL task','markdown','body',1,?,?)").run(ts,JSON.stringify({status:'doing',nested:{kept:true}}));
 db.prepare("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level,seq) VALUES('migration-seq',?,'test','task.status','task','t','todo → doing','info',500)").run(ts);
 const unchanged=before();const snapshot=await createSnapshot(engine,source,snap);
 check('online snapshot includes WAL rows without changing original DB or WAL',JSON.stringify(before())===JSON.stringify(unchanged)&&snapshot.tables.find(t=>t.table==='artifacts').rows===1);
 if(process.platform==='win32')console.log('SKIP POSIX mode bits on Windows; verify output ACL separately');
 else check('snapshot and manifest are private',statSync(join(snap,'workspace.sqlite')).mode%512===0o600&&statSync(join(snap,'manifest.json')).mode%512===0o600);
 const target=await fresh(),hash=engine.pgTargetHash(target),env={YGL_MIGRATION_PG_URL:target};
 const result=await migrateSnapshot(engine,snap,hash,report(),env);
 check('all 28 business tables have exact row-content digests',result.tables.length===28&&result.tables.every(t=>t.source_sha256===t.target_sha256));
 const pg=new engine.Client({connectionString:target});await pg.connect();
 try{
  check('task metadata survived migration exactly',(await pg.query("SELECT meta FROM artifacts WHERE id='t'")).rows[0].meta===JSON.stringify({status:'doing',nested:{kept:true}}));
  check('sequence resumes beyond imported historical values',BigInt((await pg.query("SELECT nextval('events_seq') n")).rows[0].n)>500n);
  const values=await pg.query("SELECT title,meta FROM artifacts WHERE id='t'");
  await refusals('existing target is refused with no overwritten content',()=>migrateSnapshot(engine,snap,hash,report(),env),'target_not_empty');
  check('existing target content remains unchanged',JSON.stringify((await pg.query("SELECT title,meta FROM artifacts WHERE id='t'")).rows)===JSON.stringify(values.rows));
  const verified=await migrateSnapshot(engine,snap,hash,report(),env,true);check('read-only verify repeats content comparison',verified.ok&&verified.operation==='verify');check('read-only verify records identical constraints indexes and columns',verified.catalog.sha256===result.catalog.sha256);
  const cliPositive=verifyCli(hash,env);check('CLI verify accepts intact reviewed schema',cliPositive.status===0&&JSON.parse(cliPositive.stdout).ok===true);
  await pg.query('ALTER TABLE artifacts DROP CONSTRAINT artifacts_project_id_fkey');
  await refusals('verify rejects missing target foreign key',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  const cliMissingFk=verifyCli(hash,env);check('CLI verify rejects missing target foreign key',cliMissingFk.status===1&&JSON.parse(cliMissingFk.stderr).error==='target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts ADD CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id)');
  await refusals('verify rejects altered foreign key actions',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts DROP CONSTRAINT artifacts_project_id_fkey');
  await pg.query('ALTER TABLE artifacts ADD CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
  await pg.query('ALTER TABLE artifacts DISABLE TRIGGER ALL');
  await refusals('verify rejects disabled internal foreign key trigger',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts ENABLE TRIGGER ALL');
  await pg.query('DROP INDEX idx_artifacts_proj');
  await refusals('verify rejects missing target index',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('CREATE INDEX idx_artifacts_proj ON artifacts(project_id)');
  await pg.query('ALTER TABLE artifacts ALTER COLUMN title DROP NOT NULL');
  await refusals('verify rejects weakened target column constraint',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts ALTER COLUMN title SET NOT NULL');
  await pg.query("ALTER TABLE artifacts ALTER COLUMN format SET DEFAULT 'SYNTHETIC_DDL_MARKER'");
  const driftReport=report();await refusals('verify rejects changed target column default',()=>migrateSnapshot(engine,snap,hash,driftReport,env,true),'target_catalog_mismatch');
  check('schema mismatch report never copies arbitrary target DDL',!readFileSync(driftReport,'utf8').includes('SYNTHETIC_DDL_MARKER'));
  await pg.query("ALTER TABLE artifacts ALTER COLUMN format SET DEFAULT 'markdown'");
  await pg.query("CREATE FUNCTION synthetic_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
  await pg.query('CREATE TRIGGER synthetic_drift BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION synthetic_drift()');
  await refusals('verify rejects extra target trigger and routine',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('DROP TRIGGER synthetic_drift ON artifacts');await pg.query('DROP FUNCTION synthetic_drift()');
  await pg.query('ALTER SEQUENCE events_seq INCREMENT BY 2');
  await refusals('verify rejects changed sequence increment',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER SEQUENCE events_seq INCREMENT BY 1');
  await pg.query('ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY');
  await refusals('verify rejects changed row security settings',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts DISABLE ROW LEVEL SECURITY');
  await pg.query('ALTER TABLE artifacts REPLICA IDENTITY FULL');
  await refusals('verify rejects changed replica identity',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts REPLICA IDENTITY DEFAULT');
  await pg.query('ALTER TABLE artifacts SET UNLOGGED');
  await refusals('verify rejects unlogged target table',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts SET LOGGED');
  await pg.query('ALTER TABLE artifacts ADD COLUMN synthetic_extra text');
  await refusals('verify rejects unexpected target column',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('ALTER TABLE artifacts DROP COLUMN synthetic_extra');
  await pg.query('CREATE SCHEMA synthetic_extra');
  await refusals('verify rejects unexpected target schema',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'target_catalog_mismatch');
  await pg.query('DROP SCHEMA synthetic_extra');
  check('restored target schema matches pinned baseline',(await migrateSnapshot(engine,snap,hash,report(),env,true)).catalog.sha256===result.catalog.sha256);
  let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r});let paused=false;
  class PauseCatalogClient extends engine.Client { async query(sql,...args){if(!paused&&typeof sql==='string'&&sql.startsWith('SELECT table_name,column_name,ordinal_position')){paused=true;enter();await gate;}return super.query(sql,...args);} }
  const checking=migrateSnapshot({...engine,Client:PauseCatalogClient},snap,hash,report(),env,true);checking.catch(()=>{});
  try { await Promise.race([entered,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('catalog_pause_timeout')),5000);t.unref?.();})]);await pg.query("SET statement_timeout='250ms'");
    await assert.rejects(pg.query('ALTER TABLE artifacts ADD COLUMN synthetic_race text'),e=>e.code==='57014');checks++;console.log('PASS catalog and rows hold read locks against concurrent DDL');
  } finally { release();await pg.query('SET statement_timeout=0'); }
  check('verification succeeds after concurrent DDL is blocked',(await checking).ok);
  await pg.query("UPDATE artifacts SET content='tampered' WHERE id='t'");
  await refusals('same row count with different content fails',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'row_content_mismatch:artifacts');
  await pg.query("UPDATE artifacts SET content='body' WHERE id='t'");
 }finally{await pg.end();}
 const unknownEngine={...engine,migrationNormalizedSha256:'0'.repeat(64),Client:class{constructor(){throw Error('unexpected_target_connection')}}};
 await refusals('unknown engine schema baseline fails before PG connection',()=>migrateSnapshot(unknownEngine,snap,hash,report(),env,true),'engine_catalog_baseline_unavailable');
 await refusals('wrong target identity is refused before writing',()=>migrateSnapshot(engine,snap,'sha256:'+'0'.repeat(64),report(),env),'target_identity_mismatch');
 const secret=join(dir,'empty-secret');writeFileSync(secret,'',{mode:0o600});
 await refusals('empty explicit secret does not fall back to valid environment',()=>migrateSnapshot(engine,snap,hash,report(),{...env,YGL_MIGRATION_PG_URL_FILE:secret}),'explicit_target_identity_required');
 await refusals('snapshot output cannot overwrite an existing backup',()=>createSnapshot(engine,source,snap),'snapshot_output_exists');

 const target2=await fresh(),hash2=engine.pgTargetHash(target2),env2={YGL_MIGRATION_PG_URL:target2};
 const nonempty=new engine.Client({connectionString:target2});await nonempty.connect();
 try{
  await nonempty.query('CREATE TABLE unrelated_keep(id int PRIMARY KEY,body text)');await nonempty.query("INSERT INTO unrelated_keep VALUES(7,'do not overwrite')");
  await refusals('unrelated existing target table is protected',()=>migrateSnapshot(engine,snap,hash2,report(),env2),'target_not_empty');
  check('unrelated target data unchanged',(await nonempty.query('SELECT body FROM unrelated_keep WHERE id=7')).rows[0].body==='do not overwrite');
 }finally{await nonempty.end();}
 const noReport=join(dir,'nonexistent-parent','report.json');
 await refusals('unwritable report destination refuses before PG migration',()=>migrateSnapshot(engine,snap,hash,noReport,env),'report_output_unavailable');
 const custom=await fresh(),customHash=engine.pgTargetHash(custom),customEnv={YGL_MIGRATION_PG_URL:custom};const lockClient=new engine.Client({connectionString:custom});await lockClient.connect();
 try{
  await lockClient.query("SELECT pg_advisory_lock(hashtext('ygl:explicit-empty-database-migration'))");
  await refusals('concurrent migrator must acquire database lock before writing',()=>migrateSnapshot(engine,snap,customHash,report(),customEnv),'migration_already_in_progress');
  await lockClient.query("SELECT pg_advisory_unlock(hashtext('ygl:explicit-empty-database-migration'))");
  await lockClient.query('CREATE SCHEMA retained_schema');
  await refusals('custom schema prevents declaring an existing database empty',()=>migrateSnapshot(engine,snap,customHash,report(),customEnv),'target_not_empty');
 }finally{await lockClient.end();}
 const triggered=join(dir,'triggered');db.exec('CREATE TRIGGER task_guard BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,\'guard\'); END');await createSnapshot(engine,source,triggered);db.exec('DROP TRIGGER task_guard');
 await refusals('custom trigger semantics cannot silently disappear',()=>migrateSnapshot(engine,triggered,hash,report(),env),'unsupported_source_triggers');
 const viewed=join(dir,'viewed');db.exec('CREATE VIEW task_projection AS SELECT id FROM artifacts');await createSnapshot(engine,source,viewed);db.exec('DROP VIEW task_projection');
 await refusals('custom view semantics cannot silently disappear',()=>migrateSnapshot(engine,viewed,hash,report(),env),'unsupported_source_views');
 const virtual=join(dir,'virtual');db.exec('CREATE VIRTUAL TABLE custom_search USING fts5(body)');await createSnapshot(engine,source,virtual);db.exec('DROP TABLE custom_search');
 await refusals('unregistered virtual table cannot be dropped as derived FTS',()=>migrateSnapshot(engine,virtual,hash,report(),env),'unsupported_source_virtual_tables');
 const manifestPath=join(snap,'manifest.json'),manifestText=readFileSync(manifestPath,'utf8'),manifest=JSON.parse(manifestText);manifest.tables[0].rows++;
 writeFileSync(manifestPath,JSON.stringify(manifest));await refusals('manifest metadata tampering is detected',()=>migrateSnapshot(engine,snap,hash,report(),env),'snapshot_manifest_mismatch');writeFileSync(manifestPath,manifestText);
 const seqClient=new engine.Client({connectionString:target});await seqClient.connect();try{await seqClient.query("SELECT setval('events_seq',1,false)");await refusals('read-only verification detects sequence reset behind history',()=>migrateSnapshot(engine,snap,hash,report(),env,true),'events_sequence_behind_history');await seqClient.query("SELECT setval('events_seq',500,true)");}finally{await seqClient.end();}
 const pluginSnap=join(dir,'plugin-snapshot');db.exec('CREATE TABLE lc_ledger(seq INTEGER PRIMARY KEY, row_hash TEXT NOT NULL)');db.exec("INSERT INTO lc_ledger VALUES(1,'preserve')");await createSnapshot(engine,source,pluginSnap);
 await refusals('plugin table omission fails closed instead of silent loss',()=>migrateSnapshot(engine,pluginSnap,hash,report(),env),'unsupported_source_tables:lc_ledger');
 const original=readFileSync(join(snap,'workspace.sqlite'));writeFileSync(join(snap,'workspace.sqlite'),Buffer.concat([original,Buffer.from('tamper')]));
 await refusals('tampered snapshot hash is refused',()=>migrateSnapshot(engine,snap,hash,report(),env),'snapshot_checksum_mismatch');writeFileSync(join(snap,'workspace.sqlite'),original);
 const cols=[{name:'n',type:'INTEGER'}];check('row comparison preserves 64-bit integer identity',rowsDigest([{n:9223372036854775807n}],cols)===rowsDigest([{n:'9223372036854775807'}],cols));
 console.log(JSON.stringify({checks,production_requests:0,isolated_targets:names.length,all_targets_cleaned_in_finally:true}));
}finally{db?.close();for(const name of names){assert(/^migrate_[0-9]+_[a-z0-9]{1,6}$/.test(name));await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');}await admin.end();assert.equal(realpathSync(dir),dir);assert(dir.startsWith(tmp+sep)&&!lstatSync(dir).isSymbolicLink());rmSync(dir,{recursive:true,force:true});}
