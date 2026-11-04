import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateApplication } from '../scripts/forge-application-model.mjs';
import { prepare, createService } from '../scripts/forge-mcp.mjs';
import { normalizeApplication, hash, networkClient, identityFromPrivateKey } from '../scripts/forge-network.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { profileClient } from '../scripts/forge-profile.mjs';
const legacy=JSON.parse(readFileSync(new URL('./legacy-application.json',import.meta.url)));
const clone=()=>structuredClone(legacy);
const cid='QmYwAPJzv5CZsnAzt8auVZRnGi2C9GEBjYqH3CxiZq3Cfu';
const rawCid='bafkreidbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbme';
const pbCid='bafybeidbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbme';

test('legacy profile bytes/marker stay unchanged and do not acquire setup fields',()=>{
 const result=prepare(legacy);assert.equal(result.requestId,'forge-v1-b2ecde36f7088aa684c8619f5145f7192117716e1f50b5305086b8532a0fff55');
 for(const key of ['avatar','models','framework'])assert.equal(Object.hasOwn(result.application,key),false);
});
test('setup normalization preserves declarations and explicitly unknown values',()=>{
 const app={...clone(),avatar:' https://apeforge.fun/bot.png ',models:[' Model A ','model a','Model B'],framework:' OpenClaw ',services:[]};
 const r=prepare(app);assert.equal(r.ok,true);assert.equal(r.application.avatar,'https://apeforge.fun/bot.png');assert.deepEqual(r.application.models,['Model A','Model B']);assert.equal(r.application.framework,'OpenClaw');assert.deepEqual(r.application.services,[]);
 assert.deepEqual(normalizeApplication(app),r.application);assert.notEqual(r.requestId,prepare(legacy).requestId);
 assert.equal(prepare({...clone(),avatar:'',models:[],framework:''}).ok,true);assert.equal(prepare({...clone(),avatar:'https://apeforge.fun:443/bot.png'}).ok,true);
 for(const key of ['avatar','models','framework']){const edited=structuredClone(app);edited[key]=key==='models'?['Other']:key==='avatar'?'https://apeforge.fun/other.png':'Other';assert.notEqual(hash(normalizeApplication(edited)),hash(normalizeApplication(app)));}
});
test('avatar accepts IPFS source, never gateways or fetches it during preparation',()=>{
 for(const avatar of ['ipfs://'+cid,'ipfs://'+cid+'/images/bot.png','ipfs://'+rawCid+'/bot.png','ipfs://'+pbCid+'/bot.png'])assert.equal(prepare({...clone(),avatar}).application.avatar,avatar);
 for(const avatar of ['http://apeforge.fun/bot.png','https://user:secret@apeforge.fun/bot.png','https://127.0.0.1/a','https://apeforge.fun:8443/a','https://apeforge.fun/a#','https://apeforge.fun/a#fragment','https://localhost/a','data:image/png;base64,abc','ipfs://bad','ipfs://b'+'a'.repeat(58),'ipfs://Qm'+'1'.repeat(44),'ipfs://bafyreidbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbme','ipfs://bafkrgidbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbme','ipfs://'+rawCid.slice(0,-1)+'f','ipfs://'+rawCid+'a','ipfs://'+cid+'/../x','ipfs://'+cid+'/%2e%2e/x','ipfs://'+cid+'/x?secret=1','ipfs://'+cid+'/x#frag','ipfs://'+cid+'/','ipfs://'+cid+'//a'])assert.equal(prepare({...clone(),avatar}).ok,false,avatar);
});
test('setup rejects structural/bound/control errors without exposing invalid values',()=>{
 for(const extra of [{models:Array(21).fill('a')},{models:['a'.repeat(81)]},{models:['']},{models:'private-model'},{models:[{}]},{models:['bad\u0000model']},{framework:'a'.repeat(121)},{framework:{}},{avatar:null},{avatar:'a'.repeat(2049)}])assert.equal(validateApplication({...clone(),...extra}).ok,false);
 const r=prepare({...clone(),models:['a'.repeat(81)]});assert.equal(r.errors[0].field,'models.0');assert.equal(JSON.stringify(r).includes('a'.repeat(81)),false);
});
test('MCP preview does not strip setup or service fields',async()=>{
 const application={...clone(),avatar:'ipfs://'+cid,models:['Model A'],framework:'OpenClaw'};
 let received;const service=createService({network:{preview:async app=>{received=normalizeApplication(app);return{ok:true,application:received,previewHash:hash(received)}}}});
 const result=await service.previewEnrollment({application});assert.equal(result.ok,true);assert.equal(received.avatar,application.avatar);assert.deepEqual(received.services,application.services);assert.equal(received.framework,'OpenClaw');
});
test('public readback keeps setup and rejects malformed setup declarations',async()=>{
 const app={...clone(),avatar:'ipfs://'+cid,models:['Model A'],framework:'OpenClaw'};
 const record={id:'g123',revision:1,name:app.name,overview:app.summary,project:{id:'p'+'a'.repeat(24),name:app.projectName},membership:{status:'applicant'},profile:app,source:{type:'github-public-application',url:'https://github.com/chaoscrewweb3-prog/apeforge-skill/issues/7'},createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z'};
 const client=()=>profileClient(async url=>{const response=new Response(JSON.stringify(record),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;});
 assert.deepEqual((await client().get('g123')).publicRecord.profile.models,['Model A']);record.profile.avatar='https://127.0.0.1/a';assert.equal((await client().get('g123')).code,'invalid_profile_response');
});

test('native consent hash covers avatar, models and framework before any transport',async()=>{
 const identity=identityFromPrivateKey(generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}));let calls=0;
 const client=networkClient(identity,{fetcher:async()=>{calls++;throw new Error('must not send');}});
 const application={...clone(),avatar:'ipfs://'+cid,models:['Model A'],framework:'OpenClaw'};const previewHash=hash(normalizeApplication(application));
 for(const key of ['avatar','models','framework']){const changed=structuredClone(application);changed[key]=key==='models'?['Other']:key==='avatar'?'https://apeforge.fun/changed.png':'Other';await assert.rejects(client.submit(changed,{consent:true,previewHash,operation:'ab'.repeat(16)}),{code:'exact_profile_consent_required'});}
 assert.equal(calls,0);
});
