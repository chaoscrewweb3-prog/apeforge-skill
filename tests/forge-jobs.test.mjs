import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Readable,Writable} from 'node:stream';
import {jobsClient,validateJob,JOBS_API} from '../scripts/forge-jobs.mjs';
import {createRpc,createService,startStdio,TOOLS} from '../scripts/forge-mcp.mjs';
import {createMarketClient} from '../jobs-runtime/meatsuit-client.mjs';
import {unsignedIntent} from '../jobs-runtime/meatsuit-model.mjs';
const draft=JSON.parse(await readFile(new URL('../job.example.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(draft);
const market={version:1,state:'not-launched',activationEnabled:false};
const receipt=(status='unknown',changes={})=>({version:1,agentId:draft.agentId,status,eligible:false,verified:false,walletBinding:{verified:false,address:null},...changes});
function response(value,url,options={}){const r=new Response(typeof value==='string'?value:JSON.stringify(value),{status:options.status??200,headers:{'Content-Type':'application/json',...options.headers}});Object.defineProperties(r,{url:{value:options.url??url},redirected:{value:options.redirected??false}});return r;}
function transport(eligibility=receipt(),change=()=>{}){const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});const v=url===JOBS_API?market:eligibility;return change(v,url,options)??response(v,url);};return {fetcher,calls};}
const bound={eligible:true,verified:true,walletBinding:{verified:true,address:'0x'+'1'.repeat(40)}};
test('strict draft types preserve precise decimal strings and reject arbitrary fields',()=>{
 assert.equal(validateJob(draft).ok,true);
 for(const invalid of [{...draft,reward:100},{...draft,reward:'1e3'},{...draft,reward:'0'},{...draft,reward:'1.0000000000000000001'},{...draft,listingDays:'7'},{...draft,role:'core'},{...draft,agentId:'core:FORGED'},{...draft,contact:'https://a:secret@example.com'},{...draft,title:'é'.repeat(61)}])assert.equal(validateJob(invalid).ok,false);
});
test('planning uses exact integer quantities, rounds fee up and never produces calldata or transaction',async()=>{
 const t=transport();const c=jobsClient(t.fetcher);let r=await c.prepare({agentId:draft.agentId,draft});
 assert.equal(r.ok,true);assert.equal(r.state,'prepared-local-blocked');assert.equal(r.paymentPlan.total,'105');assert.equal(r.paymentPlan.totalRaw,'105000000000000000000');assert.equal(r.paymentPlan.decimalsStatus,'provisional-not-token-configuration');
 assert.equal(r.escrowPlan.reviewSeconds,'259200');assert.equal(r.escrowPlan.earlyAgentRefund,false);assert.equal(r.posted,false);assert.equal(r.funded,false);assert.equal(r.transactionPrepared,false);assert.equal(r.data,undefined);assert.equal(r.readiness.eligible,false);
 const repeated=await c.prepare({agentId:draft.agentId,draft:Object.fromEntries(Object.entries(draft).reverse())});assert.equal(r.intentId,repeated.intentId);
 const small={...draft,reward:'0.000000000000000001'};r=await c.prepare({agentId:draft.agentId,draft:small});assert.equal(r.paymentPlan.rewardRaw,'1');assert.equal(r.paymentPlan.postingFeeRaw,'1');assert.equal(r.paymentPlan.totalRaw,'2');
 const huge={...draft,reward:'9007199254740993.123456789123456789'};r=await c.prepare({agentId:draft.agentId,draft:huge});assert.equal(r.paymentPlan.rewardRaw,'9007199254740993123456789123456789');assert.equal(JSON.parse(JSON.stringify(r)).draft.reward,huge.reward);
 assert.equal((await c.prepare({agentId:'g123',draft})).code,'agent_id_mismatch');
});
test('all three authoritative statuses also require verified wallet and eligibility, not self-assertion',async()=>{
 for(const status of ['core','community','partner']){const r=await jobsClient(transport(receipt(status,bound)).fetcher).readiness(draft.agentId);assert.equal(r.ok,true);assert.equal(r.eligible,true);assert.equal(r.jobPosting,false);assert.equal(r.payment,false);assert.equal(r.blocked,true);assert(r.blockers.includes('ape_not_launched'));}
 for(const status of ['applicant','insider','unknown','CORE']){const r=await jobsClient(transport(receipt(status,bound)).fetcher).readiness(draft.agentId);assert.equal(r.eligible,false);assert(r.blockers.includes('agent_status_not_eligible'));}
 for(const changes of [{verified:false},{eligible:false},{walletBinding:{verified:false,address:'0x'+'1'.repeat(40)}},{walletBinding:{verified:true,address:null}}]){const r=await jobsClient(transport(receipt('partner',{...bound,...changes})).fetcher).readiness(draft.agentId);assert.equal(r.eligible,false);}
});
test('fixed-origin reads omit credentials, block redirects and sanitize failures',async()=>{
 const t=transport();await jobsClient(t.fetcher).readiness(draft.agentId);assert.equal(t.calls.length,2);
 assert.equal(t.calls[1].url,JOBS_API+'/eligibility?agentId=core%3AATLAS');
 for(const c of t.calls){assert.equal(c.options.method,'GET');assert.equal(c.options.credentials,'omit');assert.equal(c.options.redirect,'error');assert.equal(c.options.cache,'no-store');assert.equal(c.options.body,undefined);assert(c.options.signal instanceof AbortSignal);}
 for(const options of [{redirected:true},{url:'https://evil.invalid/'},{status:302},{headers:{'Content-Type':'text/html'}},{headers:{'Content-Length':'32769'}}]){const r=await jobsClient(transport(receipt(),(v,url)=>response(v,url,options)).fetcher).readiness(draft.agentId);assert.equal(r.ok,false);}
 const unavailable=await jobsClient(async()=>{throw Error('Bearer privateSECRET');}).prepare({agentId:draft.agentId,draft});assert.equal(unavailable.ok,true);assert.equal(unavailable.readiness.code,'jobs_readiness_unavailable');assert(!JSON.stringify(unavailable).includes('privateSECRET'));
});
test('malformed identity, state or unbounded payload never grants readiness',async()=>{
 for(const v of [receipt('core',{...bound,agentId:'g999'}),receipt('core',{...bound,version:2}),receipt('core',{...bound,walletBinding:{verified:true,address:'0x'+'0'.repeat(40)}}),receipt('core',{...bound,verified:'true'})])assert.equal((await jobsClient(transport(v).fetcher).readiness(draft.agentId)).ok,false);
 let calls=0;assert.equal((await jobsClient(async()=>{calls++;}).readiness('https://evil.invalid')).ok,false);assert.equal(calls,0);
 assert.equal((await jobsClient(transport(receipt(),(v,url)=>response('x'.repeat(32769),url)).fetcher).readiness(draft.agentId)).ok,false);
});
test('legacy plus new tools dispatch through actual RPC with canonical result wrappers',async()=>{
 const rpc=createRpc(createService({jobs:jobsClient(transport().fetcher)}));
 await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});await rpc({jsonrpc:'2.0',method:'notifications/initialized'});
 const list=await rpc({jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal(list.result.tools.length,13);assert.equal(new Set(TOOLS.map(t=>t.name)).size,13);
 for(const [name,args] of [['forge_validate_job',{draft}],['forge_job_readiness',{agentId:draft.agentId}],['forge_prepare_job',{agentId:draft.agentId,draft}]]){const r=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}});assert.equal(r.result.isError,false);const v=JSON.parse(r.result.content[0].text);assert.equal(v.ok,true);assert.equal(v.posted,false);assert.equal(v.funded,false);}
 const invalid=await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'forge_prepare_job',arguments:{agentId:draft.agentId,draft,role:'core'}}});assert.equal(invalid.error.code,-32602);
});
test('real stdio stream dispatches offline validation and advertises release 1.5.0',async()=>{
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'forge_validate_job',arguments:{draft}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'forge_capabilities',arguments:{}}}];let out='';await startStdio(Readable.from(messages.map(v=>JSON.stringify(v)+'\n')),new Writable({write(chunk,encoding,done){out+=chunk;done();}}));const rows=out.trim().split('\n').map(JSON.parse);assert.equal(rows[0].result.serverInfo.version,'1.5.0');assert.equal(JSON.parse(rows[1].result.content[0].text).valid,true);const c=JSON.parse(rows[2].result.content[0].text);assert.equal(c.jobPreparation,true);assert.equal(c.jobPosting,false);assert.equal(c.paymentAvailable,false);assert.equal(c.mcpToolCount,13);
});
test('bundled unsigned runtime rejects disabled deployment before any provider request',()=>{
 let calls=0;assert.throws(()=>createMarketClient({request(){calls++;}}, {version:1,activationEnabled:false}),/not activated/);assert.equal(calls,0);assert.throws(()=>unsignedIntent('post',[],{activationEnabled:false}),/not activated/);
});
