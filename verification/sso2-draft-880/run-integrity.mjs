// Owned runner ledger; not a product audit service. No waiting for arbitrary detached work.
import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function createRunIntegrity(runId,files){
 if(!runId)throw new Error('run_id required');
 const events=[];let phase='EXECUTING',reportSha=null;
 const save=()=>writeFileSync(files.state,JSON.stringify({run_id:runId,phase,report_sha256:reportSha,valid:events.length===0,event_count:events.length,limitation:'only callbacks reaching this live runner are observed; detached work after process exit cannot be certified complete'},null,2));
 writeFileSync(files.events,'');save();
 return {
  record(event){if(!event.probe_id)throw new Error('late event missing probe_id');const row=Object.freeze({...event,run_id:runId,phase,invalidates_report:phase==='FINALIZED'});events.push(row);appendFileSync(files.events,JSON.stringify(row)+String.fromCharCode(10));if(phase==='FINALIZED')phase='INVALIDATED';save();},
  snapshot(){return structuredClone({run_id:runId,phase,valid:events.length===0,integrity_events:events});},
  finalize(reportBytes){if(phase!=='EXECUTING')throw new Error('run already finalized');reportSha=createHash('sha256').update(reportBytes).digest('hex');phase=events.length?'INVALIDATED':'FINALIZED';save();return this.snapshot();},
 };
}
export function loadRunIntegrity(report,statePath,eventsPath){
 if(!existsSync(statePath)||!existsSync(eventsPath))throw new Error('run integrity sidecars missing');
 const state=JSON.parse(readFileSync(statePath,'utf8'));
 if(state.run_id!==report.run_id)throw new Error('run integrity identity mismatch');
 const events=readFileSync(eventsPath,'utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
 if(events.some(e=>e.run_id!==report.run_id))throw new Error('cross-run integrity event');
 if(state.event_count!==events.length)throw new Error('integrity event count mismatch');
 return {...report,integrity_events:[...(report.integrity_events??[]),...events],integrity_state:state};
}
