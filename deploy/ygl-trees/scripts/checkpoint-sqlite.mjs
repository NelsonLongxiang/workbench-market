#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root=process.argv[2]??'/data';
let files=0;
function walk(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const path=join(dir,ent.name);if(ent.isDirectory())walk(path);else if(ent.isFile()&&/\.(?:db|sqlite)$/.test(ent.name)){const db=new DatabaseSync(path);try{const c=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(!c||Number(c.busy)!==0||Number(c.log)!==Number(c.checkpointed))throw new Error('WAL checkpoint incomplete: '+path+' '+JSON.stringify(c));const check=db.prepare('PRAGMA integrity_check').get();if(check?.integrity_check!=='ok')throw new Error('integrity_check failed: '+path+' '+JSON.stringify(check));files++;}finally{db.close();}}}}
walk(root);
if(files===0)throw new Error('no SQLite databases found; refusing an unverified snapshot');
console.log('PASS checkpoint and integrity_check for '+files+' SQLite databases');
