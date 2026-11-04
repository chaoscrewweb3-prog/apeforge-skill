import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {publicAddress,publicJSON,publicURL} from '../scripts/forge-peer-transport.mjs';
import {peerDirectory,prepareBinding} from '../scripts/forge-peer-discovery.mjs';
import {createPeer,keyId,sign,makeRequest,verifyResponse} from '../scripts/forge-peer-engine.mjs';
import {prepare} from '../scripts/forge-mcp.mjs';

const base=JSON.parse(readFileSync(new URL('../application.example.json',import.meta.url)));
const now=Date.parse('2026-11-04T12:00:00Z');
function fixture({expiry=now+3600000}={}){
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const claim={schema:'forge-peer-binding-v1',agentId:'g123',profileRevision:1,bindingRevision:1,sourceIssue:'https://github.com/chaoscrewweb3-prog/apeforge-skill/issues/12',cardUrl:'https://peer.apeforge.fun/card.json',endpoint:'https://peer.apeforge.fun/rpc',protocolVersion:'1.0',keyId:keyId(publicKey),publicKey,acceptInbound:true,revoked:false,expiresAt:new Date(expiry).toISOString()};
 const peer=createPeer({binding:claim,privateKey:keys.privateKey,clock:()=>now});
 const issue={id:123,number:12,html_url:claim.sourceIssue,user:{id:44,login:'fixture-owner'},state:'open',body:prepare(base).issueBody};
 const comments=[{user:{id:44},body:prepareBinding(claim,keys.privateKey,{clock:()=>now}).commentBody}];
 let proofChange=x=>x,commentPages=null;const calls=[];
 const transport=async(url)=>{calls.push(url);if(url.includes('/agents/g123'))return{value:{id:'g123',revision:1,source:{type:'github-public-application',url:claim.sourceIssue,author:'fixture-owner'},profile:base}};
 if(url.includes('/issues/12/comments'))return{value:commentPages?commentPages[Number(new URL(url).searchParams.get('page'))-1]:comments,headers:{}};
 if(url.includes('/issues/12'))return{value:issue};
 if(url===claim.cardUrl)return{value:peer.card()};
 if(url.includes('/forge-peer/proof'))return{value:proofChange(peer.proof(new URL(url).searchParams.get('nonce')))};
 throw Error('unexpected URL '+url);};
 return{claim,keys,peer,issue,comments,calls,transport,setProofChange:x=>proofChange=x,setPages:x=>commentPages=x};
}
for(const address of ['127.0.0.1','10.3.2.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','2001:db8::1','2002:7f00:1::','3fff::1'])test('reject nonpublic '+address,()=>assert.equal(publicAddress(address),false));
for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])test('allow public '+address,()=>assert.equal(publicAddress(address),true));
test('reject hostile URL forms',()=>{for(const url of ['http://peer.apeforge.fun','https://127.0.0.1','https://[::1]','https://user:pass@peer.apeforge.fun','https://peer.apeforge.fun:8443','https://peer.apeforge.fun/#x','https://local','https://one.local'])assert.throws(()=>publicURL(url));});
test('reject any private DNS answer before network',async()=>assert.rejects(publicJSON('https://peer.apeforge.fun',{resolver:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}),/non_public_dns/));
test('reject credentials before DNS',async()=>assert.rejects(publicJSON('https://peer.apeforge.fun',{headers:{Authorization:'not-a-real-secret'},resolver:()=>{throw Error('must not resolve');}}),/credential_header_rejected/));
test('production request pins validated DNS and preserves TLS hostname',async()=>{
 const original=https.request;let opts;https.request=(url,options,callback)=>{opts=options;const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');});return req;};
 try{assert.deepEqual((await publicJSON('https://peer.apeforge.fun',{resolver:async()=>[{address:'8.8.8.8',family:4}]})).value,{});assert.equal(opts.servername,'peer.apeforge.fun');assert.equal(opts.rejectUnauthorized,true);assert.equal(opts.agent,false);let captured;opts.lookup('peer.apeforge.fun',{},(...args)=>captured=args);assert.deepEqual(captured,[null,'8.8.8.8',4]);}finally{https.request=original;}
});
test('normal hour-lived binding actual engine endpoint proof succeeds',async()=>{const f=fixture();const result=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(result.ok,true,JSON.stringify(result));});
test('reject signed proof missing expiry',async()=>{const f=fixture({expiry:now+60000});f.setProofChange(p=>{delete p.payload.expiresAt;p.signature=sign(f.keys.privateKey,p.payload);return p;});const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.ok,false);});
test('reject signed malformed proof expiry',async()=>{const f=fixture({expiry:now+60000});f.setProofChange(p=>{p.payload.expiresAt='nonsense';p.signature=sign(f.keys.privateKey,p.payload);return p;});const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.ok,false);});
test('wrong numeric GitHub author cannot enroll',async()=>{const f=fixture({expiry:now+60000});f.comments[0].user.id=45;const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.ok,false);assert.equal(r.code,'peer_not_enrolled');});
test('canonical application body mutation rejected',async()=>{const f=fixture();f.issue.body+=' ';const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.code,'profile_source_mismatch');});
test('three full pages cannot establish latest claim',async()=>{const f=fixture();f.setPages(Array.from({length:3},()=>Array.from({length:100},()=>({user:{id:99},body:'untrusted irrelevant comment'}))));const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.code,'source_pagination_incomplete');});
test('proof card hash mismatch rejected',async()=>{const f=fixture({expiry:now+60000});f.setProofChange(p=>{p.payload.cardSha256='f'.repeat(64);p.signature=sign(f.keys.privateKey,p.payload);return p;});const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.code,'endpoint_control_not_proven');});
test('proof session mismatch rejected',async()=>{const f=fixture({expiry:now+60000});f.setProofChange(p=>{p.payload.sessionId='f'.repeat(32);p.signature=sign(f.keys.privateKey,p.payload);return p;});const r=await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123');assert.equal(r.code,'endpoint_control_not_proven');});
test('new key requires consent on every attempt, never overwrites old key pin',async()=>{
 const f=fixture({expiry:now+60000}),directory=peerDirectory({transport:f.transport,clock:()=>now});assert.equal((await directory.discover('g123')).ok,true);
 const newer=generateKeyPairSync('ed25519'),publicKey=newer.publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const replacement={...f.claim,bindingRevision:2,publicKey,keyId:keyId(publicKey)};f.comments.push({user:{id:44},body:prepareBinding(replacement,newer.privateKey,{clock:()=>now}).commentBody});
 for(let n=0;n<2;n++)assert.equal((await directory.discover('g123')).code,'key_rotation_requires_new_consent');
 assert.equal(directory.pins.get('g123').keyId,f.claim.keyId);
});
test('signed latest revocation blocks fallback and pins rollback',async()=>{
 const f=fixture({expiry:now+60000}),directory=peerDirectory({transport:f.transport,clock:()=>now});assert.equal((await directory.discover('g123')).ok,true);
 const revoked={...f.claim,bindingRevision:2,revoked:true};f.comments.push({user:{id:44},body:prepareBinding(revoked,f.keys.privateKey,{clock:()=>now}).commentBody});
 assert.equal((await directory.discover('g123')).code,'peer_revoked_or_not_opted_in');f.comments.pop();assert.equal((await directory.discover('g123')).code,'binding_rollback_or_edit');
});
test('latest expired claim blocks fallback',async()=>{
 const f=fixture({expiry:now+60000}),directory=peerDirectory({transport:f.transport,clock:()=>now});
 const expired={...f.claim,bindingRevision:2,expiresAt:new Date(now-1000).toISOString()};f.comments.push({user:{id:44},body:prepareBinding(expired,f.keys.privateKey,{clock:()=>now-60000}).commentBody});assert.equal((await directory.discover('g123')).code,'peer_binding_expired');
});
test('conflicting top revision fails closed',async()=>{
 const f=fixture({expiry:now+60000}),other={...f.claim,acceptInbound:false};f.comments.push({user:{id:44},body:prepareBinding(other,f.keys.privateKey,{clock:()=>now}).commentBody});assert.equal((await peerDirectory({transport:f.transport,clock:()=>now}).discover('g123')).code,'binding_revision_conflict');
});
test('authenticated A2A1.0 error details use typed array and signed receipts',()=>{
 const f=fixture(),sender={...f.claim,agentId:'g456'},recipient={...f.claim,sessionId:f.peer.sessionId};f.peer.grant(sender);
 const request=makeRequest(sender,f.keys.privateKey,recipient,{jsonrpc:'2.0',id:'unknown-task',method:'GetTask',params:{id:'does-not-exist'}},{clock:()=>now});
 const response=f.peer.dispatch(request),error=JSON.parse(response.body).error;assert.equal(error.code,-32001);assert.equal(verifyResponse(sender,recipient,request,response),true);
 if(error.data!==undefined){assert.equal(Array.isArray(error.data),true,'A2A1.0 error.data must be typed array, not generic JSONRPC object');assert.ok(error.data.every(item=>typeof item['@type']==='string'));}
});
test('signed unsupported protocol has exact version code and signed response',()=>{
 const f=fixture(),sender={...f.claim,agentId:'g456'},recipient={...f.claim,sessionId:f.peer.sessionId};f.peer.grant(sender);
 const request=makeRequest(sender,f.keys.privateKey,recipient,{jsonrpc:'2.0',id:'version-test',method:'GetTask',params:{id:'unknown'}},{clock:()=>now});request.headers['a2a-version']='9.9';
 const response=f.peer.dispatch(request);assert.equal(JSON.parse(response.body).error.code,-32009);assert.equal(verifyResponse(sender,recipient,request,response),true);
});
