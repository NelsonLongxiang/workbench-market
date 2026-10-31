/** Default-off real Runner wiring, stage 1: authorized read-only shell only. */
import type express from 'express';
import type {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {resolve,relative,sep,join} from 'node:path';
import {createSopRunAccess,SopWriteError} from './sop-run-access.ts';
import {renderReadonlySopPreview} from './sop-readonly-channel.ts';
import {surfaceOf} from './surfaces.ts';
import {trustedOdooOrigins} from './odoo-session.ts';
export function sopRunnerConfig(env:NodeJS.ProcessEnv) {
  const mode=env.WM_SOP_CHANNEL_MODE??'off';if(mode==='off')return null;
  if(mode!=='readonly')throw Error('WM_SOP_CHANNEL_MODE supports only off/readonly in this stage');
  const marketOrigin=env.WM_SOP_CHANNEL_MARKET_ORIGIN??'',odooOrigin=env.WM_SOP_CHANNEL_ODOO_ORIGIN??'';
  for(const value of [marketOrigin,odooOrigin]){const u=new URL(value);if(u.origin!==value||!['http:','https:'].includes(u.protocol))throw Error('Explicit SOP channel origins required');}
  if(!trustedOdooOrigins().origins.has(odooOrigin))throw Error('SOP identity origin must be explicitly trusted');
  const targets=JSON.parse(env.WM_SOP_CHANNEL_TARGETS??'[]') as {slug:string;targetId:number}[];
  if(!Array.isArray(targets)||!targets.length||targets.length>256)throw Error('Explicit SOP target allowlist required');
  const slugs=new Set(),ids=new Set();
  for(const t of targets){if(!t||Object.keys(t).sort().join(',')!=='slug,targetId'||typeof t.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(t.slug)||!Number.isSafeInteger(t.targetId)||t.targetId<1||slugs.has(t.slug)||ids.has(t.targetId))throw Error('Invalid/duplicate SOP target');slugs.add(t.slug);ids.add(t.targetId);}
  return {mode,marketOrigin,odooOrigin,targets};
}
/** Fixed version raw YAML only. No active fallback, symlink/junction, token injection or cold IO. */
export function readFrozenSopYaml(appsRoot:string,slug:string,version:number) {
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)||!Number.isSafeInteger(version)||version<1)throw Error('Invalid SOP version pin');
  const root=resolve(appsRoot);let file=root;
  if(lstatSync(root).isSymbolicLink())throw Error('SOP root link rejected');
  for(const segment of [slug,'v'+version,'sop.yaml']){file=join(file,segment);if(lstatSync(file).isSymbolicLink())throw Error('SOP source link rejected');}
  const realRoot=realpathSync(root),realFile=realpathSync(file),rel=relative(realRoot,realFile);
  if(!rel||rel==='..'||rel.startsWith('..'+sep))throw Error('SOP source escaped root');
  const fd=openSync(realFile,'r');try{const before=fstatSync(fd);if(!before.isFile()||before.size>1024*1024)throw Error('SOP source oversized');
    const bytes=Buffer.alloc(before.size+1);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
    const after=fstatSync(fd);if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('SOP source changed');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,offset));
  }finally{closeSync(fd);}
}
export function createSopRunnerWiring(config:NonNullable<ReturnType<typeof sopRunnerConfig>>,db:DatabaseSync,appsRoot:string,getSurface:typeof surfaceOf=surfaceOf) {
  const access=createSopRunAccess({db,odooOrigin:config.odooOrigin,marketOrigin:config.marketOrigin,frozenYaml:(slug,version)=>readFrozenSopYaml(appsRoot,slug,version)});
  const bySlug=new Map(config.targets.map(t=>[t.slug,t.targetId])),authority=new URL(config.marketOrigin).host;
  const handler:express.RequestHandler=(req,res,next)=>{
    const portal=/^[/]go[/]([0-9]+)(?:[/]|[?]|$)/i.exec(req.url??'');
    if(portal&&config.targets.some(t=>t.targetId===Number(portal[1])))return void res.status(403).set('Cache-Control','no-store').json({error:'explicit_authorized_sop_run_required'});
    const match=/^[/]sop[/]([^/]+)(?:[/](.*))?$/.exec(req.path??'');
    if(!match||!bySlug.has(match[1]))return next();
    // Selected target is terminal, including attachments; no legacy HTML or token fallback.
    void(async()=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
      const count=(name:string)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
      if(getSurface(req)!=='market'||count('host')!==1||req.headers.host!==authority||!req.url.startsWith('/'))return void res.status(404).end();
      if(req.headers.origin!==undefined&&(count('origin')!==1||req.headers.origin!==config.marketOrigin))return void res.status(403).json({error:'sop_shell_origin_denied'});
      if(req.method!=='GET'&&req.method!=='HEAD')return void res.status(405).end();
      if(match[2])return void res.status(404).end();
      const query=new URL(req.url,config.marketOrigin).searchParams;
      if(query.getAll('run').length!==1||query.getAll('step').length!==1||[...query.keys()].some(k=>!['run','step'].includes(k))||!/^[0-9]+$/.test(query.get('run')??''))return void res.status(400).json({error:'explicit_run_and_step_required'});
      const runId=Number(query.get('run')),step=query.get('step')!;
      const meta=db.prepare('SELECT sop_slug FROM sop_runs WHERE id=?').get(runId) as {sop_slug:string}|undefined;
      if(!meta||meta.sop_slug!==match[1])return void res.status(403).json({error:'sop_run_access_denied'});
      try{const opened=await access.open(String(req.headers.cookie??''),{targetId:bySlug.get(match[1])!,runId,step});
        res.set('X-App-Version','v'+opened.run.version).status(200).type('html').send(renderReadonlySopPreview(opened.preview));
      }catch(error){res.status(error instanceof SopWriteError?error.status:503).json({error:error instanceof SopWriteError?error.code:'sop_readonly_unavailable'});}
    })().catch(next);
  };
  return {handler}; // No public ACL binder or generic capabilities exposed by this wiring.
}
