#!/usr/bin/env node
/** P0 browser/print fixture: synthetic-only, loopback-only, never touches the market or its production routes.
 * Builds the isolated test entry with the already-installed Vite, then closes its own server and child.
 * Output: tmp/report-template-p0/ (frozen input, PDF, screenshots, raw browser/layout observations).
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { materializeReport } from '../web/src/report-template/p0.ts';
import { pythonBin } from './python-bin.mjs';
import { makeOperatingFixture, makeProductFixture } from './fixtures/report-template-p0.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=join(ROOT,'tmp','report-template-p0');
const DIST=join(OUT,'assets');mkdirSync(OUT,{recursive:true});
const webRequire=createRequire(join(ROOT,'web','package.json'));
const {build}=await import(pathToFileURL(webRequire.resolve('vite')).href);
await build({root:join(ROOT,'web'),configFile:false,publicDir:false,define:{'process.env.NODE_ENV':JSON.stringify('production')},esbuild:{jsx:'automatic'},logLevel:'warn',build:{outDir:DIST,emptyOutDir:true,target:'es2022',lib:{entry:join(ROOT,'web/src/report-template/p0-entry.tsx'),formats:['es'],fileName:'report-p0',cssFileName:'report-p0'},rollupOptions:{output:{inlineDynamicImports:true}}}});
const names=readdirSync(DIST),js=names.find(x=>x.endsWith('.js')),css=names.filter(x=>x.endsWith('.css'));
if(!js||!css.length)throw Error('missing_fixture_bundle');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const compile=f=>materializeReport(f.template,f.bindings,f.views,f.input,f.assets);
const fixture=makeOperatingFixture();const operating=compile(fixture),before=hash(operating);
fixture.views.source.blocks[2].data.rows[0].amount=-999;fixture.input.fields.summary='mutated';
if(hash(operating)!==before)throw Error('frozen_input_mutated');
const reports={operating,products:compile(makeProductFixture()),'next-period':compile(makeOperatingFixture('synthetic-b','2026-11'))};
writeFileSync(join(OUT,'frozen-reports.json'),JSON.stringify(reports,null,2));
const files=new Map(names.map(name=>['/assets/'+name,join(DIST,name)]));
const html=(key)=>'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Report P0 - '+key+'</title>'+css.map(c=>'<link rel="stylesheet" href="/assets/'+c+'">').join('')+'</head><body><div id="root"></div><script>window.__REPORT_P0__='+JSON.stringify(reports[key]).replace(/</g,'\\u003c')+';</script><script type="module" src="/assets/'+js+'"></script></body></html>';
const server=createServer((req,res)=>{const u=new URL(req.url,'http://fixture.invalid');const key=u.pathname.slice(1);if(Object.hasOwn(reports,key)){res.setHeader('content-type','text/html; charset=utf-8');res.end(html(key));return;}const f=files.get(u.pathname);if(f){res.setHeader('content-type',f.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(f));return;}res.writeHead(404).end();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const cfg=join(OUT,'browser.json');writeFileSync(cfg,JSON.stringify({base,out:OUT,hashes:Object.fromEntries(Object.entries(reports).map(([k,v])=>[k,hash(v)]))}));
let child;
try{
 child=spawn(pythonBin(),[join(ROOT,'scripts/report-template-p0-browser.py'),cfg],{stdio:'inherit',cwd:ROOT});
 const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',(c)=>r(c??1));});
 process.exitCode=Number(code);
 if(code===0 && process.argv.includes('--inspect-pdf')){
  child=spawn(pythonBin(),[join(ROOT,'scripts/report-template-p0-pdf.py'),OUT],{stdio:'inherit',cwd:ROOT});
  const pdfCode=await new Promise((r,j)=>{child.once('error',j);child.once('exit',c=>r(c??1));});
  process.exitCode=Number(pdfCode);
 }
}finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();await new Promise(r=>server.close(r));}
