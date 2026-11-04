/** Versioned, opt-in source claims. No central enrollment or wallet proof. */
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { prepare } from './forge-mcp.mjs';
import { publicJSON, publicURL } from './forge-peer-transport.mjs';
import { canonical, sign, verify, keyId } from './forge-peer-engine.mjs';
const REPO='chaoscrewweb3-prog/apeforge-skill',API='https://app.apeforge.fun/api/forge/v1';
const CLAIM_KEYS=['schema','agentId','profileRevision','bindingRevision','sourceIssue','cardUrl','endpoint','protocolVersion','keyId','publicKey','acceptInbound','revoked','expiresAt'];
const prefix='<!-- forge-peer-binding-v1 -->\n```json\n';
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>({ok:false,code,verified:false,centralEnrollment:false,walletVerified:false});
export function validateClaim(claim,clock=Date.now){
 if(!claim||typeof claim!=='object'||Object.keys(claim).sort().join('|')!==[...CLAIM_KEYS].sort().join('|')||claim.schema!=='forge-peer-binding-v1'||!/^g[0-9]{1,16}$/.test(claim.agentId)||!Number.isSafeInteger(claim.profileRevision)||claim.profileRevision<1||!Number.isSafeInteger(claim.bindingRevision)||claim.bindingRevision<1||claim.protocolVersion!=='1.0'||typeof claim.acceptInbound!=='boolean'||typeof claim.revoked!=='boolean'||!/^https:\/\/github\.com\/chaoscrewweb3-prog\/apeforge-skill\/issues\/[1-9][0-9]{0,9}$/.test(claim.sourceIssue)||typeof claim.expiresAt!=='string'||!Number.isFinite(Date.parse(claim.expiresAt))||Date.parse(claim.expiresAt)<=clock()||Date.parse(claim.expiresAt)>clock()+7*86400000)throw Error('invalid_peer_claim');
 for(const field of['cardUrl','endpoint']){const u=publicURL(claim[field]);if(u.search||u.href!==claim[field])throw Error('invalid_peer_claim');}
 if(new URL(claim.cardUrl).origin!==new URL(claim.endpoint).origin)throw Error('card_endpoint_origin_mismatch');
 if(typeof claim.publicKey!=='string'||!/^[A-Za-z0-9_-]{50,128}$/.test(claim.publicKey))throw Error('invalid_peer_key');
 const key=createPublicKey({key:Buffer.from(claim.publicKey,'base64url'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519'||key.export({format:'der',type:'spki'}).toString('base64url')!==claim.publicKey||keyId(claim.publicKey)!==claim.keyId)throw Error('invalid_peer_key');
 return claim;
}
export function prepareBinding(claim,privateKey,{clock=Date.now}={}){
 validateClaim(claim,clock);const envelope={claim,signature:sign(privateKey,claim)};if(!verify(claim.publicKey,claim,envelope.signature))throw Error('private_key_mismatch');
 return{claim,commentBody:prefix+canonical(envelope)+'\n```',publicConsentRequired:true,centralEnrollment:false};
}
/** A pins Map must survive discovery calls. Persist it locally for rollback/rotation protection. */
export function peerDirectory({transport=publicJSON,clock=Date.now,pins=new Map()}={}){
 return{pins,async discover(agentId){
  try{
   if(!/^g[0-9]{1,16}$/.test(agentId))return fail('invalid_agent_id');
   const signal=AbortSignal.timeout(12000),get=(url,options={})=>transport(url,{...options,signal});
   const profile=(await get(`${API}/agents/${agentId}`)).value;
   if(profile?.id!==agentId||!Number.isSafeInteger(profile.revision)||profile.revision<1||profile.source?.type!=='github-public-application')return fail('unregistered_peer');
   const source=profile.source.url;if(!new RegExp(`^https://github\\.com/${REPO}/issues/[1-9][0-9]{0,9}$`).test(source))return fail('invalid_source');
   const number=Number(source.split('/').at(-1)),issue=(await get(`https://api.github.com/repos/${REPO}/issues/${number}`)).value;
   const prepared=prepare(profile.profile);
   // Current registry's explicit g+numeric GitHub issue-id identity contract.
   if(!prepared.ok||issue?.html_url!==source||issue.number!==number||!Number.isSafeInteger(issue.id)||issue.id<1||'g'+issue.id!==agentId||!Number.isSafeInteger(issue.user?.id)||issue.user.id<1||issue.user.login!==profile.source.author||issue.pull_request||issue.state!=='open'||issue.body!==prepared.issueBody)return fail('profile_source_mismatch');
   const claims=[];let complete=false;
   for(let page=1;page<=3;page++){
    const response=await get(`https://api.github.com/repos/${REPO}/issues/${number}/comments?per_page=100&page=${page}`),items=response.value;
    if(!Array.isArray(items)||items.length>100)return fail('source_comments_invalid');
    for(const item of items){if(item.user?.id!==issue.user.id||typeof item.body!=='string'||!item.body.startsWith(prefix))continue;
     // Any malformed owner claim fails closed; never skip revocations or corrupt latest state.
     if(item.body.length>16384||!item.body.endsWith('\n```'))return fail('invalid_owner_claim');
     const envelope=JSON.parse(item.body.slice(prefix.length,-4));if(!envelope||Object.keys(envelope).sort().join('|')!=='claim|signature'||prefix+canonical(envelope)+'\n```'!==item.body)return fail('invalid_owner_claim');
     const c=envelope.claim;if(c.agentId!==agentId||c.sourceIssue!==source)return fail('stale_profile_claim');
     // Validate syntax even when expired. Latest expired record must block fallback.
     validateClaim(c,()=>Math.min(clock(),Date.parse(c.expiresAt)-1));
     if(!verify(c.publicKey,c,envelope.signature))return fail('claim_signature_invalid');claims.push(c);
    }
    const link=response.headers?.link||'';
    if(!link.includes('rel="next"')&&items.length<100){complete=true;break;}
    // Exactly-full page with missing Link is ambiguous. Fetch next bounded page.
   }
   if(!complete)return fail('source_pagination_incomplete');
   if(!claims.length)return fail('peer_not_enrolled');
   claims.sort((a,b)=>b.bindingRevision-a.bindingRevision);const claim=claims[0];
   if(claims.some(c=>c.bindingRevision===claim.bindingRevision&&canonical(c)!==canonical(claim)))return fail('binding_revision_conflict');
   const old=pins.get(agentId);
   if(old&&(claim.bindingRevision<old.bindingRevision||claim.bindingRevision===old.bindingRevision&&sha(canonical(claim))!==old.claimHash))return fail('binding_rollback_or_edit');
   pins.set(agentId,{bindingRevision:claim.bindingRevision,keyId:old?.keyId??claim.keyId,claimHash:sha(canonical(claim)),revoked:claim.revoked});
   if(claim.profileRevision!==profile.revision)return fail('stale_profile_claim');
   if(claim.revoked||!claim.acceptInbound)return fail('peer_revoked_or_not_opted_in');
   if(Date.parse(claim.expiresAt)<=clock())return fail('peer_binding_expired');
   if(old&&old.keyId!==claim.keyId)return fail('key_rotation_requires_new_consent');
   const card=(await get(claim.cardUrl,{limit:16384})).value;
   const extension=card?.capabilities?.extensions?.find(e=>e.uri==='https://apeforge.fun/forge-peer/v1');
   if(!card||!card.supportedInterfaces?.some(i=>i.url===claim.endpoint&&i.protocolBinding==='JSONRPC'&&i.protocolVersion==='1.0')||!extension?.required||extension.params?.agentId!==agentId||extension.params?.keyId!==claim.keyId||extension.params?.bindingRevision!==claim.bindingRevision)return fail('peer_card_mismatch');
   const nonce=randomBytes(16).toString('hex'),proofUrl=new URL('/forge-peer/proof',claim.endpoint);proofUrl.searchParams.set('nonce',nonce);
   const proof=(await get(proofUrl.href,{limit:16384})).value,d=proof?.payload;
   if(!d||d.domain!=='forge-peer-proof-v1'||d.agentId!==agentId||d.keyId!==claim.keyId||d.cardUrl!==claim.cardUrl||d.endpoint!==claim.endpoint||d.bindingRevision!==claim.bindingRevision||d.nonce!==nonce||d.cardSha256!==sha(canonical(card))||typeof d.sessionId!=='string'||!/^[a-f0-9]{32}$/.test(d.sessionId)||d.sessionId!==extension.params.sessionId||typeof d.expiresAt!=='string'||!Number.isFinite(Date.parse(d.expiresAt))||Date.parse(d.expiresAt)<=clock()||Date.parse(d.expiresAt)>clock()+120000||!verify(claim.publicKey,d,proof.signature))return fail('endpoint_control_not_proven');
   return{ok:true,verified:true,centralEnrollment:false,walletVerified:false,verification:'github-original-author-and-client-observed-endpoint-key-control',binding:{...claim,sessionId:d.sessionId},source:{profileUrl:`${API}/agents/${agentId}`,issueUrl:source,profileRevision:profile.revision},observedAt:new Date(clock()).toISOString(),requiresRecipientConsent:true};
  }catch{return fail('peer_verification_unavailable');}
 }};
}
