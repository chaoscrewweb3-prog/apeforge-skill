import {createHash} from 'node:crypto';
import {validateApplication} from './forge-application-model.mjs';
export const APE_TOKEN_POLICY=Object.freeze({version:2,updatedDate:'2026-11-03',symbol:'APE',totalSupplyWholeTokens:'1000000',rewardLockMinimumWholeTokens:'1000',partnerLockMinimumWholeTokens:'2500',comparison:'greater-than-or-equal',activationEnabled:false,chainId:null,contractAddress:null,decimals:null,lockDurationSeconds:null});
export const REPO='chaoscrewweb3-prog/apeforge-skill';
export class ForgeError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
export function prepare(application){
 const result=validateApplication(application);if(!result.ok)throw new ForgeError('invalid_application',422);
 const a=result.application,raw={...a.profile,requestedCategory:a.requestedCategory};
 const canonical=JSON.stringify(raw,null,2),requestId='forge-v1-'+createHash('sha256').update(canonical).digest('hex');
 const issueBody=['# Forge application review request','',`<!-- ${requestId} -->`,'','Public profile supplied by the applicant. Unverified: not a registered listing, membership or payment.','','```json',canonical,'```','','The applicant consented to publishing this profile in this public repository.'].join('\n');
 if(Buffer.byteLength(issueBody)>32768)throw new ForgeError('application_too_large',413);
 return{application:raw,requestId,issueBody};
}
export function verifiedIssue(issue,number,requestId){
 if(!issue||issue.pull_request||issue.number!==number||!Number.isSafeInteger(issue.id)||issue.id<1||!Number.isSafeInteger(issue.user?.id)||issue.user.id<1||!/^[-A-Za-z0-9]{1,39}$/.test(issue.user.login)||issue.html_url!==`https://github.com/${REPO}/issues/${number}`||issue.state!=='open'||typeof issue.body!=='string'||Buffer.byteLength(issue.body)>32768||!Number.isFinite(Date.parse(issue.updated_at)))throw new ForgeError('invalid_source_issue',422);
 const match=/\n```json\n([\s\S]+)\n```\n/.exec(issue.body);if(!match)throw new ForgeError('invalid_application_issue',422);
 let raw;try{raw=JSON.parse(match[1]);}catch{throw new ForgeError('invalid_application_issue',422);}
 const p=prepare(raw);if(p.requestId!==requestId||p.issueBody!==issue.body)throw new ForgeError('source_profile_mismatch',409);
 return{...p,issueId:issue.id,issueNumber:number,authorId:issue.user.id,authorLogin:issue.user.login,sourceUpdatedAt:issue.updated_at,sourceUrl:issue.html_url};
}
