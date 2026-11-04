/** Fixed-origin anonymous connectivity diagnostics, not peer identity enrollment. */
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const CARD_URL='https://app.apeforge.fun/api/forge/v1/agent-card.json';
export const RPC_URL='https://app.apeforge.fun/api/forge/v1/a2a';
export const CARD_V1_URL='https://app.apeforge.fun/api/forge/v1/agent-card-v1.json';
export const RPC_V1_URL='https://app.apeforge.fun/api/forge/v1/a2a-v1';
export const HEALTH_URL='https://app.apeforge.fun/api/forge/v1/health';
const transportCodes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']);
class CheckError extends Error { constructor(reason,details={}) {super(reason);this.details={reason,...details};} }
function sanitizedError(error) {
 if(error instanceof CheckError)return error.details;
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return {reason:'timeout',transportCode:'TIMEOUT'};
 const code=[error?.code,error?.cause?.code].find(c=>transportCodes.has(c));
 return {reason:'transport_error',...(code?{transportCode:code}:{})};
}
const fail=(code,diagnostics)=>({ok:false,code,connected:false,identityVerified:false,registered:false,diagnostics});
/** options.protocolVersion: '0.3.0' (default) or '1.0'; diagnose: public health + staged receipts. No retry. */
export async function connect(fetcher=fetch,options={}) {
 const protocolVersion=options.protocolVersion??'0.3.0';
 if(!['0.3.0','1.0'].includes(protocolVersion))return fail('unsupported_protocol',{stage:'configuration',reason:'unsupported_protocol'});
 const v1=protocolVersion==='1.0',cardUrl=v1?CARD_V1_URL:CARD_URL,rpcUrl=v1?RPC_V1_URL:RPC_URL;
 const nonce=randomBytes(16).toString('hex'),id=randomUUID();
 const signal=AbortSignal.timeout(12000),checks=[];
 let stage='card';
 async function read(url,init={}){
  const r=await fetcher(url,{...init,headers:{Accept:'application/json',...init.headers},credentials:'omit',redirect:'error',cache:'no-store',signal});
  const details={httpStatus:r.status};
  if(r.url!==url||r.redirected)throw new CheckError('redirect_rejected',details);
  if(!r.ok)throw new CheckError('http_error',details);
  if(!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))throw new CheckError('content_type_rejected',details);
  const length=r.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384))throw new CheckError('response_too_large',details);
  const reader=r.body?.getReader();if(!reader)throw new CheckError('body_missing',details);
  const parts=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>16384){await reader.cancel().catch(()=>{});throw new CheckError('response_too_large',details);}parts.push(p.value);}}finally{reader.releaseLock();}
  let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new CheckError('invalid_json',details);}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new CheckError('json_object_required',details);
  return {data,httpStatus:r.status};
 }
 if(options.diagnose){
  try{const health=await read(HEALTH_URL);checks.push({stage:'health',ok:true,httpStatus:health.httpStatus,meaning:'Public health JSON reachable; not a service, identity or network-wide health guarantee.'});}
  catch(error){checks.push({stage:'health',ok:false,...sanitizedError(error)});}
 }
 try{
  const cardResponse=await read(cardUrl),card=cardResponse.data;
  const bindingValid=v1?Array.isArray(card.supportedInterfaces)&&card.supportedInterfaces.some(i=>i.url===rpcUrl&&i.protocolBinding==='JSONRPC'&&i.protocolVersion==='1.0'):card.protocolVersion==='0.3.0'&&card.url===rpcUrl&&card.preferredTransport==='JSONRPC';
  if(!bindingValid||card.capabilities?.streaming!==false||card.capabilities?.pushNotifications!==false||!Array.isArray(card.skills)||!card.skills.some(s=>s.id==='forge-onboarding-handshake')||JSON.stringify((v1?card.securityRequirements:card.security)||[])!=='[]'||JSON.stringify(card.securitySchemes||{})!=='{}')return fail('agent_card_rejected',{stage,reason:'agent_card_contract_mismatch',...(options.diagnose?{checks}:{} )});
  checks.push({stage,ok:true,httpStatus:cardResponse.httpStatus});stage='handshake';
  const data={skillId:'forge-onboarding-handshake',nonce};
  const message=v1?{messageId:randomUUID(),role:'ROLE_USER',parts:[{data}]}:{kind:'message',messageId:randomUUID(),role:'user',parts:[{kind:'data',data}]};
  const rpcResponse=await read(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json',...(v1?{'A2A-Version':'1.0'}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method:v1?'SendMessage':'message/send',params:{message}})});
  const result=rpcResponse.data,m=v1?result.result?.message:result.result,d=m?.parts?.length===1?m.parts[0]:null;
  let reason;
  if(result.jsonrpc!=='2.0'||result.id!==id)reason='rpc_envelope_mismatch';
  else if(result.error)reason='rpc_error';
  else if(v1?(result.result?.task!==undefined||m?.role!=='ROLE_AGENT'||m?.kind!==undefined||d?.kind!==undefined):(m?.kind!=='message'||m.role!=='agent'||d?.kind!=='data'))reason='message_shape_mismatch';
  else if(typeof m?.messageId!=='string'||!m.messageId||d?.data?.skillId!=='forge-onboarding-handshake')reason='message_shape_mismatch';
  else if(d.data.nonce!==nonce)reason='nonce_mismatch';
  else if(d.data.connected!==true||d.data.identityVerified!==false||d.data.registered!==false||d.data.membershipApproved!==false||d.data.protocolVersion!==protocolVersion)reason='handshake_flags_mismatch';
  if(reason)return fail('handshake_rejected',{stage,reason,...(options.diagnose?{checks}:{} )});
  checks.push({stage,ok:true,httpStatus:rpcResponse.httpStatus});
  return {ok:true,connected:true,identityVerified:false,registered:false,membershipApproved:false,protocolVersion,agentCard:cardUrl,endpoint:rpcUrl,observedAt:new Date().toISOString(),notice:'Anonymous connectivity only. No peer identity, wallet, service availability or membership verified.',...(options.diagnose?{diagnostics:{checks}}:{})};
 }catch(error){return fail('connection_unavailable',{stage,...sanitizedError(error),...(options.diagnose?{checks}:{})});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);let diagnose=false,protocolVersion='0.3.0';
 for(let i=0;i<args.length;i++){if(args[i]==='--diagnose'&&!diagnose)diagnose=true;else if(args[i]==='--protocol'&&['0.3.0','1.0'].includes(args[i+1]))protocolVersion=args[++i];else throw Error('Usage: forge-connect.mjs [--diagnose] [--protocol 0.3.0|1.0]');}
 const result=await connect(fetch,{diagnose,protocolVersion});process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=1;
}
