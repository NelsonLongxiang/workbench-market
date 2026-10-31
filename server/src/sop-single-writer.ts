/** Process-scoped legacy fence. Inactive unless explicitly configured by default-off Runner wiring. */
import type {DatabaseSync} from 'node:sqlite';
import {HttpError} from './errors.ts';
let enabled=false;
export function configureSopSingleWriter(active:boolean){enabled=active;}
export function channelOwnsRun(db:DatabaseSync,id:number):boolean {
 if(!enabled)return false;
 return !!db.prepare('SELECT 1 FROM sop_run_access WHERE run_id=?').get(id);
}
export function legacyVisibleRuns<T extends {id?:unknown;run_id?:unknown}>(db:DatabaseSync,rows:T[]):T[]{if(!enabled)return rows;return rows.filter(row=>{const id=Number(row.run_id??row.id);return Number.isSafeInteger(id)&&!channelOwnsRun(db,id);});}
export function assertLegacySopWrite(db:DatabaseSync,id:number){if(channelOwnsRun(db,id))throw new HttpError(409,'sop_channel_single_writer');}
