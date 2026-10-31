import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {portalCallChainPresent,readPortalCallChainFact,PORTAL_CALL_CHAIN_FACT} from './portal-call-chain-fact.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const page=readFileSync(join(root,'web/src/pages/UseWorkbench.tsx'),'utf8').replaceAll('\r\n','\n'),frame=readFileSync(join(root,'web/src/components/GoFrame.tsx'),'utf8').replaceAll('\r\n','\n');
let passed=0;const check=(name,f)=>{f();passed++;console.log('PASS '+name)};
const call='<GoFrame wid={w.id} name={w.name} frameKey={frameKey} className="wm-use-frame" />';
const route='const src = '+String.fromCharCode(96)+'/go/'+String.fromCharCode(36)+'{wid}/'+String.fromCharCode(96)+';';
assert.ok(page.includes(call));assert.ok(frame.includes(route));
const variants=[
 ['raw URL iframe',page.replace(call,'<iframe src={w.url} />'),frame,0],
 ['remove component call',page.replace(call,'<div />'),frame,0],
 ['component bypasses portal',page,frame.replace(route,'const src = "https://upstream.invalid/";'),0],
 ['comments cannot replace call',page.replace(call,'<div />')+'\n// '+call,frame,0],
 ['unused template cannot replace src',page,frame.replace(route,'const src = "raw";')+'\n// '+route,0],
 ['component imported elsewhere',page.replace('../components/GoFrame','../components/Other'),frame,0],
 ['wrong target id',page.replace('wid={w.id}','wid={7}'),frame,0],
 ['unused component JSX',page.replace(call,'<div />')+'\nconst unused = ('+call+');',frame,0],
 ['iframe not bound to portal src',page,frame.replace('src={src}','src={"raw"}'),0],
 ['spread can override wid',page.replace('wid={w.id}','wid={w.id} {...other}'),frame,0],
 ['nested shadowed src',page,frame.replace('return <iframe','{ const src="https://untrusted.example"; return <iframe').replace('fullscreen" />;','fullscreen" />; }'),0],
 ['unreachable iframe after early return',page,frame.replace('return <iframe','return null; return <iframe'),0],
 ['unreachable page call after early return',page.replace('  return (\n    <div className="wm-use-wrap">','  return null; return (\n    <div className="wm-use-wrap">'),frame,0],
 ['page false conditional JSX',page.replace(call,'{false && '+call+'}'),frame,0],
 ['page zero ternary JSX',page.replace(call,'{0 ? '+call+' : null}'),frame,0],
 ['frame false conditional JSX',page,frame.replace('return <iframe','return <>{false && <iframe').replace('fullscreen" />;','fullscreen" />}</>;'),0],
 ['frame zero ternary JSX',page,frame.replace('return <iframe','return <>{0 ? <iframe').replace('fullscreen" />;','fullscreen" /> : null}</>;'),0],
 ['iframe srcDoc overrides URL',page,frame.replace('src={src}','src={src} srcDoc="different content"'),0],
 ['iframe lowercase srcdoc',page,frame.replace('src={src}','src={src} srcdoc="different content"'),0],
 ['wid redeclared with var',page,frame.replace(route,'var wid = 999; '+route),0],
 ['wid assigned in initializer',page,frame.replace(route,'const ignored = (wid = 999); '+route),0],
 ['wid incremented in initializer',page,frame.replace(route,'const ignored = wid++; '+route),0],
 ['iframe ref mutates src',page,frame.replace('src={src}','src={src} ref={e => { if(e) e.src="https://evil.example/" }}'),0],
 ['iframe unknown attribute',page,frame.replace('src={src}','src={src} data-test="unknown"'),0],
 ['wid destructuring assignment',page,frame.replace(route,'const ignored = ([wid] = [999]); '+route),0],
 ['page local GoFrame shadows import',page.replace('  const w = req.data;','  const GoFrame = (p: any) => <iframe src={"https://evil.example/" + p.wid} />;\n  const w = req.data;'),frame,0],
 ['page parameter shadows import',page.replace('function UseWorkbench()','function UseWorkbench(GoFrame: any)'),frame,0],
 ['page destructuring shadows import',page.replace('  const w = req.data;','  const { GoFrame } = other;\n  const w = req.data;'),frame,0],
 ['page renamed destructuring shadows import',page.replace('  const w = req.data;','  const { other: GoFrame } = supplied;\n  const w = req.data;'),frame,0],
 ['page nested function binding shadows import',page+'\nfunction helper(GoFrame: any) { return null; }',frame,0],
 ['page function declaration shadows import',page.replace('  const w = req.data;','  function GoFrame() { return <iframe src="raw" />; }\n  const w = req.data;'),frame,0],
 ['iframe className effect rejected',page,frame.replace('className={className}','className={(setTimeout(() => {}, 0), className)}'),0],
 ['iframe key effect rejected',page,frame.replace('key={frameKey}','key={(setTimeout(() => {}, 0), frameKey)}'),0],
 ['iframe title effect rejected',page,frame.replace('title={name}','title={(setTimeout(() => {}, 0), name)}'),0],
 ['iframe allow call rejected',page,frame.replace('allow="clipboard-read; clipboard-write; fullscreen"','allow={sideEffect()}'),0],
 ['page name effect rejected',page.replace('name={w.name}','name={(setTimeout(() => {}, 0), w.name)}'),frame,0],
 ['page frameKey effect rejected',page.replace('frameKey={frameKey}','frameKey={(setTimeout(() => {}, 0), frameKey)}'),frame,0],
 ['page className effect rejected',page.replace('className="wm-use-frame"','className={(sideEffect(), "wm-use-frame")}'),frame,0],
 ['documented dataflow limit w rewritten',page.replace('const w = req.data;','const w = { ...req.data!, id: 7 };'),frame,1],
 ['valid current call chain',page,frame,1],
];
for(const [name,p,f,want]of variants)check(name,()=>assert.equal(Number(portalCallChainPresent(p,f)),want));
// Actual generator + actual snapshot extraction on an entirely synthetic fixture.
// Do not run make-submission against the real server/data, or change frozen runs.
const fixture=join(root,'tmp','portal-call-chain-'+Date.now());mkdirSync(fixture,{recursive:true});
for(const f of ['README.md','package.json','pnpm-workspace.yaml','server/package.json','web/package.json','ADMIN-TOKEN-SETUP.md']){mkdirSync(join(fixture,f,'..'),{recursive:true});cpSync(join(root,f),join(fixture,f));}
for(const d of ['scripts','web/src','server/src','design-system'])cpSync(join(root,d),join(fixture,d),{recursive:true});
mkdirSync(join(fixture,'web/dist'),{recursive:true});mkdirSync(join(fixture,'evidence'));cpSync(join(root,'evidence/e2e_test.py'),join(fixture,'evidence/e2e_test.py'));
symlinkSync(join(root,'web/node_modules'),join(fixture,'web/node_modules'),'junction');
symlinkSync(join(root,'node_modules'),join(fixture,'node_modules'),'junction');
mkdirSync(join(fixture,'server/data'));const db=new DatabaseSync(join(fixture,'server/data/workbench-market.db'));db.exec('CREATE TABLE synthetic_probe(id INTEGER PRIMARY KEY)');db.close();
execFileSync(process.execPath,['scripts/gen-verifier.mjs'],{cwd:fixture,stdio:'pipe'});
const material=readFileSync(join(fixture,'verify/material.md'),'utf8').trim().split('\n');const candidates=JSON.parse(readFileSync(join(fixture,'verify/candidates.json'))).candidates;const reviews=JSON.parse(readFileSync(join(fixture,'verify/reviews.json'))).reviews;
check('175 stable numbered material/candidate/review rows',()=>{assert.equal(material.length,175);assert.equal(candidates.length,175);assert.equal(reviews.length,175);for(let i=0;i<175;i++){assert.ok(material[i].startsWith('判据'+(i+1)+'：'));assert.equal(candidates[i].source_clause,material[i]);assert.equal(reviews[i].source_clause,material[i]);assert.equal(candidates[i].anchor.quote,material[i]);}});
check('explicit new material version',()=>{const v=JSON.parse(readFileSync(join(fixture,'verify/material-version.json')));assert.equal(v.version,'v69.3');assert.equal(v.supersedes,'v69.2');assert.deepEqual(v.changed_criteria,[111]);});
const extraction=[];
for(const [name,p,f,want]of variants){
 writeFileSync(join(fixture,'web/src/pages/UseWorkbench.tsx'),p);writeFileSync(join(fixture,'web/src/components/GoFrame.tsx'),f);
 execFileSync(process.execPath,['scripts/make-submission.mjs'],{cwd:fixture,stdio:'pipe'});
 const snapshot=new DatabaseSync(join(fixture,'tmp/verify-snap.sqlite'),{readOnly:true});let row;try{row=snapshot.prepare('SELECT present FROM verifier_text_facts WHERE path=? AND needle=?').get(PORTAL_CALL_CHAIN_FACT.path,PORTAL_CALL_CHAIN_FACT.needle);}finally{snapshot.close()}
 check('real snapshot extraction: '+name,()=>assert.equal(row?.present,want));extraction.push({name,present:row.present});
}
writeFileSync(join(fixture,'result.json'),JSON.stringify({passed,extraction,production_data_used:false,scope:'structural development tests, not full formal verifier PASS'},null,2));
console.log(JSON.stringify({passed,evidence:fixture}));
