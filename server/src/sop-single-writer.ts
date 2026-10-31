/** Process-scoped legacy fence. Inactive unless explicitly configured by default-off Runner wiring. */
import type {DatabaseSync} from 'node:sqlite';
import {HttpError} from './errors.ts';
let enabled=false;
export function configureSopSingleWriter(active:boolean){enabled=active;}
export function channelOwnsRun(db:DatabaseSync,id:number):boolean {
 if(!enabled)return false;
 return !!db.prepare('SELECT 1 FROM sop_run_access WHERE run_id=?').get(id);
}
export function assertLegacySopWrite(db:DatabaseSync,id:number){if(channelOwnsRun(db,id))throw new HttpError(409,'sop_channel_single_writer');}
