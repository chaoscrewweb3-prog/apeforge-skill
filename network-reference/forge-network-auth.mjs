import{createHash,createPublicKey,verify}from'node:crypto';
import{ForgeError}from'./forge-contract.mjs';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function canonical(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return'['+x.map(canonical).join(',')+']';return'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';}
export function exact(x,required,optional=[]){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>![...required,...optional].includes(k))||required.some(k=>!Object.hasOwn(x,k)))throw new ForgeError('invalid_parameters');}
export function bounded(x,max,min=1){if(typeof x!=='string'||x.length<min||x.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x))throw new ForgeError('invalid_text');return x;}
export const hex=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
export function authenticate(e,now){
 if(Buffer.byteLength(JSON.stringify(e)??'')>(e?.method==='UploadAvatar'?1400000:32768))throw new ForgeError('body_too_large',413);
 exact(e,['version','method','principal','publicKey','issuedAt','nonce','operation','params','signature']);
 if(e.version!==1||typeof e.method!=='string'||!/^[A-Za-z]{1,32}$/.test(e.method)||!Number.isSafeInteger(e.issuedAt)||Math.abs(now/1000-e.issuedAt)>60||!hex(e.nonce)||!hex(e.operation)||typeof e.publicKey!=='string'||!/^[A-Za-z0-9_-]{50,100}$/.test(e.publicKey)||typeof e.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(e.signature))throw new ForgeError('invalid_envelope',401);
 let key,der;try{der=Buffer.from(e.publicKey,'base64url');key=createPublicKey({key:der,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519'||key.export({format:'der',type:'spki'}).toString('base64url')!==e.publicKey)throw Error();}catch{throw new ForgeError('invalid_key',401);}
 if(e.principal!=='a'+hash(der).slice(0,32))throw new ForgeError('principal_mismatch',401);
 const{signature,...unsigned}=e;if(!verify(null,Buffer.from(canonical({domain:'forge-network-v1',...unsigned})),key,Buffer.from(signature,'base64url')))throw new ForgeError('invalid_signature',401);
 exact(e.params,[],Object.keys(e.params||{}));return hash(canonical({method:e.method,params:e.params}));
}

export function nativeQuota(db,kind,principal,previewHash,at,application){
 if(kind==='preview'&&db.prepare('SELECT COUNT(*) n FROM native_previews').get().n>=2000&&!db.prepare('SELECT 1 FROM native_previews WHERE principal=? AND hash=?').get(principal,previewHash))throw new ForgeError('preview_capacity',429);
 if(kind==='submit'&&db.prepare('SELECT 1 FROM native_agents WHERE payload=? UNION SELECT 1 FROM agents WHERE payload=?').get(JSON.stringify(application),JSON.stringify(application)))throw new ForgeError('duplicate_profile_requires_review',409);
 if(kind==='submit'&&db.prepare("SELECT COUNT(*) n FROM native_audit WHERE action='application-submitted' AND at>=?").get(new Date(at-3600000).toISOString()).n>=30)throw new ForgeError('intake_rate_limited',429);
}
