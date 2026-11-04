/** Synthetic Applicant sources + two real loopback HTTP recipients, never public registrations. */
import test from'node:test';import assert from'node:assert/strict';import{generateKeyPairSync}from'node:crypto';import http from'node:http';import{readFile}from'node:fs/promises';
import{prepare}from'../scripts/forge-mcp.mjs';import{createPeer,keyId,makeRequest,verifyResponse}from'../scripts/forge-peer-engine.mjs';import{prepareBinding,peerDirectory}from'../scripts/forge-peer-discovery.mjs';import{listenPeer}from'../scripts/forge-peer-http.mjs';import{peerClient}from'../scripts/forge-peer-client.mjs';
const example=JSON.parse(await readFile(new URL('../application.example.json',import.meta.url)));
test('two synthetic Applicants discover, prove endpoint control, mutually consent, authenticate HTTP send/reply/status and revoke',async()=>{
 const now=Date.now(),clock=()=>now,records=new Map(),byId=new Map(),servers=[];
 function applicant(n){const{privateKey,publicKey}=generateKeyPairSync('ed25519'),pub=publicKey.export({format:'der',type:'spki'}).toString('base64url'),agentId='g'+(9000+n),source='https://github.com/chaoscrewweb3-prog/apeforge-skill/issues/'+n,app=structuredClone(example);app.name='Synthetic peer '+n;const p=prepare(app),claim={schema:'forge-peer-binding-v1',agentId,profileRevision:1,bindingRevision:1,sourceIssue:source,cardUrl:`https://peer${n}.forge-fixture.dev/.well-known/agent-card.json`,endpoint:`https://peer${n}.forge-fixture.dev/a2a`,protocolVersion:'1.0',keyId:keyId(pub),publicKey:pub,acceptInbound:true,revoked:false,expiresAt:new Date(now+3600000).toISOString()},peer=createPeer({binding:claim,privateKey,clock});
 const row={privateKey,claim,peer,profile:{id:agentId,revision:1,profile:p.application,source:{type:'github-public-application',url:source,author:'fixture'+n}},issue:{id:9000+n,number:n,html_url:source,user:{id:100+n,login:'fixture'+n},state:'open',body:p.issueBody},comments:[{user:{id:100+n},body:prepareBinding(claim,privateKey,{clock}).commentBody}]};records.set(n,row);byId.set(agentId,row);return row;}
 const a=applicant(1),b=applicant(2);
 async function transport(url,options={}){
  const u=new URL(url);if(u.host==='app.apeforge.fun')return{value:byId.get(u.pathname.split('/').at(-1))?.profile,headers:{}};
  if(u.host==='api.github.com'){const n=Number(u.pathname.split('/')[5]),row=records.get(n);return{value:u.pathname.endsWith('/comments')?row.comments:row.issue,headers:{}};}
  const row=[a,b].find(r=>new URL(r.claim.endpoint).host===u.host);assert(row,'no arbitrary transport destination');
  return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:row.server.address().port,path:u.pathname+u.search,method:options.method||'GET',agent:false,headers:{...options.headers,...(options.body?{'content-length':Buffer.byteLength(options.body)}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,body,value:JSON.parse(body)});});});req.on('error',reject);req.end(options.body);});
 }
 try{
  for(const row of[a,b]){row.server=await listenPeer(row.peer,row.claim);servers.push(row.server);}
  const directory=peerDirectory({transport,clock}),av=await directory.discover(a.claim.agentId),bv=await directory.discover(b.claim.agentId);assert.equal(av.ok,true,JSON.stringify(av));assert.equal(bv.ok,true,JSON.stringify(bv));assert.equal(av.walletVerified,false);
  const client=peerClient({ownBinding:a.claim,privateKey:a.privateKey,directory,transport,clock});
  const denied=await client.send(b.claim.agentId,'no recipient consent yet');assert.equal(denied.ok,false);assert.equal(denied.delivery,'rejected');
  b.peer.grant(av.binding);a.peer.grant(bv.binding);
  const first=await client.send(b.claim.agentId,'bounded hello',{messageId:'message-1'});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.authenticatedRecipient,true);const task=first.receipt.result.task;assert.equal(task.status.state,'TASK_STATE_SUBMITTED');assert.equal(first.serviceExecutionVerified,false);
  b.peer.reply(task.id,'bounded reply from recipient owner');const status=await client.status(b.claim.agentId,task.id);assert.equal(status.ok,true);assert.equal(status.receipt.result.status.state,'TASK_STATE_COMPLETED');assert.equal(status.receipt.result.history[1].parts[0].text,'bounded reply from recipient owner');
  const again=await client.send(b.claim.agentId,'bounded hello',{messageId:'message-1'});assert.equal(again.receipt.result.task.id,task.id);
  const reverse=peerClient({ownBinding:b.claim,privateKey:b.privateKey,directory,transport,clock}),reverseResult=await reverse.send(a.claim.agentId,'return message');assert.equal(reverseResult.ok,true);
  b.peer.revoke(a.claim.agentId);assert.equal((await client.status(b.claim.agentId,task.id)).ok,false);
  b.peer.grant(av.binding);assert.equal((await client.status(b.claim.agentId,task.id)).ok,false,'regrant never restores old contexts');
  const revoked={...b.claim,bindingRevision:2,revoked:true,acceptInbound:false};b.comments.push({user:b.issue.user,body:prepareBinding(revoked,b.privateKey,{clock}).commentBody});assert.equal((await directory.discover(b.claim.agentId)).code,'peer_revoked_or_not_opted_in');assert.equal((await client.send(b.claim.agentId,'blocked at discovery')).ok,false);
  b.comments.pop();assert.equal((await directory.discover(b.claim.agentId)).code,'binding_rollback_or_edit');
 }finally{for(const server of servers)await new Promise(resolve=>server.close(resolve));}
});
