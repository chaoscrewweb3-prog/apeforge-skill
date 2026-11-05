import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { avatarUriForHash, avatarBytes, readAvatarFile } from '../scripts/forge-avatar.mjs';
import { hash, identityFromPrivateKey, networkClient, normalizeApplication } from '../scripts/forge-network.mjs';
import { LISTING_CONSENT } from '../scripts/forge-listing.mjs';
import { createService, createRpc, TOOLS } from '../scripts/forge-mcp.mjs';
const bytesBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const bytes = Buffer.from(bytesBase64, 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
const operation = 'aa'.repeat(16);
const input = { bytesBase64, mediaType: 'image/png', expectedRevision: 2, operation };
const application = normalizeApplication({ name:'Avatar test',summary:'Synthetic applicant',ownerWallet:'0x1111111111111111111111111111111111111111',website:'https://apeforge.fun/',requestedCategory:'partner',techStack:['Node.js'],services:[] });
const success = { avatarOperation:operation,ok:true,id:'g1',expectedRevision:2,uri:avatarUriForHash(sha256),sha256,mediaType:'image/png',size:bytes.length,verified:true,pinning:'healthy',retrieval:'healthy' };
function fixture(mutate = r => r) {
  const calls=[]; const identity = identityFromPrivateKey(generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}));
  const client=networkClient(identity,{fetcher:async(url,options)=>{
    const e=JSON.parse(options.body).params.message.parts[0].data.forgeNetwork;calls.push(e);
    let result={ok:true,id:'g1',revision:2,visibility:'unlisted',networkStatus:'pending',application};
    if(e.method==='UploadAvatar')result=success;
    if(e.method==='GetAvatarUploadReceipt')result=e.params.operation===operation?success:{ok:false,code:'avatar_upload_not_found'};
    if(e.method==='GetAvatarUploadStatus')result={ok:true,id:'g1',pinning:'healthy',retrieval:'healthy',available:true,checkedAt:new Date().toISOString(),maxBytes:1048576,mediaTypes:['image/png','image/jpeg','image/gif']};
    if(e.method==='PreviewListingUpdate')result={ok:true,id:'g1',...e.params,previewHash:hash({domain:'forge-listing-update-v1',agentId:'g1',...e.params}),consentStatement:LISTING_CONSENT,expiresAt:new Date(Date.now()+3600000).toISOString()};
    result=mutate(result,e);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:e.operation,result:{message:{role:'ROLE_AGENT',messageId:'reply',contextId:e.operation,parts:[{data:result}]}}}));
  }});return {client,calls};
}
test('raw CIDv1 uses exact sha256 bytes and no gateway/path',()=>{
  assert.equal(avatarUriForHash('00'.repeat(32)),'ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(avatarBytes(bytesBase64,'image/png'),bytes);
});
test('authenticated upload binds own identity, exact bytes and revision without publishing',async()=>{
  const {client,calls}=fixture();const r=await client.uploadAvatar(input);
  assert.equal(r.avatarOperation,operation);assert.equal(r.uri,success.uri);assert.equal(r.listingUpdated,false);assert.equal(r.consentRequired,true);
  assert.deepEqual(calls.map(e=>e.method),['GetOwnListing','UploadAvatar']);
  assert.deepEqual(calls[1].params,{bytesBase64,mediaType:'image/png',sha256,expectedRevision:2});assert.equal(calls[1].operation,operation);
});
for(const [key,value] of [['id','g2'],['expectedRevision',3],['uri','ipfs://bafybad'],['sha256','00'.repeat(32)],['size',1],['mediaType','image/jpeg'],['verified',false],['pinning','unknown'],['retrieval','unhealthy']])test('reject upload receipt alteration: '+key,async()=>{
  const {client,calls}=fixture((r,e)=>e.method==='UploadAvatar'?{...r,[key]:value}:r);
  await assert.rejects(client.uploadAvatar(input));assert.equal(calls.some(e=>e.method==='UpdateListing'),false);
});
test('invalid bytes/type/size/revision/operation reject before transport',async()=>{
  const {client,calls}=fixture();for(const change of [{bytesBase64:'AAAA'},{bytesBase64:bytesBase64+'='},{mediaType:'image/svg+xml'},{mediaType:'image/jpeg'},{mediaType:'image/webp'},{bytesBase64:Buffer.alloc(1048577).toString('base64')},{expectedRevision:0},{operation:'bad'}])await assert.rejects(client.uploadAvatar({...input,...change}));assert.equal(calls.length,0);
});
test('upload revision conflict does not pin or update; failure keeps current/default avatar',async()=>{
  const stale=fixture();assert.equal((await stale.client.uploadAvatar({...input,expectedRevision:1})).code,'revision_conflict');assert.deepEqual(stale.calls.map(e=>e.method),['GetOwnListing']);
  const failed=fixture((r,e)=>e.method==='UploadAvatar'?{ok:false,code:'avatar_readback_failed',uri:success.uri,verified:true}:r);const result=await failed.client.uploadAvatar(input);assert.equal(result.ok,false);assert.equal(result.uri,undefined);assert.match(result.note,/current\/default/);assert.equal(failed.calls.some(e=>e.method==='UpdateListing'),false);
});
test('avatar helper preserves existing Applicant, application fields, services and visibility and previews only',async()=>{
  const {client,calls}=fixture();const result=await client.previewAvatarUpdate(success);
  assert.equal(result.consentRequired,true);assert.deepEqual(result.application,{...application,avatar:success.uri});assert.equal(result.id,'g1');assert.equal(result.visibility,'unlisted');assert.equal(result.expectedRevision,2);assert.equal(calls.filter(e=>e.method==='GetAvatarUploadReceipt').length,1);assert.deepEqual(calls.find(e=>e.method==='GetAvatarUploadReceipt').params,{operation});
  assert.equal(calls.some(e=>/UpdateListing|SubmitApplication/.test(e.method)),false);
});
test('avatar helper rejects mismatched Applicant or revision against authenticated durable receipt',async()=>{
  const {client,calls}=fixture();
  for(const change of [{id:'g2'},{expectedRevision:1}])await assert.rejects(client.previewAvatarUpdate({...success,...change}),{code:'avatar_upload_receipt_mismatch'});
  assert.equal(calls.some(e=>e.method==='PreviewListingUpdate'),false);
});
test('avatar helper rejects fabricated verification, missing operation and swapped operation',async()=>{
  const {client,calls}=fixture();
  await assert.rejects(client.previewAvatarUpdate({...success,avatarOperation:undefined}),{code:'invalid_avatar_upload_receipt'});
  assert.equal(calls.length,0);
  const missing=await client.previewAvatarUpdate({...success,avatarOperation:'bb'.repeat(16)});assert.equal(missing.ok,false);assert.equal(missing.code,'avatar_upload_not_found');
  const fakeHash='00'.repeat(32);await assert.rejects(client.previewAvatarUpdate({...success,sha256:fakeHash,uri:avatarUriForHash(fakeHash)}),{code:'avatar_upload_receipt_mismatch'});
  assert.equal(calls.some(e=>e.method==='PreviewListingUpdate'),false);
});
test('avatar helper rejects durable pending/failure and current listing revision conflicts',async()=>{
  for(const code of ['avatar_upload_pending','avatar_readback_failed']){
    const {client,calls}=fixture((r,e)=>e.method==='GetAvatarUploadReceipt'?{ok:false,code}:r);
    assert.equal((await client.previewAvatarUpdate(success)).code,code);assert.equal(calls.some(e=>e.method==='PreviewListingUpdate'),false);
  }
  const {client,calls}=fixture((r,e)=>e.method==='GetOwnListing'?{...r,revision:3}:r);
  assert.equal((await client.previewAvatarUpdate(success)).code,'revision_conflict');assert.equal(calls.some(e=>e.method==='PreviewListingUpdate'),false);
});
test('health distinguishes provider configuration from verified readback health',async()=>{
  const {client}=fixture((r,e)=>e.method==='GetAvatarUploadStatus'?{...r,pinning:'unconfigured',retrieval:'unknown',available:false,checkedAt:null}:r);assert.equal((await client.getAvatarUploadStatus()).available,false);
  const unknown=fixture((r,e)=>e.method==='GetAvatarUploadStatus'?{...r,retrieval:'unknown',pinning:'unknown',available:true}:r);assert.equal((await unknown.client.getAvatarUploadStatus()).retrieval,'unknown');
});
test('bounded regular-file read rejects oversize and symlink without arbitrary MCP paths',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'forge-avatar-'));try{const path=join(dir,'avatar.png');await writeFile(path,bytes);assert.deepEqual(await readAvatarFile(path,'image/png'),{bytesBase64,mediaType:'image/png'});await symlink(path,join(dir,'link'));await assert.rejects(readAvatarFile(join(dir,'link'),'image/png'));await writeFile(path,Buffer.alloc(1048577));await assert.rejects(readAvatarFile(path,'image/png'));}finally{await rm(dir,{recursive:true,force:true});}
  const upload=TOOLS.find(t=>t.name==='forge_upload_avatar');assert.equal(upload.annotations.readOnlyHint,false);assert.equal(upload.inputSchema.properties.path,undefined);assert.equal(upload.inputSchema.properties.privateKey,undefined);
});
test('MCP has dedicated upload/health/preview and rejects target IDs, file paths or generic avatar calls',async()=>{
  const service=createService({network:{getAvatarUploadStatus:async()=>({ok:true}),uploadAvatar:async args=>args,previewAvatarUpdate:async r=>r}}),rpc=createRpc(service);
  await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});await rpc({jsonrpc:'2.0',method:'notifications/initialized'});
  const call=(name,args={})=>rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});
  for(const args of [{...input,path:'/etc/passwd'},{...input,agentId:'g2'},{...input,privateKey:'secret'}])assert.ok((await call('forge_upload_avatar',args)).error);
  assert.equal(JSON.parse((await call('forge_network_call',{method:'UploadAvatar',params:{},operation,authorize:true})).result.content[0].text).code,'invalid_network_operation');
  assert.equal(JSON.parse((await call('forge_upload_avatar',input)).result.content[0].text).bytesBase64,bytesBase64);
});

test('uncertain upload reconciles its original operation without retry or listing update',async()=>{
  const {client,calls}=fixture((r,e)=>{if(e.method==='UploadAvatar')throw Error('timeout');return r;});
  const uncertain=await client.uploadAvatar(input);assert.equal(uncertain.reconcileMethod,'GetAvatarUploadReceipt');assert.equal(uncertain.operation,operation);
  const receipt=await client.avatarUploadReceipt(operation);assert.equal(receipt.uri,success.uri);assert.equal(receipt.listingUpdated,false);
  assert.deepEqual(calls.at(-1).params,{operation});assert.equal(calls.filter(e=>e.method==='UploadAvatar').length,1);assert.equal(calls.some(e=>e.method==='UpdateListing'),false);
});

test('PNG dimensions and interlace are bounded before network transmission',async()=>{
  const {client,calls}=fixture();
  for(const mutate of [b=>b.writeUInt32BE(2049,16),b=>{b.writeUInt32BE(2048,16);b.writeUInt32BE(2048,20);},b=>{b[28]=1;}]){
    const altered=Buffer.from(bytes);mutate(altered);await assert.rejects(client.uploadAvatar({...input,bytesBase64:altered.toString('base64')}));
  }
  assert.equal(calls.length,0);
});

test('a different successful upload operation cannot authorize the supplied avatar receipt',async()=>{
  const differentHash='11'.repeat(32);
  const {client,calls}=fixture((r,e)=>e.method==='GetAvatarUploadReceipt'?{...success,sha256:differentHash,uri:avatarUriForHash(differentHash)}:r);
  await assert.rejects(client.previewAvatarUpdate({...success,avatarOperation:'cc'.repeat(16)}),{code:'avatar_upload_receipt_mismatch'});
  assert.equal(calls.some(e=>e.method==='PreviewListingUpdate'),false);
});
