import{ForgeError,prepare}from'./forge-contract.mjs';
import{canonical,hash,exact,hex,nativeQuota}from'./forge-network-auth.mjs';

export const LISTING_METHODS=new Set(['GetOwnListing','PreviewListingUpdate','UpdateListing','GetListingUpdateReceipt']);
export const LISTING_CONSENT='I consent to publishing this exact updated public profile, services and listing visibility. This does not change membership, network permissions or payment authorization.';
export function InstallListing(store){const db=store.db;
 db.exec('CREATE TABLE IF NOT EXISTS native_listings(agent TEXT PRIMARY KEY,visibility TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL)');
 const visibility=id=>db.prepare('SELECT visibility FROM native_listings WHERE agent=?').get(id)?.visibility||'listed';
 function candidate(a,p){if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<1)throw new ForgeError('invalid_revision',422);if(p.expectedRevision!==a.revision)throw new ForgeError('revision_conflict',409);if(!['listed','unlisted'].includes(p.visibility))throw new ForgeError('invalid_visibility',422);
  const application=prepare(p.application).application,current=JSON.parse(a.payload);if(application.ownerWallet!==current.ownerWallet||application.requestedCategory!==current.requestedCategory)throw new ForgeError('immutable_listing_field',422);
  const payload={domain:'forge-listing-update-v1',agentId:a.id,expectedRevision:p.expectedRevision,visibility:p.visibility,application};return{application,payload,previewHash:hash(canonical(payload))};
 }
 return function listing(e){const p=e.params,at=store.clock();
  const a=db.prepare('SELECT * FROM native_agents WHERE principal=?').get(e.principal);if(!a)throw new ForgeError('not_found',404);if(a.identity_revoked||db.prepare('SELECT 1 FROM native_retired WHERE principal=?').get(e.principal))throw new ForgeError('identity_revoked',403);
  // Current key may reconcile this stable agent's historical key-lineage receipts.
  if(e.method==='GetListingUpdateReceipt'){exact(p,['operation']);if(!hex(p.operation))throw new ForgeError('invalid_operation');const ops=db.prepare("SELECT response FROM native_operations WHERE operation=? AND method='UpdateListing' AND (principal=? OR principal IN(SELECT principal FROM native_retired WHERE agent=?)) LIMIT 2").all(p.operation,e.principal,a.id);if(!ops.length)throw new ForgeError('receipt_not_found',404);if(ops.length!==1)throw new ForgeError('operation_conflict',409);return JSON.parse(ops[0].response);}
  if(e.method==='GetOwnListing'){exact(p,[]);return{ok:true,id:a.id,revision:a.revision,application:prepare(JSON.parse(a.payload)).application,visibility:visibility(a.id),networkStatus:a.network_status};}
  exact(p,e.method==='PreviewListingUpdate'?['application','visibility','expectedRevision']:['application','visibility','expectedRevision','previewHash','consent']);
  const c=candidate(a,p);
  if(e.method==='PreviewListingUpdate'){nativeQuota(db,'preview',e.principal,c.previewHash,at);if(db.prepare('SELECT COUNT(*) n FROM native_previews WHERE principal=?').get(e.principal).n>=8&&!db.prepare('SELECT 1 FROM native_previews WHERE principal=? AND hash=?').get(e.principal,c.previewHash))throw new ForgeError('preview_capacity',429);
   db.prepare('INSERT INTO native_previews VALUES(?,?,?,?) ON CONFLICT(principal,hash) DO UPDATE SET at=excluded.at').run(e.principal,c.previewHash,JSON.stringify(c.payload),at);return{ok:true,id:a.id,expectedRevision:p.expectedRevision,application:c.application,visibility:p.visibility,previewHash:c.previewHash,consentStatement:LISTING_CONSENT,expiresAt:new Date(at+86400000).toISOString()};}
  if(e.method!=='UpdateListing')throw new ForgeError('method_not_supported',404);
  if(p.consent!==true||p.previewHash!==c.previewHash)throw new ForgeError('exact_profile_consent_required',422);const preview=db.prepare('SELECT * FROM native_previews WHERE principal=? AND hash=?').get(e.principal,c.previewHash);if(!preview||preview.at<at-86400000||canonical(JSON.parse(preview.payload))!==canonical(c.payload))throw new ForgeError('preview_required',409);
  if(db.prepare("SELECT 1 FROM native_operations WHERE operation=? AND method='UpdateListing' AND principal IN(SELECT principal FROM native_retired WHERE agent=?)").get(e.operation,a.id))throw new ForgeError('operation_conflict',409);
  const time=store.now(),updated=db.prepare('UPDATE native_agents SET payload=?,revision=revision+1,updated_at=? WHERE id=? AND principal=? AND revision=? AND identity_revoked=0').run(JSON.stringify(c.application),time,a.id,e.principal,p.expectedRevision);if(updated.changes!==1)throw new ForgeError('revision_conflict',409);
  db.prepare('INSERT INTO native_listings VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET visibility=excluded.visibility,source=excluded.source,updated_at=excluded.updated_at').run(a.id,p.visibility,JSON.stringify(e),time);
  db.prepare("DELETE FROM native_previews WHERE principal=? AND json_extract(payload,'$.domain')='forge-listing-update-v1' AND json_extract(payload,'$.agentId')=? AND json_extract(payload,'$.expectedRevision')<=?").run(e.principal,a.id,p.expectedRevision);
  db.prepare('INSERT INTO native_audit(agent,action,at,actor,operation) VALUES(?,?,?,?,?)').run(a.id,'listing-updated',time,e.principal,e.operation);
  return{ok:true,id:a.id,revision:p.expectedRevision+1,visibility:p.visibility,updated:true,agentUrl:`https://app.apeforge.fun/app/forge-agent.html?id=${a.id}`,projectUrl:`https://app.apeforge.fun/app/forge-project.html?id=${a.project_id}`,sourceUrl:`https://app.apeforge.fun/api/forge/v1/applications/${a.id}`,networkStatus:a.network_status};
 };
}
