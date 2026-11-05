import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ForgeError} from './forge-contract.mjs';
import {exact,hex} from './forge-network-auth.mjs';
export const AVATAR_METHODS=new Set(['GetAvatarUploadStatus','UploadAvatar','GetAvatarUploadReceipt']);
export const MAX_AVATAR_BYTES=16384;
export const MEDIA_TYPES=['image/png'];
const digest=b=>createHash('sha256').update(b).digest('hex');
export function rawCid(sha256){let bits=0,value=0,out='b';for(const byte of Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),Buffer.from(sha256,'hex')])){value=(value<<8)|byte;bits+=8;while(bits>=5){out+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];return out;}
// Sniff actual raster structure, not caller extension or Content-Type. No SVG/HTML/GIF.
export function validateImage(p){
 exact(p,['mediaType','bytesBase64','sha256','expectedRevision']);
 if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<1)throw new ForgeError('invalid_revision',422);
 if(!MEDIA_TYPES.includes(p.mediaType)||typeof p.bytesBase64!=='string'||p.bytesBase64.length>21848||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.bytesBase64))throw new ForgeError('invalid_avatar_type',422);
 const b=Buffer.from(p.bytesBase64,'base64');if(!b.length||b.length>MAX_AVATAR_BYTES)throw new ForgeError('avatar_size_exceeded',413);
 if(b.toString('base64')!==p.bytesBase64||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256)||digest(b)!==p.sha256)throw new ForgeError('avatar_hash_mismatch',422);
 let w=0,h=0,depth=0,color=0,parts=[],palette=false,ended=false,idatEnded=false;
 const bad=()=>{throw new ForgeError('invalid_avatar_image',422);};
 if(b.length<45||!b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))bad();
 let pos=8;
 while(pos+12<=b.length){
  const n=b.readUInt32BE(pos),tag=b.toString('ascii',pos+4,pos+8);if(n>b.length-pos-12||!/^[A-Za-z]{4}$/.test(tag))bad();
  let crc=0xffffffff;for(const byte of b.subarray(pos+4,pos+8+n)){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}if(((crc^0xffffffff)>>>0)!==b.readUInt32BE(pos+8+n))bad();
  if(pos===8){if(tag!=='IHDR'||n!==13)bad();w=b.readUInt32BE(pos+8);h=b.readUInt32BE(pos+12);depth=b[pos+16];color=b[pos+17];if(!w||!h||w>2048||h>2048||w*h>1048576||b[pos+18]||b[pos+19]||b[pos+20]||!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color]||[]).includes(depth))bad();}
  else if(tag==='IHDR'||['acTL','fcTL','fdAT'].includes(tag))bad();
  if(tag==='PLTE'){if(palette||parts.length||![2,3,6].includes(color)||!n||n%3||n>768||(color===3&&n/3>2**depth))bad();palette=true;}
  if(tag==='IDAT'){if(idatEnded||(color===3&&!palette))bad();parts.push(b.subarray(pos+8,pos+8+n));}
  else if(parts.length)idatEnded=true;
  if(!['IHDR','PLTE','IDAT','IEND'].includes(tag)&&tag[0]===tag[0].toUpperCase())bad();
  pos+=n+12;if(tag==='IEND'){if(n||pos!==b.length||!parts.length)bad();ended=true;break;}
 }
 if(!ended)bad();
 const components={0:1,2:3,3:1,4:2,6:4}[color],row=Math.ceil(w*components*depth/8),size=(row+1)*h;
 try{const data=inflateSync(Buffer.concat(parts),{maxOutputLength:size,info:true});if(data.buffer.length!==size||data.engine.bytesWritten!==Buffer.concat(parts).length)bad();for(let i=0;i<size;i+=row+1)if(data.buffer[i]>4)bad();}catch{bad();}
 return {bytes:b,cid:rawCid(p.sha256)};
}
export function installAvatarUploads(store,{provider=null}={}){
 const db=store.db;let busy=0;db.exec('CREATE TABLE IF NOT EXISTS native_avatar_uploads(agent TEXT NOT NULL,operation TEXT NOT NULL,intent TEXT NOT NULL,response TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(agent,operation))');
 const own=principal=>{const a=db.prepare('SELECT * FROM native_agents WHERE principal=?').get(principal);if(!a)throw new ForgeError('not_found',404);if(a.status==='suspended')throw new ForgeError('applicant_unavailable',403);if(a.identity_revoked||db.prepare('SELECT 1 FROM native_retired WHERE principal=?').get(principal))throw new ForgeError('identity_revoked',403);return a;};
 function status(a){let h=store.control('avatar-upload-health');if(!provider)h={pinning:'unconfigured',retrieval:'unconfigured',checkedAt:null};else if(!h||Date.parse(h.checkedAt)<store.clock()-300000)h={pinning:'unknown',retrieval:'unknown',checkedAt:h?.checkedAt||null};return{ok:true,id:a.id,...h,maxBytes:MAX_AVATAR_BYTES,mediaTypes:MEDIA_TYPES,available:!!provider};}
 async function dispatch(e,intent){
  let a,old,image,pending;const at=store.clock();db.exec('BEGIN IMMEDIATE');try{
   a=own(e.principal);db.prepare('DELETE FROM native_nonces WHERE at<?').run(at-120000);db.prepare('DELETE FROM native_rates WHERE window<?').run(Math.floor(at/60000)-2);
   if(db.prepare('SELECT 1 FROM native_nonces WHERE principal=? AND nonce=?').get(e.principal,e.nonce))throw new ForgeError('nonce_replayed',409);
   const window=Math.floor(at/60000);if((db.prepare('SELECT count FROM native_rates WHERE principal=? AND window=?').get(e.principal,window)?.count||0)>=60)throw new ForgeError('rate_limited',429);
   db.prepare('INSERT INTO native_nonces VALUES(?,?,?)').run(e.principal,e.nonce,at);db.prepare('INSERT INTO native_rates VALUES(?,?,1) ON CONFLICT(principal,window) DO UPDATE SET count=count+1').run(e.principal,window);
   if(e.method==='GetAvatarUploadStatus'){exact(e.params,[]);old=status(a);}
   else if(e.method==='GetAvatarUploadReceipt'){exact(e.params,['operation']);if(!hex(e.params.operation))throw new ForgeError('invalid_operation');const r=db.prepare('SELECT response FROM native_avatar_uploads WHERE agent=? AND operation=?').get(a.id,e.params.operation);if(!r)throw new ForgeError('receipt_not_found',404);old=JSON.parse(r.response);}
   else{
    image=validateImage(e.params);
    const r=db.prepare('SELECT * FROM native_avatar_uploads WHERE agent=? AND operation=?').get(a.id,e.operation);
    if(r){if(r.intent!==intent)throw new ForgeError('operation_conflict',409);old=JSON.parse(r.response);}
    else{
     if(a.revision!==e.params.expectedRevision)throw new ForgeError('revision_conflict',409);
     if(!provider){old={...status(a),ok:false,code:'avatar_pinning_unconfigured'};}
     else{if(busy>=2)throw new ForgeError('avatar_capacity',429);
      const since=at-86400000;if(db.prepare('SELECT COUNT(*) n FROM native_avatar_uploads WHERE agent=? AND at>?').get(a.id,since).n>=5||db.prepare('SELECT COUNT(*) n FROM native_avatar_uploads WHERE at>?').get(since).n>=100)throw new ForgeError('avatar_upload_quota',429);
      pending={ok:false,code:'avatar_upload_pending',id:a.id,operation:e.operation,note:'Query the original upload receipt. No listing has been changed.'};
      db.prepare('INSERT INTO native_avatar_uploads VALUES(?,?,?,?,?)').run(a.id,e.operation,intent,JSON.stringify(pending),at);busy++;
     }
    }
   }db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  if(old){await store.checkpoint();return old;}
  try{
   await store.checkpoint();let pinning='unknown',retrieval='unknown',result;
   try{const beforePin=own(e.principal);if(beforePin.id!==a.id||beforePin.revision!==e.params.expectedRevision)throw new ForgeError('revision_conflict',409);const pinned=await provider.pin(image.bytes,e.params.mediaType,image.cid);if(pinned!==image.cid)throw Error('pin_mismatch');pinning='healthy';const beforeRead=own(e.principal);if(beforeRead.id!==a.id||beforeRead.revision!==e.params.expectedRevision)throw new ForgeError('revision_conflict',409);const back=await provider.retrieve(image.cid);if(!Buffer.isBuffer(back)||!back.equals(image.bytes))throw Error('readback_mismatch');retrieval='healthy';
    const current=own(e.principal);if(current.id!==a.id||current.revision!==e.params.expectedRevision)throw new ForgeError('revision_conflict',409);
    result={ok:true,id:a.id,expectedRevision:e.params.expectedRevision,uri:'ipfs://'+image.cid,sha256:e.params.sha256,mediaType:e.params.mediaType,size:image.bytes.length,verified:true,pinning,retrieval};
   }catch(error){if(!['revision_conflict','identity_revoked','not_found','applicant_unavailable'].includes(error.code)){if(pinning!=='healthy')pinning='unhealthy';else if(retrieval!=='healthy')retrieval='unhealthy';}result={ok:false,code:error instanceof ForgeError?error.code:pinning==='unhealthy'?'avatar_pinning_failed':'avatar_readback_failed',id:a.id,operation:e.operation,pinning,retrieval,note:'No listing has changed. Keep the current/default avatar.'};}
   db.exec('BEGIN IMMEDIATE');try{store.control('avatar-upload-health',{pinning,retrieval,checkedAt:store.now()});db.prepare('UPDATE native_avatar_uploads SET response=? WHERE agent=? AND operation=?').run(JSON.stringify(result),a.id,e.operation);db.exec('COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}await store.checkpoint();return result;
  }finally{busy--;}
 }
 return {dispatch,status};
}
