/** Verify the checked-in catalog baseline against upstream DDL on a disposable PostgreSQL database.
 * YGL_ENGINE_ROOT=<built-ygl> YGL_TEST_PG_ADMIN_URL=<isolated-admin> YGL_TEST_PG_HOST=<isolated-host> node scripts/ygl-pg-catalog-baseline-test.mjs
 * This test creates and drops only a database it successfully created. Never point it at a persistent or production server. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadEngine} from './ygl-pg-migrate.mjs';
import {pgCatalog,pinnedCatalogs} from './ygl-pg-catalog.mjs';
const root=resolve('.'),engine=loadEngine(process.env.YGL_ENGINE_ROOT),url=process.env.YGL_TEST_PG_ADMIN_URL;
assert(url,'explicit isolated PG URL required, no skip');const u=new URL(url);
assert(['127.0.0.1','[::1]',process.env.YGL_TEST_PG_HOST].filter(Boolean).includes(u.hostname),'isolated PG host required');
const tmp=join(root,'tmp');mkdirSync(tmp,{recursive:true});assert.equal(realpathSync(tmp),tmp);assert(!lstatSync(tmp).isSymbolicLink());
const dir=mkdtempSync(join(tmp,'pg-catalog-baseline-')),home=join(dir,'seed'),dbName='catalog_'+randomBytes(10).toString('hex');
assert(/^catalog_[0-9a-f]{20}$/.test(dbName));const admin=new engine.Client({connectionString:url});let connected=false,created=false,source,client;
try{
  const env={PATH:process.env.PATH,HOME:process.env.HOME||dir,YGL_HOME:home,YGL_SESSION:'catalog-baseline',YGL_NO_UPDATE_CHECK:'1'};
  const init=spawnSync(process.execPath,[join(process.env.YGL_ENGINE_ROOT,'dist/bundle/bin.cjs'),'db','init','--json'],{env,encoding:'utf8',timeout:30000});
  assert.equal(init.status,0,'synthetic source initialization failed');
  const sourceFile=join(home,'ygl-trees.db'),before=createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
  source=new engine.Native(sourceFile,{readonly:true,fileMustExist:true});source.defaultSafeIntegers(true);source.pragma('query_only=ON');source.exec('BEGIN');
  await admin.connect();connected=true;await admin.query('CREATE DATABASE "'+dbName+'"');created=true;
  const target=new URL(url);target.pathname='/'+dbName;
  const adapter={all:(sql,params=[])=>source.prepare(sql).all(params),get:(sql,params=[])=>source.prepare(sql).get(params)};
  const result=await engine.migrateToPg(adapter,target.toString(),false);assert.equal(result.tables.length,engine.tables.length);
  client=new engine.Client({connectionString:target.toString()});await client.connect();
  const catalog=await pgCatalog(client),expected=pinnedCatalogs(engine.migrationNormalizedSha256);assert(expected,'unreviewed engine schema baseline');
  assert(expected.includes(catalog.sha256),'upstream-created catalog differs from checked-in baseline');
  assert.equal(createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),before,'synthetic source changed');
  const version=(await client.query('SHOW server_version_num')).rows[0].server_version_num;
  console.log(JSON.stringify({pass:true,pg_major:Math.floor(Number(version)/10000),engine_module_normalized_sha256:engine.migrationNormalizedSha256,catalog_sha256:catalog.sha256,source_unchanged:true,production_requests:0}));
} catch(e) {
  const code=typeof e?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(e.code)?e.code:'catalog_baseline_test_failed';
  console.error(JSON.stringify({pass:false,error:code,production_requests:0}));process.exitCode=1;
} finally {
  await client?.end().catch(()=>{});try{source?.close()}catch{}
  if(created){assert(/^catalog_[0-9a-f]{20}$/.test(dbName));await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)')}
  if(connected)await admin.end();
  assert.equal(realpathSync(dir),dir);assert(dir.startsWith(tmp+sep)&&!lstatSync(dir).isSymbolicLink());rmSync(dir,{recursive:true,force:true});
}
