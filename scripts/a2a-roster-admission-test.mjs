// Isolated 35-check roster regression; usage: node scripts/a2a-roster-admission-test.mjs [--expect-red].
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
mkdirSync(resolve('tmp'), {recursive:true});
const data = mkdtempSync(resolve('tmp/roster-admission-'));
process.env.NODE_ENV='test';process.env.WM_OUTBOUND='off';process.env.DATA_DIR=data;
process.on('exit',()=>rmSync(data,{recursive:true,force:true}));
import {generateKeyPairSync,createPublicKey,createHash,sign} from 'node:crypto';
const {handleInboundReceipt}=await import(pathToFileURL(resolve('server/src/a2a/receipt-inbound.ts')));
const {setPeerCardFetch}=await import('../server/src/a2a/peer-card.ts');
const {db}=await import('../server/src/db.ts');
const {signCard}=await import('@nelsonlongxiang/dsh-open-a2a-net/card');
const {resetRosterOutcomeCounts}=await import('../server/src/a2a/roster-stats.ts');
const now=Date.now(),aud='http://market.synthetic.invalid:9800',zone='dsh';
const key=generateKeyPairSync('ed25519').privateKey,other=generateKeyPairSync('ed25519').privateKey;
const publicKey=createPublicKey(key).export({format:'der',type:'spki'}).toString('base64'),full=createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex'),fp=full.slice(0,8);
let fetches=0;setPeerCardFetch(async()=>{fetches++;return JSON.stringify(signCard({name:'synthetic',session:'host',team:zone,capabilities:{},expiresAt:now+3600000},key))});
let seq=0,checks=0;
function check(v,label){assert(v,label);checks++;console.log('PASS',label)}
const t=new Date(now).toISOString();
function register(root,status='active',pk=publicKey){db.prepare("INSERT INTO a2a_peers (id,root_url,zone,name,public_key,key_fingerprint,status,registered_by,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('test_'+(++seq),root,zone,'synthetic',pk,pk?'sha256:'+full:'',status,'test',t,t)}
function request(root,opts={}){const at=new Date(now+(++seq)).toISOString(),seats=[{seat:'dsh/1234abcd',seatId:'seat-test',team:'dsh/canvas/Test',name:'synthetic',role:'member',online:true,...opts.seatFields},{seat:'foreign/1234abcd',team:'dsh/canvas/Test',role:'member',online:true}];const doc={host:opts.host??fp,at:opts.at??at,seats};const message=`[A2A roster] ${opts.host??fp} ${opts.at??at}\n${JSON.stringify(doc)}`;const body={team:'market/1234abcd',message,caller_session:'dsh-host-synthetic',task_id:'roster-test-'+seq,wait:false,context_id:''};const raw=Buffer.from(JSON.stringify(body)),ts=now+seq,headers={'x-a2a-caller':opts.zone??zone,'x-a2a-caller-url':root,'x-a2a-caller-ts':String(opts.ts??ts),'x-a2a-caller-aud':opts.aud??aud};const digest=createHash('sha256').update(raw).digest('base64url');for(const [tag,name,tail]of [['a2a-origin-claim/2','x-a2a-caller-sig2',[]],['a2a-origin-claim/3','x-a2a-caller-sig3',[digest]]])headers[name]=sign(null,Buffer.from(JSON.stringify([tag,headers['x-a2a-caller'],root,Number(headers['x-a2a-caller-ts']),headers['x-a2a-caller-aud'],'POST','/a2a/direct',...tail])),opts.key??key).toString('base64');headers['x-a2a-body-sha256']=digest;if(opts.noSig3)delete headers['x-a2a-caller-sig3'];if(opts.tamper)body.message+=' altered';return {body,rawBody:opts.tamper?Buffer.from(JSON.stringify(body)):raw,headers,method:'POST',url:'/a2a/direct',originalUrl:'/a2a/direct',socket:{}}}
const call=req=>handleInboundReceipt(req,{audiences:()=>[aud],now:()=>now});
try{
 const active='http://active.synthetic.invalid';register(active);
 const first=await call(request(active));
 if(process.argv.includes('--expect-red')){assert(!first?.body?.roster,'Already fixed unexpectedly');console.log('EXPECTED_RED active pinned peer without historical delivery is refused');} else {
 check(first?.status===200&&first.body.roster==='recorded','active pinned registered peer without delivery accepted');
 check(first.body.seats===1,'foreign-zone seats excluded');
 check(db.prepare('SELECT COUNT(*) n FROM a2a_sent_tasks WHERE peer_root=?').get(active).n===0,'no fabricated delivery history');
 const cases=[['unknown',{},null],['disabled',{},'disabled'],['key_changed',{},'key_changed'],['pending_registration',{},'pending_registration'],['empty-key',{},'active'],['wrong-key',{key:other},'active'],['wrong-zone',{zone:'other'},'active'],['unsigned-body',{noSig3:true},'active'],['tampered-body',{tamper:true},'active'],['expired',{ts:now-600000},'active'],['wrong-audience',{aud:'http://elsewhere.synthetic.invalid'},'active']];
 for(const [name,opts,status]of cases){const root='http://'+name+'.synthetic.invalid';if(status)register(root,status,name==='empty-key'?'':publicKey);const prev=fetches,res=await call(request(root,opts));check(!res?.body?.roster,name+' not admitted');check(db.prepare('SELECT COUNT(*) n FROM a2a_roster_nodes WHERE peer_root=?').get(root).n===0,name+' no roster writes');if(['unknown','disabled','key_changed','pending_registration','empty-key'].includes(name))check(fetches===prev,name+' no card fetch')}
 const replay=request(active);check((await call(replay))?.body?.roster==='recorded','fresh snapshot recorded');check(!(await call(replay))?.body?.roster,'replay rejected');
 check((await call(request(active,{host:'deadbeef'})))?.body?.roster==='not-accepted','host fingerprint spoof rejected');
 check((await call(request(active,{at:'2099-01-01T00:00:00.000Z'})))?.body?.roster==='not-accepted','future reported timestamp rejected');
 const storedSeat = () => db.prepare('SELECT * FROM a2a_roster_node_seats WHERE peer_root = ?').get(active);
 const label = (value, at) => call(request(active, { seatFields: { teamLabel: value }, at }));
 const originalTeam = 'dsh/canvas/Test';
 const named = await label('  研发与协作  ', new Date(now + 1000).toISOString());
 const saved = storedSeat();
 check(named?.body?.roster === 'recorded' && saved.team_label === '研发与协作' && saved.name === 'synthetic' && saved.team === originalTeam,
   '有效显示名只写独立列，保留团队地址和席位名');
 const stale = await label('旧快照', t);
 check(stale?.body?.roster === 'stale' && storedSeat().team_label === '研发与协作', '过期名册不能改写团队显示名');
 const invalid = ['zone/1234abcd', '格式\u202e符', '控制\u0001符', '\u2028文字', '\ufffd', ' '.repeat(3), '\u0301', '🙂'.repeat(65), 12];
 for (const [index, value] of invalid.entries()) {
   const res = await label(value, new Date(now + 1001 + index).toISOString());
   check(res?.body?.roster === 'recorded' && storedSeat().team_label === '', '无效的显示名被丢弃，席位仍收下：' + index);
 }
 const emoji = '🙂'.repeat(64);
 await label(emoji, new Date(now + 1100).toISOString());
 check(storedSeat().team_label === emoji, '显示名长度按 Unicode 码点核对');
 await label(undefined, new Date(now + 1101).toISOString());
 check(storedSeat().team_label === '' && storedSeat().team === originalTeam, '新快照省略显示名会清除旧值，地址不变');
 const legacy='http://legacy.synthetic.invalid';db.prepare("INSERT INTO a2a_sent_tasks(task_id,kind,event_id,delivery_id,peer_root,peer_zone,created_at) VALUES (?,?,?,?,?,?,?)").run('test-legacy','delivery','test-event',0,legacy,zone,t);check((await call(request(legacy)))?.body?.roster==='host-shared','legacy delivered host still accepted, shared fingerprint isolated');
 console.log('ALL_PASS',checks);
 }
}finally{setPeerCardFetch(null);resetRosterOutcomeCounts();db.close()}
