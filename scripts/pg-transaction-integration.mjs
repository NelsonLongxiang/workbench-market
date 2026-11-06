/** Disposable real-PG test. Usage: PG_TRANSACTION_TEST_RUNNER_IMAGE=sha256:... PG_TRANSACTION_TEST_PG_IMAGE=sha256:... node scripts/pg-transaction-integration.mjs
 * Creates only nonce-labeled internal Docker network + tmpfs PG; no host ports, production mounts or URL inputs.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
if(process.argv[2]==='--inside'){
 assert.match(process.env.PG_TRANSACTION_FIXTURE_NONCE??'',/^[a-f0-9]{24}$/);
 const {Pool}=createRequire('/opt/ygl/node_modules/ygl-trees/package.json')('pg');
 const pool=new Pool({host:'pg',port:5432,user:'postgres',database:'postgres',password:process.env.PGPASSWORD,max:3,connectionTimeoutMillis:5000,statement_timeout:5000});
 let checks=0;const check=(name,ok)=>{assert(ok,name);checks++;console.log('PASS '+name)};
 try{
  const server=await pool.query("SELECT current_setting('server_version') AS version, COALESCE(bool_and(auth_method='scram-sha-256'),false) AS scram FROM pg_hba_file_rules WHERE type LIKE 'host%' AND error IS NULL");
  check('owned PostgreSQL requires SCRAM on all host rules',server.rows[0].scram===true);
  console.log(JSON.stringify({postgres_version:server.rows[0].version}));
  await pool.query('CREATE TABLE tx_fixture(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL UNIQUE)');
  let escaped;
  const committed=await withPgTransaction(pool,async tx=>{escaped=tx;const a=await tx.query('SELECT pg_backend_pid() AS pid');const r=await tx.query('INSERT INTO tx_fixture(value) VALUES($1) RETURNING id,value',['first']);const b=await tx.query('SELECT pg_backend_pid() AS pid');return {a:a.rows[0].pid,b:b.rows[0].pid,row:r.rows[0]}});
  check('BEGIN writes RETURNING and reads share one real backend',committed.a===committed.b&&committed.row.value==='first'&&Number(committed.row.id)>0);
  check('successful transaction visible to subsequent reader',(await pool.query('SELECT count(*)::int AS n FROM tx_fixture')).rows[0].n===1);
  await assert.rejects(escaped.query('SELECT 1'),/pg_transaction_scope_closed/);check('expired real-client scope refuses further SQL',true);
  const rejected=Error('SYNTHETIC_CALLBACK');await assert.rejects(withPgTransaction(pool,async tx=>{await tx.query('INSERT INTO tx_fixture(value) VALUES($1)',['rolled-back']);throw rejected}),e=>e===rejected);
  check('callback failure rolls back real inserted row',(await pool.query('SELECT count(*)::int AS n FROM tx_fixture WHERE value=$1',['rolled-back'])).rows[0].n===0);
  await assert.rejects(withPgTransaction(pool,async tx=>{await tx.query('INSERT INTO tx_fixture(value) VALUES($1)',['first']).catch(()=>{})}),e=>e.code==='23505');
  check('caught SQL failure still rejects transaction success',true);
  check('connection returns to clean state after rollback',(await withPgTransaction(pool,tx=>tx.query('SELECT 7::int AS n'))).rows[0].n===7);
  const pid1={},gate={};let release,entered;gate.promise=new Promise(r=>release=r);const ready=new Promise(r=>entered=r);
  const held=withPgTransaction(pool,async tx=>{pid1.value=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await tx.query('INSERT INTO tx_fixture(value) VALUES($1)',['held']);entered();await gate.promise});
  await ready;
  try{await withPgTransaction(pool,async tx=>{const other=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;const rows=await tx.query('SELECT value FROM tx_fixture');check('parallel transaction has distinct connection and no uncommitted read',other!==pid1.value&&!rows.rows.some(x=>x.value==='held'))})}finally{release();await held}
  check('held transaction visible only after release and commit',(await pool.query('SELECT count(*)::int AS n FROM tx_fixture WHERE value=$1',['held'])).rows[0].n===1);
  await pool.query('CREATE TABLE tx_deferred(value integer UNIQUE DEFERRABLE INITIALLY DEFERRED)');
  let calls=0;await assert.rejects(withPgTransaction(pool,async tx=>{calls++;await tx.query('INSERT INTO tx_deferred(value) VALUES(1),(1)')}),e=>e.code==='23505');
  check('real deferred constraint COMMIT rejection is not replayed',calls===1&&(await pool.query('SELECT count(*)::int AS n FROM tx_deferred')).rows[0].n===0);
  await assert.rejects(withPgTransaction(pool,async tx=>{await tx.query('SET LOCAL statement_timeout = 20');await tx.query('SELECT pg_sleep(1)')}),e=>e.code==='57014');
  check('statement timeout rejects and leaves pool reusable',(await withPgTransaction(pool,tx=>tx.query('SELECT 8::int AS n'))).rows[0].n===8);
  console.log(JSON.stringify({checks,production_requests:0,real_postgresql:true,backend_activation:false}));
  const {runPgSopRunsTests}=await import('./pg-sop-runs-test.mjs');
  const roleSql=await pool.query("SELECT format('CREATE ROLE wm_sop_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text) AS sql",[process.env.PGPASSWORD]);
  await pool.query(roleSql.rows[0].sql);
  await pool.query('CREATE DATABASE wm_sop_fixture OWNER wm_sop_fixture');
  const appPool=new Pool({host:'pg',port:5432,user:'wm_sop_fixture',database:'wm_sop_fixture',password:process.env.PGPASSWORD,max:3,connectionTimeoutMillis:5000,statement_timeout:5000});
  try {
    const role=await appPool.query('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0].name,'wm_sop_fixture');assert.equal(role.rows[0].rolsuper,false);
    console.log('SOP_FIXTURE_NON_SUPERUSER_DATABASE_OWNER=yes');
    await runPgSopRunsTests(appPool);
    const {runSopImportTests}=await import('./sop-preservation-import-test.mjs');
    await runSopImportTests(appPool);
    const {runPgSettingsTests}=await import('./pg-settings-test.mjs');
    await runPgSettingsTests(appPool);
    const {runPgSettingsImportTests}=await import('./pg-settings-import-test.mjs');
    await runPgSettingsImportTests(appPool);
    const {runPgWorkbenchesTests}=await import('./pg-workbenches-test.mjs');
    await runPgWorkbenchesTests(appPool);
  } finally { await appPool.end(); }
 }finally{await pool.end()}
}else{
 assert.equal(process.argv.length,2,'no URL/host/target arguments accepted');
 const runner=process.env.PG_TRANSACTION_TEST_RUNNER_IMAGE,pg=process.env.PG_TRANSACTION_TEST_PG_IMAGE;
 for(const id of [runner,pg])assert.match(id??'',/^sha256:[a-f0-9]{64}$/,'provide existing pinned local test images');
 const nonce=randomBytes(12).toString('hex'),net='wm-tx-'+nonce,pgname=net+'-pg',runname=net+'-runner';
 const secret=randomBytes(32).toString('hex');const env={...process.env,POSTGRES_PASSWORD:secret,PGPASSWORD:secret};
 const docker=(args,timeout=30000)=>execFileSync('docker',args,{encoding:'utf8',timeout,env,stdio:['ignore','pipe','pipe']}).trim();
 let madeNetwork=false,pgid,runid;
 const owned=(id,name,image)=>{const meta=JSON.parse(docker(['inspect',id]))[0];assert.equal(meta.Name,'/'+name);assert.equal(meta.Config.Labels['wm.test.transaction'],nonce);assert.equal(meta.Image,image);return meta};
 try{
  for(const image of [runner,pg])assert.equal(JSON.parse(docker(['image','inspect',image]))[0].Id,image);
  docker(['network','create','--internal','--label','wm.test.transaction='+nonce,net]);madeNetwork=true;
  pgid=docker(['run','-d','--name',pgname,'--label','wm.test.transaction='+nonce,'--network',net,'--network-alias','pg','--read-only','--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev','--tmpfs','/var/run/postgresql:rw,nosuid,nodev','--env','POSTGRES_PASSWORD','--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',pg]);
  const meta=owned(pgid,pgname,pg);assert(meta.Mounts.every(x=>x.Type==='tmpfs'));assert.equal(Object.keys(meta.HostConfig.PortBindings??{}).length,0);
  // pg_isready runs only inside this owned container; it never probes a host service.
  docker(['exec',pgid,'sh','-c','for i in 1 2 3 4 5 6 7 8 9 10; do pg_isready -h 127.0.0.1 -U postgres -d postgres && exit 0; sleep 1; done; exit 1'],15000);
  const root=resolve(import.meta.dirname,'..'),uid=process.getuid?.()??1000,gid=process.getgid?.()??1000;
  runid=docker(['create','--name',runname,'--label','wm.test.transaction='+nonce,'--network',net,'--read-only','--user',uid+':'+gid,'--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700','--mount','type=bind,src='+root+'/server/src/pg-transaction.ts,dst=/fixture/server/src/pg-transaction.ts,readonly','--mount','type=bind,src='+root+'/scripts/pg-transaction-integration.mjs,dst=/fixture/scripts/pg-transaction-integration.mjs,readonly','--mount','type=bind,src='+root+'/server/src/pg-sop-runs.ts,dst=/fixture/server/src/pg-sop-runs.ts,readonly','--mount','type=bind,src='+root+'/scripts/pg-sop-runs-test.mjs,dst=/fixture/scripts/pg-sop-runs-test.mjs,readonly','--mount','type=bind,src='+root+'/server/src/pg-settings.ts,dst=/fixture/server/src/pg-settings.ts,readonly','--mount','type=bind,src='+root+'/server/src/pg-workbenches.ts,dst=/fixture/server/src/pg-workbenches.ts,readonly',...['pg-settings-import.mjs','pg-settings-import-test.mjs','pg-workbenches-test.mjs','pg-settings-test.mjs','sop-preservation-plan.mjs','sop-preservation-import.mjs','sop-preservation-import-test.mjs'].flatMap(name=>['--mount','type=bind,src='+root+'/scripts/'+name+',dst=/fixture/scripts/'+name+',readonly']),'--env','PGPASSWORD','--env','PG_TRANSACTION_FIXTURE_NONCE='+nonce,'--entrypoint','node',runner,'/fixture/scripts/pg-transaction-integration.mjs','--inside']);
  owned(runid,runname,runner);console.log(docker(['start','--attach',runid],60000));
  const ended=owned(runid,runname,runner);assert.equal(ended.State.ExitCode,0,'fixture exit code');
  const {verifySopDumpRestore}=await import('./pg-sop-backup-restore-test.mjs');
  verifySopDumpRestore({docker,container:pgid,nonce,verifyOwned:()=>owned(pgid,pgname,pg)});
 }finally{
  const failures=[];
  for(const [id,name,image]of [[runid,runname,runner],[pgid,pgname,pg]])if(id){try{owned(id,name,image);docker(['rm','-f',id])}catch{failures.push(name)}}
  if(madeNetwork)try{const n=JSON.parse(docker(['network','inspect',net]))[0];assert.equal(n.Labels['wm.test.transaction'],nonce);assert.equal(n.Internal,true);docker(['network','rm',net])}catch{failures.push(net)}
  console.log(JSON.stringify({cleanup_failures:failures,production_requests:0}));assert.equal(failures.length,0,'owned fixture cleanup');
 }
}
