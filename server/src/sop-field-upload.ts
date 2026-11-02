/** Unmounted upload endpoint: inert SQLite blobs, no inline/download/execute route. */
import express from 'express';
import multer from 'multer';
import {surfaceOf} from './surfaces.ts';
import {SopWriteError,type createSopRunAccess} from './sop-run-access.ts';
export const SOP_FIELD_UPLOAD_PATH='/api/sop/field-channel/upload';
export function createSopFieldUploadRouter(access:ReturnType<typeof createSopRunAccess>,marketOrigin:string,getSurface:typeof surfaceOf=surfaceOf) {
  const origin=new URL(marketOrigin);if(origin.origin!==marketOrigin||!['http:','https:'].includes(origin.protocol))throw Error('Invalid trusted shell origin');
  const router=express.Router(),parse=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:1,fields:1,fieldSize:4096,parts:2}}).single('file');
  router.post(SOP_FIELD_UPLOAD_PATH,(req,res,next)=>{res.set('Cache-Control','no-store');const count=(name:string)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
    if(getSurface(req)!=='market'||['host','origin','cookie','content-type','x-sop-upload-capability'].some(k=>count(k)!==1)||!req.headers.cookie||!req.headers['x-sop-upload-capability']||req.headers.host!==origin.host||req.headers.origin!==marketOrigin||!req.headers['content-type']?.startsWith('multipart/form-data;'))return void res.status(403).json({error:'sop_upload_forbidden'});next();
  },parse,(req,res)=>{void(async()=>{try{
    if(!req.file||!req.body||Object.keys(req.body).join(',')!=='binding')throw new SopWriteError(400,'invalid_upload');
    let b;try{b=JSON.parse(req.body.binding);}catch{throw new SopWriteError(400,'invalid_upload');}
    if(!b||Array.isArray(b)||Object.keys(b).sort().join(',')!=='field,request_id,runId,step,targetId,version')throw new SopWriteError(400,'invalid_upload');
    res.json(await access.upload(String(req.headers.cookie),String(req.headers['x-sop-upload-capability']),{runId:b.runId,targetId:b.targetId,step:b.step},{version:b.version,field:b.field,request_id:b.request_id,mime:req.file.mimetype,name:req.file.originalname,bytes:req.file.buffer}));
  }catch(error){res.status(error instanceof SopWriteError?error.status:500).json({error:error instanceof SopWriteError?error.code:'sop_upload_failed'});}})();});
  router.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error?.code==='LIMIT_FILE_SIZE'?413:400).json({error:error?.code==='LIMIT_FILE_SIZE'?'upload_too_large':'invalid_upload'}));
  return router;
}
