import {ForgeError} from './forge-contract.mjs';
export function networkHandler(store,verifyAdmin){
 let window=0,count=0;
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 return async(req,res)=>{
  const media=/^\/forge\/v1\/media\/([a-f0-9]{64})\.(png|jpg|gif)$/.exec(req.url);
  const source=/^\/forge\/v1\/applications\/(g[0-9]{1,16})$/.exec(req.url),admin=/^\/forge\/v1\/admin\/network\/(g[0-9]{1,16})$/.exec(req.url);
  if(req.url!=='/forge/v1/network'&&!source&&!admin&&!media)return false;
  try{
   if(!store.network)throw new ForgeError('network_unavailable',503);
   if(media){if(req.method!=='GET')throw new ForgeError('method_not_allowed',405);const item=store.network.media(media[1],media[2]);res.writeHead(200,{'Content-Type':item.mediaType,'Content-Length':item.bytes.length,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','ETag':'"'+media[1]+'"'});res.end(item.bytes);return true;}
   if(source){if(req.method!=='GET')throw new ForgeError('method_not_allowed',405);json(res,200,store.network.publicApplication(source[1]));return true;}
   if(req.method!=='POST')throw new ForgeError('method_not_allowed',405);
   const now=Date.now();if(now-window>=60000){window=now;count=0;}if(++count>300)throw new ForgeError('network_rate_limited',429);
   const raw=req.rawHeaders,one=name=>raw.filter((v,i)=>i%2===0&&v.toLowerCase()===name).length===1;
   if(!one('content-length')||!one('content-type')||req.headers['content-type']!=='application/json'||req.headers['transfer-encoding']||req.headers.expect||!/^\d{1,7}$/.test(req.headers['content-length']||'')||Number(req.headers['content-length'])>1400000)throw new ForgeError('invalid_framing');
   let body=Buffer.alloc(0);for await(const part of req){body=Buffer.concat([body,part]);if(body.length>1400000)throw new ForgeError('body_too_large',413);}if(body.length!==Number(req.headers['content-length']))throw new ForgeError('invalid_framing');
   let b;try{b=JSON.parse(body.toString('utf8'));}catch{throw new ForgeError('invalid_json');}
   // Public proxy emits this exact representation after rejecting duplicate keys.
   if(!b||Array.isArray(b)||JSON.stringify(b)!==body.toString('utf8'))throw new ForgeError('noncanonical_json');
   if(body.length>32768&&(admin||b.method!=='UploadAvatar'))throw new ForgeError('body_too_large',413);
   if(admin){
    if(!verifyAdmin)throw new ForgeError('admin_unavailable',503);
    if(Object.keys(b).sort().join('|')!=='chainId|decision|expectedRevision|operation|providerToken')throw new ForgeError('invalid_admin_request');
    const actor=await verifyAdmin({providerToken:b.providerToken,chainId:b.chainId});
    json(res,200,await store.network.review(admin[1],b.expectedRevision,b.decision,actor,b.operation));
   }else json(res,200,await store.network.dispatch(b));
   return true;
  }catch(e){if(!res.headersSent)json(res,e.status||503,{ok:false,error:e instanceof ForgeError?e.code:'network_unavailable'});else res.destroy();return true;}
 };
}
