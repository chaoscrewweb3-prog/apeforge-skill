import {ForgeError} from './forge-contract.mjs';
// Operator-only backend binding. Never read an endpoint or credential from applicants.
export function configuredAvatarProvider(env=process.env,fetchImpl=fetch){
 if(env.FORGE_IPFS_ENABLED!=='1')return null;
 // Deliberately fixed private service. Provisioning/network exposure is separate.
 const base='http://apeforge-ipfs:5001/api/v0/';
 async function rpc(route,{body,limit=4096,signal}={}){
  const r=await fetchImpl(base+route,{method:'POST',body,redirect:'error',signal:signal||AbortSignal.timeout(1500)});
  if(r.status!==200||!r.body)throw new ForgeError('ipfs_unavailable',503);
  const reader=r.body.getReader();let size=0,parts=[];try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('ipfs_response_too_large');parts.push(Buffer.from(value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}return Buffer.concat(parts);
 }
 return {
  async pin(bytes,mediaType,cid){
   const signal=AbortSignal.timeout(3000),form=new FormData();form.append('file',new Blob([bytes],{type:mediaType}),'avatar');
   const put=JSON.parse((await rpc('block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=true',{body:form,signal})).toString('utf8'));
   if(put.Key!==cid||put.Size!==bytes.length)throw Error('ipfs_pin_mismatch');
   const pins=JSON.parse((await rpc('pin/ls?arg='+cid+'&type=recursive',{signal})).toString('utf8'));
   if(pins.Keys?.[cid]?.Type!=='recursive')throw Error('ipfs_pin_unconfirmed');return cid;
  },
  async retrieve(cid){return rpc('block/get?arg='+cid,{limit:16384});}
 };
}
