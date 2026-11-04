import {Interface,keccak256} from './vendor/meatsuit-abi.mjs';
import {deploymentReady,validateDraft,rawAmount,unsignedIntent,DAY} from './meatsuit-model.mjs';
export const ABI = [
 'function token() view returns (address)', 'function treasury() view returns (address)',
 'function eligibilityRegistry() view returns (address)', 'function autoPayOnTimeout() view returns (bool)', 'function nextJobId() view returns (uint256)',
 'function escrowed() view returns (uint256)', 'function bonded() view returns (uint256)', 'function collateralPolicyVersion() view returns (uint256)',
 'function getJob(uint256 id) view returns ((address agent,address nominee,address worker,uint256 reward,uint256 workerCollateral,uint256 lockedCollateral,uint64 listingEnds,uint64 deliverySeconds,uint64 deliveryEnds,uint64 reviewEnds,uint8 skill,uint8 state,bytes32 termsHash,bytes32 evidenceHash,bytes32 rejectionHash),(string agentId,string title,string brief,string acceptance,string category,string contact,string requiredSystems,string requiredKnowledge,string visual,uint32 estimatedMinutes))',
 'function post((string agentId,string title,string brief,string acceptance,string category,string contact,string requiredSystems,string requiredKnowledge,string visual,uint32 estimatedMinutes),uint256 reward,uint256 workerCollateral,uint64 listingSeconds,uint64 deliverySeconds,uint8 skill) returns (uint256)',
 'function nominate(uint256,address)', 'function accept(uint256)', 'function submit(uint256,bytes32)',
 'function approve(uint256)', 'function reject(uint256,bytes32)', 'function refund(uint256)', 'function settleTimeout(uint256)', 'function settleMissedDelivery(uint256)'
];
const escrowInterface=new Interface(ABI),tokenInterface=new Interface(['function decimals() view returns (uint8)','function approve(address,uint256) returns (bool)','function allowance(address,address) view returns(uint256)']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function createMarketClient(provider,config){
 if(!deploymentReady(config))throw Error('APE escrow is not activated.');
 if(typeof provider?.request!=='function')throw Error('An explicitly supplied EIP-1193 provider is required.');
 const rpc=(method,params)=>provider.request({method,params});
 const read=async(name,args=[],block='latest')=>escrowInterface.decodeFunctionResult(name,await rpc('eth_call',[{to:config.escrow,data:escrowInterface.encodeFunctionData(name,args)},block]));
 async function verify(){
   if(BigInt(await rpc('eth_chainId',[]))!==BigInt(config.chainId))throw Error('Wrong chain. Switch deliberately in your wallet.');
   if(Number((await read('collateralPolicyVersion'))[0])!==config.collateralPolicyVersion)throw Error('Collateral policy mismatch.');
   const code=await rpc('eth_getCode',[config.escrow,'latest']);
   if(code==='0x'||!same(keccak256(code),config.runtimeCodeHash))throw Error('Escrow runtime code does not match the reviewed deployment.');
   const[t,r,p,dec,registry,registryCode]=await Promise.all([read('token'),read('treasury'),read('autoPayOnTimeout'),rpc('eth_call',[{to:config.token,data:tokenInterface.encodeFunctionData('decimals')},'latest']),read('eligibilityRegistry'),rpc('eth_getCode',[config.eligibilityRegistry,'latest'])]);
   if(!same(registry[0],config.eligibilityRegistry)||registryCode==='0x'||!same(keccak256(registryCode),config.eligibilityCodeHash))throw Error('Eligibility registry mismatch.');
   if(!same(t[0],config.token)||!same(r[0],config.treasury)||p[0]!==config.autoPayOnTimeout||Number(tokenInterface.decodeFunctionResult('decimals',dec)[0])!==config.decimals)throw Error('Deployment configuration mismatch.');
 }
 async function prepare(action,args){await verify();const intent=unsignedIntent(action,args,config);return{...intent,data:escrowInterface.encodeFunctionData(action,args)};}
 return {
  verify,
  async list({cursor,limit=12}={}){
   await verify();if(!Number.isInteger(limit)||limit<1||limit>24)throw Error('Page limit must be 1–24.');
   const block=await rpc('eth_blockNumber',[]);const next=Number((await read('nextJobId',[],block))[0]);
   if(!Number.isSafeInteger(next))throw Error('Job count overflow.');
   let id=cursor===undefined?next-1:Number(cursor);if(!Number.isSafeInteger(id)||id<0||id>=next)throw Error('Invalid job cursor.');
   const jobs=[];for(let n=0;id>0&&n<limit;n++,id--){const[j,t]=await read('getJob',[id],block);jobs.push({id,agent:j.agent,nominee:j.nominee,worker:j.worker,reward:j.reward,workerCollateral:j.workerCollateral,lockedCollateral:j.lockedCollateral,listingEnds:Number(j.listingEnds),deliveryEnds:Number(j.deliveryEnds),reviewEnds:Number(j.reviewEnds),skill:Number(j.skill),state:Number(j.state),terms:Object.fromEntries(['agentId','title','brief','acceptance','category','contact','requiredSystems','requiredKnowledge','visual','estimatedMinutes'].map(k=>[k,t[k]]))});}
   return{jobs,nextCursor:id||null,observedBlock:block,finality:'provider-observed-not-finalized'};
  },
  async preparePost(draft){const d=validateDraft(draft);if(!d.ok)throw Error(d.errors.join('\n'));const v=d.value;return prepare('post',[Object.fromEntries(['agentId','title','brief','acceptance','category','contact','requiredSystems','requiredKnowledge','visual','estimatedMinutes'].map(k=>[k,v[k]])),rawAmount(v.reward,config.decimals),rawAmount(v.workerCollateral,config.decimals),v.listingDays*DAY,v.deliveryDays*DAY,v.skill]);},
  prepare,
  async allowance(owner){await verify();if(!/^0x[0-9a-f]{40}$/i.test(owner))throw Error('Invalid wallet address.');const data=await rpc('eth_call',[{to:config.token,data:tokenInterface.encodeFunctionData('allowance',[owner,config.escrow])},'latest']);return tokenInterface.decodeFunctionResult('allowance',data)[0];},
  async prepareApproval(rawTotal){await verify();if(typeof rawTotal!=='bigint'||rawTotal<=0n||rawTotal>=2n**256n-1n)throw Error('Exact finite allowance required.');return{version:1,chainId:config.chainId,to:config.token,value:'0',function:'approve',args:[config.escrow,rawTotal],data:tokenInterface.encodeFunctionData('approve',[config.escrow,rawTotal])};},
  // Intents are returned, never sent or signed. Agent wallets retain their own spending authority.
 };
}
