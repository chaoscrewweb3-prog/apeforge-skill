import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Interface,keccak256} from '../jobs-runtime/vendor/meatsuit-abi.mjs';
import {ABI,createMarketClient} from '../jobs-runtime/meatsuit-client.mjs';
import {validateDraft,quote,deploymentReady} from '../jobs-runtime/meatsuit-model.mjs';
import {validateJob,jobsClient,JOBS_API} from '../scripts/forge-jobs.mjs';
const example=JSON.parse(await readFile(new URL('../job.example.json',import.meta.url),'utf8'));
const address=n=>'0x'+String(n).repeat(40);
const iface=new Interface(ABI),erc=new Interface(['function decimals() view returns(uint8)','function approve(address,uint256) returns(bool)']);
const cfg={version:2,collateralPolicyVersion:1,activationEnabled:true,chainId:1,decimals:18,token:address(1),escrow:address(2),treasury:address(3),eligibilityRegistry:address(4),autoPayOnTimeout:true,runtimeCodeHash:keccak256('0x6000'),eligibilityCodeHash:keccak256('0x6001')};
test('exact collateral defaults and editable amounts do not alter agent total or fee',()=>{
 assert.deepEqual(quote('100',18),{reward:100n*10n**18n,fee:5n*10n**18n,total:105n*10n**18n,workerCollateral:10n*10n**18n});
 assert.equal(quote('0.000000000000000001',18).workerCollateral,1n);
 assert.equal(quote('100',18,'7.123456789123456789').workerCollateral,7123456789123456789n);
 for(const workerCollateral of ['0','101','1e1',10])assert.equal(validateJob({...example,workerCollateral}).ok,false);
 for(const bad of [{estimatedMinutes:0},{estimatedMinutes:'45'},{requiredSystems:['Phone']},{requiredKnowledge:'x'.repeat(501)},{visual:'javascript:alert(1)'}])assert.equal(validateJob({...example,...bad}).ok,false);
 const {workerCollateral,requiredSystems,requiredKnowledge,estimatedMinutes,visual,...legacy}=example;
 const normalized=validateJob(legacy);assert.equal(normalized.ok,true);assert.equal(normalized.draft.workerCollateral,'10');assert.equal(normalized.draft.estimatedMinutes,60);assert.equal(normalized.draft.visual,'');
});
function provider(){const calls=[];return {calls,async request({method,params}){calls.push({method,params});if(method==='eth_chainId')return '0x1';if(method==='eth_getCode')return params[0]===cfg.escrow?'0x6000':'0x6001';if(method==='eth_call'){const [{to,data}]=params;if(to===cfg.token)return erc.encodeFunctionResult('decimals',[18]);const parsed=iface.parseTransaction({data});const values={collateralPolicyVersion:[1],token:[cfg.token],treasury:[cfg.treasury],eligibilityRegistry:[cfg.eligibilityRegistry],autoPayOnTimeout:[true]};if(!values[parsed.name])throw Error('Unexpected read '+parsed.name);return iface.encodeFunctionResult(parsed.name,values[parsed.name]);}throw Error('Unsupported RPC '+method);}};}
test('real ABI calldata includes immutable collateral and metadata, and remains unsigned',async()=>{
 const p=provider(),client=createMarketClient(p,cfg);const intent=await client.preparePost(example);const tx=iface.parseTransaction({data:intent.data});
 assert.equal(tx.name,'post');assert.equal(tx.args.length,6);assert.equal(tx.args[1],100n*10n**18n);assert.equal(tx.args[2],10n*10n**18n);assert.equal(tx.args[0].requiredSystems,example.requiredSystems);assert.equal(tx.args[0].estimatedMinutes,45n);assert.equal(tx.args[3],7n*86400n);
 const settle=await client.prepare('settleMissedDelivery',[17]);assert.equal(iface.parseTransaction({data:settle.data}).args[0],17n);
 const approval=await client.prepareApproval(10n*10n**18n);const parsed=erc.parseTransaction({data:approval.data});assert.equal(parsed.args[1],10n*10n**18n);assert.equal(parsed.args[0],cfg.escrow);
 assert(p.calls.every(c=>['eth_chainId','eth_getCode','eth_call'].includes(c.method)));assert.equal(intent.value,'0');
});
test('old deployments or unreviewed collateral policies fail closed before RPC',()=>{
 let calls=0;for(const bad of [{version:1},{collateralPolicyVersion:undefined},{collateralPolicyVersion:2},{activationEnabled:false}]){const c={...cfg,...bad};assert.equal(deploymentReady(c),false);assert.throws(()=>createMarketClient({request(){calls++;}},c),/not activated/);}assert.equal(calls,0);
});
test('preparation separates worker bond and immutable deadline policy from agent funding',async()=>{
 const fetcher=async url=>{const value=url===JOBS_API?{version:1,state:'not-launched',activationEnabled:false}:{version:1,agentId:example.agentId,status:'unknown',eligible:false,verified:false,walletBinding:{address:null,verified:false}};const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
 const r=await jobsClient(fetcher).prepare({agentId:example.agentId,draft:example});assert.equal(r.paymentPlan.total,'105');assert.equal(r.paymentPlan.workerCollateral,'10');assert.equal(r.paymentPlan.workerCollateralPostingFee,'0');assert.equal(r.paymentPlan.workerCollateralIncludedInAgentTotal,false);assert.equal(r.escrowPlan.collateralPolicyVersion,1);assert.match(r.escrowPlan.collateralReturn,/strictly-before/);assert.match(r.escrowPlan.collateralForfeit,/fixed-ecosystem-treasury/);assert.match(r.intentId,/^forge-job-v2-/);assert.equal(r.funded,false);assert.equal(r.transactionPrepared,false);
});
