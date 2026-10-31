/** Offline/read-only assembly of a fixed version's raw sop.yaml and an existing run snapshot.
 * No route, DB, credential reader, active-version fallback, or write capability. */
import {parse} from 'yaml';
import type {SopRunRow} from './db.ts';
import {validateReadonlySop, renderReadonlySopPreview, type ReadonlySop} from './sop-readonly-channel.ts';
export type FrozenSopSource = {targetId:number; slug:string; version:number; yaml:string};
type RunSnapshot = Pick<SopRunRow,'id'|'sop_slug'|'sop_version'|'status'> & {data:Record<string,unknown>};
const object = (v:unknown): v is Record<string,any> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v:unknown) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v) && !['constructor','prototype','__proto__'].includes(v);
export function assembleReadonlySop(source:FrozenSopSource, run:RunSnapshot, stepKey:string, revision:number, marketOrigin:string):ReadonlySop {
  if (!source || !/^[a-z0-9][a-z0-9-]*$/.test(source.slug) || typeof source.yaml !== 'string' || Buffer.byteLength(source.yaml)>1024*1024) throw Error('Invalid frozen SOP source');
  if (!run || run.sop_slug !== source.slug || run.sop_version !== source.version || !['running','finished'].includes(run.status) || !object(run.data)) throw Error('Run does not match frozen SOP source');
  // Parse raw frozen bytes, not the legacy parser which drops field metadata.
  const manifest = parse(source.yaml,{maxAliasCount:0});
  if (!object(manifest) || typeof manifest.title !== 'string' || !manifest.title.trim() || !Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length>100) throw Error('Invalid frozen SOP manifest');
  const seen = new Set<string>(); let selected:ReadonlySop|undefined;
  for (const step of manifest.steps) {
    if (!object(step) || !key(step.key) || seen.has(step.key) || typeof step.title !== 'string' || !step.title.trim()) throw Error('Invalid/duplicate frozen SOP step');
    seen.add(step.key);
    if (!Array.isArray(step.fields)) throw Error('Step '+step.key+': explicit reviewed fields required; no runtime HTML inference');
    const fields = step.fields.map((field:any) => {
      if (!object(field) || Object.keys(field).some(k=>!['key','type','required','maxLength','options','maxItems','operations'].includes(k)) || typeof field.required !== 'boolean' || !Array.isArray(field.operations) || field.operations.length!==1 || field.operations[0]!=='read') throw Error('Step '+step.key+': invalid read-only field declaration');
      if (field.type==='text' && (!Number.isSafeInteger(field.maxLength) || field.maxLength<1 || field.maxLength>4096) || field.type==='multi' && (!Number.isSafeInteger(field.maxItems) || field.maxItems<1 || field.maxItems>50) || field.maxItems!==undefined && field.type!=='multi' || field.maxLength!==undefined && field.type!=='text' || field.options!==undefined && field.type!=='multi') throw Error('Step '+step.key+': invalid field bounds');
      return {...field};
    });
    // Validate every step's declaration, not only the selected one. File/write declarations fail closed.
    let config:ReadonlySop;
    try { config = validateReadonlySop({targetId:source.targetId,runId:run.id,version:source.version,step:step.key,revision,marketOrigin,fields,values:{},body:step.body??''}); }
    catch (error) { throw Error('Step '+step.key+': '+(error as Error).message); }
    if (step.key===stepKey) selected=config;
  }
  if (!selected) throw Error('Unknown frozen SOP step');
  const saved = Object.hasOwn(run.data,stepKey) ? run.data[stepKey] : {};
  if (!object(saved)) throw Error('Step '+stepKey+': explicit legacy value migration required');
  selected.values=saved;
  return validateReadonlySop(selected); // only selected step and declared typed values leave the shell
}
export function renderReadonlySopRun(source:FrozenSopSource, run:RunSnapshot, step:string, revision:number, marketOrigin:string):string {
  return renderReadonlySopPreview(assembleReadonlySop(source,run,step,revision,marketOrigin));
}
