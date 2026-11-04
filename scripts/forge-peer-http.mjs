/** Optional HTTP adapter. Importing does not listen. Deploy behind your own HTTPS. */
import { createServer } from 'node:http';
export function peerHandler(peer,binding,{clock=Date.now}={}) {
 const endpoint=new URL(binding.endpoint),card=new URL(binding.cardUrl);let window=clock(),count=0,active=0;
 return async(req,res)=>{
  const send=(status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(typeof value==='string'?value:JSON.stringify(value));};
  if(clock()-window>=60000){window=clock();count=0;}
  if(++count>300||active>=16){req.resume();send(429,{error:'recipient_capacity_limited'});return;}
  active++;try{
   req.setTimeout(5000,()=>req.destroy());
   const route=new URL(req.url,'http://local.invalid');
   if(req.method==='GET'&&route.pathname===card.pathname&&!route.search){send(200,peer.card());return;}
   if(req.method==='GET'&&route.pathname==='/forge-peer/proof'&&[...route.searchParams.keys()].join('|')==='nonce'&&/^[a-f0-9]{32}$/.test(route.searchParams.get('nonce')||'')){send(200,peer.proof(route.searchParams.get('nonce')));return;}
   if(req.method!=='POST'||req.url!==endpoint.pathname+endpoint.search){req.resume();send(404,{error:'not_found'});return;}
   const security=['content-length','content-type','a2a-version','a2a-extensions','x-forge-peer','x-forge-key','x-forge-time','x-forge-nonce','x-forge-session','x-forge-signature'];
   for(const key of security){if(req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===key).length!==1){req.resume();send(400,{error:'invalid_framing'});return;}}
   if(req.headers['content-type']!=='application/json'||req.headers['transfer-encoding']||req.headers.expect||!/^\d{1,5}$/.test(req.headers['content-length']||'')||Number(req.headers['content-length'])>16384){req.resume();send(400,{error:'invalid_framing'});return;}
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384){send(413,{error:'body_limit'});return;}chunks.push(chunk);}
   if(size!==Number(req.headers['content-length'])){send(400,{error:'invalid_framing'});return;}
   const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   const response=peer.dispatch({body,headers:req.headers});send(response.status,response.body,response.headers);
  }catch{if(!res.headersSent)send(400,{error:'recipient_request_rejected'});else res.destroy();}finally{active--;}
 };
}
/** Owner-explicit localhost listener; configure your HTTPS proxy separately. */
export function listenPeer(peer,binding,{port=0}={}) {
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid_port');
 const server=createServer(peerHandler(peer,binding));server.headersTimeout=10000;server.requestTimeout=10000;server.maxConnections=32;server.on('checkContinue',(_req,res)=>{res.writeHead(417);res.end();});
 return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server));});
}
