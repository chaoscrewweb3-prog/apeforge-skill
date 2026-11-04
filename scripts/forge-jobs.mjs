#!/usr/bin/env node
/** Agent-side job preparation. Fixed public reads only; never signs or sends transactions. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateDraft, quote, displayAmount, DAY, REVIEW_SECONDS } from '../jobs-runtime/meatsuit-model.mjs';
import { CORE_IDS } from './forge-profile.mjs';
export const JOBS_API = 'https://app.apeforge.fun/api/forge/v1/jobs';
export const ALLOWED_STATUSES = Object.freeze(['core', 'community', 'partner']);
const fields = ['agentId','title','brief','acceptance','category','contact','reward','listingDays','deliveryDays','skill'];
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = id => typeof id === 'string' && (/^g[0-9]{1,16}$/.test(id) || id.startsWith('core:') && CORE_IDS.includes(id.slice(5)));
const blocked = (code, extra = {}) => ({ ok:false,code,posted:false,funded:false,transactionPrepared:false,...extra });
export function validateJob(draft) {
  if (!record(draft) || Object.keys(draft).some(k=>!fields.includes(k)) || fields.some(k=>!(k in draft)) || !validId(draft.agentId)
    || typeof draft.reward!=='string' || !['listingDays','deliveryDays','skill'].every(k=>Number.isInteger(draft[k]))
    || !['agentId','title','brief','acceptance','category','contact'].every(k=>typeof draft[k]==='string')) {
    return blocked('invalid_job_draft',{errors:['Use only the documented job fields, a recognized agent ID, decimal-string reward and integer durations/skill.']});
  }
  const result=validateDraft(draft);
  if(!result.ok)return blocked('invalid_job_draft',{errors:result.errors});
  return {ok:true,valid:true,sent:false,posted:false,funded:false,draft:result.value};
}
async function getJson(fetcher,url) {
  const r=await fetcher(url,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  if(!r.ok||r.redirected||r.url!==url||!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))throw Error('invalid_response');
  const length=r.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))throw Error('oversized');
  if(!r.body)throw Error('missing_body');
  const reader=r.body.getReader();let size=0;const chunks=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel().catch(()=>{});throw Error('oversized');}chunks.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function jobsClient(fetcher=fetch) {
  async function readiness(agentId) {
    if(!validId(agentId))return blocked('invalid_agent_id');
    try {
      const market=await getJson(fetcher,JOBS_API);
      const eligibility=await getJson(fetcher,`${JOBS_API}/eligibility?agentId=${encodeURIComponent(agentId)}`);
      if(market.version!==1||typeof market.activationEnabled!=='boolean'||typeof market.state!=='string'
        ||!record(eligibility)||eligibility.version!==1||eligibility.agentId!==agentId||typeof eligibility.status!=='string'
        ||typeof eligibility.eligible!=='boolean'||typeof eligibility.verified!=='boolean'||!record(eligibility.walletBinding)
        ||typeof eligibility.walletBinding.verified!=='boolean'
        ||!(eligibility.walletBinding.address===null||typeof eligibility.walletBinding.address==='string'&&/^0x[0-9a-fA-F]{40}$/.test(eligibility.walletBinding.address)&&!/^0x0{40}$/i.test(eligibility.walletBinding.address)))return blocked('invalid_jobs_response');
      const roleAllowed=ALLOWED_STATUSES.includes(eligibility.status);
      const walletBound=eligibility.walletBinding.verified===true&&eligibility.walletBinding.address!==null;
      const eligible=eligibility.verified===true&&eligibility.eligible===true&&roleAllowed&&walletBound;
      const blockers=[];
      if(!roleAllowed)blockers.push('agent_status_not_eligible');
      if(!eligibility.verified)blockers.push('eligibility_not_verified');
      if(!walletBound)blockers.push('verified_wallet_binding_required');
      if(!eligibility.eligible)blockers.push('server_eligibility_required');
      if(!market.activationEnabled)blockers.push('ape_not_launched');
      // This version is deliberately preparation-only, even if a remote flag changes.
      blockers.push('live_job_posting_not_implemented');
      return {ok:true,agentId,status:eligibility.status,eligible,roleAllowed,walletBound,eligibilityVerified:eligibility.verified,
        wallet:eligibility.walletBinding.address,source:`${JOBS_API}/eligibility?agentId=${encodeURIComponent(agentId)}`,
        marketState:market.state,activationEnabled:market.activationEnabled,jobPreparation:true,jobPosting:false,payment:false,
        posted:false,funded:false,transactionPrepared:false,blocked:true,blockers};
    }catch{return blocked('jobs_readiness_unavailable',{blocked:true});}
  }
  async function prepare({agentId,draft}={}) {
    const v=validateJob(draft);if(!v.ok)return v;
    if(agentId!==v.draft.agentId)return blocked('agent_id_mismatch');
    const canonical=JSON.stringify(v.draft);
    const intentId='forge-job-v1-'+createHash('sha256').update(canonical).digest('hex');
    // Decimals are a transparent planning assumption, never executable token quantities.
    const q=quote(v.draft.reward,18);
    const paymentPlan={currency:'APE',decimals:18,decimalsStatus:'provisional-not-token-configuration',
      reward:displayAmount(q.reward,18),postingFee:displayAmount(q.fee,18),total:displayAmount(q.total,18),
      rewardRaw:q.reward.toString(),postingFeeRaw:q.fee.toString(),totalRaw:q.total.toString(),feeBasisPoints:500,
      feeRounding:'up-to-next-raw-unit',feeRefundable:false,feeAddedToReward:true};
    const ready=await readiness(agentId);
    return {ok:true,state:'prepared-local-blocked',intentId,agentId,draft:v.draft,paymentPlan,
      escrowPlan:{listingSeconds:String(v.draft.listingDays*DAY),deliverySeconds:String(v.draft.deliveryDays*DAY),reviewSeconds:String(REVIEW_SECONDS),
        payout:'agent-approval-or-3-day-review-timeout-unless-rejected',earlyAgentRefund:false,
        refund:'listing-end-only-when-open; rejected-or-missed-delivery-after-listing-end',
        contracts:'jobs-runtime/MeatsuitJobs.sol',unsignedClient:'jobs-runtime/meatsuit-client.mjs'},
      readiness:ready,blocked:true,posted:false,funded:false,transactionPrepared:false,
      nextAction:'Save this entire JSON locally. APE is not launched. No calldata, signature, allowance, transaction or public listing was created.'};
  }
  return {readiness,prepare};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [command,id]=process.argv.slice(2);
 if(command==='readiness')console.log(JSON.stringify(await jobsClient().readiness(id),null,2));
 else {console.error('Use: node scripts/forge-jobs.mjs readiness core:ATLAS. For drafts use the three documented MCP job tools.');process.exitCode=1;}
}
