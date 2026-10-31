/** Draft SOP authorization stage a. Explicit factory only: no index import, route or production migration.
 * Legacy started_by / A2A node labels NEVER confer a human permission. */
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {resolveOdooViewer} from './lifecycle.ts';
import {parse as parseYaml} from 'yaml';
import {trustedOdooOrigins} from './odoo-session.ts';
import {validateReadonlySop} from './sop-readonly-channel.ts';
import {assembleReadonlySop,type FrozenSopSource} from './sop-readonly-assembly.ts';
type ViewerResult = Awaited<ReturnType<typeof resolveOdooViewer>>;
// Existing run upload hard ceilings: single50MiB / run20 files / run200MiB. Stored MIME is declared, not content-authenticated.
type Deps = {db:DatabaseSync; odooOrigin:string; marketOrigin:string; frozenYaml:(slug:string,version:number)=>string; viewer?:typeof resolveOdooViewer; now?:()=>number; editableCreation?:boolean};
type Binding = {run_id:number; target_id:number; sop_version:number; owner_subject:string; assignee_subject:string; acl_revision:number; manifest_sha256:string; revoked:number};
type Scope = {targetId:number;runId:number;step:string};
type Record = Scope & {action:'read'|'save'|'upload'|'finish'|'recover';version:number;subject:string;session:string;epoch:number;aclRevision:number;expires:number};
const positive = (n:number) => Number.isSafeInteger(n)&&n>0;
export class SopWriteError extends Error { status:number;code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;} }
const deny = () => { throw new SopWriteError(403,'sop_run_access_denied'); };
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export function createSopRunAccess(deps:Deps) {
  const {db}=deps, now=deps.now??Date.now, viewer=deps.viewer??resolveOdooViewer;
  const origin=new URL(deps.odooOrigin);
  if(origin.origin!==deps.odooOrigin || !trustedOdooOrigins().origins.has(deps.odooOrigin)) throw Error('Explicit trusted Odoo origin required');
  // Only callers constructing this unmounted service initialize this table. Existing app startup unchanged.
  db.exec('CREATE TABLE IF NOT EXISTS sop_run_access (run_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL, sop_version INTEGER NOT NULL, owner_subject TEXT NOT NULL, assignee_subject TEXT NOT NULL, acl_revision INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS sop_run_revisions (run_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data_sha256 TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sop_channel_files (id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,step TEXT NOT NULL,field_key TEXT NOT NULL,request_id TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,body BLOB NOT NULL,UNIQUE(run_id,step,request_id))');
  db.exec('CREATE TABLE IF NOT EXISTS sop_channel_completions (run_id INTEGER PRIMARY KEY, acl_revision INTEGER NOT NULL)');
  const secret=randomBytes(32), records=new Map<string,Record>(), sessions=new Map<string,{epoch:number;generation:number;subject:string|null}>();
  const mac=(s:string)=>createHmac('sha256',secret).update(s).digest('base64url');
  const cookieKey=(cookie:string) => {
    const parts=cookie.split(';').map(x=>x.trim()).filter(x=>x.startsWith('session_id='));
    if(parts.length!==1 || !/^session_id=[A-Za-z0-9_.=-]{16,512}$/.test(parts[0])) return deny();
    return {cookie:parts[0],key:mac(parts[0])}; // reference is process-local and never projected
  };
  const binding=(runId:number)=>db.prepare('SELECT * FROM sop_run_access WHERE run_id=?').get(runId) as Binding|undefined;
  function metadata(runId:number,targetId:number) {
    if(!positive(runId)||!positive(targetId)) return deny();
    const r=db.prepare('SELECT id,sop_slug,sop_version,status FROM sop_runs WHERE id=?').get(runId) as {id:number;sop_slug:string;sop_version:number;status:string}|undefined;
    if(!r || !positive(r.sop_version) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.sop_slug)||!['running','finished'].includes(r.status)) return deny();
    const target=db.prepare('SELECT url,enabled FROM workbenches WHERE id=?').get(targetId) as any;
    const app=db.prepare('SELECT id,kind,status FROM apps WHERE slug=?').get(r.sop_slug) as any;
    if(!target?.enabled || target.url!=='/sop/'+r.sop_slug+'/' || app?.kind!=='sop'||app.status!=='published'||!db.prepare('SELECT 1 FROM app_versions WHERE app_id=? AND version=?').get(app.id,r.sop_version)) return deny();
    return r;
  }
  const allowed=(b:Binding|undefined,subject:string,target:number)=> b && !b.revoked && b.target_id===target && (b.owner_subject===subject || !!b.assignee_subject && b.assignee_subject===subject);
  function sweep(){for(const [id,r] of records)if(r.expires<=now())records.delete(id);}
  // ponytail: bounded process-local sessions (4096); restart clears epochs and all capabilities.
  function revokeKey(key:string){const state=sessions.get(key);if(!state)return;state.epoch++;state.generation++;state.subject=null;for(const [id,r]of records)if(r.session===key)records.delete(id);}
  const stillCurrent=(who:{key:string;epoch:number;generation:number;subject:string})=>{const s=sessions.get(who.key);return s?.epoch===who.epoch&&s.generation===who.generation&&s.subject===who.subject;};
  async function identify(cookie:string) {
    const session=cookieKey(cookie);
    if(!sessions.has(session.key)){if(sessions.size>=4096)return deny();sessions.set(session.key,{epoch:0,generation:0,subject:null});}
    const state=sessions.get(session.key)!,epoch=state.epoch,generation=++state.generation;let result:ViewerResult|null=null;
    try{result=await viewer(session.cookie,deps.odooOrigin);}catch{ /* fresh identity failed below */ }
    // Latest-started identity query wins. A stale result (success OR failure) cannot replace newer state.
    if(state.generation!==generation||state.epoch!==epoch)return deny();
    if(!result?.ok){revokeKey(session.key);return deny();}
    const who=result.viewer;
    if(!positive(who.uid)||!who.sub?.startsWith('user:')){revokeKey(session.key);return deny();}
    const subject=who.sub+':'+who.uid;
    if(state.subject!==null&&state.subject!==subject)revokeKey(session.key);
    state.subject=subject;
    return {...session,epoch:state.epoch,generation:state.generation,subject};
  }
  function authorized(scope:Scope,subject:string,finishedRead=false) {
    const r=metadata(scope.runId,scope.targetId),b=binding(scope.runId);
    const completed=finishedRead&&r.status==='finished'&&b&&db.prepare('SELECT 1 FROM sop_channel_completions WHERE run_id=? AND acl_revision=?').get(scope.runId,b.acl_revision);
    const readable=allowed(b,subject,scope.targetId)||(completed&&b!.target_id===scope.targetId&&(b!.owner_subject===subject||!!b!.assignee_subject&&b!.assignee_subject===subject));
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(scope.step)||!readable||b!.sop_version!==r.sop_version)return deny();
    return {r,b:b!};
  }
  function project(scope:Scope,subject:string, allowSave = false, allowUpload = false, finishedRead=false) {
    const {r,b}=authorized(scope,subject,finishedRead);
    const yaml=deps.frozenYaml(r.sop_slug,r.sop_version);
    if(hash(yaml)!==b.manifest_sha256)return deny();
    // Values are not selected until current viewer AND controlled run binding pass.
    const row=db.prepare('SELECT data FROM sop_runs WHERE id=?').get(r.id) as {data:string};
    const source:FrozenSopSource={targetId:scope.targetId,slug:r.sop_slug,version:r.sop_version,yaml};
    const data=JSON.parse(row.data);
    if(allowUpload){const refs=db.prepare('SELECT id,field_key FROM sop_channel_files WHERE run_id=? AND step=? ORDER BY rowid').all(scope.runId,scope.step) as {id:string;field_key:string}[];for(const f of refs){data[scope.step]??={};if(!(data[scope.step][f.field_key]??=[]).includes(f.id))data[scope.step][f.field_key].push(f.id);}}
    const run={id:r.id,sop_slug:r.sop_slug,sop_version:r.sop_version,status:r.status,data};
    const revision=db.prepare('SELECT revision,data_sha256 FROM sop_run_revisions WHERE run_id=?').get(r.id) as {revision:number;data_sha256:string}|undefined;
    if(allowSave && (!revision || hash(row.data)!==revision.data_sha256))throw new SopWriteError(409,'run_revision_conflict');
    const preview=assembleReadonlySop(source,run,scope.step,revision?.revision??0,deps.marketOrigin,allowSave,allowUpload);
    // Projection has no owner/login/uid/session/receipt or upload capability. Token is separate, shell only.
    return {preview,run:{id:r.id,targetId:scope.targetId,version:r.sop_version,step:scope.step,status:r.status,authorized:true as const},aclRevision:b.acl_revision};
  }
  async function authenticate(cookie:string,capability:string,scope:Scope) {
    sweep();const match=typeof capability==='string'&&/^([A-Za-z0-9_-]{43})[.]([A-Za-z0-9_-]{43})$/.exec(capability);
    if(!match||!timingSafeEqual(Buffer.from(match[2]),Buffer.from(mac(match[1]))))return deny();
    const record=records.get(match[1]);if(!record||record.expires<=now()||record.targetId!==scope.targetId||record.runId!==scope.runId||record.step!==scope.step)return deny();
    const who=await identify(cookie);
    if(!stillCurrent(who)||!records.has(match[1])||record.expires<=now()||record.session!==who.key||record.subject!==who.subject||record.epoch!==who.epoch||record.aclRevision!==binding(scope.runId)?.acl_revision)return deny();
    if(metadata(scope.runId,scope.targetId).sop_version!==record.version)return deny();
    return {record,who};
  }
  async function issue(cookie:string,scope:Scope,action:'read'|'save'|'upload'|'finish'|'recover') {
    scope={...scope};const who=await identify(cookie);sweep();if(!stillCurrent(who)||records.size>=4096)return deny();
    const projection=project(scope,who.subject,action!=='read',action!=='read',action==='recover');
    if(action==='save' && (metadata(scope.runId,scope.targetId).status!=='running'||!projection.preview.fields.some(f=>f.operations?.includes('save' as never))))return deny();
    if(action==='upload' && (metadata(scope.runId,scope.targetId).status!=='running'||!projection.preview.fields.some(f=>f.type==='file'&&f.operations?.includes('upload' as never))))return deny();
    if(action==='finish' && metadata(scope.runId,scope.targetId).status!=='running')return deny();
    const id=randomBytes(32).toString('base64url'),expires=now()+300_000;
    records.set(id,{...scope,action,version:projection.run.version,subject:who.subject,session:who.key,epoch:who.epoch,aclRevision:projection.aclRevision,expires});
    return {capability:id+'.'+mac(id),expires,...projection};
  }
  return {
    /** Create a NEW run and bind its owner from fresh Odoo identity. Never claims an existing run. */
    async createOwnedRun(cookie:string,input:{slug:string;targetId:number}) {
      input=structuredClone(input);
      if(!input||Object.keys(input).sort().join(',')!=='slug,targetId'||typeof input.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)||!positive(input.targetId))throw new SopWriteError(400,'invalid_owned_run');
      const who=await identify(cookie);
      if(!stillCurrent(who))return deny();
      db.exec('BEGIN IMMEDIATE');
      try {
        const target=db.prepare('SELECT url,enabled FROM workbenches WHERE id=?').get(input.targetId) as {url:string;enabled:number}|undefined;
        const app=db.prepare('SELECT id,kind,status,active_version FROM apps WHERE slug=?').get(input.slug) as {id:number;kind:string;status:string;active_version:number}|undefined;
        if(!target?.enabled||target.url!=='/sop/'+input.slug+'/'||!app||app.kind!=='sop'||app.status!=='published'||!positive(app.active_version)||!db.prepare('SELECT 1 FROM app_versions WHERE app_id=? AND version=?').get(app.id,app.active_version))return deny();
        const yaml=deps.frozenYaml(input.slug,app.active_version),manifest=parseYaml(yaml,{maxAliasCount:0}),step=manifest?.steps?.[0]?.key;
        // New read-only wiring accepts only reviewed read schemas; invalid source never creates a run.
        assembleReadonlySop({targetId:input.targetId,slug:input.slug,version:app.active_version,yaml},{id:1,sop_slug:input.slug,sop_version:app.active_version,status:'running',data:{}},step,0,deps.marketOrigin,!!deps.editableCreation,!!deps.editableCreation);
        if(!stillCurrent(who))return deny();
        const created=db.prepare('INSERT INTO sop_runs(sop_slug,sop_version,started_by,data) VALUES(?,?,?,?)').run(input.slug,app.active_version,'','{}'),id=Number(created.lastInsertRowid);
        db.prepare('INSERT INTO sop_run_access(run_id,target_id,sop_version,owner_subject,assignee_subject,acl_revision,manifest_sha256,revoked) VALUES(?,?,?,?,?,1,?,0)').run(id,input.targetId,app.active_version,who.subject,'',hash(yaml));
        db.prepare('INSERT INTO sop_run_revisions VALUES(?,0,?)').run(id,hash('{}'));
        db.exec('COMMIT');return {id,targetId:input.targetId,version:app.active_version,step,authorized:true as const};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    /** Server-only controlled registration. Never expose through MCP or accept started_by as subject.
     * caller supplies Odoo sub+uid derived from trusted records; no legacy backfill/guess. */
    bindTrustedRun(input:{runId:number;targetId:number;ownerSubject:string;assigneeSubject?:string;manifestSha256:string}) {
      const run=metadata(input.runId,input.targetId);
      const valid=(s:string)=>typeof s==='string'&&/^user:[^\s:]+:[1-9][0-9]*$/.test(s)&&s.length<=256;
      if(!valid(input.ownerSubject)||input.assigneeSubject!==undefined&&!valid(input.assigneeSubject)||!/^[a-f0-9]{64}$/.test(input.manifestSha256))return deny();
      const revision=(binding(input.runId)?.acl_revision??0)+1;
      db.prepare('INSERT INTO sop_run_access(run_id,target_id,sop_version,owner_subject,assignee_subject,acl_revision,manifest_sha256,revoked) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(run_id) DO UPDATE SET target_id=excluded.target_id,sop_version=excluded.sop_version,owner_subject=excluded.owner_subject,assignee_subject=excluded.assignee_subject,acl_revision=excluded.acl_revision,manifest_sha256=excluded.manifest_sha256,revoked=0').run(input.runId,input.targetId,run.sop_version,input.ownerSubject,input.assigneeSubject??'',revision,input.manifestSha256);
      const data=(db.prepare('SELECT data FROM sop_runs WHERE id=?').get(input.runId) as {data:string}).data;
      db.prepare('INSERT OR IGNORE INTO sop_run_revisions VALUES(?,0,?)').run(input.runId,hash(data));
    },
    revokeRun(runId:number){db.prepare('UPDATE sop_run_access SET revoked=1,acl_revision=acl_revision+1 WHERE run_id=?').run(runId);},
    revokeSession(cookie:string){revokeKey(cookieKey(cookie).key);},
    open(cookie:string,scope:Scope) { return issue(cookie,scope,'read'); },
    openEditable(cookie:string,scope:Scope) { return issue(cookie,scope,'save'); },
    openUpload(cookie:string,scope:Scope) { return issue(cookie,scope,'upload'); },
    openFinish(cookie:string,scope:Scope) { return issue(cookie,scope,'finish'); },
    openRecovery(cookie:string,scope:Scope) { return issue(cookie,scope,'recover'); },
    async recover(cookie:string,capability:string,scope:Scope) {
      scope={...scope};const {who,record}=await authenticate(cookie,capability,scope);if(record.action!=='recover'||!stillCurrent(who)||record.expires<=now()||record.aclRevision!==binding(scope.runId)?.acl_revision)return deny();return project(scope,who.subject,true,true,true);
    },
    async read(cookie:string,capability:string,scope:Scope) {
      scope={...scope};const {who,record}=await authenticate(cookie,capability,scope);
      if(!stillCurrent(who)||record.expires<=now()||record.aclRevision!==binding(scope.runId)?.acl_revision)return deny();
      return project(scope,who.subject,record.action!=='read',record.action!=='read',record.action==='recover');
    },
    async finish(cookie:string,capability:string,scope:Scope,input:{version:number;expected_revision:number;values:Record<string,unknown>}) {
      scope={...scope};input=structuredClone(input);
      if(!input||Object.keys(input).sort().join(',')!=='expected_revision,values,version'||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw new SopWriteError(400,'invalid_finish');
      const {record,who}=await authenticate(cookie,capability,scope);
      if(record.action!=='finish'||record.version!==input.version)return deny();
      db.exec('BEGIN IMMEDIATE');
      try {
        if(!stillCurrent(who)||record.expires<=now()||record.aclRevision!==binding(scope.runId)?.acl_revision)return deny();
        const meta=metadata(scope.runId,scope.targetId);if(meta.status!=='running')return deny();
        const out=project(scope,who.subject,true,true);if(out.preview.revision!==input.expected_revision)throw new SopWriteError(409,'run_revision_conflict');
        let current;try{current=validateReadonlySop({...out.preview,values:input.values},true,true);}catch{throw new SopWriteError(422,'invalid_finish_values');}
        if(Object.keys(current.values).length!==current.fields.length||current.fields.some(f=>!Object.hasOwn(current.values,f.key)))throw new SopWriteError(422,'incomplete_finish_values');
        for(const f of current.fields){if(!f.operations?.includes('save' as never)&&JSON.stringify(current.values[f.key]??[])!==JSON.stringify(out.preview.values[f.key]??[]))throw new SopWriteError(422,'invalid_finish_reference');}
        const row=db.prepare('SELECT data FROM sop_runs WHERE id=?').get(scope.runId) as {data:string},data=JSON.parse(row.data);
        data[scope.step]={...current.values};
        const yaml=deps.frozenYaml(meta.sop_slug,meta.sop_version);if(hash(yaml)!==binding(scope.runId)!.manifest_sha256)return deny();
        const manifest=parseYaml(yaml,{maxAliasCount:0});
        for(const step of manifest.steps){
          const refs=db.prepare('SELECT id,field_key,mime,size FROM sop_channel_files WHERE run_id=? AND step=? ORDER BY rowid').all(scope.runId,step.key) as {id:string;field_key:string;mime:string;size:number}[];
          data[step.key]??={};
          for(const f of step.fields){if(f.type==='file'){const actual=refs.filter(x=>x.field_key===f.key);if(actual.some(x=>x.size>f.maxBytes||!f.mime.includes(x.mime)))throw new SopWriteError(422,'invalid_finish_reference');data[step.key][f.key]=actual.map(x=>x.id);}}
          let checked;try{checked=assembleReadonlySop({targetId:scope.targetId,slug:meta.sop_slug,version:meta.sop_version,yaml},{id:scope.runId,sop_slug:meta.sop_slug,sop_version:meta.sop_version,status:'running',data},step.key,input.expected_revision,deps.marketOrigin,true,true);}catch{throw new SopWriteError(422,'invalid_finish_values');}
          if(checked.fields.some(f=>f.required&&(!Object.hasOwn(checked.values,f.key)||checked.values[f.key]===''||Array.isArray(checked.values[f.key])&&!(checked.values[f.key] as unknown[]).length)))throw new SopWriteError(422,'required_finish_field');
        }
        const next=JSON.stringify(data),revision=input.expected_revision+1;if(!Number.isSafeInteger(revision))throw new SopWriteError(409,'run_revision_conflict');
        if(db.prepare('UPDATE sop_run_revisions SET revision=?,data_sha256=? WHERE run_id=? AND revision=? AND data_sha256=?').run(revision,hash(next),scope.runId,input.expected_revision,hash(row.data)).changes!==1)throw new SopWriteError(409,'run_revision_conflict');
        if(db.prepare("UPDATE sop_runs SET status='finished',data=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='running'").run(next,scope.runId).changes!==1)return deny();
        db.prepare('UPDATE sop_run_access SET revoked=1,acl_revision=acl_revision+1 WHERE run_id=?').run(scope.runId);
        db.prepare('INSERT OR REPLACE INTO sop_channel_completions VALUES(?,?)').run(scope.runId,binding(scope.runId)!.acl_revision);
        db.exec('COMMIT');for(const [id,r]of records)if(r.runId===scope.runId)records.delete(id);
        return {ok:true as const,status:'finished' as const,revision};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    async upload(cookie:string,capability:string,scope:Scope,input:{version:number;field:string;request_id:string;mime:string;name:string;bytes:Uint8Array}) {
      scope={...scope};input=structuredClone(input);
      if(!input||Object.keys(input).sort().join(',')!=='bytes,field,mime,name,request_id,version'||!(input.bytes instanceof Uint8Array)||input.bytes.byteLength>50*1024*1024||typeof input.name!=='string'||input.name.length>255||typeof input.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.request_id))throw new SopWriteError(400,'invalid_upload');
      const {record,who}=await authenticate(cookie,capability,scope);
      if(record.action!=='upload'||record.version!==input.version)return deny();
      db.exec('BEGIN IMMEDIATE');
      try {
        if(!stillCurrent(who)||record.expires<=now()||record.aclRevision!==binding(scope.runId)?.acl_revision||metadata(scope.runId,scope.targetId).status!=='running')return deny();
        const out=project(scope,who.subject,true,true),field=out.preview.fields.find(f=>f.key===input.field);
        if(!field||field.type!=='file'||!field.operations?.includes('upload' as never))return deny();
        if(input.bytes.byteLength>field.maxBytes!||!field.mime!.includes(input.mime))throw new SopWriteError(422,'invalid_upload_type_size');
        if(db.prepare('SELECT 1 FROM sop_channel_files WHERE run_id=? AND step=? AND request_id=?').get(scope.runId,scope.step,input.request_id))throw new SopWriteError(409,'upload_request_replayed');
        const count=db.prepare('SELECT count(*) n FROM sop_channel_files WHERE run_id=? AND step=? AND field_key=?').get(scope.runId,scope.step,input.field) as {n:number};
        const total=db.prepare('SELECT count(*) n,coalesce(sum(size),0) bytes FROM sop_channel_files WHERE run_id=?').get(scope.runId) as {n:number;bytes:number};
        if(count.n>=field.maxItems!||total.n>=20||total.bytes+input.bytes.byteLength>200*1024*1024)throw new SopWriteError(413,'upload_quota_exceeded');
        // Blob bytes stay inert in SQLite: server-generated key only, client name is never a path or storage input.
        const id='f_'+randomBytes(24).toString('hex');
        db.prepare('INSERT INTO sop_channel_files VALUES(?,?,?,?,?,?,?,?)').run(id,scope.runId,scope.step,input.field,input.request_id,input.mime,input.bytes.byteLength,input.bytes);
        db.exec('COMMIT');return {ok:true as const,id,field:input.field,size:input.bytes.byteLength,mime:input.mime};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    async save(cookie:string,capability:string,scope:Scope,input:{version:number;expected_revision:number;values:Record<string,unknown>}) {
      scope={...scope};input=structuredClone(input);
      if(!input||Object.keys(input).sort().join(',')!=='expected_revision,values,version'||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw new SopWriteError(400,'invalid_save');
      const {who,record}=await authenticate(cookie,capability,scope);
      if(record.action!=='save'||record.version!==input.version)return deny();
      db.exec('BEGIN IMMEDIATE');
      try {
        if(!stillCurrent(who)||record.expires<=now()||record.aclRevision!==binding(scope.runId)?.acl_revision||metadata(scope.runId,scope.targetId).status!=='running')return deny();
        const out=project(scope,who.subject,true,true);
        if(out.preview.revision!==input.expected_revision)throw new SopWriteError(409,'run_revision_conflict');
        let validated;
        try{validated=validateReadonlySop({...out.preview,values:input.values},true,true);}catch{throw new SopWriteError(422,'invalid_field_values');}
        if(Object.keys(validated.values).some(key=>!out.preview.fields.find(f=>f.key===key)?.operations?.includes('save' as never)))return deny();
        const row=db.prepare('SELECT data FROM sop_runs WHERE id=?').get(scope.runId) as {data:string};
        const data=JSON.parse(row.data),current=data[scope.step]??{};
        data[scope.step]={...current,...validated.values};
        const next=JSON.stringify(data),revision=input.expected_revision+1;
        if(!Number.isSafeInteger(revision))throw new SopWriteError(409,'run_revision_conflict');
        const changed=db.prepare('UPDATE sop_run_revisions SET revision=?,data_sha256=? WHERE run_id=? AND revision=? AND data_sha256=?').run(revision,hash(next),scope.runId,input.expected_revision,hash(row.data));
        if(changed.changes!==1)throw new SopWriteError(409,'run_revision_conflict');
        if(db.prepare("UPDATE sop_runs SET data=? WHERE id=? AND status='running'").run(next,scope.runId).changes!==1)return deny();
        db.exec('COMMIT');return {ok:true,revision};
      } catch(error) { db.exec('ROLLBACK');throw error; }
    }
  };
}
