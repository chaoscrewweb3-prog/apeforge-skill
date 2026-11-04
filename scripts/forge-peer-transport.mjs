/** Public HTTPS only, IP-pinned DNS, no proxies/redirects; no credentials. */
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export function publicAddress(address) {
 const family=isIP(address);
 if(family===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 if(family===6){const s=address.toLowerCase();if(s.includes('.')||s.includes('%'))return false;const parts=s.split(':'),head=parseInt(parts[0],16),second=parseInt(parts[1]||'0',16);return head>=0x2000&&head<0x3fff&&head!==0x2002&&!(head===0x2001&&(second<0x200||second===0xdb8));}
 return false;
}
export function publicURL(value) {
 if(typeof value!=='string'||value.length>2048||/[\s\\]/.test(value))throw Error('invalid_public_url');
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||isIP(u.hostname)||!u.hostname.includes('.')||!u.hostname.split('.').every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s))||/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|arpa)$/.test(u.hostname)||/(?:^|\.)(?:example\.com|example\.net|example\.org)$/.test(u.hostname))throw Error('invalid_public_url');
 return u;
}
export async function publicJSON(value,{method='GET',body,headers={},limit=196608,signal=AbortSignal.timeout(12000),resolver=lookup,allowPeerErrors=false}={}) {
 const url=publicURL(value);if(!['GET','POST'].includes(method))throw Error('invalid_method');
 // No credential, cookie or proxy headers may be passed by this boundary.
 if(Object.keys(headers).some(k=>/^(?:authorization|cookie|host|proxy-)/i.test(k)))throw Error('credential_header_rejected');
 if(body!==undefined&&(typeof body!=='string'||Buffer.byteLength(body)>16384))throw Error('body_too_large');
 const addresses=await new Promise((resolve,reject)=>{if(signal.aborted)return reject(Error('transport_timeout'));const abort=()=>reject(Error('transport_timeout'));signal.addEventListener('abort',abort,{once:true});resolver(url.hostname,{all:true,verbatim:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
 if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(a=>!publicAddress(a.address)))throw Error('non_public_dns');
 const pinned=addresses[0];
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{method,agent:false,signal,servername:url.hostname,rejectUnauthorized:true,lookup:(_host,options,callback)=>options.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family),headers:{Accept:'application/json','User-Agent':'ApeForge-Peer-Client/1.4',...headers,...(body!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
   const chunks=[];let bytes=0;
   if(res.statusCode!==200&&!(allowPeerErrors&&method==='POST'&&[400,401,403,404,409,413,429].includes(res.statusCode))){res.resume();return reject(Error(res.statusCode===403?'source_forbidden':res.statusCode===429?'source_rate_limited':'http_response_rejected'));}
   if(!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']||'')||res.headers['content-length']&&(!/^\d+$/.test(res.headers['content-length'])||Number(res.headers['content-length'])>limit)){res.destroy();return reject(Error('response_rejected'));}
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){res.destroy();reject(Error('response_too_large'));}else chunks.push(chunk);});
   res.on('error',()=>reject(Error('transport_failed')));res.on('end',()=>{try{const raw=Buffer.concat(chunks).toString('utf8');resolve({value:JSON.parse(raw),body:raw,headers:res.headers,status:res.statusCode,url:url.href});}catch{reject(Error('invalid_json'));}});
  });req.on('error',()=>reject(Error(signal.aborted?'transport_timeout':'transport_failed')));req.end(body);
 });
}
