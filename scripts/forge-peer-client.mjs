/** Explicit direct send. Never enrolls peers or requests payment automatically. */
import { peerDirectory } from './forge-peer-discovery.mjs';
import { publicJSON } from './forge-peer-transport.mjs';
import { makeRequest, verifyResponse } from './forge-peer-engine.mjs';
import { randomUUID } from 'node:crypto';
export function peerClient({ownBinding,privateKey,directory=peerDirectory(),transport=publicJSON,clock=Date.now}){
 return{async request(recipientId,rpc){
  const verified=await directory.discover(recipientId);if(!verified.ok)return verified;
  const recipient=verified.binding,request=makeRequest(ownBinding,privateKey,recipient,rpc,{clock});
  try{
   const response=await transport(recipient.endpoint,{method:'POST',body:request.body,headers:request.headers,limit:32768,allowPeerErrors:true});
   if([401,403].includes(response.status)&&!verifyResponse(ownBinding,recipient,request,response))return{ok:false,code:'recipient_authentication_or_consent_denied',delivery:'rejected',authenticatedRecipient:false,retry:false};
   if(!verifyResponse(ownBinding,recipient,request,response))return{ok:false,code:'recipient_receipt_invalid',delivery:'unknown',retry:false};
   const value=response.value;if(value?.jsonrpc!=='2.0'||value.id!==rpc.id)return{ok:false,code:'recipient_receipt_invalid',delivery:'unknown',retry:false};
   return{ok:!value.error,recipientId,receipt:value,authenticatedRecipient:true,delivery:value.error?'rejected':'received-by-reference-inbox',serviceExecutionVerified:false};
  }catch{return{ok:false,code:'delivery_unavailable_or_ambiguous',delivery:'unknown',retry:false,notice:'Do not automatically resend. Preserve messageId and reconcile task/status where known.'};}
 },async send(recipientId,text,{messageId=randomUUID(),contextId}={}){return this.request(recipientId,{jsonrpc:'2.0',id:randomUUID(),method:'SendMessage',params:{message:{messageId,role:'ROLE_USER',parts:[{text}],...(contextId?{contextId}:{})}}});},async status(recipientId,taskId,{historyLength=8}={}){return this.request(recipientId,{jsonrpc:'2.0',id:randomUUID(),method:'GetTask',params:{id:taskId,historyLength}});}};
}
