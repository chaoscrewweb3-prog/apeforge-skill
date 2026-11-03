/** Fixed-origin anonymous A2A 0.3 connectivity check. No identity enrollment. */
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const CARD_URL='https://app.apeforge.fun/api/forge/v1/agent-card.json';
export const RPC_URL='https://app.apeforge.fun/api/forge/v1/a2a';
const fail=code=>({ok:false,code,connected:false,identityVerified:false,registered:false});
export async function connect(fetcher=fetch) {
 const nonce=randomBytes(16).toString('hex'),id=randomUUID();
 const signal=AbortSignal.timeout(12000);
 async function read(url,init={}){
  const r=await fetcher(url,{...init,headers:{Accept:'application/json',...init.headers},credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(!r.ok||r.url!==url||r.redirected||!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))throw Error();
  const length=r.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384))throw Error();
  const reader=r.body.getReader(),parts=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>16384){await reader.cancel().catch(()=>{});throw Error();}parts.push(p.value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }
 try{
  const card=await read(CARD_URL);
  if(card.protocolVersion!=='0.3.0'||card.url!==RPC_URL||card.preferredTransport!=='JSONRPC'||card.capabilities?.streaming!==false||card.capabilities?.pushNotifications!==false||!Array.isArray(card.skills)||!card.skills.some(s=>s.id==='forge-onboarding-handshake')||JSON.stringify(card.security||[])!=='[]'||JSON.stringify(card.securitySchemes||{})!=='{}')return fail('agent_card_rejected');
  const result=await read(RPC_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:'message/send',params:{message:{kind:'message',messageId:randomUUID(),role:'user',parts:[{kind:'data',data:{skillId:'forge-onboarding-handshake',nonce}}]}}})});
  const m=result.result,d=m?.parts?.length===1?m.parts[0]:null;
  if(result.jsonrpc!=='2.0'||result.id!==id||result.error||m?.kind!=='message'||m.role!=='agent'||typeof m.messageId!=='string'||d?.kind!=='data'||d.data?.skillId!=='forge-onboarding-handshake'||d.data?.nonce!==nonce||d.data.connected!==true||d.data.identityVerified!==false||d.data.registered!==false||d.data.membershipApproved!==false||d.data.protocolVersion!=='0.3.0')return fail('handshake_rejected');
  return{ok:true,connected:true,identityVerified:false,registered:false,membershipApproved:false,protocolVersion:'0.3.0',agentCard:CARD_URL,endpoint:RPC_URL,observedAt:new Date().toISOString(),notice:'Anonymous connectivity only. No peer identity, wallet, service availability or membership verified.'};
 }catch{return fail('connection_unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==2)throw Error('No arguments accepted.');const result=await connect();process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=1;}
