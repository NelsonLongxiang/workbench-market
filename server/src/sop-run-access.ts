/** Draft SOP authorization stage a. Explicit factory only: no index import, route or production migration.
 * Legacy started_by / A2A node labels NEVER confer a human permission. */
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {resolveOdooViewer} from './lifecycle.ts';
import {trustedOdooOrigins} from './odoo-session.ts';
import {assembleReadonlySop,type FrozenSopSource} from './sop-readonly-assembly.ts';
type ViewerResult = Awaited<ReturnType<typeof resolveOdooViewer>>;
type Deps = {db:DatabaseSync; odooOrigin:string; marketOrigin:string; frozenYaml:(slug:string,version:number)=>string; viewer?:typeof resolveOdooViewer; now?:()=>number};
type Binding = {run_id:number; target_id:number; sop_version:number; owner_subject:string; assignee_subject:string; acl_revision:number; manifest_sha256:string; revoked:number};
type Scope = {targetId:number;runId:number;step:string};
type Record = Scope & {version:number;subject:string;session:string;epoch:number;aclRevision:number;expires:number};
const positive = (n:number) => Number.isSafeInteger(n)&&n>0;
const deny = () => { throw Error('SOP run access denied'); };
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export function createSopRunAccess(deps:Deps) {
  const {db}=deps, now=deps.now??Date.now, viewer=deps.viewer??resolveOdooViewer;
  const origin=new URL(deps.odooOrigin);
  if(origin.origin!==deps.odooOrigin || !trustedOdooOrigins().origins.has(deps.odooOrigin)) throw Error('Explicit trusted Odoo origin required');
  // Only callers constructing this unmounted service initialize this table. Existing app startup unchanged.
  db.exec('CREATE TABLE IF NOT EXISTS sop_run_access (run_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL, sop_version INTEGER NOT NULL, owner_subject TEXT NOT NULL, assignee_subject TEXT NOT NULL, acl_revision INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
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
  function authorized(scope:Scope,subject:string) {
    const r=metadata(scope.runId,scope.targetId),b=binding(scope.runId);
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(scope.step)||!allowed(b,subject,scope.targetId)||b!.sop_version!==r.sop_version)return deny();
    return {r,b:b!};
  }
  function project(scope:Scope,subject:string) {
    const {r,b}=authorized(scope,subject);
    const yaml=deps.frozenYaml(r.sop_slug,r.sop_version);
    if(hash(yaml)!==b.manifest_sha256)return deny();
    // Values are not selected until current viewer AND controlled run binding pass.
    const row=db.prepare('SELECT data FROM sop_runs WHERE id=?').get(r.id) as {data:string};
    const source:FrozenSopSource={targetId:scope.targetId,slug:r.sop_slug,version:r.sop_version,yaml};
    const run={id:r.id,sop_slug:r.sop_slug,sop_version:r.sop_version,status:r.status,data:JSON.parse(row.data)};
    const preview=assembleReadonlySop(source,run,scope.step,0,deps.marketOrigin);
    // Projection has no owner/login/uid/session/receipt or upload capability. Token is separate, shell only.
    return {preview,run:{id:r.id,targetId:scope.targetId,version:r.sop_version,step:scope.step,authorized:true as const},aclRevision:b.acl_revision};
  }
  return {
    /** Server-only controlled registration. Never expose through MCP or accept started_by as subject.
     * caller supplies Odoo sub+uid derived from trusted records; no legacy backfill/guess. */
    bindTrustedRun(input:{runId:number;targetId:number;ownerSubject:string;assigneeSubject?:string;manifestSha256:string}) {
      const run=metadata(input.runId,input.targetId);
      const valid=(s:string)=>typeof s==='string'&&/^user:[^\s:]+:[1-9][0-9]*$/.test(s)&&s.length<=256;
      if(!valid(input.ownerSubject)||input.assigneeSubject!==undefined&&!valid(input.assigneeSubject)||!/^[a-f0-9]{64}$/.test(input.manifestSha256))return deny();
      const revision=(binding(input.runId)?.acl_revision??0)+1;
      db.prepare('INSERT INTO sop_run_access(run_id,target_id,sop_version,owner_subject,assignee_subject,acl_revision,manifest_sha256,revoked) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(run_id) DO UPDATE SET target_id=excluded.target_id,sop_version=excluded.sop_version,owner_subject=excluded.owner_subject,assignee_subject=excluded.assignee_subject,acl_revision=excluded.acl_revision,manifest_sha256=excluded.manifest_sha256,revoked=0').run(input.runId,input.targetId,run.sop_version,input.ownerSubject,input.assigneeSubject??'',revision,input.manifestSha256);
    },
    revokeRun(runId:number){db.prepare('UPDATE sop_run_access SET revoked=1,acl_revision=acl_revision+1 WHERE run_id=?').run(runId);},
    revokeSession(cookie:string){revokeKey(cookieKey(cookie).key);},
    async open(cookie:string,scope:Scope) {
      scope={...scope};const who=await identify(cookie);sweep();if(!stillCurrent(who)||records.size>=4096)return deny();
      const projection=project(scope,who.subject),id=randomBytes(32).toString('base64url'),expires=now()+300_000;
      records.set(id,{...scope,version:projection.run.version,subject:who.subject,session:who.key,epoch:who.epoch,aclRevision:projection.aclRevision,expires});
      return {capability:id+'.'+mac(id),expires,...projection};
    },
    async read(cookie:string,capability:string,scope:Scope) {
      scope={...scope};sweep();const match=typeof capability==='string'&&/^([A-Za-z0-9_-]{43})[.]([A-Za-z0-9_-]{43})$/.exec(capability);
      if(!match||!timingSafeEqual(Buffer.from(match[2]),Buffer.from(mac(match[1]))))return deny();
      const record=records.get(match[1]);if(!record||record.expires<=now()||record.targetId!==scope.targetId||record.runId!==scope.runId||record.step!==scope.step)return deny();
      const who=await identify(cookie);
      if(!stillCurrent(who)||!records.has(match[1])||record.expires<=now()||record.session!==who.key||record.subject!==who.subject||record.epoch!==who.epoch||record.aclRevision!==binding(scope.runId)?.acl_revision)return deny();
      if(metadata(scope.runId,scope.targetId).sop_version!==record.version)return deny();
      return project(scope,who.subject);
    }
  };
}
