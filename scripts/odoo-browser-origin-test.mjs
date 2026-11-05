/** Browser-only login address policy tests. Usage: node scripts/odoo-browser-origin-test.mjs */
import assert from 'node:assert/strict';
import { odooBrowserOrigin, browserLoginOrigin } from '../server/src/odoo-browser-origin.ts';
const keep={...process.env};let checks=0;const test=(label,fn)=>{fn();checks++;console.log('PASS '+label);};
try{
 process.env.LC_ODOO_URL='http://odoo.internal:8069';process.env.WM_ODOO_ORIGINS='http://192.0.2.88:8069';delete process.env.WM_ODOO_BROWSER_URL;
 test('unset browser URL preserves legacy behavior',()=>{assert.equal(odooBrowserOrigin(),null);assert.equal(browserLoginOrigin('http://odoo.internal:8069','192.0.2.88:9800',null),'http://odoo.internal:8069');});
 process.env.WM_ODOO_BROWSER_URL='http://192.0.2.88:8069';const cfg=odooBrowserOrigin();
 test('explicit trusted browser origin remains separate from fixed backend',()=>{assert.equal(cfg.origin,'http://192.0.2.88:8069');assert.equal(cfg.upstream,'http://odoo.internal:8069');assert.equal(process.env.LC_ODOO_URL,cfg.upstream);});
 test('matching host across ports redirects only login to browser origin',()=>assert.equal(browserLoginOrigin(cfg.upstream,'192.0.2.88:9800',cfg),cfg.origin));
 test('other market host refuses host-only session mismatch',()=>assert.equal(browserLoginOrigin(cfg.upstream,'market.example:9800',cfg),null));
 test('unrelated trusted Odoo card keeps its own browser destination',()=>assert.equal(browserLoginOrigin('http://other-odoo:8069','192.0.2.88:9800',cfg),'http://other-odoo:8069'));
 for(const value of ['', 'http://user:password@192.0.2.88:8069','http://192.0.2.88:8069/path','http://192.0.2.88:8069/?q=1','http://192.0.2.88:8069/#x','https://untrusted.invalid','ftp://192.0.2.88:8069','http://192.0.2.88:8069/../','http://192.0.2.88:8069?','http://192.0.2.88:8069#',' http://192.0.2.88:8069'])test('unsafe browser origin refuses: '+(value.includes('@')?'userinfo':value),()=>{process.env.WM_ODOO_BROWSER_URL=value;assert.throws(()=>odooBrowserOrigin(),/WM_ODOO_BROWSER_URL/);});
 process.env.WM_ODOO_BROWSER_URL='http://192.0.2.88:8069';delete process.env.WM_ODOO_ORIGINS;
 test('configured browser endpoint never grants itself trust',()=>assert.throws(()=>odooBrowserOrigin(),/WM_ODOO_BROWSER_URL/));
 console.log(JSON.stringify({pass:true,checks,production_requests:0}));
}finally{for(const k of ['WM_ODOO_BROWSER_URL','WM_ODOO_ORIGINS','LC_ODOO_URL']){if(keep[k]===undefined)delete process.env[k];else process.env[k]=keep[k];}}
