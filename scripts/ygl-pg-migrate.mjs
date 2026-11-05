/** Read-only SQLite snapshot -> NEW EMPTY PostgreSQL database + full row-digest verification.
 * Usage: node scripts/ygl-pg-migrate.mjs snapshot --source <sqlite> --out <new-dir> --engine-root <built-ygl>
 *        YGL_MIGRATION_PG_URL_FILE=<secret> node scripts/ygl-pg-migrate.mjs migrate|verify --snapshot <dir> --target-hash <sha256:...> --report <new-json> --engine-root <built-ygl>
 * Credentials are env/file only. No --fresh, sync, overwrite, implicit project merge or consumer cutover.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join, dirname, basename, relative, sep, isAbsolute } from 'node:path';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, chmodSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';

export class MigrationRefusal extends Error { constructor(code) { super(code); this.code=code; } }
const refuse=code=>{throw new MigrationRefusal(code);};
const hash=data=>createHash('sha256').update(data).digest('hex');
const quote=name=>'"'+String(name).replaceAll('"','""')+'"';
const writeNew=(file,value)=>{
  const text=JSON.stringify(value,null,2)+'\n',temp=file+'.'+randomUUID()+'.tmp';
  let fd;
  try { fd=openSync(temp,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;linkSync(temp,file); }
  finally { if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp); }
};
const isRegular=file=>{try{return lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink();}catch{return false;}};
const occupied=file=>{try{lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

export function loadEngine(root) {
  if(!root||!isAbsolute(root))refuse('engine_root_required');
  const req=createRequire(join(realpathSync(root),'package.json'));
  const pkg=req('./package.json');if(pkg.name!=='ygl-trees')refuse('engine_package_invalid');
  const migrationPath=join(root,'dist/packages/ops/tools/src/pgsync.js');
  const {migrateToPg,MIRROR_TABLES}=req(migrationPath);
  const {exportableRows}=req(join(root,'dist/packages/ops/tools/src/config.js'));
  const {SCHEMA_VERSION}=req(join(root,'dist/packages/core/database/src/db.js'));
  const {pgTargetHash}=req(join(root,'dist/packages/core/database/src/pg-workspace.js'));
  return {Native:req('better-sqlite3'),Client:req('pg').Client,migrateToPg,tables:MIRROR_TABLES,exportableRows,schemaVersion:SCHEMA_VERSION,pgTargetHash,version:pkg.version,migrationSha256:hash(readFileSync(migrationPath))};
}
function adapter(db){return {all:(sql,params=[])=>db.prepare(sql).all(params),get:(sql,params=[])=>db.prepare(sql).get(params)};}
function columns(db,table){return db.prepare('PRAGMA table_info('+quote(table)+')').all().map(r=>({name:r.name,type:r.type,notnull:Number(r.notnull),pk:Number(r.pk),default:r.dflt_value}));}
function businessTables(db){return db.prepare('PRAGMA table_list').all().filter(r=>r.schema==='main'&&r.type==='table'&&!r.name.startsWith('sqlite_')).map(r=>r.name).sort();}
function canonicalCell(v,type) {
  if(v===null||v===undefined)return null;
  if(Buffer.isBuffer(v))return ['blob',v.toString('base64')];
  if(/INT/i.test(type)){
    if(typeof v==='number'&&!Number.isSafeInteger(v))refuse('unsafe_integer_value');
    if(!/^-?\d+$/.test(String(v)))refuse('invalid_integer_value');return ['integer',BigInt(v).toString()];
  }
  if(/REAL|FLOA|DOUB/i.test(type)){const n=Number(v);if(!Number.isFinite(n))refuse('invalid_real_value');return ['real',n];}
  return ['text',String(v)];
}
export function rowsDigest(rows,cols){
  const canonical=rows.map(r=>JSON.stringify(cols.map(c=>canonicalCell(r[c.name],c.type)))).sort();
  return hash(JSON.stringify(canonical));
}
function tableInfo(db,table){const cols=columns(db,table),rows=db.prepare('SELECT * FROM '+quote(table)).all();return {table,columns:cols,rows:rows.length,sha256:rowsDigest(rows,cols)};}
function snapshotInfo(db,file,source){
  const tables=businessTables(db).map(t=>tableInfo(db,t));
  return {format:'ygl-pg-snapshot/v1',source,read_at:new Date().toISOString(),schema_version:Number(db.pragma('user_version',{simple:true})),snapshot_file:'workspace.sqlite',snapshot_sha256:hash(readFileSync(file)),tables,triggers:db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r=>({name:r.name,table:r.tbl_name,sql_sha256:hash(r.sql||'')}))};
}
function openSnapshot(engine,dir){
  const manifestFile=join(dir,'manifest.json'),file=join(dir,'workspace.sqlite');
  if(!isRegular(file)||!isRegular(manifestFile))refuse('snapshot_files_invalid');
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  if(manifest.format!=='ygl-pg-snapshot/v1'||manifest.snapshot_file!=='workspace.sqlite'||manifest.snapshot_sha256!==hash(readFileSync(file)))refuse('snapshot_checksum_mismatch');
  const db=new engine.Native(file,{readonly:true,fileMustExist:true});db.defaultSafeIntegers(true);db.pragma('query_only=ON');db.exec('BEGIN');
  try {
    if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)refuse('snapshot_integrity_failed');
    const actual=snapshotInfo(db,file,manifest.source);
    if(JSON.stringify(actual.tables)!==JSON.stringify(manifest.tables)||actual.schema_version!==manifest.schema_version||JSON.stringify(actual.triggers)!==JSON.stringify(manifest.triggers))refuse('snapshot_manifest_mismatch');
    return {db,file,manifest};
  }catch(e){db.close();throw e;}
}
function snapshotOutputOutsideSource(input,out){
  const sourceRoot=dirname(input);let parent;
  try { parent=realpathSync(dirname(resolve(out)));if(!statSync(parent).isDirectory())throw Error('not a directory'); }
  catch { refuse('snapshot_output_parent_invalid'); }
  const destination=join(parent,basename(resolve(out))),rel=relative(sourceRoot,destination);
  if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))refuse('snapshot_output_inside_source');
  // realpath cannot resolve bind-mount aliases. Compare the source directory tree
  // with each output-parent ancestor by physical identity without reading file contents.
  const identity=dir=>{const s=statSync(dir,{bigint:true});if(!s.isDirectory())throw Error('not a directory');return String(s.dev)+':'+String(s.ino);};
  try {
    const sourceDirs=new Set(),pending=[sourceRoot];
    while(pending.length){const dir=pending.pop(),id=identity(dir);if(sourceDirs.has(id))continue;sourceDirs.add(id);for(const entry of readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())pending.push(join(dir,entry.name));}
    for(let current=parent;;current=dirname(current)){if(sourceDirs.has(identity(current)))refuse('snapshot_output_inside_source');if(dirname(current)===current)break;}
  } catch(e) { if(e instanceof MigrationRefusal)throw e;refuse('snapshot_source_tree_uninspectable'); }
  return destination;
}
export async function createSnapshot(engine,source,out){
  if(!source||!out||!isAbsolute(source)||!isAbsolute(out))refuse('absolute_source_and_output_required');
  if(occupied(out))refuse('snapshot_output_exists');
  const input=realpathSync(source);if(!isRegular(input))refuse('source_file_invalid');
  const dir=snapshotOutputOutsideSource(input,out),file=join(dir,'workspace.sqlite');mkdirSync(dir,{mode:0o700});
  let db,copy;
  try {
    db=new engine.Native(input,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
    await db.backup(file);db.close();db=null;chmodSync(file,0o600);
    copy=new engine.Native(file,{readonly:true,fileMustExist:true});copy.defaultSafeIntegers(true);copy.pragma('query_only=ON');copy.exec('BEGIN');
    if(copy.pragma('integrity_check',{simple:true})!=='ok'||copy.pragma('foreign_key_check').length)refuse('snapshot_integrity_failed');
    const manifest=snapshotInfo(copy,file,input);writeNew(join(dir,'manifest.json'),manifest);
    writeFileSync(join(dir,'workspace.sqlite.sha256'),manifest.snapshot_sha256+'  workspace.sqlite\n',{flag:'wx',mode:0o600});
    return {ok:true,operation:'snapshot',out:dir,schema_version:manifest.schema_version,tables:manifest.tables.map(t=>({table:t.table,rows:t.rows,sha256:t.sha256})),snapshot_sha256:manifest.snapshot_sha256};
  }catch(e){if(!existsSync(join(dir,'failure.json')))writeNew(join(dir,'failure.json'),{ok:false,operation:'snapshot',error:e instanceof MigrationRefusal?e.code:'snapshot_failed'});throw e;}
  finally{try{copy?.close();}catch{}try{db?.close();}catch{}}
}
function targetUrl(engine,env,expected){
  let url;if(env.YGL_MIGRATION_PG_URL_FILE!==undefined){const f=env.YGL_MIGRATION_PG_URL_FILE;if(!isAbsolute(f)||!isRegular(f))refuse('target_secret_file_invalid');url=readFileSync(f,'utf8').trim();}else url=env.YGL_MIGRATION_PG_URL||'';
  if(!url||!/^sha256:[a-f0-9]{64}$/.test(expected||''))refuse('explicit_target_identity_required');
  let identity;try{identity=engine.pgTargetHash(url);}catch{refuse('target_url_invalid');}
  const u=new URL(url);if(u.hash||['postgres','template0','template1'].includes(decodeURIComponent(u.pathname.slice(1))))refuse('system_database_refused');
  if(identity!==expected)refuse('target_identity_mismatch');return {url,identity};
}
function preflight(engine,snapshot){
  if(snapshot.manifest.schema_version!==engine.schemaVersion)refuse('schema_version_mismatch');
  const tables=snapshot.manifest.tables.map(t=>t.table),extra=tables.filter(t=>!engine.tables.includes(t));
  if(extra.length)refuse('unsupported_source_tables:'+extra.join(','));
  if(engine.tables.some(t=>!tables.includes(t)))refuse('source_tables_missing');
  const knownVirtuals=new Set(['skills_fts','sources_fts','evidence_fts','kb_fts','nodes_fts']);
  if(snapshot.db.pragma('table_list').some(r=>r.schema==='main'&&r.type==='virtual'&&!knownVirtuals.has(r.name)))refuse('unsupported_source_virtual_tables');
  if(snapshot.manifest.triggers.length)refuse('unsupported_source_triggers');
  if(snapshot.db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().length)refuse('unsupported_source_views');
  if(snapshot.db.prepare("SELECT 1 FROM meta WHERE key='backend_binding'").get())refuse('source_backend_binding_present');
}
export async function pgCatalog(client){
  const columns=(await client.query("SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const constraints=(await client.query("SELECT c.relname AS table_name,p.conname,pg_get_constraintdef(p.oid) definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid WHERE p.connamespace='public'::regnamespace ORDER BY c.relname,p.conname")).rows;
  const indexes=(await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
  const fingerprint=hash(JSON.stringify({columns,constraints,indexes}));
  return {columns,constraints,indexes,sha256:fingerprint};
}
async function verifyRows(engine,snapshot,client){
  const results=[];
  for(const table of engine.tables){
    const meta=snapshot.manifest.tables.find(t=>t.table===table),cols=meta.columns;
    let expected=engine.exportableRows(adapter(snapshot.db),table,true),actual=(await client.query('SELECT '+cols.map(c=>quote(c.name)).join(',')+' FROM '+quote(table))).rows;
    if(table==='schema_migrations'){
      expected=expected.filter(r=>r.backend!=='postgres');actual=actual.filter(r=>r.backend!=='postgres');
      const rows=(await client.query("SELECT version FROM schema_migrations WHERE backend='postgres'")).rows;
      if(rows.length!==1||Number(rows[0].version)!==engine.schemaVersion)refuse('migration_ledger_mismatch');
    }
    const source_sha256=rowsDigest(expected,cols),target_sha256=rowsDigest(actual,cols);
    if(expected.length!==actual.length||source_sha256!==target_sha256)refuse('row_content_mismatch:'+table);
    results.push({table,rows:actual.length,source_sha256,target_sha256});
  }
  const unknown=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.filter(r=>!engine.tables.includes(r.tablename));
  if(unknown.length)refuse('unexpected_target_tables');
  return results;
}
export async function migrateSnapshot(engine,dir,expected,report,env=process.env,verifyOnly=false){
  if(!dir||!report||!isAbsolute(dir)||!isAbsolute(report))refuse('absolute_snapshot_and_report_required');
  if(occupied(report))refuse('report_exists');
  let snapshot,client,locked=false,transaction=false,reportOwned=false;
  const reportLock=report+'.lock';
  try{
    try {const fd=openSync(reportLock,'wx',0o600);closeSync(fd);reportOwned=true;} catch {refuse('report_output_unavailable');}
    if(occupied(report))refuse('report_exists');
    snapshot=openSnapshot(engine,dir);
    preflight(engine,snapshot);
    const target=targetUrl(engine,env,expected);
    client=new engine.Client({connectionString:target.url,connectionTimeoutMillis:5000});await client.connect();
    const identity=(await client.query('SELECT current_database() db,current_schema() schema')).rows[0];
    if(identity.schema!=='public'||identity.db!==decodeURIComponent(new URL(target.url).pathname.slice(1)))refuse('target_schema_or_database_mismatch');
    await client.query("SET statement_timeout TO '30s'");
    if(!verifyOnly){
      locked=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtext('ygl:explicit-empty-database-migration')) AS locked")).rows[0].locked);if(!locked)refuse('migration_already_in_progress');
      const objects=(await client.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')")).rows;
      if(objects.length)refuse('target_not_empty');
      const custom=(await client.query("SELECT nspname FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname NOT IN ('public','information_schema') UNION ALL SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace")).rows;
      if(custom.length)refuse('target_not_empty');
      await engine.migrateToPg(adapter(snapshot.db),target.url,false);
      await client.query('BEGIN');transaction=true;
      // Migrated historical seq values must precede all new PG-native events.
      await client.query("SELECT setval('events_seq',GREATEST(COALESCE(MAX(seq),0),1),COALESCE(MAX(seq),0)>0) FROM events");
      await client.query('COMMIT');transaction=false;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    const tables=await verifyRows(engine,snapshot,client);
    const seq=(await client.query('SELECT last_value,is_called FROM events_seq')).rows[0];
    const maximum=(await client.query('SELECT COALESCE(MAX(seq),0) n FROM events')).rows[0].n;
    const next=BigInt(seq.last_value)+(seq.is_called?1n:0n);
    if(next<=BigInt(maximum))refuse('events_sequence_behind_history');
    const catalog=await pgCatalog(client);
    await client.query('COMMIT');transaction=false;
    if(hash(readFileSync(snapshot.file))!==snapshot.manifest.snapshot_sha256)refuse('snapshot_changed_during_migration');
    const result={ok:true,operation:verifyOnly?'verify':'migrate',verified_at:new Date().toISOString(),engine_version:engine.version,migration_module_sha256:engine.migrationSha256,target_hash:target.identity,snapshot_sha256:snapshot.manifest.snapshot_sha256,tables,catalog,known_transformations:['secret config.set event payloads redacted by official export','postgres schema_migrations graduation row','search ngram/generated columns rebuilt from official tokenizer','events_seq advanced beyond historical maximum'],production_cutover:false};
    writeNew(report,result);return result;
  }catch(e){if(transaction)await client?.query('ROLLBACK').catch(()=>{});const error=e instanceof MigrationRefusal?e.code:'pg_migration_or_verification_failed';if(reportOwned&&!occupied(report))writeNew(report,{ok:false,error,operation:verifyOnly?'verify':'migrate',production_cutover:false,target_may_be_partially_migrated:!verifyOnly&&!!client});throw new MigrationRefusal(error);}
  finally{if(locked)await client?.query("SELECT pg_advisory_unlock(hashtext('ygl:explicit-empty-database-migration'))").catch(()=>{});await client?.end().catch(()=>{});snapshot?.db.close();if(reportOwned)unlinkSync(reportLock);}
}
async function main(){
  const [operation,...rest]=process.argv.slice(2),args={};for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith('--')||!rest[i+1]||rest[i+1].startsWith('--')||Object.hasOwn(args,rest[i]))refuse('invalid_arguments');args[rest[i]]=rest[i+1];}
  const allowed=new Set(['--engine-root','--source','--out','--snapshot','--target-hash','--report']);if(Object.keys(args).some(k=>!allowed.has(k)))refuse('invalid_arguments');
  const engine=loadEngine(args['--engine-root']);let result;
  if(operation==='snapshot')result=await createSnapshot(engine,args['--source'],args['--out']);
  else if(operation==='migrate'||operation==='verify')result=await migrateSnapshot(engine,args['--snapshot'],args['--target-hash'],args['--report'],process.env,operation==='verify');
  else refuse('unknown_operation');
  console.log(JSON.stringify({ok:result.ok,operation:result.operation,tables:result.tables.length,snapshot_sha256:result.snapshot_sha256,...(result.target_hash?{target_hash:result.target_hash}:{}),production_cutover:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e instanceof MigrationRefusal?e.code:'migration_failed',production_cutover:false}));process.exitCode=1;});
