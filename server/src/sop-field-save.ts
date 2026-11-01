/** Unmounted SOP field save router. No installation in index or existing Runner. */
import express from 'express';
import {surfaceOf} from './surfaces.ts';
import {SopWriteError,type createSopRunAccess} from './sop-run-access.ts';
export const SOP_FIELD_SAVE_PATH='/api/sop/field-channel/save';
export function createSopFieldSaveRouter(access:ReturnType<typeof createSopRunAccess>,marketOrigin:string, getSurface:typeof surfaceOf=surfaceOf) {
  const origin=new URL(marketOrigin);if(origin.origin!==marketOrigin||!['http:','https:'].includes(origin.protocol))throw Error('Invalid trusted shell origin');
  const router=express.Router();
  router.post(SOP_FIELD_SAVE_PATH,(req,res,next)=>{
    res.set('Cache-Control','no-store');
    const count=(name:string)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
    if(getSurface(req)!=='market'||count('host')!==1||count('origin')!==1||count('x-sop-run-capability')!==1||count('cookie')!==1||count('content-type')!==1||!req.headers.cookie||!req.headers['x-sop-run-capability']||req.headers.host!==origin.host||req.headers.origin!==marketOrigin||req.headers['content-type']?.split(';')[0].trim()!=='application/json')return void res.status(403).json({error:'sop_channel_forbidden'});
    next();
  },express.json({limit:'32kb',strict:true}),(req,res)=>{void(async()=>{
    try {
      const b=req.body;
      if(!b||Array.isArray(b)||Object.keys(b).sort().join(',')!=='expected_revision,runId,step,targetId,values,version')throw new SopWriteError(400,'invalid_save');
      const result=await access.save(String(req.headers.cookie??''),String(req.headers['x-sop-run-capability']??''),{targetId:b.targetId,runId:b.runId,step:b.step},{version:b.version,expected_revision:b.expected_revision,values:b.values});
      res.json(result);
    } catch(error) { res.status(error instanceof SopWriteError?error.status:500).json({error:error instanceof SopWriteError?error.code:'sop_save_failed'}); }
  })();});
  router.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.set('Cache-Control','no-store').status(error?.status===413?413:400).json({error:error?.status===413?'save_body_too_large':'invalid_save_json'});});
  return router;
}
