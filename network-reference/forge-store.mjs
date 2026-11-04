import{installRoles}from'./forge-roles.mjs';
import{DatabaseSync,backup}from'node:sqlite';
import fs from'node:fs';import fsp from'node:fs/promises';import path from'node:path';import{createHash,randomUUID}from'node:crypto';import{ForgeError,REPO}from'./forge-contract.mjs';
const APP_ID=0x46475232;
export class ForgeStore{
 constructor(file,{clock=Date.now,eligibility=null}={}){
  if(!path.isAbsolute(file)||fs.lstatSync(path.dirname(file)).isSymbolicLink())throw new ForgeError('invalid_storage',503);
  this.file=file;this.clock=clock;this.eligibility=eligibility;this.backupTask=Promise.resolve();this.closed=false;
  if(!fs.existsSync(file))fs.closeSync(fs.openSync(file,'wx',0o600));
  const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new ForgeError('invalid_storage',503);
  this.db=new DatabaseSync(file);this.db.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000');
  const version=this.db.prepare('PRAGMA user_version').get().user_version,id=this.db.prepare('PRAGMA application_id').get().application_id;
  if(version===0&&id===0&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length===0){
   this.db.exec(`BEGIN IMMEDIATE;CREATE TABLE agents(id TEXT PRIMARY KEY,issue_id INTEGER UNIQUE NOT NULL,issue_number INTEGER UNIQUE NOT NULL,author_id INTEGER NOT NULL,author_login TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,request_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_updated_at TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('applicant','suspended')));CREATE TABLE projects(id TEXT PRIMARY KEY,author_id INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE controls(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE events(id INTEGER PRIMARY KEY,agent_id TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,request_id TEXT NOT NULL);CREATE TABLE approvals(agent_id TEXT NOT NULL,revision INTEGER NOT NULL,subject TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(agent_id,revision,subject));PRAGMA application_id=${APP_ID};PRAGMA user_version=1;COMMIT;`);
  }else if(version!==1||id!==APP_ID){this.db.close();throw new ForgeError('unsupported_database',503);}
  this.roles=installRoles(this);
  if(this.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'){this.db.close();throw new ForgeError('invalid_database',503);}
 }
 control(key,value){if(value===undefined){const r=this.db.prepare('SELECT value FROM controls WHERE key=?').get(key);return r?JSON.parse(r.value):null;}this.db.prepare('INSERT INTO controls VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}
 now(){return new Date(this.clock()).toISOString();}
 row(id){if(typeof id!=='string'||!/^g[0-9]{1,16}$/.test(id))throw new ForgeError('not_found',404);return this.db.prepare('SELECT * FROM agents WHERE id=?').get(id);}
 receipt(row){return{registered:true,status:row.status,id:row.id,revision:row.revision,requestId:row.request_id,agentUrl:`https://app.apeforge.fun/app/forge-agent.html?id=${row.id}`,projectUrl:`https://app.apeforge.fun/app/forge-project.html?id=${row.project_id}`,sourceUrl:`https://github.com/${REPO}/issues/${row.issue_number}`,membership:'not-approved',walletVerification:'self-declared'};}
 existing(number,requestId){const row=this.db.prepare('SELECT * FROM agents WHERE issue_number=? AND request_id=?').get(number,requestId);return row?this.receipt(row):null;}
 async importIssue(source){
  const prior=this.db.prepare('SELECT * FROM agents WHERE issue_id=?').get(source.issueId);if(prior?.request_id===source.requestId){await this.checkpoint();return this.receipt(prior);}
  const id='g'+source.issueId,at=this.now(),projectId='p'+createHash('sha256').update(source.authorId+':'+source.application.projectName.toLowerCase()).digest('hex').slice(0,24);
  this.db.exec('BEGIN IMMEDIATE');try{
   const row=this.db.prepare('SELECT * FROM agents WHERE issue_id=?').get(source.issueId);
   if(row&&(row.author_id!==source.authorId||row.issue_number!==source.issueNumber))throw new ForgeError('source_identity_changed',409);
   if(row&&Date.parse(source.sourceUpdatedAt)<=Date.parse(row.source_updated_at))throw new ForgeError('stale_source',409);
   if(!row&&this.db.prepare('SELECT COUNT(*) n FROM agents').get().n>=10000)throw new ForgeError('registry_capacity',503);
   this.db.prepare('INSERT OR IGNORE INTO projects VALUES(?,?,?,?)').run(projectId,source.authorId,source.application.projectName,at);
   this.db.prepare(`INSERT INTO agents VALUES(?,?,?,?,?,?,1,?,?,?,?,?,'applicant') ON CONFLICT(issue_id) DO UPDATE SET author_login=excluded.author_login,project_id=excluded.project_id,revision=agents.revision+1,request_id=excluded.request_id,updated_at=excluded.updated_at,source_updated_at=excluded.source_updated_at,payload=excluded.payload,status='applicant'`).run(id,source.issueId,source.issueNumber,source.authorId,source.authorLogin,projectId,source.requestId,at,at,source.sourceUpdatedAt,JSON.stringify(source.application));
   this.db.prepare('DELETE FROM designations WHERE agent_id=?').run(id);
   this.db.prepare('INSERT INTO events(agent_id,action,at,request_id) VALUES(?,?,?,?)').run(id,row?'updated':'registered',at,source.requestId);this.db.exec('COMMIT');
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  await this.checkpoint();return this.receipt(this.row(id));
 }
 membership(row){
  const base={status:'applicant',eligibleApprovals:null,requiredApprovals:5,votingAvailable:false,reason:'verified_lock_eligibility_unavailable'};
  if(row.status!=='applicant')return{...base,status:row.status};if(!this.eligibility)return base;
  try{const subjects=this.db.prepare('SELECT subject FROM approvals WHERE agent_id=? AND revision=?').all(row.id,row.revision).map(x=>x.subject),s=this.eligibility(new Set(subjects),this.clock());if(!s||!(s.eligible instanceof Set)||!Number.isFinite(s.observedAt)||!Number.isFinite(s.validUntil)||s.observedAt>this.clock()||s.validUntil<=this.clock()||typeof s.policyVersion!=='string')return base;const count=new Set(subjects.filter(x=>s.eligible.has(x))).size;return{status:count>=5?'community':'applicant',eligibleApprovals:count,requiredApprovals:5,votingAvailable:true,policyVersion:s.policyVersion};}catch{return base;}
 }
 publicAgent(row){if(!row||row.status==='suspended')throw new ForgeError('not_found',404);const p=JSON.parse(row.payload);return{id:row.id,revision:row.revision,designation:this.roles.read(row.id),name:p.name,overview:p.summary,avatar:'/assets/apeforge-profile-silhouette.png',avatarKind:'default',requestedCategory:p.requestedCategory,project:{id:row.project_id,name:p.projectName},profile:p,source:{type:'github-public-application',url:`https://github.com/${REPO}/issues/${row.issue_number}`,author:row.author_login,verified:'github-source-only'},verification:{wallet:'self-declared',services:'self-declared',project:'self-declared'},membership:this.membership(row),createdAt:row.created_at,updatedAt:row.updated_at};}
 card(row){const a=this.publicAgent(row);a.declaredServices=a.profile.services.length;a.profile={website:a.profile.website,x:a.profile.x,telegram:a.profile.telegram,techStack:a.profile.techStack,services:[]};return a;}
 list({cursor='',limit=24}={}){if(typeof cursor!=='string'||cursor&&!/^g[0-9]{1,16}$/.test(cursor)||!Number.isInteger(limit)||limit<1||limit>24)throw new ForgeError('invalid_page');const rows=this.db.prepare("SELECT * FROM agents WHERE status='applicant' AND id>? ORDER BY id LIMIT ?").all(cursor,limit+1),more=rows.length>limit,items=rows.slice(0,limit).map(r=>this.card(r));return{schemaVersion:1,items,nextCursor:more?items.at(-1).id:null,capturedAt:this.now(),pageComplete:!more,total:this.db.prepare("SELECT COUNT(*) n FROM agents WHERE status='applicant'").get().n,voting:{available:!!this.eligibility,reason:this.eligibility?null:'verified_lock_eligibility_unavailable'}};}
 get(id){return this.publicAgent(this.row(id));}
 project(id){if(typeof id!=='string'||!/^p[a-f0-9]{24}$/.test(id))throw new ForgeError('not_found',404);const p=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);if(!p)throw new ForgeError('not_found',404);const agents=this.db.prepare("SELECT * FROM agents WHERE project_id=? AND status='applicant' ORDER BY id LIMIT 49").all(id);if(!agents.length)throw new ForgeError('not_found',404);return{id:p.id,name:p.name,association:'self-declared-by-applicant',agents:agents.slice(0,48).map(a=>this.card(a)),complete:agents.length<=48,createdAt:p.created_at};}
 vote(id,identity,revision){if(!this.eligibility)throw new ForgeError('verified_lock_eligibility_unavailable',503);const row=this.row(id);if(!row)throw new ForgeError('not_found',404);if(!identity?.serverVerified||typeof identity.subject!=='string'||!/^wallet:0x[a-f0-9]{40}$/.test(identity.subject))throw new ForgeError('authentication_required',401);if(row.revision!==revision)throw new ForgeError('revision_conflict',409);const p=JSON.parse(row.payload);if('wallet:'+p.ownerWallet.toLowerCase()===identity.subject)throw new ForgeError('self_approval_denied',403);const snapshot=this.eligibility(new Set([identity.subject]),this.clock());if(!snapshot?.eligible?.has(identity.subject)||snapshot.observedAt>this.clock()||snapshot.validUntil<=this.clock())throw new ForgeError('voter_ineligible',403);this.db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?)').run(id,row.revision,identity.subject,this.now());return this.membership(row);}
 async checkpoint(){this.backupTask=this.backupTask.catch(()=>{}).then(async()=>{const temp=this.file+'.backup-'+randomUUID();try{await backup(this.db,temp);const check=new DatabaseSync(temp,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('backup_integrity');}finally{check.close();}await fsp.chmod(temp,0o600);await fsp.rename(temp,this.file+'.backup');}catch(e){await fsp.rm(temp,{force:true}).catch(()=>{});throw new ForgeError('backup_unavailable',503);}});return this.backupTask;}
 async close(){try{await this.backupTask;}finally{this.db.close();this.closed=true;}}
}
