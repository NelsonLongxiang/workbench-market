// Negative-group test requires no issued ticket. Positive must use official controlled issuance.
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {startInstance,redact} from './fixtures.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const i=await startInstance(root,{}, {keyless:true});const rows=[];
try{
 if(!i.ready)throw new Error('keyless instance boot failed');
 const db=new DatabaseSync(join(i.dir,'workbench-market.db'),{readOnly:true});let settings;try{settings=db.prepare("SELECT key FROM settings WHERE key LIKE '%admin%' OR key LIKE '%token%'").all();}finally{db.close();}
 const body={username:'keyless-user',password:'fixture-password-880'};
 for(const headers of [{},{'X-Admin-Token':'wrong-test-ticket'}]){const x=await i.request('/api/auth/register',{method:'POST',body,headers});rows.push({case:Object.keys(headers).length?'wrong-ticket':'no-ticket',expected:403,actual:x.status,ok:x.status===403});}
 // Scoped ticket positivity cannot be manufactured. Product/issuance missing is not a green negative control.
 const result={fixture:'keyless-negative',target_sha:'d90f81abca809a48a893544d0bdd4c409be78526',env_admin_token_present:Object.hasOwn(i.env,'ADMIN_TOKEN'),managed_keys_in_fresh_db:settings,listener_pid:i.child.pid,listener_owners:i.listenerOwners,port:i.port,data_dir:i.dir,rows,positive_ticket_status:'NEEDS-MATERIAL until official isolated issuance exists; no token table insertion',requests:i.requests};
 writeFileSync(join(root,'keyless-report.json'),JSON.stringify(redact(result),null,2));console.log(JSON.stringify({negatives:rows,positive:'NEEDS-MATERIAL'}));
}finally{await i.close();}
