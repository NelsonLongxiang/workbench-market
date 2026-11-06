/** Synthetic snapshot destination guard; never opens a real database. Usage: node scripts/ygl-pg-snapshot-path-test.mjs */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createSnapshot } from './ygl-pg-migrate.mjs';

const tmp=resolve('tmp');mkdirSync(tmp,{recursive:true});if(realpathSync(tmp)!==tmp||lstatSync(tmp).isSymbolicLink())throw Error('test tmp must be a real local directory');
const dir=mkdtempSync(join(tmp,'ygl-snapshot-path-'));
const engine={Native:class { constructor(){throw Error('SYNTHETIC_DATABASE_OPEN_INTERCEPTED')} }};
const cases=['direct','nested','symlink-root','symlink-child','symlink-chain','outside','dangling-output','missing-parent'];let checks=0,failed=0;
try {
 for(const name of cases){
  const area=join(dir,name),home=join(area,'home'),child=join(home,'child'),outside=join(area,'outside'),alias=join(area,'alias'),childAlias=join(area,'child-alias'),chain=join(area,'chain');
  mkdirSync(area);mkdirSync(home);mkdirSync(child);mkdirSync(outside);writeFileSync(join(home,'ygl-trees.db'),'SYNTHETIC_NOT_A_DATABASE');symlinkSync(home,alias,'dir');symlinkSync(child,childAlias,'dir');symlinkSync(alias,chain,'dir');
  let out;switch(name){case 'direct':out=join(home,'backup');break;case 'nested':out=join(child,'backup');break;case 'symlink-root':out=join(alias,'backup');break;case 'symlink-child':out=join(childAlias,'backup');break;case 'symlink-chain':out=join(chain,'backup');break;case 'outside':out=join(outside,'backup');break;case 'dangling-output':out=join(outside,'dangling');symlinkSync(join(area,'missing-target'),out,'dir');break;default:out=join(area,'missing-parent','backup')}
  const before=readdirSync(home).sort().join(',');let error='';try{await createSnapshot(engine,join(home,'ygl-trees.db'),out)}catch(e){error=e.code||e.message}
  const after=readdirSync(home).sort().join(',');let pass;if(name==='outside')pass=error==='SYNTHETIC_DATABASE_OPEN_INTERCEPTED'&&existsSync(out);else if(name==='dangling-output')pass=error==='snapshot_output_exists';else if(name==='missing-parent')pass=error==='snapshot_output_parent_invalid';else pass=error==='snapshot_output_inside_source'&&!existsSync(out);pass=pass&&before===after;
  checks++;if(!pass)failed++;console.log(JSON.stringify({case:name,pass,error,sourceDirectoryUnchanged:before===after}));
 }
 if(process.argv[2]==='--mount-fixture'){
  const [mountedSource,mountedAlias]=process.argv.slice(3);if(!mountedSource?.startsWith('/')||!mountedAlias?.startsWith('/'))throw Error('absolute synthetic mount paths required');
  const target=join(mountedAlias,'snapshot-output'),before=readdirSync(mountedSource).sort().join(',');let error='';try{await createSnapshot(engine,join(mountedSource,'ygl-trees.db'),target)}catch(e){error=e.code||e.message}
  const pass=error==='snapshot_output_inside_source'&&!existsSync(target)&&before===readdirSync(mountedSource).sort().join(',');checks++;if(!pass)failed++;console.log(JSON.stringify({case:'physical-mount-alias',pass,error,sourceDirectoryUnchanged:before===readdirSync(mountedSource).sort().join(',')}));
 }
 console.log(JSON.stringify({checks,failed,production_requests:0,real_database_opens:0}));if(failed)process.exitCode=1;
} finally {
 const actual=realpathSync(dir);assert(actual.startsWith(tmp+sep)&&actual===dir&&!lstatSync(dir).isSymbolicLink());rmSync(dir,{recursive:true,force:true});
}
