// Shared real/synthetic packaging; preserves ERROR separately from business predicate values.
export function packObservations(db,coverage,report){
 db.exec('CREATE TABLE IF NOT EXISTS sso2_probes(probe_id TEXT PRIMARY KEY,value INTEGER,status TEXT,evidence_json TEXT);DELETE FROM sso2_probes;CREATE TABLE IF NOT EXISTS sso2_execution_integrity(probe_id TEXT PRIMARY KEY,status TEXT,error_kind TEXT,error_code TEXT,exit_code INTEGER,business_verdict TEXT,evidence_json TEXT);DELETE FROM sso2_execution_integrity;');
 for(const u of coverage.units){
  const table='sso2_eval_'+u.id;
  if(!/^[A-Za-z0-9_]+$/.test(u.id))throw new Error('invalid probe id');
  db.exec('DROP TABLE IF EXISTS '+table+';CREATE TABLE '+table+'(probe_id TEXT PRIMARY KEY,value INTEGER)');
  const r=report.results.find(x=>x.id===u.id);
  if(r){
   db.prepare('INSERT INTO sso2_probes VALUES(?,?,?,?)').run(u.id,r.value,r.status,JSON.stringify(r));
   db.prepare('INSERT INTO sso2_execution_integrity VALUES(?,?,?,?,?,?,?)').run(u.id,r.status,r.error_kind??null,r.error_code??null,r.exit_code??null,r.business_verdict??(r.status==='FAIL'?'FAIL':r.status==='PASS'?'PASS':'NOT_EVALUATED'),JSON.stringify(r));
   // ERROR never becomes fake business value0. Guard below blocks overall PASS.
   if(r.value!==null&&r.status!=='ERROR')db.prepare('INSERT INTO '+table+' VALUES(?,?)').run(u.id,r.value);
  } else if(u.id.startsWith('deferred_')) {
   db.prepare("INSERT INTO sso2_execution_integrity VALUES(?,'DEFERRED',NULL,NULL,NULL,'NOT_EVALUATED',?)").run(u.id,JSON.stringify({reason:'contract deferred'}));
  } // Truly missing unit => empty scoped guard => NEEDS, not fabricated execution success.
 }
}
